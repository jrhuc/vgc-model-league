import assert from 'node:assert/strict';
import test from 'node:test';

import { facedPositions, fitPaired, type PairedDecision, readPaired } from '../src/eval/paired.js';

function side(overrides: Partial<PairedDecision> = {}): PairedDecision {
  return {
    game: 'run:series:1',
    position: 0,
    model: 'model-a',
    opponent: 'model-b',
    phase: 'decision',
    exAnte: 0.1,
    spread: 1,
    discriminating: true,
    ...overrides,
  };
}

function facing(left: string, right: string, leftRegret: number, rightRegret: number, game: string, position: number) {
  return [
    side({ game, position, model: left, opponent: right, exAnte: leftRegret }),
    side({ game, position, model: right, opponent: left, exAnte: rightRegret }),
  ];
}

test('a position becomes a comparison only when both sides were graded', () => {
  const faced = facedPositions([
    ...facing('a', 'b', 0.3, 0.1, 'g1', 0),
    side({ game: 'g1', position: 1, model: 'a' }),
    ...facing('a', 'b', 0.2, 0.2, 'g1', 2).map((row, index) => (index ? { ...row, discriminating: false } : row)),
  ]);
  assert.equal(faced.length, 1);
  assert.equal(faced[0]?.left, 'a');
  assert.ok(Math.abs((faced[0]?.difference ?? 0) - 0.2) < 1e-9);
});

test('a model playing itself is not evidence about which is better', () => {
  assert.equal(facedPositions(facing('a', 'a', 0.4, 0.1, 'g1', 0)).length, 0);
});

test('the cohort a model met is differenced out', () => {
  const rows: PairedDecision[] = [];
  for (let index = 0; index < 30; index += 1) {
    rows.push(...facing('careful', 'loose', 0.05, 0.15, `easy:${index}`, index));
    rows.push(...facing('middling', 'loose', 0.5, 0.6, `hard:${index}`, index));
  }
  const fit = fitPaired(rows, { resamples: 200, seed: 'fixed', minOpponents: 1 });
  const effect = (model: string) => fit.scores.find((entry) => entry.model === model)?.effect.mean ?? Number.NaN;
  assert.ok(effect('careful') < effect('loose'));
  assert.ok(Math.abs(effect('loose') - effect('middling') - 0.1) < 0.02);
});

test('models that never met enough positions are named rather than ranked', () => {
  const rows = [...facing('a', 'b', 0.1, 0.2, 'g1', 0)];
  for (let index = 0; index < 40; index += 1) rows.push(...facing('c', 'd', 0.1, 0.2, `g:${index}`, index));
  const fit = fitPaired(rows, { resamples: 50, seed: 'fixed', minOpponents: 1 });
  assert.deepEqual(
    fit.scores.map((entry) => entry.model),
    ['c', 'd'],
  );
  assert.deepEqual(fit.isolated, ['a', 'b']);
});

test('a difference the games do not support keeps zero inside its interval', () => {
  const rows: PairedDecision[] = [];
  for (let index = 0; index < 30; index += 1) {
    rows.push(...facing('a', 'b', index % 2 ? 0.4 : 0, index % 2 ? 0 : 0.4, `g:${index}`, index));
  }
  const fit = fitPaired(rows, { resamples: 300, seed: 'fixed', minOpponents: 1 });
  assert.equal(fit.comparisons.length, 0);
});

test('a difference every game agrees on is reported as separated', () => {
  const rows: PairedDecision[] = [];
  for (let index = 0; index < 30; index += 1) rows.push(...facing('a', 'b', 0.02, 0.4, `g:${index}`, index));
  const fit = fitPaired(rows, { resamples: 300, seed: 'fixed', minOpponents: 1 });
  assert.equal(fit.comparisons.length, 1);
  assert.ok((fit.comparisons[0]?.difference.high ?? 0) < 0);
});

test('a swingy position does not count for more than a quiet one', () => {
  const rows: PairedDecision[] = [];
  for (let index = 0; index < 20; index += 1) {
    const swingy = index % 2 === 0;
    const scale = swingy ? 1 : 0.2;
    rows.push(
      side({ game: `g:${index}`, position: index, model: 'a', opponent: 'b', exAnte: 0.1 * scale, spread: scale }),
      side({ game: `g:${index}`, position: index, model: 'b', opponent: 'a', exAnte: 0.5 * scale, spread: scale }),
    );
  }
  const share = fitPaired(rows, { resamples: 200, seed: 'fixed', minOpponents: 1 });
  const raw = fitPaired(rows, { resamples: 200, seed: 'fixed', minOpponents: 1, metric: 'regret' });
  const gap = (fit: typeof share) =>
    (fit.scores.find((entry) => entry.model === 'b')?.effect.mean ?? 0) -
    (fit.scores.find((entry) => entry.model === 'a')?.effect.mean ?? 0);
  assert.ok(Math.abs(gap(share) - 0.4) < 0.02);
  assert.ok(gap(raw) < 0.3);
});

test('the shape the grader writes carries both sides of a position', () => {
  const [row] = readPaired([
    {
      run_id: 'r',
      series_id: 's',
      game_number: 3,
      position_index: 7,
      model: 'a',
      opponent: 'b',
      phase: 'decision',
      ex_ante: { regret: 0.2, spread: 0.8, discriminating: true },
      ex_post: { regret: 0.3, discriminating: true },
    },
    { run_id: 'r', model: 'b' },
  ]);
  assert.equal(row?.game, 'r:s:3');
  assert.equal(row?.position, 7);
  assert.equal(row?.opponent, 'b');
  assert.equal(row?.spread, 0.8);
  assert.equal(readPaired([{ run_id: 'r' }]).length, 0);
});
