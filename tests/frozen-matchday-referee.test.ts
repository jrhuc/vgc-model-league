import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { canonicalJsonDigest } from '../src/eval/serialization.js';
import { FrozenBattleReferee } from '../src/frozen-battle-referee.js';
import {
  FROZEN_MATCHDAY_REFEREE_PROTOCOL_VERSION,
  FrozenMatchdayReferee,
  FrozenMatchdayRefereeError,
  type FrozenMatchdaySubmissionResult,
} from '../src/frozen-matchday-referee.js';
import { loadShowdown } from '../src/showdown.js';
import type { Pid } from '../src/types.js';
import { frozenMatchdayOptions, MATCHDAY_SEEDS } from './fixtures/frozen-matchday.js';

const Showdown = loadShowdown();
const SEEDS = MATCHDAY_SEEDS;
const options = frozenMatchdayOptions;

function resignSnapshot(snapshot: ReturnType<FrozenMatchdayReferee['snapshot']>): void {
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
  const { sha256: _old, ...body } = snapshot;
  snapshot.sha256 = canonicalJsonDigest(body);
}

function scriptedBattle(index: number): {
  referee: FrozenBattleReferee;
  evidence: NonNullable<ReturnType<FrozenBattleReferee['terminalEvidence']>>;
} {
  const matchday = options();
  const referee = new FrozenBattleReferee({
    format: matchday.format,
    seed: matchday.gameSeeds[index]!,
    seats: matchday.seats.map((seat) => {
      assert.equal(seat.construction.status, 'accepted');
      return { pid: seat.pid, name: seat.name, packedTeam: seat.construction.packed };
    }),
  });
  for (let step = 0; step < 100 && !referee.terminalEvidence(); step += 1) {
    for (const pid of ['p1', 'p2'] as const) {
      const observation = referee.observe(pid);
      if (!observation.request || observation.request.wait) continue;
      const legal = referee.legalActions(pid).actions;
      const selected = pid === 'p1' ? legal[0] : legal.at(-1);
      assert.ok(selected);
      referee.submit(pid, selected.command, observation.revision, observation.stateHash);
    }
  }
  const evidence = referee.terminalEvidence();
  assert.ok(evidence);
  return { referee, evidence };
}

function action(referee: FrozenMatchdayReferee, pid: Pid): string {
  const legal = referee.legalActions(pid);
  assert.ok(legal.actions.length > 0);
  return legal.actions[0]!.command;
}

function advanceDecision(referee: FrozenMatchdayReferee): FrozenMatchdaySubmissionResult {
  const observations = { p1: referee.observe('p1'), p2: referee.observe('p2') };
  let latest: FrozenMatchdaySubmissionResult | undefined;
  for (const pid of ['p1', 'p2'] as const) {
    const observation = observations[pid];
    if (!observation.battle?.request || observation.battle.request.wait) continue;
    latest = referee.submit(pid, action(referee, pid), observation.revision, observation.stateHash);
  }
  assert.ok(latest);
  return latest;
}

function finishGame(referee: FrozenMatchdayReferee): FrozenMatchdaySubmissionResult {
  for (let decisions = 0; decisions < 30; decisions += 1) {
    const observation = referee.observe('p1');
    if (observation.phase !== 'playing') {
      return {
        advanced: true,
        phase: observation.phase,
        gameNumber: observation.gameNumber,
        score: observation.score,
        revision: observation.revision,
        stateHash: observation.stateHash,
        terminal: observation.terminal,
      };
    }
    const result = advanceDecision(referee);
    if (result.phase !== 'playing') return result;
  }
  throw new Error('fixture game did not terminate');
}

function finishGameWithoutObserving(
  referee: FrozenMatchdayReferee,
  p2UsesLastAction = false,
): FrozenMatchdaySubmissionResult {
  for (let decisions = 0; decisions < 30; decisions += 1) {
    for (const pid of ['p1', 'p2'] as const) {
      const legal = referee.legalActions(pid);
      const selected = pid === 'p2' && p2UsesLastAction ? legal.actions.at(-1) : legal.actions[0];
      if (!selected) continue;
      const result = referee.submit(pid, selected.command, legal.revision, legal.stateHash);
      if (result.phase !== 'playing') return result;
    }
  }
  throw new Error('fixture game did not terminate');
}

function startNextGameWithoutObserving(
  referee: FrozenMatchdayReferee,
  transition: FrozenMatchdaySubmissionResult,
): FrozenMatchdaySubmissionResult {
  const first = referee.readyNextGame('p1', {}, transition.revision, transition.stateHash);
  assert.equal(first.advanced, false);
  const second = referee.readyNextGame('p2', {}, transition.revision, transition.stateHash);
  assert.equal(second.advanced, true);
  return second;
}

function startNextGame(
  referee: FrozenMatchdayReferee,
  p1: { notebookReplacement?: string } = {},
  p2: { notebookReplacement?: string } = {},
): void {
  const observations = { p1: referee.observe('p1'), p2: referee.observe('p2') };
  const first = referee.readyNextGame('p1', p1, observations.p1.revision, observations.p1.stateHash);
  assert.equal(first.advanced, false);
  const second = referee.readyNextGame('p2', p2, observations.p2.revision, observations.p2.stateHash);
  assert.equal(second.advanced, true);
  assert.equal(second.phase, 'playing');
}

function assertMatchdayError(code: FrozenMatchdayRefereeError['code']): (error: unknown) => boolean {
  return (error) => error instanceof FrozenMatchdayRefereeError && error.code === code;
}

test('strict construction starts native Champions open-sheet bring-four preview', () => {
  const referee = new FrozenMatchdayReferee(options());
  const observation = referee.observe('p1');
  assert.equal(FROZEN_MATCHDAY_REFEREE_PROTOCOL_VERSION, 2);
  assert.equal(observation.protocolVersion, 2);
  assert.equal(observation.battleProtocolVersion, 2);
  assert.equal(referee.snapshot().protocolVersion, 2);
  assert.equal(observation.phase, 'playing');
  assert.equal(observation.gameNumber, 1);
  assert.equal(observation.battle?.request?.teamPreview, true);
  assert.equal(observation.battle?.request?.maxChosenTeamSize, 4);

  const legal = referee.legalActions('p1');
  assert.equal(legal.actions.length, 360);
  assert.ok(legal.actions.every((entry) => entry.command.startsWith('team ')));

  const sheets = observation.battle?.povLines.filter((line) => line.startsWith('|showteam|')) ?? [];
  assert.equal(sheets.length, 2);
  for (const line of sheets) {
    const packed = line.split('|').slice(3).join('|');
    for (const entry of packed.split(']').filter(Boolean)) {
      const fields = entry.split('|');
      assert.ok(fields[2], 'open sheet must include item');
      assert.ok(fields[3], 'open sheet must include ability');
      assert.ok(fields[4], 'open sheet must include moves');
      assert.ok(fields[5], 'Champions open sheet must include nature');
      assert.equal(fields[6], '', 'open sheet must exclude stat points');
      assert.equal(fields[8], '', 'open sheet must exclude IVs');
      assert.equal(fields[11] ?? '', '', 'open sheet must exclude Tera metadata');
    }
  }
});

test('Game 1 final POV is seat isolated, exactly once, and survives interval readiness without both observations', () => {
  const referee = new FrozenMatchdayReferee(options());
  const game1 = finishGame(referee);
  assert.equal(game1.phase, 'between-games');
  assert.equal(game1.gameNumber, 2);

  const queued = referee.snapshot().pendingPovLines;
  assert.ok(queued.p1.some((line) => line.startsWith('|win|')));
  assert.ok(queued.p2.some((line) => line.startsWith('|win|')));
  const p1Private = queued.p1.find((line) => line.startsWith('|-damage|p1b: Swampert|'));
  const p2View = queued.p2.find((line) => line.startsWith('|-damage|p1b: Swampert|'));
  assert.ok(p1Private);
  assert.ok(p2View);
  assert.notEqual(p1Private, p2View);
  assert.ok(!queued.p2.includes(p1Private));
  assert.ok(!queued.p1.includes(p2View));

  const p1Ready = referee.readyNextGame('p1', { notebookReplacement: 'Game 1 plan' }, game1.revision, game1.stateHash);
  assert.equal(p1Ready.advanced, false);
  const p2Ready = referee.readyNextGame('p2', {}, game1.revision, game1.stateHash);
  assert.equal(p2Ready.advanced, true);
  assert.equal(p2Ready.gameNumber, 2);
  assert.deepEqual(
    referee.seatPrivateEvidence('p1').intervals.map((receipt) => receipt.gameNumber),
    [1],
  );

  const p1 = referee.observe('p1');
  assert.equal(p1.phase, 'playing');
  assert.equal(p1.gameNumber, 2);
  assert.deepEqual(p1.povLines, queued.p1);
  assert.equal(p1.battle?.request?.teamPreview, true);
  assert.deepEqual(referee.observe('p1').povLines, []);
  assert.deepEqual(referee.observe('p2').povLines, queued.p2);
  assert.deepEqual(referee.observe('p2').povLines, []);
});

test('pending terminal POV queues restore before consumption and remain consumed afterward', () => {
  const referee = new FrozenMatchdayReferee(options());
  assert.equal(finishGame(referee).phase, 'between-games');
  const before = referee.snapshot();
  const restoredBefore = FrozenMatchdayReferee.restore(structuredClone(before));

  const originalP1 = referee.observe('p1');
  assert.deepEqual(restoredBefore.observe('p1'), originalP1);
  assert.deepEqual(restoredBefore.observe('p1').povLines, []);
  assert.deepEqual(restoredBefore.observe('p2').povLines, before.pendingPovLines.p2);

  const after = referee.snapshot();
  assert.deepEqual(after.pendingPovLines.p1, []);
  assert.deepEqual(after.pendingPovLines.p2, before.pendingPovLines.p2);
  const restoredAfter = FrozenMatchdayReferee.restore(structuredClone(after));
  assert.deepEqual(restoredAfter.observe('p1').povLines, []);
  assert.deepEqual(restoredAfter.observe('p2').povLines, before.pendingPovLines.p2);

  const mixedSeats = structuredClone(before);
  mixedSeats.pendingPovLines.p2 = [...mixedSeats.pendingPovLines.p1];
  resignSnapshot(mixedSeats);
  assert.throws(() => FrozenMatchdayReferee.restore(mixedSeats), assertMatchdayError('snapshot-protocol'));

  const shortened = structuredClone(before);
  shortened.pendingPovLines.p1 = shortened.pendingPovLines.p1.slice(1);
  resignSnapshot(shortened);
  assert.throws(() => FrozenMatchdayReferee.restore(shortened), assertMatchdayError('snapshot-protocol'));
});

test('completed-game POV cursors reject native-impossible terminal and intra-update positions', () => {
  const referee = new FrozenMatchdayReferee(options());
  assert.equal(finishGameWithoutObserving(referee).phase, 'between-games');
  const snapshot = referee.snapshot();
  assert.deepEqual(snapshot.completedGamePovCursors, [{ p1: 0, p2: 0 }]);
  assert.equal(snapshot.pendingPovLines.p1.length, 289);
  assert.match(snapshot.pendingPovLines.p1.at(-1) ?? '', /^\|win\|/);
  assert.doesNotThrow(() => FrozenMatchdayReferee.restore(structuredClone(snapshot)));

  const insideTerminalUpdate = structuredClone(snapshot);
  insideTerminalUpdate.completedGamePovCursors[0]!.p1 = 288;
  insideTerminalUpdate.pendingPovLines.p1 = insideTerminalUpdate.pendingPovLines.p1.slice(288);
  assert.equal(insideTerminalUpdate.pendingPovLines.p1.length, 1);
  assert.match(insideTerminalUpdate.pendingPovLines.p1[0]!, /^\|win\|/);
  resignSnapshot(insideTerminalUpdate);
  assert.throws(() => FrozenMatchdayReferee.restore(insideTerminalUpdate), assertMatchdayError('snapshot-protocol'));

  const afterTerminalObserve = structuredClone(snapshot);
  afterTerminalObserve.completedGamePovCursors[0]!.p1 = 289;
  afterTerminalObserve.pendingPovLines.p1 = [];
  resignSnapshot(afterTerminalObserve);
  assert.throws(() => FrozenMatchdayReferee.restore(afterTerminalObserve), assertMatchdayError('snapshot-protocol'));
});

test('completed-game POV delivery accumulates across games and restores after one-seat consumption', () => {
  const referee = new FrozenMatchdayReferee(options());
  const game1 = finishGameWithoutObserving(referee);
  assert.equal(game1.phase, 'between-games');
  const game1Lines = structuredClone(referee.snapshot().pendingPovLines);
  const game2Start = startNextGameWithoutObserving(referee, game1);
  assert.equal(game2Start.gameNumber, 2);
  const game2 = finishGameWithoutObserving(referee);
  assert.equal(game2.phase, 'between-games');
  assert.equal(game2.gameNumber, 3);

  const accumulated = referee.snapshot();
  assert.equal(accumulated.completedGames.length, 2);
  assert.deepEqual(accumulated.completedGamePovCursors, [
    { p1: 0, p2: 0 },
    { p1: 0, p2: 0 },
  ]);
  assert.ok(accumulated.pendingPovLines.p1.length > game1Lines.p1.length);
  assert.ok(accumulated.pendingPovLines.p2.length > game1Lines.p2.length);
  assert.deepEqual(accumulated.pendingPovLines.p1.slice(0, game1Lines.p1.length), game1Lines.p1);
  assert.deepEqual(accumulated.pendingPovLines.p2.slice(0, game1Lines.p2.length), game1Lines.p2);

  const delivered = referee.observe('p1');
  assert.deepEqual(delivered.povLines, accumulated.pendingPovLines.p1);
  assert.equal(delivered.revision, accumulated.revision);
  assert.equal(delivered.stateHash, accumulated.stateHash);
  const partiallyDelivered = referee.snapshot();
  assert.equal(partiallyDelivered.revision, accumulated.revision);
  assert.equal(partiallyDelivered.stateHash, accumulated.stateHash);
  assert.notEqual(partiallyDelivered.sha256, accumulated.sha256);
  assert.deepEqual(partiallyDelivered.pendingPovLines.p1, []);
  assert.deepEqual(partiallyDelivered.pendingPovLines.p2, accumulated.pendingPovLines.p2);

  const restored = FrozenMatchdayReferee.restore(structuredClone(partiallyDelivered));
  assert.deepEqual(restored.observe('p1').povLines, []);
  assert.deepEqual(restored.observe('p2').povLines, accumulated.pendingPovLines.p2);
});

test('a 2-0 terminal caps outer gameNumber at 3 while final POV is delivered without snapshot state', () => {
  const referee = new FrozenMatchdayReferee(options());
  const game1 = finishGameWithoutObserving(referee, true);
  assert.equal(game1.phase, 'between-games');
  assert.deepEqual(game1.score, { p1: 1, p2: 0, ties: 0 });
  startNextGameWithoutObserving(referee, game1);
  const game2 = finishGameWithoutObserving(referee, true);
  assert.equal(game2.phase, 'terminal');
  assert.equal(game2.gameNumber, 3);
  assert.deepEqual(game2.score, { p1: 2, p2: 0, ties: 0 });

  const p1 = referee.observe('p1');
  const p2 = referee.observe('p2');
  assert.equal(p1.gameNumber, 3);
  assert.equal(p2.gameNumber, 3);
  assert.ok(p1.povLines.some((line) => line.startsWith('|win|')));
  assert.ok(p2.povLines.some((line) => line.startsWith('|win|')));
  const terminal = referee.terminalEvidence();
  assert.ok(terminal);
  assert.equal(terminal.protocolVersion, 2);
  assert.equal(terminal.battleProtocolVersion, 2);
  assert.equal(terminal.games.length, 2);

  const forbiddenDeliveryKeys = new Set(['pendingPovLines', 'completedGamePovCursors', 'povCursors']);
  const containsForbiddenDeliveryState = (value: unknown): boolean => {
    if (!value || typeof value !== 'object') return false;
    if (Array.isArray(value)) return value.some(containsForbiddenDeliveryState);
    return Object.entries(value).some(
      ([key, nested]) => forbiddenDeliveryKeys.has(key) || containsForbiddenDeliveryState(nested),
    );
  };
  assert.equal(containsForbiddenDeliveryState(terminal), false);
});

test('same registered six start a fresh preview each game through a deterministic Bo3', () => {
  const referee = new FrozenMatchdayReferee(options());
  const game1 = finishGame(referee);
  assert.equal(game1.phase, 'between-games');
  assert.equal(game1.score.p1 + game1.score.p2, 1);
  const firstWinner = game1.score.p1 ? 'p1' : 'p2';

  startNextGame(referee, { notebookReplacement: 'new plan' });
  const game2Preview = referee.observe('p1');
  assert.equal(game2Preview.gameNumber, 2);
  assert.equal(game2Preview.battle?.request?.teamPreview, true);
  assert.equal(referee.legalActions('p1').actions.length, 360);

  const game2 = finishGame(referee);
  assert.equal(game2.phase, 'between-games');
  assert.equal(game2.score[firstWinner], 1);
  assert.equal(game2.score[firstWinner === 'p1' ? 'p2' : 'p1'], 1);
  startNextGame(referee);
  const game3Preview = referee.observe('p1');
  assert.equal(game3Preview.gameNumber, 3);
  assert.equal(game3Preview.battle?.request?.teamPreview, true);
  const game3 = finishGame(referee);
  assert.equal(game3.phase, 'terminal');
  const terminalQueues = referee.snapshot().pendingPovLines;
  const terminalP1 = referee.observe('p1');
  const terminalP2 = referee.observe('p2');
  assert.equal(terminalP1.gameNumber, 3);
  assert.equal(terminalP1.terminal, true);
  assert.equal(terminalP1.battle, null);
  assert.deepEqual(terminalP1.povLines, terminalQueues.p1);
  assert.deepEqual(terminalP2.povLines, terminalQueues.p2);
  assert.ok(terminalP1.povLines.some((line) => line.startsWith('|win|')));
  assert.ok(terminalP2.povLines.some((line) => line.startsWith('|win|')));
  assert.deepEqual(referee.observe('p1').povLines, []);
  assert.deepEqual(referee.observe('p2').povLines, []);
  const terminal = referee.terminalEvidence();
  assert.ok(terminal);
  assert.equal(Object.hasOwn(terminal, 'povLines'), false);
  assert.equal(terminal.games.length, 3);
  assert.equal(terminal.result.type, 'win');
  assert.deepEqual(
    terminal.games.map((game) => game.seed),
    SEEDS,
  );
  assert.doesNotMatch(JSON.stringify(terminal), /packedTeam|initial notebook|new plan/);
});

test('between-game notebook evidence is private and cannot change the next game', () => {
  const source = new FrozenMatchdayReferee(options());
  assert.equal(finishGame(source).phase, 'between-games');
  const left = FrozenMatchdayReferee.restore(source.snapshot());
  const right = FrozenMatchdayReferee.restore(source.snapshot());

  startNextGame(left, { notebookReplacement: 'left private plan' });
  startNextGame(right, { notebookReplacement: 'different private plan' });
  const leftPreview = left.observe('p1');
  const rightPreview = right.observe('p1');
  assert.equal(leftPreview.stateHash, rightPreview.stateHash);
  assert.deepEqual(leftPreview.battle?.request, rightPreview.battle?.request);
  assert.notEqual(left.seatPrivateEvidence('p1').currentNotebook, right.seatPrivateEvidence('p1').currentNotebook);
  assert.doesNotMatch(JSON.stringify(left.observe('p2')), /left private plan/);

  const leftGame2 = finishGame(left);
  const rightGame2 = finishGame(right);
  assert.deepEqual(leftGame2.score, rightGame2.score);
  if (leftGame2.phase === 'between-games') {
    assert.equal(rightGame2.phase, 'between-games');
    startNextGame(left);
    startNextGame(right);
    finishGame(left);
    finishGame(right);
  }
  const leftTerminal = left.terminalEvidence();
  const rightTerminal = right.terminalEvidence();
  assert.ok(leftTerminal && rightTerminal);
  assert.deepEqual(leftTerminal.games, rightTerminal.games);
  assert.deepEqual(leftTerminal.score, rightTerminal.score);
  assert.notDeepEqual(leftTerminal.notebookReceipts, rightTerminal.notebookReceipts);
});

test('snapshot restore preserves a private staged acknowledgement and rejects semantic tampering', () => {
  const referee = new FrozenMatchdayReferee(options());
  assert.equal(finishGame(referee).phase, 'between-games');
  const p1 = referee.observe('p1');
  referee.readyNextGame('p1', { notebookReplacement: '' }, p1.revision, p1.stateHash);

  const snapshot = referee.snapshot();
  const restored = FrozenMatchdayReferee.restore(JSON.parse(JSON.stringify(snapshot)));
  assert.deepEqual(restored.observe('p2'), referee.observe('p2'));
  const p2 = referee.observe('p2');
  const restoredP2 = restored.observe('p2');
  referee.readyNextGame('p2', {}, p2.revision, p2.stateHash);
  restored.readyNextGame('p2', {}, restoredP2.revision, restoredP2.stateHash);
  assert.deepEqual(restored.observe('p1'), referee.observe('p1'));

  const tampered = JSON.parse(JSON.stringify(snapshot)) as typeof snapshot;
  tampered.score.p1 += 1;
  const { sha256: _old, ...body } = tampered;
  tampered.sha256 = canonicalJsonDigest(body);
  assert.throws(() => FrozenMatchdayReferee.restore(tampered), assertMatchdayError('snapshot-protocol'));
});

test('snapshot restore rejects a re-signed matchday protocol v1 snapshot', () => {
  const stale = structuredClone(new FrozenMatchdayReferee(options()).snapshot()) as unknown as {
    protocolVersion: number;
  };
  stale.protocolVersion = 1;
  resignSnapshot(stale as ReturnType<FrozenMatchdayReferee['snapshot']>);
  assert.throws(
    () => FrozenMatchdayReferee.restore(stale as ReturnType<FrozenMatchdayReferee['snapshot']>),
    assertMatchdayError('snapshot-protocol'),
  );
});

test('snapshot restore replays active history and rejects impossible outer revisions or terminal active games', () => {
  const initial = new FrozenMatchdayReferee(options()).snapshot();

  const outerRevision = structuredClone(initial);
  outerRevision.revision = 999;
  resignSnapshot(outerRevision);
  assert.throws(() => FrozenMatchdayReferee.restore(outerRevision), assertMatchdayError('snapshot-protocol'));

  const innerRevision = structuredClone(initial);
  assert.ok(innerRevision.activeBattle);
  innerRevision.activeBattle.revision = -7;
  resignSnapshot(innerRevision);
  assert.throws(() => FrozenMatchdayReferee.restore(innerRevision), assertMatchdayError('snapshot-protocol'));

  const fakeHistory = structuredClone(initial);
  assert.ok(fakeHistory.activeBattle);
  fakeHistory.activeBattle.submittedActions.push({
    decisionRevision: 0,
    stateHash: fakeHistory.activeBattle.stateHash,
    pid: 'p1',
    command: 'team 1234',
  });
  resignSnapshot(fakeHistory);
  assert.throws(() => FrozenMatchdayReferee.restore(fakeHistory), assertMatchdayError('snapshot-protocol'));

  const terminalActive = structuredClone(initial);
  const ended = JSON.parse(JSON.stringify(scriptedBattle(0).referee.snapshot())) as NonNullable<
    typeof terminalActive.activeBattle
  >;
  terminalActive.activeBattle = ended;
  terminalActive.revision = ended.revision;
  resignSnapshot(terminalActive);
  assert.throws(() => FrozenMatchdayReferee.restore(terminalActive), assertMatchdayError('snapshot-protocol'));
});

test('snapshot restore rejects a third game after a two-win prefix', () => {
  const snapshot = new FrozenMatchdayReferee(options()).snapshot();
  const games = [scriptedBattle(0), scriptedBattle(1), scriptedBattle(2)];
  assert.deepEqual(
    games.map(({ evidence }) => evidence.result.type === 'win' && evidence.result.winner.pid),
    ['p1', 'p1', 'p1'],
  );
  snapshot.completedGames = games.map(({ evidence }) => evidence);
  snapshot.activeBattle = null;
  snapshot.phase = 'terminal';
  snapshot.score = { p1: 3, p2: 0, ties: 0 };
  snapshot.revision = games.reduce((sum, { referee }) => sum + referee.snapshot().revision, 2);
  snapshot.ready = {};
  for (const pid of ['p1', 'p2'] as const) {
    const construction = snapshot.options.seats.find((seat) => seat.pid === pid)?.construction;
    assert.ok(construction && construction.status === 'accepted');
    const notebook = construction.artifact.evidence.notebook;
    const notebookSha256 = createHash('sha256').update(notebook).digest('hex');
    snapshot.notebooks[pid] = notebook;
    snapshot.privateEvidence[pid] = [1, 2].map((gameNumber) => ({
      gameNumber,
      supplied: false,
      notebook,
      notebookSha256,
    }));
  }
  resignSnapshot(snapshot);
  assert.throws(() => FrozenMatchdayReferee.restore(snapshot), assertMatchdayError('snapshot-protocol'));
});

test('invalid strict construction and stale or duplicate interval submissions fail closed', () => {
  for (const mutate of [
    (accepted: Extract<ReturnType<typeof options>['seats'][number]['construction'], { status: 'accepted' }>) => {
      accepted.artifact.fallback = true;
    },
    (accepted: Extract<ReturnType<typeof options>['seats'][number]['construction'], { status: 'accepted' }>) => {
      accepted.artifact.validation.repaired = true;
    },
    (accepted: Extract<ReturnType<typeof options>['seats'][number]['construction'], { status: 'accepted' }>) => {
      accepted.artifact.task.sheetPolicy = 'closed';
    },
    (accepted: Extract<ReturnType<typeof options>['seats'][number]['construction'], { status: 'accepted' }>) => {
      accepted.artifact.task.format = 'gen9ou';
    },
    (accepted: Extract<ReturnType<typeof options>['seats'][number]['construction'], { status: 'accepted' }>) => {
      accepted.artifact.showdownCommit = 'wrong-revision';
    },
    (accepted: Extract<ReturnType<typeof options>['seats'][number]['construction'], { status: 'accepted' }>) => {
      accepted.artifact.task.constraint.candidates[0]!.id = 'forged-candidate';
    },
    (accepted: Extract<ReturnType<typeof options>['seats'][number]['construction'], { status: 'accepted' }>) => {
      const unpacked = Showdown.Teams.unpack(accepted.packed);
      assert.ok(unpacked);
      unpacked[0]!.name = 'Noncanonical nickname';
      accepted.packed = Showdown.Teams.pack(unpacked);
      accepted.artifact.action!.packed = accepted.packed;
    },
    (accepted: Extract<ReturnType<typeof options>['seats'][number]['construction'], { status: 'accepted' }>) => {
      accepted.artifact.action!.selected.pop();
      accepted.artifact.action!.sets.pop();
    },
  ]) {
    const invalid = options();
    const accepted = invalid.seats[0]!.construction;
    assert.equal(accepted.status, 'accepted');
    mutate(accepted);
    assert.throws(() => new FrozenMatchdayReferee(invalid), assertMatchdayError('invalid-construction'));
  }

  const tera = options();
  const accepted = tera.seats[0]!.construction;
  assert.equal(accepted.status, 'accepted');
  const unpacked = Showdown.Teams.unpack(accepted.packed);
  assert.ok(unpacked);
  unpacked[0]!.teraType = 'Fire';
  const packedWithTera = Showdown.Teams.pack(unpacked);
  accepted.packed = packedWithTera;
  accepted.artifact.action!.packed = packedWithTera;
  assert.throws(() => new FrozenMatchdayReferee(tera), assertMatchdayError('invalid-construction'));

  const referee = new FrozenMatchdayReferee(options());
  const stale = referee.observe('p1');
  advanceDecision(referee);
  assert.throws(
    () => referee.submit('p1', 'team 1234', stale.revision, stale.stateHash),
    assertMatchdayError('stale-revision'),
  );
  assert.equal(finishGame(referee).phase, 'between-games');
  const interval = referee.observe('p1');
  referee.readyNextGame('p1', {}, interval.revision, interval.stateHash);
  assert.throws(
    () => referee.readyNextGame('p1', {}, interval.revision, interval.stateHash),
    assertMatchdayError('duplicate-submission'),
  );
});
