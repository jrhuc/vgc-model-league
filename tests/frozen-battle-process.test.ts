import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';

import { FROZEN_BATTLE_JSONL_PROTOCOL_VERSION } from '../src/frozen-battle-protocol.js';
import { REPO_ROOT } from '../src/paths.js';
import { showdownCommit } from '../src/showdown.js';
import { loadPool } from '../src/teams.js';
import type { JsonObject } from '../src/types.js';

const REFEREE = path.join(REPO_ROOT, 'dist', 'tools', 'frozen-battle-referee.js');
const pool = loadPool();

/** Drives the compiled referee as the external process a verifiers runtime opens, so the stdio
 * framing and handshake are exercised rather than only the in-process session object. */
class RefereeProcess {
  private readonly child = spawn(process.execPath, [REFEREE], { stdio: ['pipe', 'pipe', 'pipe'] });
  private readonly lines: string[] = [];
  private waiting: ((line: string) => void) | undefined;
  private buffer = '';
  readonly stderr: string[] = [];

  constructor() {
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      let index = this.buffer.indexOf('\n');
      while (index >= 0) {
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        if (this.waiting) {
          const resolve = this.waiting;
          this.waiting = undefined;
          resolve(line);
        } else {
          this.lines.push(line);
        }
        index = this.buffer.indexOf('\n');
      }
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => this.stderr.push(chunk));
  }

  private next(): Promise<string> {
    const buffered = this.lines.shift();
    if (buffered !== undefined) return Promise.resolve(buffered);
    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }

  async read(): Promise<JsonObject> {
    const line = await this.next();
    return JSON.parse(line) as JsonObject;
  }

  async send(request: unknown): Promise<JsonObject> {
    return this.sendRaw(JSON.stringify(request));
  }

  async sendRaw(line: string): Promise<JsonObject> {
    this.child.stdin.write(`${line}\n`);
    return this.read();
  }

  async call(id: number, method: string, params: Record<string, unknown> = {}): Promise<JsonObject> {
    return this.send({ protocolVersion: FROZEN_BATTLE_JSONL_PROTOCOL_VERSION, id, method, params });
  }

  close(): void {
    this.child.stdin.end();
    this.child.kill();
  }
}

function options() {
  return {
    format: pool.format,
    seed: [5, 6, 7, 8],
    seats: [
      { pid: 'p1', name: 'seat-a', packedTeam: pool.teams[0]!.packed },
      { pid: 'p2', name: 'seat-b', packedTeam: pool.teams[1]!.packed },
    ],
  };
}

function ok(response: JsonObject): unknown {
  assert.equal(response.ok, true, JSON.stringify(response.error));
  const result = response.result as JsonObject;
  assert.ok(result.binding && typeof result.binding === 'object');
  return result.value;
}

function okObject(response: JsonObject): JsonObject {
  const value = ok(response);
  assert.ok(value && typeof value === 'object');
  return value as JsonObject;
}

test('the referee process announces its handshake and plays an episode over stdio', async (t) => {
  const referee = new RefereeProcess();
  t.after(() => referee.close());

  const ready = await referee.read();
  assert.equal(ready.kind, 'ready');
  assert.equal(ready.protocolVersion, FROZEN_BATTLE_JSONL_PROTOCOL_VERSION);
  assert.equal(ready.showdownRevision, showdownCommit());

  okObject(
    await referee.call(1, 'start', {
      episodeId: 'process-episode',
      conditionDigest: 'b'.repeat(64),
      showdownRevision: showdownCommit(),
      options: options(),
    }),
  );

  for (let decision = 0; decision < 60; decision += 1) {
    const terminal = ok(await referee.call(100 + decision, 'terminal'));
    if (terminal) {
      const evidence = terminal as JsonObject;
      assert.equal(evidence.format, pool.format);
      assert.ok(Array.isArray(evidence.authoritativeLog));
      assert.ok((evidence.submittedActions as unknown[]).length > 0);
      assert.equal(referee.stderr.join(''), '');
      return;
    }
    let submitted = 0;
    for (const pid of ['p1', 'p2'] as const) {
      const observation = okObject(await referee.call(200 + decision * 2, 'observe', { pid }));
      const request = observation.request as JsonObject | null;
      if (!request || request.wait) continue;
      const legal = okObject(await referee.call(300 + decision * 2, 'legal_actions', { pid }));
      const first = (legal.actions as JsonObject[])[0];
      assert.ok(first, `${pid} has an active request but no candidate`);
      okObject(
        await referee.call(400 + decision * 2, 'submit', {
          pid,
          command: first.command,
          expectedRevision: observation.revision,
          expectedStateHash: observation.stateHash,
        }),
      );
      submitted += 1;
    }
    assert.ok(submitted > 0, 'a nonterminal battle must have an active decision');
  }
  assert.fail('the process did not reach terminal evidence');
});

test('the referee process reports bad framing and a wrong revision without exiting', async (t) => {
  const referee = new RefereeProcess();
  t.after(() => referee.close());
  await referee.read();

  const notJson = await referee.sendRaw('{not json');
  assert.equal(notJson.ok, false);
  assert.deepEqual(notJson.error, { code: 'invalid-json', message: 'request is not valid JSON' });

  const notObject = await referee.send('a bare string');
  assert.equal(notObject.ok, false);

  const wrongProtocol = await referee.send({ protocolVersion: 999, id: 1, method: 'start', params: {} });
  assert.equal(wrongProtocol.ok, false);

  const wrongRevision = await referee.call(2, 'start', {
    episodeId: 'process-episode',
    conditionDigest: 'c'.repeat(64),
    showdownRevision: 'not-the-pinned-revision',
    options: options(),
  });
  assert.equal(wrongRevision.ok, false);

  const beforeStart = await referee.call(3, 'observe', { pid: 'p1' });
  assert.equal(beforeStart.ok, false);
});
