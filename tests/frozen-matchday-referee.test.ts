import assert from 'node:assert/strict';
import test from 'node:test';

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
const options = frozenMatchdayOptions;

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
  const state = referee.currentState();
  const first = referee.readyNextGame('p1', p1, state.revision, state.stateHash);
  assert.equal(first.advanced, false);
  const second = referee.readyNextGame('p2', p2, state.revision, state.stateHash);
  assert.equal(second.advanced, true);
  assert.equal(second.phase, 'playing');
}

function assertMatchdayError(code: FrozenMatchdayRefereeError['code']): (error: unknown) => boolean {
  return (error) => error instanceof FrozenMatchdayRefereeError && error.code === code;
}

test('strict construction starts native Champions open-sheet bring-four preview', () => {
  const referee = new FrozenMatchdayReferee(options());
  const observation = referee.observe('p1');
  assert.equal(FROZEN_MATCHDAY_REFEREE_PROTOCOL_VERSION, 1);
  assert.equal(observation.protocolVersion, 1);
  assert.equal(observation.battleProtocolVersion, 1);
  assert.equal(observation.phase, 'playing');
  assert.equal(observation.gameNumber, 1);
  assert.equal(observation.battle?.request?.teamPreview, true);
  assert.equal(observation.battle?.request?.maxChosenTeamSize, 4);
  assert.equal(referee.legalActions('p1').actions.length, 360);

  const sheets = observation.battle?.povLines.filter((line) => line.startsWith('|showteam|')) ?? [];
  assert.equal(sheets.length, 2);
  for (const line of sheets) {
    const packed = line.split('|').slice(3).join('|');
    for (const entry of packed.split(']').filter(Boolean)) {
      const fields = entry.split('|');
      assert.ok(fields[2]);
      assert.ok(fields[3]);
      assert.ok(fields[4]);
      assert.ok(fields[5]);
      assert.equal(fields[6], '');
      assert.equal(fields[8], '');
      assert.equal(fields[11] ?? '', '');
    }
  }
});

test('final game POV remains seat-isolated and is delivered exactly once across an interval', () => {
  const referee = new FrozenMatchdayReferee(options());
  const game1 = finishGame(referee);
  assert.equal(game1.phase, 'between-games');
  startNextGame(referee, { notebookReplacement: 'Game 1 plan' });

  const p1 = referee.observe('p1');
  const p2 = referee.observe('p2');
  assert.equal(p1.phase, 'playing');
  assert.equal(p1.gameNumber, 2);
  assert.equal(p1.battle?.request?.teamPreview, true);
  assert.ok(p1.povLines.some((line) => line.startsWith('|win|')));
  assert.ok(p2.povLines.some((line) => line.startsWith('|win|')));
  const p1Private = p1.povLines.find((line) => line.startsWith('|-damage|p1b: Swampert|'));
  const p2View = p2.povLines.find((line) => line.startsWith('|-damage|p1b: Swampert|'));
  assert.ok(p1Private);
  assert.ok(p2View);
  assert.notEqual(p1Private, p2View);
  assert.ok(!p2.povLines.includes(p1Private));
  assert.ok(!p1.povLines.includes(p2View));
  assert.deepEqual(referee.observe('p1').povLines, []);
  assert.deepEqual(referee.observe('p2').povLines, []);
  assert.deepEqual(
    referee.seatPrivateEvidence('p1').intervals.map((receipt) => receipt.gameNumber),
    [1],
  );
});

test('same registered six start fresh deterministic previews through a Bo3', () => {
  const referee = new FrozenMatchdayReferee(options());
  const game1 = finishGame(referee);
  assert.equal(game1.phase, 'between-games');
  startNextGame(referee, { notebookReplacement: 'new plan' });
  assert.equal(referee.observe('p1').battle?.request?.teamPreview, true);

  const game2 = finishGame(referee);
  if (game2.phase === 'between-games') {
    startNextGame(referee);
    assert.equal(referee.observe('p1').battle?.request?.teamPreview, true);
    assert.equal(finishGame(referee).phase, 'terminal');
  }
  const p1 = referee.observe('p1');
  const p2 = referee.observe('p2');
  assert.ok(p1.povLines.some((line) => line.startsWith('|win|')));
  assert.ok(p2.povLines.some((line) => line.startsWith('|win|')));
  assert.deepEqual(referee.observe('p1').povLines, []);
  assert.deepEqual(referee.observe('p2').povLines, []);
  const terminal = referee.terminalEvidence();
  assert.ok(terminal);
  assert.equal(terminal.protocolVersion, 1);
  assert.equal(terminal.battleProtocolVersion, 1);
  assert.deepEqual(
    terminal.games.map((game) => game.seed),
    MATCHDAY_SEEDS.slice(0, terminal.games.length),
  );
  assert.doesNotMatch(JSON.stringify(terminal), /packedTeam|initial notebook|new plan/);
});

test('between-game notebook evidence is private and cannot change the next game', () => {
  const left = new FrozenMatchdayReferee(options());
  const right = new FrozenMatchdayReferee(options());
  assert.equal(finishGame(left).phase, 'between-games');
  assert.equal(finishGame(right).phase, 'between-games');
  startNextGame(left, { notebookReplacement: 'left private plan' });
  startNextGame(right, { notebookReplacement: 'different private plan' });
  const leftPreview = left.observe('p1');
  const rightPreview = right.observe('p1');
  assert.equal(leftPreview.stateHash, rightPreview.stateHash);
  assert.deepEqual(leftPreview.battle?.request, rightPreview.battle?.request);
  assert.notEqual(left.seatPrivateEvidence('p1').currentNotebook, right.seatPrivateEvidence('p1').currentNotebook);
  assert.doesNotMatch(JSON.stringify(left.observe('p2')), /left private plan/);
});

test('invalid strict construction and stale or duplicate submissions fail closed', () => {
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
      accepted.artifact.showdownCommit = 'wrong-revision';
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
  const interval = finishGame(referee);
  referee.readyNextGame('p1', {}, interval.revision, interval.stateHash);
  assert.throws(
    () => referee.readyNextGame('p1', {}, interval.revision, interval.stateHash),
    assertMatchdayError('duplicate-submission'),
  );
});
