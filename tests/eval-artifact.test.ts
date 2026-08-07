import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalScoreDigest, completedPositionScores } from '../src/eval/artifact.js';
import type { JsonObject } from '../src/types.js';

const PROTOCOL = { version: 3 };
const MANIFEST: JsonObject = { source_games: 1, counterfactual: PROTOCOL };

function score(overrides: JsonObject = {}): JsonObject {
  return {
    kind: 'position_score',
    run_id: 'run',
    series_id: 'series',
    game_number: 1,
    position_index: 2,
    pid: 'p1',
    counterfactual: PROTOCOL,
    state_value: 0.1,
    ...overrides,
  };
}

function marker(overrides: JsonObject = {}): JsonObject {
  return {
    kind: 'game_complete',
    run_id: 'run',
    series_id: 'series',
    game_number: 1,
    decisions: 1,
    complete: true,
    ...overrides,
  };
}

test('only score rows from a complete, protocol-consistent corpus are admitted', () => {
  assert.throws(() => completedPositionScores([score()], MANIFEST), /incomplete/);
  assert.throws(
    () => completedPositionScores([score({ counterfactual: { version: 2 } }), marker()], MANIFEST),
    /different counterfactual protocol/,
  );
  assert.throws(() => completedPositionScores([score(), marker({ decisions: 2 })], MANIFEST), /reports 2 scores/);
  assert.deepEqual(completedPositionScores([score(), marker()], MANIFEST), [score()]);
});

test('crash duplicates cannot become duplicate tasks or change the canonical digest', () => {
  const first = score();
  const rows = completedPositionScores([first, first, marker()], MANIFEST);
  assert.equal(rows.length, 1);
  assert.equal(canonicalScoreDigest(rows), canonicalScoreDigest([...rows].reverse()));
  assert.throws(
    () => completedPositionScores([first, score({ state_value: 0.2 }), marker()], MANIFEST),
    /conflicting duplicate score/,
  );
});
