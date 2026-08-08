import assert from 'node:assert/strict';
import test from 'node:test';

import { clusterNearDuplicatePositions, jaccard, positionDuplicateFeatures } from '../src/eval/duplicates.js';

const prompt = (state: string) =>
  `Choose one legal joint action.\n\n${state}\n\nLEGAL JOINT ACTIONS:\n0. Protect\n\nReturn JSON.`;

test('near-duplicate features isolate the visible position and normalize numeric drift', () => {
  const first = positionDuplicateFeatures(prompt('Turn 2: Pelipper HP 51 rain Tailwind active'));
  const second = positionDuplicateFeatures(prompt('Turn 9: Pelipper HP 37 rain Tailwind active'));
  assert.deepEqual(first, second);
  assert.equal(jaccard(first, second), 1);
  assert.ok(jaccard(first, positionDuplicateFeatures(prompt('Flutter Mane uses Moonblast in sun'))) < 1);
  assert.throws(() => positionDuplicateFeatures('no frozen markers'), /section markers/);
  assert.throws(() => positionDuplicateFeatures(`${prompt('state')}\n\nLEGAL JOINT ACTIONS:`), /section markers/);
});

test('near-duplicate components are deterministic and keep pair evidence', () => {
  const candidates = [
    { id: 'b', prompt: prompt('Turn 9: Pelipper HP 37 rain Tailwind active') },
    { id: 'c', prompt: prompt('Flutter Mane uses Moonblast in sun') },
    { id: 'a', prompt: prompt('Turn 2: Pelipper HP 51 rain Tailwind active') },
  ];
  const clustered = clusterNearDuplicatePositions(candidates, 1);
  assert.equal(clustered.clusters.get('a'), clustered.clusters.get('b'));
  assert.notEqual(clustered.clusters.get('a'), clustered.clusters.get('c'));
  assert.deepEqual(clustered.pairs, [{ first: 'a', second: 'b', similarity: 1 }]);
  assert.deepEqual(clusterNearDuplicatePositions([...candidates].reverse(), 1).clusters, clustered.clusters);
  assert.throws(() => clusterNearDuplicatePositions(candidates, 1.1), /threshold/);
});
