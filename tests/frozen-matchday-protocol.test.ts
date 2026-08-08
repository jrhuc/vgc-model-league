import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { canonicalJsonDigest } from '../src/eval/serialization.js';
import {
  FROZEN_MATCHDAY_JSONL_PROTOCOL_VERSION,
  type FrozenMatchdayProtocolBinding,
  type FrozenMatchdayProtocolResponse,
  FrozenMatchdayProtocolSession,
  type FrozenMatchdayProtocolSnapshot,
} from '../src/frozen-matchday-protocol.js';
import {
  FROZEN_MATCHDAY_REFEREE_PROTOCOL_VERSION,
  type FrozenMatchdayLegalActions,
  type FrozenMatchdayObservation,
  type FrozenMatchdaySubmissionResult,
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

function resignRefereeSnapshot(snapshot: FrozenMatchdayProtocolSnapshot['referee']): void {
  snapshot.stateHash = canonicalJsonDigest({
    protocolVersion: snapshot.protocolVersion,
    configDigest: snapshot.configDigest,
    phase: snapshot.phase,
    revision: snapshot.revision,
    gameNumber: Math.min(snapshot.completedGames.length + 1, 3),
    score: snapshot.score,
    completedGameDigests: snapshot.completedGames.map((game) => canonicalJsonDigest(game)),
    activeBattleStateHash: snapshot.activeBattle?.stateHash ?? null,
  });
  const { sha256: _digest, ...body } = snapshot;
  snapshot.sha256 = canonicalJsonDigest(body);
}

function resignProtocolSnapshot(snapshot: FrozenMatchdayProtocolSnapshot): void {
  snapshot.sha256 = canonicalJsonDigest({
    protocolVersion: snapshot.protocolVersion,
    binding: snapshot.binding,
    referee: snapshot.referee,
  });
}

function finishFirstGame(
  session: FrozenMatchdayProtocolSession,
  firstId: number,
): { nextId: number; transition: FrozenMatchdaySubmissionResult } {
  let id = firstId;
  for (let decision = 0; decision < 30; decision += 1) {
    const observations = {
      p1: result<Bound<FrozenMatchdayObservation>>(request(session, id++, 'observe', { pid: 'p1' })).value,
      p2: result<Bound<FrozenMatchdayObservation>>(request(session, id++, 'observe', { pid: 'p2' })).value,
    };
    for (const pid of ['p1', 'p2'] as const) {
      const observation = observations[pid];
      if (!observation.battle?.request || observation.battle.request.wait) continue;
      const legal = result<Bound<FrozenMatchdayLegalActions>>(request(session, id++, 'legal_actions', { pid })).value;
      const selected = legal.actions[0];
      assert.ok(selected);
      const transition = result<Bound<FrozenMatchdaySubmissionResult>>(
        request(session, id++, 'submit', {
          pid,
          command: selected.command,
          expectedRevision: observation.revision,
          expectedStateHash: observation.stateHash,
        }),
      ).value;
      if (transition.phase !== 'playing') return { nextId: id, transition };
    }
  }
  throw new Error('fixture game did not terminate');
}

test('matchday protocol binds start, observation, actions, and snapshots', () => {
  const session = new FrozenMatchdayProtocolSession();
  assert.equal(FROZEN_MATCHDAY_JSONL_PROTOCOL_VERSION, 1);
  assert.equal(FROZEN_MATCHDAY_REFEREE_PROTOCOL_VERSION, 2);
  assert.deepEqual(session.ready(), {
    kind: 'ready',
    protocolVersion: 1,
    matchdayProtocolVersion: 2,
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
  assert.equal(started.binding.matchdayProtocolVersion, 2);
  assert.equal(started.binding.battleProtocolVersion, 2);
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
  assert.equal(snapshot.protocolVersion, 1);
  assert.equal(snapshot.binding.matchdayProtocolVersion, 2);
  assert.equal(snapshot.binding.battleProtocolVersion, 2);
  assert.equal(snapshot.referee.protocolVersion, 2);
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

test('matchday protocol snapshots seat-scoped final POV delivery before and after consumption', () => {
  const source = new FrozenMatchdayProtocolSession();
  result(
    request(source, 1, 'start', {
      episodeId: 'episode-final-pov',
      conditionDigest: CONDITION,
      showdownRevision: showdownCommit(),
      options: frozenMatchdayOptions(),
    }),
  );
  const { nextId, transition } = finishFirstGame(source, 10);
  assert.equal(transition.phase, 'between-games');
  assert.equal(transition.gameNumber, 2);

  const before = result<FrozenMatchdayProtocolSnapshot>(request(source, nextId, 'snapshot'));
  assert.ok(before.referee.pendingPovLines.p1.some((line) => line.startsWith('|win|')));
  assert.ok(before.referee.pendingPovLines.p2.some((line) => line.startsWith('|win|')));
  const restoredBefore = new FrozenMatchdayProtocolSession();
  result(request(restoredBefore, 1, 'restore', { snapshot: before }));

  const sourceP1 = result<Bound<FrozenMatchdayObservation>>(
    request(source, nextId + 1, 'observe', { pid: 'p1' }),
  ).value;
  const restoredP1 = result<Bound<FrozenMatchdayObservation>>(
    request(restoredBefore, 2, 'observe', { pid: 'p1' }),
  ).value;
  assert.deepEqual(restoredP1, sourceP1);
  assert.deepEqual(sourceP1.povLines, before.referee.pendingPovLines.p1);
  assert.deepEqual(
    result<Bound<FrozenMatchdayObservation>>(request(source, nextId + 2, 'observe', { pid: 'p1' })).value.povLines,
    [],
  );
  assert.deepEqual(
    result<Bound<FrozenMatchdayObservation>>(request(source, nextId + 3, 'observe', { pid: 'p2' })).value.povLines,
    before.referee.pendingPovLines.p2,
  );

  const after = result<FrozenMatchdayProtocolSnapshot>(request(restoredBefore, 3, 'snapshot'));
  assert.deepEqual(after.referee.pendingPovLines.p1, []);
  assert.deepEqual(after.referee.pendingPovLines.p2, before.referee.pendingPovLines.p2);
  const restoredAfter = new FrozenMatchdayProtocolSession();
  result(request(restoredAfter, 4, 'restore', { snapshot: after }));
  assert.deepEqual(
    result<Bound<FrozenMatchdayObservation>>(request(restoredAfter, 5, 'observe', { pid: 'p1' })).value.povLines,
    [],
  );
  assert.deepEqual(
    result<Bound<FrozenMatchdayObservation>>(request(restoredAfter, 6, 'observe', { pid: 'p2' })).value.povLines,
    before.referee.pendingPovLines.p2,
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

test('matchday protocol rejects re-signed matchday v1 referee, binding, and configuration state', () => {
  const source = new FrozenMatchdayProtocolSession();
  result(
    request(source, 1, 'start', {
      episodeId: 'episode-stale-protocol',
      conditionDigest: CONDITION,
      showdownRevision: showdownCommit(),
      options: frozenMatchdayOptions(),
    }),
  );
  const snapshot = result<FrozenMatchdayProtocolSnapshot>(request(source, 2, 'snapshot'));

  const staleReferee = structuredClone(snapshot);
  (staleReferee.referee as unknown as { protocolVersion: number }).protocolVersion = 1;
  resignRefereeSnapshot(staleReferee.referee);
  resignProtocolSnapshot(staleReferee);
  const staleRefereeResponse = request(new FrozenMatchdayProtocolSession(), 3, 'restore', {
    snapshot: staleReferee,
  });
  assert.equal(staleRefereeResponse.ok, false);
  assert.match(staleRefereeResponse.error?.message ?? '', /snapshot protocol is not supported/);

  const staleBinding = structuredClone(snapshot);
  (staleBinding.binding as unknown as { matchdayProtocolVersion: number }).matchdayProtocolVersion = 1;
  resignProtocolSnapshot(staleBinding);
  const staleBindingResponse = request(new FrozenMatchdayProtocolSession(), 4, 'restore', {
    snapshot: staleBinding,
  });
  assert.equal(staleBindingResponse.ok, false);
  assert.match(staleBindingResponse.error?.message ?? '', /binding does not match this referee runtime/);

  const options = snapshot.referee.options;
  const staleConfigDigest = canonicalJsonDigest({
    protocolVersion: 1,
    battleProtocolVersion: 2,
    showdownRevision: snapshot.binding.showdownRevision,
    format: options.format,
    gameSeeds: options.gameSeeds.map((seed) => [...seed]),
    registrations: (['p1', 'p2'] as const).map((pid) => {
      const seat = options.seats.find((candidate) => candidate.pid === pid);
      assert.ok(seat && seat.construction.status === 'accepted');
      return {
        pid,
        name: seat.name,
        teamSha256: createHash('sha256').update(seat.construction.packed).digest('hex'),
        constructionSha256: canonicalJsonDigest(seat.construction.artifact),
      };
    }),
  });
  assert.notEqual(staleConfigDigest, snapshot.binding.configDigest);
  const staleConfig = structuredClone(snapshot);
  staleConfig.binding.configDigest = staleConfigDigest;
  staleConfig.referee.configDigest = staleConfigDigest;
  resignRefereeSnapshot(staleConfig.referee);
  resignProtocolSnapshot(staleConfig);
  const staleConfigResponse = request(new FrozenMatchdayProtocolSession(), 5, 'restore', { snapshot: staleConfig });
  assert.equal(staleConfigResponse.ok, false);
  assert.match(staleConfigResponse.error?.message ?? '', /configuration does not match its construction/);
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
