import assert from 'node:assert/strict';
import test from 'node:test';

import { assignPositionSplits, positionSplitDigest, type SplitCandidate } from '../src/eval/splits.js';

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
