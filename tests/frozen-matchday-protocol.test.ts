import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FROZEN_MATCHDAY_JSONL_PROTOCOL_VERSION,
  type FrozenMatchdayProtocolBinding,
  type FrozenMatchdayProtocolResponse,
  FrozenMatchdayProtocolSession,
} from '../src/frozen-matchday-protocol.js';
import {
  FROZEN_MATCHDAY_REFEREE_PROTOCOL_VERSION,
  type FrozenMatchdayObservation,
} from '../src/frozen-matchday-referee.js';
import { showdownCommit } from '../src/showdown.js';
import { frozenMatchdayOptions } from './fixtures/frozen-matchday.js';

const CONDITION = 'a'.repeat(64);

type Bound<T> = { binding: FrozenMatchdayProtocolBinding; value: T };

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

test('matchday protocol binds the compiled start, observe, legal-action, and submit path', () => {
  const session = new FrozenMatchdayProtocolSession();
  assert.equal(FROZEN_MATCHDAY_JSONL_PROTOCOL_VERSION, 1);
  assert.equal(FROZEN_MATCHDAY_REFEREE_PROTOCOL_VERSION, 1);
  assert.deepEqual(session.ready(), {
    kind: 'ready',
    protocolVersion: 1,
    matchdayProtocolVersion: 1,
    battleProtocolVersion: 1,
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
  assert.equal(started.binding.matchdayProtocolVersion, 1);
  assert.equal(started.binding.battleProtocolVersion, 1);
  assert.equal(started.binding.conditionDigest, CONDITION);
  assert.match(started.binding.configDigest, /^[0-9a-f]{64}$/);

  const p1 = result<Bound<FrozenMatchdayObservation>>(request(session, 2, 'observe', { pid: 'p1' }));
  const p2 = result<Bound<FrozenMatchdayObservation>>(request(session, 3, 'observe', { pid: 'p2' }));
  assert.equal(p1.value.battle?.request?.teamPreview, true);
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
});

test('matchday protocol fails closed on revision, lifecycle, protocol pin, and notebook shape', () => {
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
