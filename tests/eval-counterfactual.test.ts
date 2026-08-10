import assert from 'node:assert/strict';
import test from 'node:test';
import {
  counterfactualProtocol,
  EXHAUSTIVE_PANEL_PROTOCOL,
  evaluateActionTable,
  exhaustivePanelDrawPlan,
  exhaustivePanelMatrixDigest,
  REFERENCE,
  twoStageClusterEstimate,
  validateCounterfactualOptions,
} from '../src/eval/counterfactual.js';
import {
  type GameSource,
  newBattle,
  omniscientLog,
  type Position,
  pendingSides,
  replayGame,
  requestActionCandidates,
} from '../src/eval/fork.js';
import { loadPool } from '../src/teams.js';
import type { Pid } from '../src/types.js';
import { minimalPanelBattle } from './fixtures/position-panel.js';

const SEED: [number, number, number, number] = [5, 10, 15, 20];
const BUDGET = { luckSamples: 3, opponentSamples: 2 };

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
      const actions = requestActionCandidates(battle.getSide(pid).activeRequest as never);
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
  assert.deepEqual(Object.keys(REFERENCE).toSorted(), [
    'actionSet',
    'continuation',
    'hiddenState',
    'opponent',
    'value',
  ]);
  assert.equal(REFERENCE.opponent, 'srswor-uniform-legal-when-simultaneous-or-null-census-when-unilateral');
  assert.equal(EXHAUSTIVE_PANEL_PROTOCOL.version, 5);
  assert.equal(EXHAUSTIVE_PANEL_PROTOCOL.uncertaintyEstimator, 'two-stage-srswor-opponent-cluster-v1');
  assert.equal(EXHAUSTIVE_PANEL_PROTOCOL.matrixDigest, 'sha256-canonical-exhaustive-panel-matrix-v2');
  assert.equal(EXHAUSTIVE_PANEL_PROTOCOL.drawPlan, 'seeded-srswor-opponents-and-battle-words-v1');
  assert.match(EXHAUSTIVE_PANEL_PROTOCOL.normalApproximation, /not-claimed-calibrated/);
});

test('counterfactual option validation admits diagnostic zero horizon and rejects unsafe budgets', () => {
  assert.doesNotThrow(() =>
    validateCounterfactualOptions({
      horizon: 0,
      luckSamples: 1,
      opponentSamples: 1,
      seed: 0,
      psDir: '.',
    }),
  );
  assert.equal(counterfactualProtocol({ horizon: 0 }).horizon, 0);
  assert.equal(counterfactualProtocol({ horizon: Number.POSITIVE_INFINITY }).horizon, 'end');
  assert.deepEqual(Object.keys(counterfactualProtocol()).toSorted(), [
    'horizon',
    'luckSamples',
    'opponentSamples',
    'reference',
    'rolloutLimit',
    'version',
  ]);
  assert.equal(counterfactualProtocol().rolloutLimit, 60);
  assert.doesNotThrow(() => validateCounterfactualOptions({ horizon: Number.MAX_SAFE_INTEGER, seed: 'seed' }));

  for (const horizon of [-1, 0.5, Number.NaN, Number.NEGATIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => validateCounterfactualOptions({ horizon }), /counterfactual horizon/);
  }
  for (const field of ['luckSamples', 'opponentSamples'] as const) {
    for (const value of [0, -1, 0.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => validateCounterfactualOptions({ [field]: value }), new RegExp(`counterfactual ${field}`));
    }
  }
  for (const seed of ['', 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => validateCounterfactualOptions({ seed }), /counterfactual seed/);
  }
  assert.throws(() => validateCounterfactualOptions({ psDir: '' }), /counterfactual psDir/);

  const invalidPosition = {} as Position;
  assert.throws(
    () => evaluateActionTable(invalidPosition, 'p1', { opponentSamples: 0 }),
    /counterfactual opponentSamples/,
  );
});

test('the exhaustive draw plan deterministically samples opponents and all battle seed words', () => {
  const input = {
    panelSeed: 'panel-root',
    id: 'stability-a' as const,
    opponentLegalActions: ['move 1', 'move 2', 'move 3'],
    opponentSlots: 2,
    luckReplications: 2,
  };
  const plan = exhaustivePanelDrawPlan(input);
  assert.deepEqual(plan, exhaustivePanelDrawPlan(input));
  assert.equal(plan.draws.length, 4);
  assert.equal(new Set(plan.draws.map((draw) => draw.opponentAction)).size, 2);
  for (const [index, draw] of plan.draws.entries()) {
    assert.equal(draw.index, index);
    assert.equal(draw.battleSeed.length, 4);
    assert.ok(draw.battleSeed.every((word) => Number.isInteger(word) && word >= 1 && word <= 0xffff));
    assert.equal(draw.continuationSeed, `${plan.seedNamespace}:continuation:${index}`);
  }
});

test('the panel digest is versioned and binds the clustered sampling design', () => {
  const panel = {
    id: 'measurement' as const,
    seedNamespace: 'seed:panel:measurement',
    opponentPopulation: 1,
    opponentSlots: 1,
    luckReplications: 1,
    draws: [
      {
        index: 0,
        opponentAction: null,
        battleSeed: [1, 2, 3, 4] as [number, number, number, number],
        continuationSeed: 'seed:panel:measurement:continuation:0',
      },
    ],
    actions: ['move 1', 'move 2'],
    matrix: [[0, 1]],
  };
  const digest = exhaustivePanelMatrixDigest(panel);
  assert.match(digest, /^[0-9a-f]{64}$/u);
  assert.notEqual(exhaustivePanelMatrixDigest({ ...panel, opponentPopulation: 2 }), digest);
  assert.notEqual(exhaustivePanelMatrixDigest({ ...panel, opponentSlots: 2 }), digest);
  assert.notEqual(exhaustivePanelMatrixDigest({ ...panel, luckReplications: 2 }), digest);
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

function inertPosition(): Position {
  const fixture = minimalPanelBattle(['Splash'], ['Splash', 'Celebrate']);
  return {
    index: 0,
    turn: 1,
    pending: ['p1', 'p2'],
    requests: fixture.requests,
    actual: { p1: fixture.actions.p1[0] as string, p2: fixture.actions.p2[0] as string },
    choiceIndex: { p1: 0, p2: 0 },
    seen: { p1: 0, p2: 0 },
    snapshot: fixture.snapshot,
  };
}

test('a failed exhaustive cell rejects the whole action table', () => {
  assert.equal(
    evaluateActionTable(inertPosition(), 'p1', {
      horizon: Number.POSITIVE_INFINITY,
      luckSamples: 1,
      opponentSamples: 1,
      seed: 'rollout-limit-failure',
    }),
    null,
  );
});

test('exhaustive ranking ties use deterministic canonical action ordering', () => {
  const table = evaluateActionTable(inertPosition(), 'p1', {
    horizon: 0,
    luckSamples: 1,
    opponentSamples: 1,
    seed: 'tie-order',
  });
  assert.ok(table);
  const canonicalFirst = [...table.measurement.actions.map((entry) => entry.action)].sort((left, right) =>
    Buffer.compare(Buffer.from(left), Buffer.from(right)),
  )[0];
  assert.equal(table.selectionBest, canonicalFirst);
  assert.equal(table.measurementBest, canonicalFirst);
});

test('the exhaustive table uses complete, normalized, common-draw action panels', () => {
  const position = battleTurn();
  const table = evaluateActionTable(position, 'p1', { ...BUDGET, horizon: 0, seed: 'table' });
  assert.ok(table);
  const legal = requestActionCandidates(position.requests.p1);
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
  for (const panel of [...table.stability, table.measurement]) {
    assert.equal(panel.matrix.length, panel.draws.length);
    assert.ok(panel.matrix.every((row) => row.length === legal.length));
    assert.ok(panel.actions.every((entry) => entry.samples === panel.draws.length));
  }
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

test('the exhaustive table sampling namespace binds every panel draw plan', () => {
  const position = battleTurn();
  const first = evaluateActionTable(position, 'p1', { ...BUDGET, horizon: 0, seed: 'panel-a' });
  const second = evaluateActionTable(position, 'p1', { ...BUDGET, horizon: 0, seed: 'panel-b' });
  assert.ok(first);
  assert.ok(second);
  assert.notDeepEqual(
    first.stability.map((panel) => panel.draws),
    second.stability.map((panel) => panel.draws),
  );
});

test('the exhaustive table does not use the recorded actual action as an opponent reference', () => {
  const position = battleTurn();
  const changed: Position = {
    ...position,
    actual: { ...position.actual, p1: 'move 99', p2: 'move 99' },
  };
  assert.deepEqual(
    evaluateActionTable(position, 'p1', { ...BUDGET, horizon: 0, seed: 'actual-independent' }),
    evaluateActionTable(changed, 'p1', { ...BUDGET, horizon: 0, seed: 'actual-independent' }),
  );
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
      const actions = requestActionCandidates(battle.getSide(pid).activeRequest as never);
      const action = actions[(steps + (pid === 'p1' ? 0 : 3)) % actions.length];
      if (!action) throw new Error(`no legal action for ${pid}`);
      base.choices[pid].push(action);
    }
    for (const pid of pending) battle.choose(pid, base.choices[pid].at(-1) as string);
  }
  const replay = replayGame(base, omniscientLog(battle.log));
  const position = replay.positions.find(
    (entry) =>
      entry.pending.length === 1 && requestActionCandidates(entry.requests[entry.pending[0] as Pid]).length >= 2,
  );
  assert.ok(position, 'the deterministic game reached a one-sided replacement with multiple legal actions');
  return position;
}

test('a one-sided replacement uses only the unilateral null-opponent census', () => {
  const position = oneSidedReplacement();
  const pid = position.pending[0] as Pid;
  const table = evaluateActionTable(position, pid, { ...BUDGET, horizon: 0, seed: 'unilateral' });
  assert.ok(table);
  for (const panel of [...table.stability, table.measurement]) {
    assert.equal(panel.opponentPopulation, 1);
    assert.equal(panel.opponentSlots, 1);
    assert.ok(panel.draws.every((draw) => draw.opponentAction === null));
  }
});

test('both sides of the same position produce complete exhaustive tables', () => {
  const position = battleTurn();
  for (const pid of ['p1', 'p2'] as const) {
    const table = evaluateActionTable(position, pid, { ...BUDGET, horizon: 0, seed: `both:${pid}` });
    assert.ok(table);
    assert.equal(table.pid, pid);
    assert.equal(table.measurement.actions.length, table.legal);
    assert.ok(table.measurement.matrix.every((row) => row.length === table.legal));
  }
});
