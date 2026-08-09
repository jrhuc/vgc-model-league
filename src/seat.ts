import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { AgentContextQuery } from './agent-context.js';
import { DRAFT_SERIES_REFLECTION_SYSTEM, REFLECTION_SYSTEM, SERIES_REFLECTION_SYSTEM } from './prompts.js';
import { DEX_TOOLS } from './reference.js';
import type { Completion, JsonObject, Provider, ProviderMessage, ToolDefinition } from './types.js';
import { isRecord, text } from './value.js';

type SeatPhase = 'decision' | 'reflection';

export interface SeatExchangeView extends JsonObject {
  id: number;
  phase: SeatPhase;
  system: string;
  prompt: string;
  messageCount: number;
}

interface PendingExchange {
  id: number;
  phase: SeatPhase;
  system: string;
  messages: ProviderMessage[];
  resolve: (completion: Completion) => void;
  reject: (error: Error) => void;
}

export interface SeatBridgeOptions {
  lookup: (name: string, args: JsonObject) => string;
  tools?: () => readonly ToolDefinition[];
  context?: (query: AgentContextQuery) => JsonObject;
  onExchange?: (view: SeatExchangeView) => void;
  onTool?: (name: string, args: JsonObject, result: string) => void;
}

const POLL_LIMIT_MS = 55_000;
const BODY_LIMIT_BYTES = 1_000_000;

/** Localhost agent bridge that exposes only one seat's prompts and menus. */
export class SeatBridge {
  readonly token = randomBytes(16).toString('hex');
  status: JsonObject = {};
  private readonly server: Server;
  private exchange: PendingExchange | undefined;
  private sequence = 0;
  private pollWaiters: Array<() => void> = [];
  private closed = false;

  constructor(private readonly options: SeatBridgeOptions) {
    this.server = createServer((request, response) => {
      void this.handle(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        if (!response.writableEnded) response.end(JSON.stringify({ error: 'internal error' }));
      });
    });
  }

  listen(port = 0): Promise<string> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, '127.0.0.1', () => {
        const address = this.server.address() as AddressInfo;
        resolve(`http://127.0.0.1:${address.port}`);
      });
    });
  }

  provider(): Provider {
    return { complete: (system, messages) => this.complete(system, messages) };
  }

  close(): void {
    this.closed = true;
    this.exchange?.reject(new Error('seat bridge closed'));
    this.exchange = undefined;
    this.wakePollers();
    this.server.close();
    this.server.closeAllConnections();
  }

  private complete(system: string, messages: ProviderMessage[]): Promise<Completion> {
    if (this.closed) return Promise.reject(new Error('seat bridge closed'));
    if (this.exchange) return Promise.reject(new Error('a seat exchange is already pending'));
    const { promise, resolve, reject } = Promise.withResolvers<Completion>();
    this.exchange = {
      id: ++this.sequence,
      phase:
        system === REFLECTION_SYSTEM || system === SERIES_REFLECTION_SYSTEM || system === DRAFT_SERIES_REFLECTION_SYSTEM
          ? 'reflection'
          : 'decision',
      system,
      messages,
      resolve,
      reject,
    };
    const view = this.view();
    if (view) this.options.onExchange?.(view);
    this.wakePollers();
    return promise;
  }

  private view(): SeatExchangeView | null {
    if (!this.exchange) return null;
    const last = this.exchange.messages.at(-1);
    return {
      id: this.exchange.id,
      phase: this.exchange.phase,
      system: this.exchange.system,
      prompt: typeof last?.content === 'string' ? last.content : '',
      messageCount: this.exchange.messages.length,
    };
  }

  private waitForExchange(ms: number): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    const wake = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      const index = this.pollWaiters.indexOf(wake);
      if (index !== -1) this.pollWaiters.splice(index, 1);
      resolve();
    }, ms);
    this.pollWaiters.push(wake);
    return promise;
  }

  private wakePollers(): void {
    const waiters = this.pollWaiters;
    this.pollWaiters = [];
    for (const wake of waiters) wake();
  }

  private authorized(request: IncomingMessage): boolean {
    const supplied = Buffer.from(request.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${this.token}`);
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }

  private availableTools(): readonly ToolDefinition[] {
    return this.exchange?.phase === 'decision' ? (this.options.tools?.() ?? DEX_TOOLS) : [];
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const send = (statusCode: number, body: JsonObject) => {
      response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(body));
    };
    if (!this.authorized(request)) return send(401, { error: 'bad or missing seat token' });
    const route = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (request.method !== 'POST') {
      response.setHeader('allow', 'POST');
      return send(405, { error: 'method must be POST' });
    }
    const contentType = String(request.headers['content-type'] ?? '')
      .split(';', 1)[0]!
      .trim()
      .toLowerCase();
    if (contentType !== 'application/json') return send(415, { error: 'content-type must be application/json' });
    let body: JsonObject;
    try {
      body = await readJson(request);
    } catch (error) {
      const status = error instanceof SeatHttpError ? error.status : 400;
      return send(status, { error: error instanceof Error ? error.message : 'invalid request body' });
    }

    if (route === '/status') return send(200, { status: this.status, exchange: this.exchange?.id ?? null });
    if (route === '/tools') return send(200, { tools: this.availableTools() });
    if (route === '/poll') {
      const waitMs = Math.max(0, Math.min(Number(body.waitMs) || 0, POLL_LIMIT_MS));
      if (!this.exchange && waitMs && !this.closed) await this.waitForExchange(waitMs);
      return send(200, { exchange: this.view(), status: this.status });
    }
    if (route === '/messages') {
      if (!this.exchange) return send(404, { error: 'no pending exchange' });
      return send(200, { id: this.exchange.id, messages: this.exchange.messages });
    }
    if (route === '/context') {
      if (!this.options.context) return send(404, { error: 'context stream is not available' });
      try {
        return send(200, this.options.context(body as AgentContextQuery));
      } catch (error) {
        return send(400, { error: error instanceof Error ? error.message : 'invalid context query' });
      }
    }
    if (route === '/tool') {
      const name = text(body.name);
      if (!this.availableTools().some((tool) => tool.name === name))
        return send(400, { error: `unknown tool ${name}` });
      const args = isRecord(body.arguments) ? body.arguments : {};
      const result = this.options.lookup(name, args);
      this.options.onTool?.(name, args, result);
      return send(200, { result });
    }
    if (route === '/submit') {
      const exchange = this.exchange;
      if (!exchange) return send(409, { error: 'no pending exchange' });
      if (typeof body.id !== 'number' || !Number.isSafeInteger(body.id))
        return send(400, { error: 'id must be a safe integer' });
      if (body.id !== exchange.id)
        return send(409, { error: `stale exchange; the pending exchange is ${exchange.id}` });
      const submitted = body.text;
      if (typeof submitted !== 'string' || !submitted.trim())
        return send(400, { error: 'text must be a non-empty string' });
      this.exchange = undefined;
      exchange.resolve({ text: submitted, usage: {}, toolCalls: [] });
      return send(200, { ok: true, id: exchange.id });
    }
    send(404, { error: 'unknown route' });
  }
}

class SeatHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function readJson(request: IncomingMessage): Promise<JsonObject> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > BODY_LIMIT_BYTES) throw new SeatHttpError(413, 'request body too large');
    chunks.push(chunk);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new SeatHttpError(400, 'request body must be JSON');
  }
  if (!isRecord(value)) throw new SeatHttpError(400, 'request body must be a JSON object');
  return value;
}
