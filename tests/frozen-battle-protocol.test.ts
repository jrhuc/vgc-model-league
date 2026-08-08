import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FROZEN_BATTLE_JSONL_PROTOCOL_VERSION,
  FrozenBattleProtocolSession,
  type FrozenBattleProtocolSnapshot,
} from '../src/frozen-battle-protocol.js';
import { showdownCommit } from '../src/showdown.js';
import { loadPool } from '../src/teams.js';
import type { JsonObject } from '../src/types.js';

const pool = loadPool();
const CONDITION_DIGEST = 'a'.repeat(64);
const options = {
  format: pool.format,
  seed: [11, 22, 33, 44],
  seats: [
    { pid: 'p1', name: 'same-model', packedTeam: pool.teams[0]!.packed },
    { pid: 'p2', name: 'same-model', packedTeam: pool.teams[1]!.packed },
  ],
};

function call(
  session: FrozenBattleProtocolSession,
  id: number,
  method: string,
  params: Record<string, unknown> = {},
): JsonObject {
  const response = session.handle({ protocolVersion: FROZEN_BATTLE_JSONL_PROTOCOL_VERSION, id, method, params });
  assert.equal(response.id, id);
  assert.equal(response.ok, true, JSON.stringify(response.error));
  assert.ok(response.result && typeof response.result === 'object');
  return response.result as JsonObject;
}

function start(session: FrozenBattleProtocolSession): JsonObject {
  return call(session, 1, 'start', {
    episodeId: 'episode-1',
    conditionDigest: CONDITION_DIGEST,
    showdownRevision: showdownCommit(),
    options,
  });
}

function boundValue(result: JsonObject): JsonObject {
  assert.ok(result.binding && typeof result.binding === 'object');
  assert.ok(result.value && typeof result.value === 'object');
  return result.value as JsonObject;
}

test('the JSONL session fails closed on handshake and lifecycle mismatches', () => {
  const session = new FrozenBattleProtocolSession();
  assert.deepEqual(session.ready(), {
    kind: 'ready',
    protocolVersion: FROZEN_BATTLE_JSONL_PROTOCOL_VERSION,
    refereeProtocolVersion: 2,
    showdownRevision: showdownCommit(),
  });
  const beforeStart = session.handle({
    protocolVersion: FROZEN_BATTLE_JSONL_PROTOCOL_VERSION,
    id: 1,
    method: 'observe',
    params: { pid: 'p1' },
  });
  assert.equal(beforeStart.ok, false);
  assert.equal(beforeStart.error?.code, 'invalid-request');
  const mismatch = session.handle({
    protocolVersion: FROZEN_BATTLE_JSONL_PROTOCOL_VERSION,
    id: 2,
    method: 'start',
    params: { episodeId: 'episode-1', conditionDigest: CONDITION_DIGEST, showdownRevision: 'wrong', options },
  });
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.error?.message ?? '', /showdownRevision/);
  const started = start(session);
  assert.equal(boundValue(started).started, true);
  const duplicate = session.handle({
    protocolVersion: FROZEN_BATTLE_JSONL_PROTOCOL_VERSION,
    id: 3,
    method: 'start',
    params: { episodeId: 'episode-2', conditionDigest: CONDITION_DIGEST, showdownRevision: showdownCommit(), options },
  });
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.error?.message ?? '', /already active/);
});

test('the JSONL session preserves simultaneous secrecy and restorable binding', () => {
  const session = new FrozenBattleProtocolSession();
  const started = start(session);
  const binding = started.binding as JsonObject;
  assert.equal(binding.conditionDigest, CONDITION_DIGEST);
  assert.match(String(binding.configDigest), /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(binding).includes(pool.teams[0]!.packed), false);

  const p1 = boundValue(call(session, 2, 'observe', { pid: 'p1' }));
  const p2 = boundValue(call(session, 3, 'observe', { pid: 'p2' }));
  const p1Legal = boundValue(call(session, 4, 'legal_actions', { pid: 'p1' }));
  const p2Legal = boundValue(call(session, 5, 'legal_actions', { pid: 'p2' }));
  const p1Command = ((p1Legal.actions as JsonObject[])[0]?.command as string | undefined) ?? '';
  const p2Command = ((p2Legal.actions as JsonObject[])[0]?.command as string | undefined) ?? '';
  assert.ok(p1Command && p2Command);
  const staged = boundValue(
    call(session, 6, 'submit', {
      pid: 'p1',
      command: p1Command,
      expectedRevision: p1.revision,
      expectedStateHash: p1.stateHash,
    }),
  );
  assert.equal(staged.advanced, false);
  const p2After = call(session, 7, 'observe', { pid: 'p2' });
  assert.equal(JSON.stringify(p2After).includes(p1Command), false);

  const saved = call(session, 8, 'snapshot') as unknown as FrozenBattleProtocolSnapshot;
  assert.match(saved.sha256, /^[0-9a-f]{64}$/);
  const tampered = structuredClone(saved);
  tampered.binding.episodeId = 'another-episode';
  const refused = new FrozenBattleProtocolSession().handle({
    protocolVersion: FROZEN_BATTLE_JSONL_PROTOCOL_VERSION,
    id: 9,
    method: 'restore',
    params: { snapshot: tampered },
  });
  assert.equal(refused.ok, false);
  assert.match(refused.error?.message ?? '', /digest/);

  const restored = new FrozenBattleProtocolSession();
  const restoredResult = call(restored, 10, 'restore', { snapshot: saved });
  assert.equal(boundValue(restoredResult).restored, true);
  const restoredP2 = boundValue(call(restored, 11, 'observe', { pid: 'p2' }));
  const advanced = boundValue(
    call(restored, 12, 'submit', {
      pid: 'p2',
      command: p2Command,
      expectedRevision: restoredP2.revision,
      expectedStateHash: restoredP2.stateHash,
    }),
  );
  assert.equal(advanced.advanced, true);
  assert.equal(advanced.revision, Number(p2.revision) + 1);
});
