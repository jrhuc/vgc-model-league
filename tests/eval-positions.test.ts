import assert from 'node:assert/strict';
import test from 'node:test';

import {
  type CandidatePosition,
  gameOf,
  keyOf,
  readCandidates,
  selectPositions,
  stratumOf,
} from '../src/eval/positions.js';

function candidate(overrides: Partial<CandidatePosition> = {}): CandidatePosition {
  return {
    runId: 'run',
    seriesId: 'series',
    gameNumber: 1,
    positionIndex: 0,
    pid: 'p1',
    format: 'gen9vgc',
    scaffold: 'rev',
    phase: 'turn',
    turn: 5,
    legal: 40,
    value: 0,
    spread: 0.5,
    played: 'move 1, move 1',
    discriminating: true,
    ...overrides,
  };
}

test('a position is placed by phase, how far in, and who was ahead', () => {
  assert.equal(stratumOf(candidate({ phase: 'team_preview', turn: 0 })), 'team_preview/preview/level');
  assert.equal(stratumOf(candidate({ turn: 2, value: 0.5 })), 'turn/early/decided');
  assert.equal(stratumOf(candidate({ turn: 12, value: -0.2 })), 'turn/late/tilted');
});

test('a position nothing could be learned from is not a candidate', () => {
  const rows = [
    candidate({ positionIndex: 0, discriminating: false }),
    candidate({ positionIndex: 1, spread: 0.001 }),
    candidate({ positionIndex: 2, legal: 1 }),
    candidate({ positionIndex: 3 }),
  ];
  const selection = selectPositions(rows, { size: 10, seed: 'fixed' });
  assert.equal(selection.rejected, 3);
  assert.equal(selection.positions.length, 1);
});

test('one long game cannot fill the set', () => {
  const rows = Array.from({ length: 60 }, (_, index) => candidate({ positionIndex: index, turn: 5 }));
  const selection = selectPositions(rows, { size: 50, seed: 'fixed', perGame: 3 });
  assert.equal(selection.positions.length, 3);
  assert.equal(selection.games, 1);
});

test('a rare kind of position is not crowded out by a common one', () => {
  const rows: CandidatePosition[] = [];
  for (let index = 0; index < 400; index += 1) {
    rows.push(candidate({ gameNumber: index, positionIndex: index, turn: 5, value: 0 }));
  }
  for (let index = 0; index < 12; index += 1) {
    rows.push(candidate({ gameNumber: 1_000 + index, positionIndex: index, phase: 'forced_switch', turn: 12 }));
  }
  const selection = selectPositions(rows, { size: 100, seed: 'fixed', perGame: 3 });
  const rare = selection.strata.find((entry) => entry.phase === 'forced_switch');
  const common = selection.strata.find((entry) => entry.phase === 'turn');
  assert.ok(rare && common);
  assert.ok(rare.taken > 0);
  assert.ok(rare.taken / rare.available > common.taken / common.available);
});

test('the same corpus and seed freeze the same set', () => {
  const rows = Array.from({ length: 200 }, (_, index) =>
    candidate({ gameNumber: index, positionIndex: index, turn: index % 14, value: (index % 7) / 10 }),
  );
  const first = selectPositions(rows, { size: 40, seed: 'fixed' });
  const second = selectPositions(rows, { size: 40, seed: 'fixed' });
  const third = selectPositions(rows, { size: 40, seed: 'other' });
  assert.deepEqual(first.positions.map(keyOf), second.positions.map(keyOf));
  assert.notDeepEqual(first.positions.map(keyOf), third.positions.map(keyOf));
});

test('both sides of a position are separate decisions to answer', () => {
  const rows = [candidate({ pid: 'p1' }), candidate({ pid: 'p2' })];
  assert.equal(gameOf(rows[0] as CandidatePosition), 'run:series:1');
  assert.notEqual(keyOf(rows[0] as CandidatePosition), keyOf(rows[1] as CandidatePosition));
  assert.equal(selectPositions(rows, { size: 10, seed: 'fixed', perGame: 3 }).positions.length, 2);
});

test('the graded rows carry everything a candidate needs', () => {
  const [row] = readCandidates([
    {
      run_id: 'r',
      series_id: 's',
      game_number: 2,
      position_index: 4,
      pid: 'p2',
      format: 'gen9vgc',
      scaffold: 'rev',
      phase: 'turn',
      turn: 6,
      legal_actions: 88,
      chosen: 'move 1, move 2',
      ex_ante: { regret: 0.1, spread: 0.6, chosen: -0.2, discriminating: true },
      ex_post: { regret: 0.2, discriminating: true },
    },
    { run_id: 'r', pid: 'p1' },
  ]);
  assert.equal(row?.pid, 'p2');
  assert.equal(row?.value, -0.2);
  assert.equal(row?.legal, 88);
  assert.equal(row?.played, 'move 1, move 2');
  assert.equal(readCandidates([{ run_id: 'r' }]).length, 0);
});
