import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EXHAUSTIVE_PANEL_PROTOCOL,
  evaluateActionTable,
  evaluatePosition,
  REFERENCE,
  twoStageClusterEstimate,
} from '../src/eval/counterfactual.js';
import {
  type GameSource,
  legalActions,
  newBattle,
  omniscientLog,
  type Position,
  pendingSides,
  replayGame,
} from '../src/eval/fork.js';
import { loadPool } from '../src/teams.js';
import type { Pid } from '../src/types.js';

const SEED: [number, number, number, number] = [5, 10, 15, 20];
const BUDGET = { luckSamples: 3, screenSamples: 1, shortlist: 3, opponentSamples: 2 };

let cached: Position[] | undefined;

function positions(): Position[] {
  if (cached) return cached;
  const pool = loadPool();
  const [first, second] = pool.teams;
  if (!first || !second) throw new Error('the test pool needs two teams');
  const base: GameSource = {
    format: pool.format,
    seed: SEED,
    names: { p1: 'p1-a', p2: 'p2-b' },
    packed: { p1: first.packed, p2: second.packed },
    choices: { p1: [], p2: [] },
  };

  const battle = newBattle(base);
  const choices: Record<Pid, string[]> = { p1: [], p2: [] };
  let steps = 0;
  while (!battle.ended && steps++ < 400) {
    const pending = pendingSides(battle);
    if (!pending.length) break;
    const taken: Partial<Record<Pid, string>> = {};
    for (const pid of pending) {
      const actions = legalActions(battle.getSide(pid).activeRequest as never);
      const action = actions[Math.min(actions.length - 1, 1)];
      if (action === undefined) throw new Error(`no legal action for ${pid}`);
      taken[pid] = action;
      choices[pid].push(action);
    }
    for (const pid of pending) battle.choose(pid, taken[pid] as string);
  }
  const replay = replayGame({ ...base, choices }, omniscientLog(battle.log));
  assert.equal(replay.verified, true);
  cached = replay.positions;
  return cached;
}

function battleTurn(): Position {
  const position = positions().find((entry) => entry.turn > 0);
  assert.ok(position, 'the scripted game reached a battle turn');
  return position;
}

test('the reference every number is measured against is named, not implied', () => {
  assert.deepEqual(Object.keys(REFERENCE).toSorted(), ['continuation', 'hiddenState', 'opponent', 'value']);
  assert.equal(EXHAUSTIVE_PANEL_PROTOCOL.uncertaintyEstimator, 'two-stage-srswor-opponent-cluster-v1');
  assert.match(EXHAUSTIVE_PANEL_PROTOCOL.normalApproximation, /not-claimed-calibrated/);
});

test('the clustered estimator retains only within-opponent uncertainty at an opponent census', () => {
  const estimate = twoStageClusterEstimate(
    [
      [1, 3],
      [5, 7],
    ],
    2,
  );
  assert.equal(estimate.value, 4);
  assert.ok(Math.abs((estimate.standardError as number) - Math.sqrt(0.5)) < 1e-12);
});

test('the clustered estimator applies the opponent finite population correction to a sampled subset', () => {
  const estimate = twoStageClusterEstimate(
    [
      [1, 3],
      [5, 7],
    ],
    4,
  );
  assert.equal(estimate.value, 4);
  assert.equal(estimate.standardError, 1.5);
});

test('paired action differences use opponent blocks before estimating uncertainty', () => {
  const selected = [
    [4, 8],
    [3, 7],
  ];
  const alternative = [
    [1, 2],
    [2, 4],
  ];
  const pairedBlocks = selected.map((block, opponentIndex) =>
    block.map((entry, luckIndex) => entry - (alternative[opponentIndex]?.[luckIndex] as number)),
  );
  const estimate = twoStageClusterEstimate(pairedBlocks, 4);
  assert.equal(estimate.value, 3.25);
  assert.ok(Math.abs((estimate.standardError as number) - Math.sqrt(1.1875)) < 1e-12);
});

test('an unreplicated luck stage reports unidentified uncertainty instead of zero', () => {
  assert.deepEqual(twoStageClusterEstimate([[1], [3]], 4), { value: 2, standardError: null });
});

test('the held-out estimate reports rather than hides selection reversals', () => {
  const result = evaluatePosition(battleTurn(), 'p1', { ...BUDGET, horizon: 0 });
  assert.ok(result);
  for (const view of [result.vsActualOpponent, result.vsSampledOpponent]) {
    assert.ok(view.opportunityLoss >= 0);
    assert.ok(Math.abs(view.signedGap - (view.selected - view.chosen)) < 1e-9);
    assert.ok(Math.abs(view.opportunityLoss - Math.max(0, view.signedGap)) < 1e-9);
    assert.equal(view.selectionReversed, view.signedGap < 0);
  }
  assert.ok(result.legal > 1);
  assert.equal(result.horizon, 0);
});

test('the same position and budget grade the same way twice', () => {
  const position = battleTurn();
  const first = evaluatePosition(position, 'p1', { ...BUDGET, horizon: 0, seed: 'fixed' });
  const second = evaluatePosition(position, 'p1', { ...BUDGET, horizon: 0, seed: 'fixed' });
  assert.deepEqual(first, second);
});

test('the sampling namespace changes luck and continuation panels, not only opponent order', () => {
  const position = battleTurn();
  const first = evaluatePosition(position, 'p1', { ...BUDGET, horizon: 2, seed: 'panel-a' });
  const second = evaluatePosition(position, 'p1', { ...BUDGET, horizon: 2, seed: 'panel-b' });
  assert.ok(first);
  assert.ok(second);
  assert.notDeepEqual(
    [first.vsActualOpponent, first.vsSampledOpponent],
    [second.vsActualOpponent, second.vsSampledOpponent],
  );
});

test('submitting the action selected on the search panel removes its measured positive gap', () => {
  const position = battleTurn();
  const graded = evaluatePosition(position, 'p1', { ...BUDGET, horizon: 0, seed: 'fixed' });
  assert.ok(graded);
  if (graded.vsActualOpponent.selectedAction === graded.chosen) {
    assert.equal(graded.vsActualOpponent.opportunityLoss, 0);
    return;
  }
  const swapped: Position = { ...position, actual: { ...position.actual, p1: graded.vsActualOpponent.selectedAction } };
  const rerun = evaluatePosition(swapped, 'p1', { ...BUDGET, horizon: 0, seed: 'fixed' });
  assert.ok(rerun);
  assert.ok(rerun.vsActualOpponent.opportunityLoss <= graded.vsActualOpponent.opportunityLoss + 1e-9);
});

test('a horizon of zero admits that it cannot grade team preview', () => {
  const preview = positions()[0];
  assert.ok(preview);
  assert.equal(preview.turn, 0);

  const myopic = evaluatePosition(preview, 'p1', { ...BUDGET, horizon: 0 });
  assert.ok(myopic);
  assert.equal(myopic.vsSampledOpponent.discriminating, false);
  assert.equal(myopic.vsSampledOpponent.opportunityLoss, 0);

  const played = evaluatePosition(preview, 'p1', { ...BUDGET, horizon: 2 });
  assert.ok(played);
  assert.equal(played.vsSampledOpponent.discriminating, true);
});

test('the exhaustive table uses complete, normalized, common-draw action panels', () => {
  const position = battleTurn();
  const table = evaluateActionTable(position, 'p1', { ...BUDGET, horizon: 0, seed: 'table' });
  assert.ok(table);
  const legal = legalActions(position.requests.p1);
  assert.deepEqual(
    table.measurement.actions.map((entry) => entry.action),
    legal,
  );
  assert.equal(table.legal, legal.length);
  assert.equal(table.stability[0].actions.length, legal.length);
  assert.ok(table.measurement.actions.every((entry) => entry.samples === BUDGET.luckSamples * BUDGET.opponentSamples));
  assert.ok(
    table.measurement.actions.every((entry) => entry.reward === null || (entry.reward >= 0 && entry.reward <= 1)),
  );
  if (table.valueSpan > 0) {
    assert.equal(Math.max(...table.measurement.actions.map((entry) => entry.reward as number)), 1);
    assert.equal(Math.min(...table.measurement.actions.map((entry) => entry.reward as number)), 0);
  } else {
    assert.ok(table.measurement.actions.every((entry) => entry.reward === null));
  }
  assert.equal(table.measurement.opponentSlots, BUDGET.opponentSamples);
  assert.ok(table.measurement.opponentPopulation >= table.measurement.opponentSlots);
  assert.equal(table.measurement.luckReplications, BUDGET.luckSamples);
  assert.equal(table.measurement.matrix.length, BUDGET.luckSamples * BUDGET.opponentSamples);
  assert.ok(table.measurement.matrix.every((row) => row.length === legal.length));
  assert.ok(table.measurement.actions.every((entry) => entry.standardError !== null));
  assert.equal(new Set(table.stability.map((panel) => panel.matrixDigest)).size, 2);
  assert.equal(table.heldOutGap.selectedAction, table.selectionBest);
  assert.notEqual(table.heldOutGap.normalApproxLower95, null);
});

test('an exhaustive panel exposes and refuses uncertainty from one luck replication', () => {
  const table = evaluateActionTable(battleTurn(), 'p1', {
    ...BUDGET,
    horizon: 0,
    luckSamples: 1,
    seed: 'unreplicated-table',
  });
  assert.ok(table);
  assert.equal(table.measurement.luckReplications, 1);
  assert.ok(table.measurement.actions.every((entry) => entry.standardError === null));
  assert.equal(table.heldOutGap.standardError, null);
  assert.equal(table.heldOutGap.normalApproxLower95, null);
});

test('the exhaustive table is deterministic for a fixed sampling namespace', () => {
  const position = battleTurn();
  const first = evaluateActionTable(position, 'p1', { ...BUDGET, horizon: 0, seed: 'table' });
  const second = evaluateActionTable(position, 'p1', { ...BUDGET, horizon: 0, seed: 'table' });
  assert.deepEqual(first, second);
});

test('a position the recorded action is not legal in is refused rather than graded', () => {
  const position = battleTurn();
  const invented: Position = { ...position, actual: { ...position.actual, p1: 'move 9 9' } };
  assert.equal(evaluatePosition(invented, 'p1', { ...BUDGET, horizon: 0 }), null);
});

function oneSidedReplacement(): Position {
  const pool = loadPool();
  const [first, second] = pool.teams;
  if (!first || !second) throw new Error('the test pool needs two teams');
  const base: GameSource = {
    format: pool.format,
    seed: [11, 22, 33, 44],
    names: { p1: 'p1-a', p2: 'p2-b' },
    packed: { p1: first.packed, p2: second.packed },
    choices: { p1: [], p2: [] },
  };
  const battle = newBattle(base);
  let steps = 0;
  while (!battle.ended && steps++ < 400) {
    const pending = pendingSides(battle);
    for (const pid of pending) {
      const action = legalActions(battle.getSide(pid).activeRequest as never)[0];
      if (!action) throw new Error(`no legal action for ${pid}`);
      base.choices[pid].push(action);
    }
    for (const pid of pending) battle.choose(pid, base.choices[pid].at(-1) as string);
  }
  const replay = replayGame(base, omniscientLog(battle.log));
  const position = replay.positions.find((entry) => entry.pending.length === 1);
  assert.ok(position, 'the deterministic game reached a one-sided replacement');
  return position;
}

test('a one-sided replacement is graded without inventing an opponent action', () => {
  const position = oneSidedReplacement();
  const pid = position.pending[0] as Pid;
  const result = evaluatePosition(position, pid, { ...BUDGET, horizon: 0 });
  assert.ok(result);
  assert.equal(result.chosen, position.actual[pid]);
  assert.deepEqual(result.vsSampledOpponent, result.vsActualOpponent);
});

test('both sides of the same position are gradeable', () => {
  const position = battleTurn();
  for (const pid of ['p1', 'p2'] as const) {
    const result = evaluatePosition(position, pid, { ...BUDGET, horizon: 0 });
    assert.ok(result);
    assert.equal(result.pid, pid);
    assert.equal(result.chosen, position.actual[pid]);
  }
});
