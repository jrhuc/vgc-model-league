import assert from 'node:assert/strict';
import test from 'node:test';

import { FROZEN_CIRCUIT_JSONL_PROTOCOL_VERSION, FrozenCircuitProtocolSession } from '../src/frozen-circuit-protocol.js';
import { showdownCommit } from '../src/showdown.js';

function startRequest(seed = 0) {
  return {
    protocolVersion: FROZEN_CIRCUIT_JSONL_PROTOCOL_VERSION,
    id: 1,
    method: 'start',
    params: {
      episodeId: 'protocol-episode',
      conditionDigest: 'a'.repeat(64),
      showdownRevision: showdownCommit(),
      options: { scenarioId: 'draft-league-v1', seed },
    },
  };
}

test('circuit JSONL session exactly binds start, pending turns, observations, and terminal calls', () => {
  const session = new FrozenCircuitProtocolSession();
  assert.deepEqual(session.ready(), {
    kind: 'ready',
    protocolVersion: 1,
    circuitProtocolVersion: 2,
    promptProtocolVersion: 2,
    matchdayProtocolVersion: 1,
    battleProtocolVersion: 1,
    showdownRevision: showdownCommit(),
    scenarios: ['victory-road-top8-v1', 'draft-league-v1'],
  });
  const start = session.handle(startRequest());
  assert.equal(start.ok, true);
  const started = start.result as { binding: Record<string, unknown>; value: Record<string, unknown> };
  assert.equal(started.binding.episodeId, 'protocol-episode');
  assert.equal(started.binding.scenarioId, 'draft-league-v1');
  assert.equal(started.binding.seed, 0);
  assert.match(String(started.binding.promptRevision), /^[0-9a-f]{16}$/u);
  assert.equal(started.value.started, true);

  const pending = session.handle({ protocolVersion: 1, id: 2, method: 'pending_turns', params: {} });
  assert.equal(pending.ok, true);
  const bound = pending.result as { binding: Record<string, unknown>; value: Array<Record<string, unknown>> };
  assert.deepEqual(bound.binding, started.binding);
  assert.equal(bound.value.length, 1);
  assert.match(String(bound.value[0]!.seatId), /^seat-[1-8]$/u);
  assert.equal(bound.value[0]!.kind, 'draft');
  assert.equal(typeof bound.value[0]!.prompt, 'string');

  const observed = session.handle({
    protocolVersion: 1,
    id: 3,
    method: 'observe',
    params: { seatId: String(bound.value[0]!.seatId) },
  });
  assert.equal(observed.ok, true);
  const terminal = session.handle({ protocolVersion: 1, id: 4, method: 'terminal', params: {} });
  assert.equal(terminal.ok, true);
  assert.equal((terminal.result as { value: unknown }).value, null);
});

test('circuit JSONL rejects malformed framing and unknown seats without mutating the active turn', () => {
  const session = new FrozenCircuitProtocolSession();
  assert.equal(session.handle(startRequest()).ok, true);
  const extra = session.handle({
    protocolVersion: 1,
    id: 2,
    method: 'pending_turns',
    params: { extra: true },
  });
  assert.equal(extra.ok, false);
  const unknown = session.handle({
    protocolVersion: 1,
    id: 3,
    method: 'observe',
    params: { seatId: 'seat-9' },
  });
  assert.equal(unknown.ok, false);
  const pending = session.handle({ protocolVersion: 1, id: 4, method: 'pending_turns', params: {} });
  assert.equal((pending.result as { value: unknown[] }).value.length, 1);
});
