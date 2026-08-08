import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { canonicalJsonDigest } from '../src/eval/serialization.js';
import { FrozenBattleReferee } from '../src/frozen-battle-referee.js';
import {
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
  const terminal = referee.terminalEvidence();
  assert.ok(terminal);
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
