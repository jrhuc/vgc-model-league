import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalJsonDigest } from '../src/eval/serialization.js';
import {
  FROZEN_MATCHDAY_JSONL_PROTOCOL_VERSION,
  type FrozenMatchdayProtocolResponse,
  FrozenMatchdayProtocolSession,
  type FrozenMatchdayProtocolSnapshot,
} from '../src/frozen-matchday-protocol.js';
import { FROZEN_MATCHDAY_REFEREE_PROTOCOL_VERSION } from '../src/frozen-matchday-referee.js';
import { showdownCommit } from '../src/showdown.js';
import { frozenMatchdayOptions } from './fixtures/frozen-matchday.js';

const CONDITION = 'a'.repeat(64);

type Bound<T> = { binding: { configDigest: string; conditionDigest: string }; value: T };

function request(
  session: FrozenMatchdayProtocolSession,
  id: number,
  method: string,
  params: Record<string, unknown> = {},
): FrozenMatchdayProtocolResponse {
  return session.handle({ protocolVersion: FROZEN_MATCHDAY_JSONL_PROTOCOL_VERSION, id, method, params });
}

function result<T>(response: FrozenMatchdayProtocolResponse): T {
  assert.equal(response.ok, true, JSON.stringify(response.error));
  return response.result as T;
}

test('matchday protocol binds start, observation, actions, and snapshots', () => {
  const session = new FrozenMatchdayProtocolSession();
  assert.deepEqual(session.ready(), {
    kind: 'ready',
    protocolVersion: FROZEN_MATCHDAY_JSONL_PROTOCOL_VERSION,
    matchdayProtocolVersion: FROZEN_MATCHDAY_REFEREE_PROTOCOL_VERSION,
    battleProtocolVersion: 2,
    showdownRevision: showdownCommit(),
  });
  assert.equal(request(session, 0, 'observe', { pid: 'p1' }).ok, false);

  const started = result<Bound<{ started: boolean; revision: number; stateHash: string }>>(
    request(session, 1, 'start', {
      episodeId: 'episode-1',
      conditionDigest: CONDITION,
      showdownRevision: showdownCommit(),
      options: frozenMatchdayOptions(),
    }),
  );
  assert.equal(started.value.started, true);
  assert.equal(started.binding.conditionDigest, CONDITION);
  assert.match(started.binding.configDigest, /^[0-9a-f]{64}$/);

  const p1 = result<Bound<{ revision: number; stateHash: string; battle: { request: { teamPreview?: boolean } } }>>(
    request(session, 2, 'observe', { pid: 'p1' }),
  );
  const p2 = result<Bound<{ revision: number; stateHash: string }>>(request(session, 3, 'observe', { pid: 'p2' }));
  assert.equal(p1.value.battle.request.teamPreview, true);
  const staged = result<Bound<{ advanced: boolean }>>(
    request(session, 4, 'submit', {
      pid: 'p1',
      command: 'team 1234',
      expectedRevision: p1.value.revision,
      expectedStateHash: p1.value.stateHash,
    }),
  );
  assert.equal(staged.value.advanced, false);
  const advanced = result<Bound<{ advanced: boolean; gameNumber: number }>>(
    request(session, 5, 'submit', {
      pid: 'p2',
      command: 'team 4321',
      expectedRevision: p2.value.revision,
      expectedStateHash: p2.value.stateHash,
    }),
  );
  assert.equal(advanced.value.advanced, true);
  assert.equal(advanced.value.gameNumber, 1);

  const snapshot = result<FrozenMatchdayProtocolSnapshot>(request(session, 6, 'snapshot'));
  assert.equal(snapshot.binding.configDigest, started.binding.configDigest);
  assert.equal(
    canonicalJsonDigest({
      protocolVersion: snapshot.protocolVersion,
      binding: snapshot.binding,
      referee: snapshot.referee,
    }),
    snapshot.sha256,
  );
});

test('matchday protocol restores a bound snapshot and rejects recomputed semantic tampering', () => {
  const source = new FrozenMatchdayProtocolSession();
  result(
    request(source, 1, 'start', {
      episodeId: 'episode-restore',
      conditionDigest: CONDITION,
      showdownRevision: showdownCommit(),
      options: frozenMatchdayOptions(),
    }),
  );
  const snapshot = result<FrozenMatchdayProtocolSnapshot>(request(source, 2, 'snapshot'));
  const restored = new FrozenMatchdayProtocolSession();
  const response = result<Bound<{ restored: boolean }>>(request(restored, 3, 'restore', { snapshot }));
  assert.equal(response.value.restored, true);
  assert.equal(response.binding.configDigest, snapshot.binding.configDigest);

  const tampered = structuredClone(snapshot);
  tampered.referee.score.p1 = 1;
  tampered.referee.sha256 = canonicalJsonDigest((({ sha256: _inner, ...body }) => body)(tampered.referee));
  tampered.sha256 = canonicalJsonDigest({
    protocolVersion: tampered.protocolVersion,
    binding: tampered.binding,
    referee: tampered.referee,
  });
  const rejected = request(new FrozenMatchdayProtocolSession(), 4, 'restore', { snapshot: tampered });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error?.message ?? '', /score|state hash|phase/i);
});

test('matchday protocol fails closed on revision, lifecycle, revision pin, and notebook shape', () => {
  const session = new FrozenMatchdayProtocolSession();
  const wrongRevision = request(session, 1, 'start', {
    episodeId: 'episode-bad',
    conditionDigest: CONDITION,
    showdownRevision: 'wrong',
    options: frozenMatchdayOptions(),
  });
  assert.equal(wrongRevision.ok, false);

  result(
    request(session, 2, 'start', {
      episodeId: 'episode-good',
      conditionDigest: CONDITION,
      showdownRevision: showdownCommit(),
      options: frozenMatchdayOptions(),
    }),
  );
  assert.equal(request(session, 3, 'start', {}).ok, false);
  assert.equal(
    request(session, 4, 'ready_next_game', {
      pid: 'p1',
      notebookReplacement: 3,
      expectedRevision: 0,
      expectedStateHash: 'x',
    }).ok,
    false,
  );
  assert.equal(session.handle({ protocolVersion: 999, id: 5, method: 'observe', params: {} }).ok, false);
});
