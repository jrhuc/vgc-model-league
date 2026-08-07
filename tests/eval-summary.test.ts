import assert from 'node:assert/strict';
import test from 'node:test';

import { type GradedDecision, readGraded, separated, summarize } from '../src/eval/summary.js';

function decision(overrides: Partial<GradedDecision> = {}): GradedDecision {
  return {
    runId: 'run',
    seriesId: 'series',
    gameNumber: 1,
    model: 'model-a',
    phase: 'decision',
    exPost: 0.2,
    exAnte: 0.1,
    discriminating: true,
    ...overrides,
  };
}

test('graded rows are read from the shape the grader writes', () => {
  const [row] = readGraded([
    {
      run_id: 'r',
      series_id: 's',
      game_number: 2,
      model: 'model-a',
      phase: 'team_preview',
      ex_post: { regret: 0.4, discriminating: true },
      ex_ante: { regret: 0.1, discriminating: true },
    },
    { run_id: 'r', model: 'model-b' },
  ]);
  assert.equal(row?.gameNumber, 2);
  assert.equal(row?.exPost, 0.4);
  assert.equal(row?.discriminating, true);
  assert.equal(readGraded([{ run_id: 'r' }]).length, 0);
});

test('a decision the value function could not tell apart is left out of the mean', () => {
  const summary = summarize([decision({ exAnte: 0.5 }), decision({ exAnte: 0, discriminating: false, gameNumber: 2 })]);
  assert.equal(summary[0]?.decisions, 1);
  assert.equal(summary[0]?.exAnte.mean, 0.5);
});

test('phases can be read separately, because team preview is a different decision', () => {
  const rows = [
    decision({ phase: 'team_preview', exAnte: 0.4 }),
    decision({ phase: 'decision', exAnte: 0.1, gameNumber: 2 }),
  ];
  assert.equal(summarize(rows, { phases: ['team_preview'] })[0]?.exAnte.mean, 0.4);
  assert.equal(summarize(rows, { phases: ['decision'] })[0]?.exAnte.mean, 0.1);
});

test('the interval widens when the same decisions come from fewer games', () => {
  const spread = (gameCount: number) =>
    summarize(
      Array.from({ length: 24 }, (_, index) =>
        decision({ gameNumber: index % gameCount, exAnte: index % 2 === 0 ? 0 : 0.4 }),
      ),
      { resamples: 400, seed: 'fixed' },
    )[0];

  const many = spread(12);
  const few = spread(2);
  assert.equal(many?.decisions, few?.decisions);
  assert.ok(many && few);
  assert.ok(few.exAnte.high - few.exAnte.low > many.exAnte.high - many.exAnte.low);
});

test('the read gap is what hindsight adds, and is reported with the same uncertainty', () => {
  const summary = summarize(
    Array.from({ length: 10 }, (_, index) => decision({ gameNumber: index, exAnte: 0.1, exPost: 0.3 })),
    { resamples: 200, seed: 'fixed' },
  );
  assert.ok(Math.abs((summary[0]?.readGap.mean ?? 0) - 0.2) < 1e-9);
  assert.ok((summary[0]?.readGap.low ?? 0) <= (summary[0]?.readGap.mean ?? 0));
});

test('two models are only called apart when their intervals do not overlap', () => {
  const rows = [
    ...Array.from({ length: 20 }, (_, index) => decision({ model: 'clean', gameNumber: index, exAnte: 0.01 })),
    ...Array.from({ length: 20 }, (_, index) => decision({ model: 'loose', gameNumber: index, exAnte: 0.5 })),
    ...Array.from({ length: 20 }, (_, index) =>
      decision({ model: 'noisy', gameNumber: index, exAnte: index % 2 ? 0 : 1 }),
    ),
  ];
  const summary = summarize(rows, { resamples: 500, seed: 'fixed' });
  const find = (model: string) => summary.find((entry) => entry.model === model);
  const clean = find('clean');
  const loose = find('loose');
  const noisy = find('noisy');
  assert.ok(clean && loose && noisy);
  assert.equal(separated(clean, loose), true);
  assert.equal(separated(loose, noisy), false);
  assert.equal(summary[0]?.model, 'clean');
});
