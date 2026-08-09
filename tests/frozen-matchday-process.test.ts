import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';

import { FROZEN_MATCHDAY_JSONL_PROTOCOL_VERSION } from '../src/frozen-matchday-protocol.js';
import { REPO_ROOT } from '../src/paths.js';
import type { JsonObject } from '../src/types.js';
import { frozenMatchdayOptions } from './fixtures/frozen-matchday.js';

const SHOWDOWN_REVISION = '6a1836dd71c0718e923206f3d089e61074410868';
const REFEREE = path.join(REPO_ROOT, 'dist-matchday', 'tools', 'frozen-matchday-referee.js');

class MatchdayProcess {
  private readonly child = spawn(process.execPath, [REFEREE], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, NO_COLOR: undefined },
  });
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
    return JSON.parse(await this.next()) as JsonObject;
  }

  async sendRaw(line: string): Promise<JsonObject> {
    this.child.stdin.write(`${line}\n`);
    return this.read();
  }

  call(id: number, method: string, params: Record<string, unknown> = {}): Promise<JsonObject> {
    return this.sendRaw(
      JSON.stringify({ protocolVersion: FROZEN_MATCHDAY_JSONL_PROTOCOL_VERSION, id, method, params }),
    );
  }

  close(): void {
    this.child.stdin.end();
    this.child.kill();
  }
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

test('the isolated matchday artifact runs strict construction through a native Champions Bo3', async (t) => {
  const referee = new MatchdayProcess();
  t.after(() => referee.close());

  const ready = await referee.read();
  assert.deepEqual(ready, {
    kind: 'ready',
    protocolVersion: 1,
    matchdayProtocolVersion: 1,
    battleProtocolVersion: 1,
    showdownRevision: SHOWDOWN_REVISION,
  });
  const malformed = await referee.sendRaw('{not json');
  assert.deepEqual(malformed.error, { code: 'invalid-json', message: 'request is not valid JSON' });

  okObject(
    await referee.call(1, 'start', {
      episodeId: 'matchday-process',
      conditionDigest: 'd'.repeat(64),
      showdownRevision: SHOWDOWN_REVISION,
      options: frozenMatchdayOptions(),
    }),
  );

  let id = 10;
  let completedGames = 0;
  for (let step = 0; step < 100; step += 1) {
    const terminal = ok(await referee.call(id++, 'terminal'));
    if (terminal) {
      const evidence = terminal as JsonObject;
      const finalP1 = okObject(await referee.call(id++, 'observe', { pid: 'p1' }));
      const finalP2 = okObject(await referee.call(id++, 'observe', { pid: 'p2' }));
      assert.equal(finalP1.phase, 'terminal');
      assert.equal(finalP2.phase, 'terminal');
      assert.equal(finalP1.gameNumber, 3);
      assert.equal(finalP2.gameNumber, 3);
      assert.equal(finalP1.battle, null);
      assert.equal(finalP2.battle, null);
      assert.ok((finalP1.povLines as string[]).some((line) => line.startsWith('|win|')));
      assert.ok((finalP2.povLines as string[]).some((line) => line.startsWith('|win|')));
      assert.deepEqual(okObject(await referee.call(id++, 'observe', { pid: 'p1' })).povLines, []);
      assert.deepEqual(okObject(await referee.call(id++, 'observe', { pid: 'p2' })).povLines, []);
      assert.equal(evidence.protocolVersion, 1);
      assert.equal(evidence.battleProtocolVersion, 1);
      assert.equal(evidence.showdownRevision, SHOWDOWN_REVISION);
      assert.equal(evidence.format, 'gen9championsvgc2026regmbbo3');
      assert.equal(Object.hasOwn(evidence, 'povLines'), false);
      assert.doesNotMatch(JSON.stringify(evidence), /pendingPovLines|completedGamePovCursors|povCursors/);
      assert.ok([2, 3].includes((evidence.games as unknown[]).length));
      assert.equal(referee.stderr.join(''), '');
      return;
    }
    const observations = {
      p1: okObject(await referee.call(id++, 'observe', { pid: 'p1' })),
      p2: okObject(await referee.call(id++, 'observe', { pid: 'p2' })),
    };
    const phase = observations.p1.phase;
    assert.equal(observations.p2.phase, phase);
    if (phase === 'between-games') {
      completedGames += 1;
      assert.equal(observations.p1.gameNumber, completedGames + 1);
      assert.equal(observations.p2.gameNumber, completedGames + 1);
      assert.ok((observations.p1.povLines as string[]).some((line) => line.startsWith('|win|')));
      assert.ok((observations.p2.povLines as string[]).some((line) => line.startsWith('|win|')));
      for (const pid of ['p1', 'p2'] as const) {
        const consumed = okObject(await referee.call(id++, 'observe', { pid }));
        assert.deepEqual(consumed.povLines, []);
        okObject(
          await referee.call(id++, 'ready_next_game', {
            pid,
            expectedRevision: consumed.revision,
            expectedStateHash: consumed.stateHash,
          }),
        );
      }
      continue;
    }
    assert.equal(phase, 'playing');
    let submitted = 0;
    for (const pid of ['p1', 'p2'] as const) {
      const observation = observations[pid];
      const battle = observation.battle as JsonObject | null;
      const request = battle?.request as JsonObject | null;
      if (!request || request.wait) continue;
      const legal = okObject(await referee.call(id++, 'legal_actions', { pid }));
      const first = (legal.actions as JsonObject[])[0];
      assert.ok(first);
      okObject(
        await referee.call(id++, 'submit', {
          pid,
          command: first.command,
          expectedRevision: legal.revision,
          expectedStateHash: legal.stateHash,
        }),
      );
      submitted += 1;
    }
    assert.ok(submitted > 0);
  }
  assert.fail('the matchday process did not reach terminal evidence');
});
