import { appendFileSync } from 'node:fs';
import { createOpenAICompatible, type MetadataExtractor } from '@ai-sdk/openai-compatible';
import {
  APICallError,
  type JSONSchema7,
  jsonSchema,
  type LanguageModel,
  type ModelMessage,
  streamText,
  type ToolCallPart,
  type ToolSet,
  tool,
} from 'ai';

import { providerOption } from './provider-registry.js';
import { redactSecrets } from './sanitize.js';
import type {
  CompleteOptions,
  Completion,
  JsonObject,
  Provider,
  ProviderFailure,
  ProviderMessage,
  ToolCall,
} from './types.js';

import { isRecord } from './value.js';

export type ReasoningLevel = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export function isReasoningLevel(value: unknown): value is ReasoningLevel {
  return value === 'minimal' || value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh';
}

export interface ModelReasoningConfig {
  reasoning?: ReasoningLevel;
  reasoningByModel?: Readonly<Record<string, ReasoningLevel>>;
}

export function reasoningForModel(model: string, config: ModelReasoningConfig): ReasoningLevel | undefined {
  return config.reasoningByModel?.[model] ?? config.reasoning;
}

export function validateModelExecution(
  models: readonly string[],
  config: ModelReasoningConfig & { apiKeys?: Readonly<Record<string, string>> },
): void {
  for (const model of models) validateReasoning(parseSpec(model), reasoningForModel(model, config));
  if (!config.apiKeys) return;
  for (const model of models) {
    if (model !== 'random' && config.apiKeys[model] === undefined)
      throw new Error(`API key missing for ${model}; this run cannot use environment keys`);
  }
}

const USAGE =
  'Usage: openrouter:<model-id>, prime:<model-id>, gateway:<model-id>, opencode-go:<model-id>, opencode-zen:<model-id>, or random';
interface ProviderSpec {
  provider: 'openrouter' | 'prime' | 'gateway' | 'opencode-go' | 'opencode-zen' | 'random';
  model: string;
}

export function parseSpec(value: string): ProviderSpec {
  if (value === 'random') return { provider: 'random', model: 'random' };
  for (const provider of ['openrouter', 'prime', 'gateway', 'opencode-go', 'opencode-zen'] as const) {
    const prefix = `${provider}:`;
    if (!value.startsWith(prefix)) continue;
    const model = value.slice(prefix.length);
    if (model && !model.startsWith('-') && !/[\s\p{Cc}]/u.test(model)) return { provider, model };
    break;
  }
  throw new Error(USAGE);
}

export function validateReasoning(spec: ProviderSpec, level?: ReasoningLevel): void {
  if (!level) return;
  if (!isReasoningLevel(level)) throw new Error(`invalid reasoning level ${JSON.stringify(level)}`);
  if (spec.provider === 'random') return;
  if (spec.provider !== 'openrouter') {
    throw new Error(`${spec.provider}:${spec.model} has no advertised configurable reasoning levels`);
  }
}

function parseToolArguments(value: unknown): JsonObject {
  if (isRecord(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Providers reject a round that answers one call id twice, and some models do repeat an id across
 * the tool calls in a single response. Collapsing to the first occurrence is the only reply that
 * stays valid: an invented id for the duplicate is rejected just as hard as the duplicate itself. */
export function uniqueToolCalls(calls: ToolCall[]): ToolCall[] {
  const byId = new Map<string, ToolCall>();
  calls.forEach((call, index) => {
    const id = call.id || `call_${index}`;
    if (!byId.has(id)) byId.set(id, { ...call, id });
  });
  return [...byId.values()];
}

export function assistantToolMessage(completion: Completion): ProviderMessage {
  return {
    role: 'assistant',
    content: completion.text || null,
    toolCalls: uniqueToolCalls(completion.toolCalls),
    ...(completion.responseMessages?.length ? { raw: completion.responseMessages } : {}),
  };
}

export function toolResultMessage(callId: string, content: string): ProviderMessage {
  return { role: 'tool', toolCallId: callId, content };
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const HARD_QUOTA_ERROR =
  /(?:insufficient[_ -]?quota|exceeded your current quota|free[_ -]?tier[_ -]?requests|requests?[_ -]?per[_ -]?day|generateRequestsPerDay|credit balance|billing quota)/i;

/** A 429 says nothing useful on its own. Providers name the limit they hit and often how long to wait,
 * so both are pulled out of the error body: without them a pause loop polls a wall it cannot see. */
function limitDetail(message: string): string {
  const quota = /"quotaId"\s*:\s*"([^"]+)"/.exec(message)?.[1] ?? /"quotaMetric"\s*:\s*"([^"]+)"/.exec(message)?.[1];
  if (quota) return quota.split('/').pop() ?? quota;
  return /\b(requests?|tokens?|input tokens?|output tokens?)[ _-]per[ _-](minute|hour|day)\b/i.exec(message)?.[0] ?? '';
}

function retryAfterMs(message: string): number | undefined {
  const seconds =
    /"retryDelay"\s*:\s*"([\d.]+)s"/.exec(message)?.[1] ??
    /\btry again in ([\d.]+)\s*s(?:econds?)?\b/i.exec(message)?.[1] ??
    /\bretry[- ]after:?\s*([\d.]+)\b/i.exec(message)?.[1];
  if (seconds === undefined) return undefined;
  const parsed = Number(seconds);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed * 1000) : undefined;
}

function rateLimited(label: string, message: string): ProviderFailure {
  const detail = limitDetail(message);
  const wait = retryAfterMs(message);
  return {
    kind: 'rate_limit',
    summary: `${label} API rate limit was reached (429${detail ? `; ${detail}` : ''}).`,
    terminal: false,
    pausable: true,
    ...(wait === undefined ? {} : { retryAfterMs: wait }),
  };
}

export function classifyProviderFailure(error: unknown, spec = 'provider'): ProviderFailure {
  const message = error instanceof Error ? error.message : String(error);
  const status = error instanceof ApiError ? error.status : Number(/\b([45]\d\d)\b/.exec(message)?.[1] ?? 0);
  const provider = spec.split(':', 1)[0] || 'provider';
  const label =
    (
      {
        openrouter: 'OpenRouter',
        prime: 'Prime Inference',
        gateway: 'Vercel AI Gateway',
        'opencode-go': 'OpenCode Go',
        'opencode-zen': 'OpenCode Zen',
      } as Record<string, string>
    )[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1);
  const suffix = status ? ` (${status})` : '';
  if (
    /Connect error (?:unauthenticated|unavailable|resource[_ -]?exhausted|internal|aborted|deadline[_ -]?exceeded)/i.test(
      message,
    )
  ) {
    return {
      kind: 'upstream',
      summary: `${label} transport failed transiently.`,
      terminal: false,
      pausable: true,
    };
  }
  if (/Upstream request failed|Inference is temporarily unavailable/i.test(message)) {
    return {
      kind: 'upstream',
      summary: `${label} API is temporarily unavailable${suffix}.`,
      terminal: false,
      pausable: true,
    };
  }
  if (status === 429 && /per[_ -]?minute/i.test(message)) {
    return rateLimited(label, message);
  }
  if (HARD_QUOTA_ERROR.test(message)) {
    const quotaId = /"quotaId"\s*:\s*"([^"]+)"/.exec(message)?.[1];
    return {
      kind: 'quota',
      summary: `${label} API quota is exhausted${quotaId ? ` (${status || 429}; ${quotaId})` : suffix}.`,
      terminal: true,
      pausable: true,
    };
  }
  if ((status === 0 || status === 408) && /(?:timed? ?out|timeout|time exhausted)/i.test(message)) {
    return { kind: 'timeout', summary: `${label} API request timed out.`, terminal: false, pausable: true };
  }
  if (status === 0 && /^reasoning exhausted the \d+-token response budget$/i.test(message.trim())) {
    return {
      kind: 'truncation',
      summary: `${label} API spent the whole response budget on reasoning and returned no answer.`,
      terminal: false,
    };
  }
  if (
    /^provider stopped the response for length after \d+ output tokens, below the requested \d+-token cap(?: before a choice was submitted)?$/i.test(
      message.trim(),
    )
  ) {
    return {
      kind: 'truncation',
      summary: `${label} API stopped the response for length below the requested output cap.`,
      terminal: false,
    };
  }
  if (status === 0 && /^empty response$/i.test(message.trim())) {
    return {
      kind: 'upstream',
      summary: `${label} API returned no usable response.`,
      terminal: true,
      retryable: true,
      pausable: true,
    };
  }
  if (status === 0 && error instanceof ApiError) {
    return { kind: 'network', summary: `${label} API could not be reached.`, terminal: false, pausable: true };
  }
  if (status === 200) {
    return {
      kind: 'upstream',
      summary: `${label} API returned an unusable 200 response.`,
      terminal: false,
      pausable: true,
    };
  }
  if (status === 409 || status === 425) {
    return {
      kind: 'upstream',
      summary: `${label} API request was temporarily blocked (${status}).`,
      terminal: false,
      pausable: true,
    };
  }
  if (status === 429) {
    return rateLimited(label, message);
  }
  if (status === 402) {
    return {
      kind: 'quota',
      summary: `${label} API credits are exhausted (402).`,
      terminal: true,
      pausable: true,
    };
  }
  if (error instanceof TypeError) {
    return { kind: 'network', summary: `${label} API could not be reached.`, terminal: false, pausable: true };
  }
  if (status >= 500 && status !== 501 && status !== 505) {
    return {
      kind: 'upstream',
      summary: `${label} API is temporarily unavailable (${status}).`,
      terminal: false,
      pausable: true,
    };
  }
  if (status === 401 || status === 403) {
    return { kind: 'request', summary: `${label} API rejected the credentials${suffix}.`, terminal: true };
  }
  if (status === 404) {
    return { kind: 'request', summary: `${label} model or endpoint was not found (404).`, terminal: true };
  }
  return { kind: 'request', summary: `${label} API request failed${suffix}.`, terminal: true };
}

function openRouterErrorStatus(responseBody: string | undefined): number | undefined {
  if (!responseBody) return undefined;
  try {
    const body: unknown = JSON.parse(responseBody);
    if (!isRecord(body) || !isRecord(body.error)) return undefined;
    const code = typeof body.error.code === 'string' ? Number(body.error.code) : body.error.code;
    return Number.isInteger(code) && Number(code) >= 400 && Number(code) <= 599 ? Number(code) : undefined;
  } catch {
    return undefined;
  }
}

const DEFAULT_TIMEOUT = 120;

interface GatewayResponseMeta {
  cost?: number;
  provider?: string;
}

/** OpenRouter may choose among upstream stacks, but never silently falls back after making that choice. */
export function parseRoutingPreferences(env: NodeJS.ProcessEnv = process.env): JsonObject {
  const pinned = env.VGC_OPENROUTER_PIN?.trim();
  if (!pinned) return { allow_fallbacks: false };
  if (pinned.includes(',')) throw new Error('VGC_OPENROUTER_PIN accepts exactly one upstream provider');
  return { order: [pinned], allow_fallbacks: false };
}

function openRouterFetch(base: typeof fetch | undefined, routing: JsonObject): typeof fetch {
  const inner = base ?? fetch;
  return async (input, init) => {
    let request = init;
    if (typeof request?.body === 'string') {
      try {
        const body = JSON.parse(request.body) as JsonObject;
        body.usage = { include: true };
        body.provider = routing;
        request = { ...request, body: JSON.stringify(body) };
      } catch {}
    }
    return inner(input, request);
  };
}

function collectGatewayMeta(payload: unknown, meta: GatewayResponseMeta): void {
  if (!isRecord(payload)) return;
  if (typeof payload.provider === 'string' && payload.provider) meta.provider = payload.provider;
  if (isRecord(payload.usage) && typeof payload.usage.cost === 'number') meta.cost = payload.usage.cost;
}

function gatewayMetadata(meta: GatewayResponseMeta) {
  return Object.keys(meta).length ? { openrouter: { ...meta } } : undefined;
}

/** Uses the compatible provider's parsed chunks instead of implementing a second SSE parser. */
const OPENROUTER_METADATA: MetadataExtractor = {
  async extractMetadata({ parsedBody }) {
    const meta: GatewayResponseMeta = {};
    collectGatewayMeta(parsedBody, meta);
    return gatewayMetadata(meta);
  },
  createStreamExtractor() {
    const meta: GatewayResponseMeta = {};
    return {
      processChunk(chunk) {
        collectGatewayMeta(chunk, meta);
      },
      buildMetadata() {
        return gatewayMetadata(meta);
      },
    };
  },
};

export function nitroSpec(spec: string): string {
  if (!spec.startsWith('openrouter:')) return spec;
  if (/:(?:nitro|floor|free)$/.test(spec)) return spec;
  return `${spec}:nitro`;
}

function convertMessages(messages: ProviderMessage[]): ModelMessage[] {
  const converted: ModelMessage[] = [];
  const callNames = new Map<string, string>();
  for (const message of messages) {
    if (message.role === 'tool') {
      converted.push({
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: message.toolCallId ?? '',
            toolName: callNames.get(message.toolCallId ?? '') ?? message.name ?? '',
            output: { type: 'text', value: message.content ?? '' },
          },
        ],
      });
    } else if (message.role === 'assistant' && message.toolCalls?.length) {
      for (const call of message.toolCalls) callNames.set(call.id, call.name);
      if (message.raw?.length) {
        converted.push(...(message.raw as unknown as ModelMessage[]));
        continue;
      }
      converted.push({
        role: 'assistant',
        content: [
          ...(message.content ? [{ type: 'text' as const, text: message.content }] : []),
          ...message.toolCalls.map((call) => ({
            type: 'tool-call' as const,
            toolCallId: call.id,
            toolName: call.name,
            input: call.arguments,
            ...(call.providerMetadata
              ? { providerOptions: call.providerMetadata as NonNullable<ToolCallPart['providerOptions']> }
              : {}),
          })),
        ],
      });
    } else {
      converted.push({ role: message.role, content: message.content ?? '' });
    }
  }
  return converted;
}

class SdkProvider implements Provider {
  readonly model: string;
  readonly reasoning?: ReasoningLevel | undefined;
  private readonly apiKey: string | undefined;
  private readonly fetch: typeof fetch | undefined;

  constructor(
    private readonly spec: ProviderSpec,
    options: { apiKey?: string | undefined; reasoning?: ReasoningLevel | undefined; fetch?: typeof fetch | undefined },
  ) {
    this.model = spec.model;
    this.reasoning = options.reasoning;
    this.apiKey = options.apiKey;
    this.fetch =
      spec.provider === 'openrouter' ? openRouterFetch(options.fetch, parseRoutingPreferences()) : options.fetch;
  }

  private key(): string {
    const envKey = providerOption(this.spec.provider)?.envKey;
    if (!envKey) throw new Error(USAGE);
    const apiKey = this.apiKey ?? process.env[envKey];
    if (!apiKey) throw new Error(`Missing ${envKey}`);
    return apiKey;
  }

  private languageModel(apiKey: string): LanguageModel {
    const option = providerOption(this.spec.provider);
    if (!option?.baseUrl) throw new Error(USAGE);
    return createOpenAICompatible({
      name: this.spec.provider,
      baseURL: option.baseUrl,
      apiKey,
      ...(this.fetch ? { fetch: this.fetch } : {}),
      ...(this.spec.provider === 'openrouter' ? { metadataExtractor: OPENROUTER_METADATA } : {}),
    })(this.model);
  }

  private secrets(apiKey: string): string[] {
    return [
      apiKey,
      process.env.OPENROUTER_API_KEY ?? '',
      process.env.PRIME_API_KEY ?? '',
      process.env.AI_GATEWAY_API_KEY ?? '',
      process.env.OPENCODE_API_KEY ?? '',
    ];
  }

  private redactedError(error: unknown, secrets: readonly string[]): Error {
    let detail: string;
    if (error instanceof Error) detail = error.message;
    else if (isRecord(error)) {
      try {
        detail = JSON.stringify(error);
      } catch {
        detail = 'provider transport failed';
      }
    } else detail = String(error);
    const message = redactSecrets(detail, secrets) || 'provider transport failed';
    if (error instanceof ApiError) return new ApiError(error.status, message);
    if (error instanceof TypeError) return new TypeError(message);
    if (isRecord(error)) {
      const status = typeof error.code === 'number' ? error.code : typeof error.status === 'number' ? error.status : 0;
      return new ApiError(status, message);
    }
    return new Error(message);
  }

  async complete(system: string, messages: ProviderMessage[], options: CompleteOptions = {}): Promise<Completion> {
    const seconds = options.timeout ?? DEFAULT_TIMEOUT;
    const timeout = AbortSignal.timeout(Math.max(100, Math.round(seconds * 1000)));
    const abortSignal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
    const apiKey = this.key();
    const secrets = this.secrets(apiKey);
    try {
      const model = this.languageModel(apiKey);
      const tools: ToolSet | undefined = options.tools?.length
        ? (Object.fromEntries(
            options.tools.map((definition) => [
              definition.name,
              tool({
                description: definition.description,
                inputSchema: jsonSchema(definition.parameters as JSONSchema7),
              }),
            ]),
          ) as ToolSet)
        : undefined;
      /** streamText reports stream failures through onError rather than rejecting, so rethrow the first
       * captured error after consumption and preserve the normal retry/failure evidence path. */
      let streamError: unknown;
      const stream = streamText({
        model,
        system,
        messages: convertMessages(messages),
        ...(tools ? { tools } : {}),
        ...(tools && options.toolChoice ? { toolChoice: options.toolChoice } : {}),
        maxOutputTokens: options.maxTokens ?? 1200,
        temperature: options.temperature ?? 0.2,
        ...(this.reasoning && !options.reasoningMaxTokens ? { reasoning: this.reasoning } : {}),
        ...(options.reasoningMaxTokens
          ? {
              providerOptions: {
                [this.spec.provider]: { reasoning: { max_tokens: options.reasoningMaxTokens } },
              },
            }
          : {}),
        maxRetries: 0,
        abortSignal,
        onError: ({ error }) => {
          if (streamError === undefined) streamError = error;
        },
      });
      await stream.consumeStream();
      if (streamError !== undefined) throw streamError;
      abortSignal.throwIfAborted();
      const [text, finishReason, usage, streamToolCalls, rawReasoningText, response, providerMetadata] =
        await Promise.all([
          stream.text,
          stream.finishReason,
          stream.usage,
          stream.toolCalls,
          stream.reasoningText,
          stream.response,
          stream.providerMetadata,
        ]);
      const debugTarget = process.env.VGC_DEBUG_PROVIDER_ERRORS;
      if (debugTarget && !text.trim() && streamToolCalls.length === 0) {
        let raw = '(unavailable)';
        try {
          raw = JSON.stringify((response as { body?: unknown }).body ?? null).slice(0, 2000);
        } catch {}
        raw = redactSecrets(raw, secrets);
        const line = redactSecrets(
          `[provider-debug] ${this.spec.provider}:${this.model} empty-response ` +
            `finish=${finishReason} usage=${JSON.stringify(usage)} response=${raw}`,
          secrets,
        );
        if (debugTarget === '1') console.error(line);
        else appendFileSync(debugTarget, `${line}\n`);
      }
      const reasoningText = rawReasoningText?.trim() ?? '';
      const reasoningTokens = usage.outputTokenDetails?.reasoningTokens ?? 0;
      const gateway = isRecord(providerMetadata?.openrouter) ? providerMetadata.openrouter : undefined;
      return {
        text,
        finishReason,
        usage: {
          input_tokens: usage.inputTokens ?? 0,
          output_tokens: usage.outputTokens ?? 0,
          ...(reasoningTokens > 0 ? { reasoning_tokens: reasoningTokens } : {}),
          ...((usage.inputTokenDetails?.cacheReadTokens ?? 0) > 0
            ? { cached_input_tokens: usage.inputTokenDetails?.cacheReadTokens as number }
            : {}),
          ...(typeof gateway?.cost === 'number' ? { cost: gateway.cost } : {}),
        },
        ...(typeof gateway?.provider === 'string' && gateway.provider ? { provider: gateway.provider } : {}),
        toolCalls: streamToolCalls.map((call) => ({
          id: call.toolCallId,
          name: call.toolName,
          arguments: parseToolArguments(call.input),
          ...(call.providerMetadata ? { providerMetadata: call.providerMetadata as JsonObject } : {}),
        })),
        ...(reasoningText ? { reasoning: reasoningText } : {}),
        ...(response.messages.length ? { responseMessages: response.messages as unknown as JsonObject[] } : {}),
      };
    } catch (error) {
      if (options.signal?.aborted) throw error;
      if (timeout.aborted)
        throw new ApiError(0, `request to ${this.spec.provider}:${this.model} timed out after ${seconds}s`);
      if (APICallError.isInstance(error)) {
        const detail = redactSecrets(error.responseBody ?? error.message, secrets);
        const inBandStatus =
          this.spec.provider === 'openrouter' ? openRouterErrorStatus(error.responseBody) : undefined;
        const status = inBandStatus ?? error.statusCode ?? 0;
        const debugTarget = process.env.VGC_DEBUG_PROVIDER_ERRORS;
        if (debugTarget) {
          const body = error.requestBodyValues === undefined ? undefined : JSON.stringify(error.requestBodyValues);
          const line = redactSecrets(
            `[provider-debug] ${this.spec.provider}:${this.model} ${status} request=${body ?? '(unavailable)'}`,
            secrets,
          );
          if (debugTarget === '1') console.error(line);
          else appendFileSync(debugTarget, `${line}\n`);
        }
        throw new ApiError(status, `${this.spec.provider}:${this.model} ${status}: ${detail}`);
      }
      throw this.redactedError(error, secrets);
    }
  }
}

export function makeProvider(
  spec: ProviderSpec,
  options: {
    apiKey?: string | undefined;
    reasoning?: ReasoningLevel | undefined;
    fetch?: typeof fetch | undefined;
  } = {},
): Provider {
  validateReasoning(spec, options.reasoning);
  if (spec.provider === 'random') throw new Error('random provider is handled separately');
  return new SdkProvider(spec, options);
}
