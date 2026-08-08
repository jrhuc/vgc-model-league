import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assignPositionSplits,
  assignStratifiedPositionSplits,
  positionSplitDigest,
  type SplitCandidate,
  splitBalance,
} from '../src/eval/splits.js';

const rows: SplitCandidate[] = [
  { taskId: 'a', sourceGroup: 'game-1', duplicateCluster: 'state-a' },
  { taskId: 'b', sourceGroup: 'game-1', duplicateCluster: 'state-b' },
  { taskId: 'c', sourceGroup: 'game-2', duplicateCluster: 'state-b' },
  { taskId: 'd', sourceGroup: 'game-3', duplicateCluster: 'state-d' },
  { taskId: 'e', sourceGroup: 'game-4', duplicateCluster: 'state-e' },
];

test('source games and duplicate clusters cannot cross immutable splits', () => {
  const assignments = assignPositionSplits(rows, 'split-1', 0.5);
  const byId = Object.fromEntries(assignments.map((entry) => [entry.taskId, entry]));
  assert.equal(byId.a?.split, byId.b?.split);
  assert.equal(byId.b?.split, byId.c?.split);
  assert.equal(byId.a?.componentId, byId.c?.componentId);
});

test('split assignment and digest ignore worker completion order', () => {
  const first = assignPositionSplits(rows, 'split-1', 0.5);
  const second = assignPositionSplits([...rows].reverse(), 'split-1', 0.5);
  assert.deepEqual(first, second);
  assert.equal(positionSplitDigest(first), positionSplitDigest(second));
  const changed = first.map((entry, index) =>
    index === 0 ? { ...entry, split: entry.split === 'train' ? ('eval' as const) : ('train' as const) } : entry,
  );
  assert.notEqual(positionSplitDigest(first), positionSplitDigest(changed));
});

test('split inputs reject ambiguous identities and invalid fractions', () => {
  assert.throws(() => assignPositionSplits([rows[0]!, rows[0]!], 'x', 0.5), /duplicate task/);
  assert.throws(() => assignPositionSplits(rows, 'x', 0), /between zero and one/);
});

test('stratified allocation balances declared strata without breaking leakage components', () => {
  const candidates = Array.from({ length: 16 }, (_, index) => ({
    taskId: `task-${String(index).padStart(2, '0')}`,
    sourceGroup: index < 2 ? 'shared-source' : `source-${index}`,
    duplicateCluster: index >= 8 && index < 10 ? 'shared-duplicate' : `duplicate-${index}`,
    stratum: index % 2 ? 'turn|high' : 'turn|low',
  }));
  const assignments = assignStratifiedPositionSplits(candidates, 'stratified-seed', 0.25);
  const byId = new Map(assignments.map((entry) => [entry.taskId, entry]));
  assert.equal(byId.get('task-00')?.split, byId.get('task-01')?.split);
  assert.equal(byId.get('task-08')?.split, byId.get('task-09')?.split);
  const balance = splitBalance(assignments, 0.25);
  assert.ok(balance.evalFractionDeviation <= 0.125);
  assert.ok(balance.maxStratumDeviation <= 0.125);
  assert.deepEqual(assignStratifiedPositionSplits([...candidates].reverse(), 'stratified-seed', 0.25), assignments);
});

test('pathological components are deterministic and the local repair is no worse than greedy', () => {
  const target = 0.25;
  const componentSizes = [8, 7, 6];
  const candidates = componentSizes.flatMap((size, component) =>
    Array.from({ length: size }, (_, member) => ({
      taskId: `component-${component}-task-${member}`,
      sourceGroup: `source-${component}`,
      duplicateCluster: `duplicate-${component}-${member}`,
      stratum: 'only-stratum',
    })),
  );
  const assignments = assignStratifiedPositionSplits(candidates, 'pathological-seed', target);
  const initialGreedyEvalFraction = 8 / candidates.length;
  const initialGreedyObjective = 2 * (initialGreedyEvalFraction - target) ** 2;
  const balance = splitBalance(assignments, target);
  const repairedObjective =
    balance.evalFractionDeviation ** 2 +
    Object.values(balance.strata).reduce((sum, stratum) => sum + stratum.deviation ** 2, 0);
  assert.ok(repairedObjective < initialGreedyObjective);
  assert.equal(assignments.filter((entry) => entry.split === 'eval').length, 6);
  for (const component of componentSizes.keys()) {
    const group = assignments.filter((entry) => entry.sourceGroup === `source-${component}`);
    assert.equal(new Set(group.map((entry) => entry.componentId)).size, 1);
    assert.equal(new Set(group.map((entry) => entry.split)).size, 1);
  }
  assert.deepEqual(assignStratifiedPositionSplits([...candidates].reverse(), 'pathological-seed', target), assignments);
});

test('split balance reports deviation when a stratum is empty on either side', () => {
  const balance = splitBalance(
    [
      {
        taskId: 'eval-1',
        sourceGroup: 'eval-source-1',
        duplicateCluster: 'eval-duplicate-1',
        componentId: 'eval-component-1',
        stratum: 'eval-only',
        split: 'eval',
      },
      {
        taskId: 'eval-2',
        sourceGroup: 'eval-source-2',
        duplicateCluster: 'eval-duplicate-2',
        componentId: 'eval-component-2',
        stratum: 'eval-only',
        split: 'eval',
      },
      {
        taskId: 'train-1',
        sourceGroup: 'train-source-1',
        duplicateCluster: 'train-duplicate-1',
        componentId: 'train-component-1',
        stratum: 'train-only',
        split: 'train',
      },
      {
        taskId: 'train-2',
        sourceGroup: 'train-source-2',
        duplicateCluster: 'train-duplicate-2',
        componentId: 'train-component-2',
        stratum: 'train-only',
        split: 'train',
      },
    ],
    0.25,
  );
  assert.deepEqual(balance, {
    evalFraction: 0.5,
    evalFractionDeviation: 0.25,
    strata: {
      'eval-only': { total: 2, eval: 2, evalFraction: 1, deviation: 0.75 },
      'train-only': { total: 2, eval: 0, evalFraction: 0, deviation: 0.25 },
    },
    maxStratumDeviation: 0.75,
  });
});
