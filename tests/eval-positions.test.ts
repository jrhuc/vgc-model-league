import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ANONYMOUS,
  anonymiseLog,
  anonymiseRequest,
  type CandidatePosition,
  gameOf,
  keyOf,
  MIN_HELD_OUT_QUALIFICATION_SPAN,
  POSITION_SET_PER_GAME_CAP,
  POSITION_SET_TARGET_SIZE,
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
    positionDigest: 'digest',
    pid: 'p1',
    format: 'gen9championsvgc2026regmbbo3',
    scaffold: 'rev',
    phase: 'turn',
    turn: 5,
    legal: 40,
    value: 0,
    heldOutQualificationSpan: 0.5,
    played: 'move 1, move 1',
    ...overrides,
  };
}

test('a position is placed by phase, how far in, and who was ahead', () => {
  assert.equal(stratumOf(candidate({ phase: 'team_preview', turn: 0 })), 'team_preview/preview/level');
  assert.equal(stratumOf(candidate({ turn: 2, value: 0.5 })), 'turn/early/far-ahead');
  assert.equal(stratumOf(candidate({ turn: 12, value: -0.2 })), 'turn/late/behind');
});

test('qualification span and legal-action thresholds are inclusive and finite', () => {
  const rows = [
    candidate({ positionIndex: 0, heldOutQualificationSpan: Number.NaN }),
    candidate({ positionIndex: 1, heldOutQualificationSpan: MIN_HELD_OUT_QUALIFICATION_SPAN - 0.001 }),
    candidate({ positionIndex: 2, legal: 1 }),
    candidate({ positionIndex: 3, heldOutQualificationSpan: MIN_HELD_OUT_QUALIFICATION_SPAN, legal: 2 }),
  ];
  const selection = selectPositions(rows, { size: 10, seed: 'fixed' });
  assert.equal(selection.rejected, 3);
  assert.equal(selection.positions.length, 1);
});

test('the frozen position-set target caps each source game at two tasks', () => {
  assert.equal(POSITION_SET_TARGET_SIZE, 500);
  assert.equal(POSITION_SET_PER_GAME_CAP, 2);
  const rows = Array.from({ length: 5 }, (_, index) => candidate({ positionIndex: index }));
  const selection = selectPositions(rows, { size: 5, seed: 'fixed' });
  assert.equal(selection.positions.length, 2);
  assert.equal(selection.games, 1);
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
  const second = selectPositions([...rows].reverse(), { size: 40, seed: 'fixed' });
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

test('the graded rows project only versioned grade-time eligibility metrics', () => {
  const source = {
    run_id: 'r',
    series_id: 's',
    game_number: 2,
    position_index: 4,
    position_digest: 'digest-4',
    pid: 'p2',
    generating_models: { p1: 'p1-openrouter:model-a', p2: 'p2-anthropic:model-b' },
    format: 'gen9championsvgc2026regmbbo3',
    scaffold: 'rev',
    phase: 'turn',
    turn: 6,
    legal_actions: 999,
    chosen: 'move 1, move 2',
    state_value: -0.2,
    eligibility_metrics: { version: 1, legalActions: 88, heldOutSpanValue: 0.6 },
    measurement_value: 99,
    measurement_panel: { span: 999 },
  };
  const [row] = readCandidates([source, { run_id: 'r', pid: 'p1' }]);
  assert.equal(row?.pid, 'p2');
  assert.equal(row?.value, -0.2);
  assert.equal(row?.legal, 88);
  assert.equal(row?.heldOutQualificationSpan, 0.6);
  assert.equal(row?.played, 'move 1, move 2');

  const changedMeasurement = structuredClone(source);
  changedMeasurement.legal_actions = 1;
  changedMeasurement.measurement_value = -99;
  changedMeasurement.measurement_panel = { span: 0 };
  assert.deepEqual(readCandidates([changedMeasurement]), readCandidates([source]));

  const changedProvenance = {
    ...source,
    generating_models: { p1: 'p1-prime:model-c', p2: 'p2-openrouter:model-d' },
  };
  assert.deepEqual(readCandidates([changedProvenance]), readCandidates([source]));
});

test('missing, wrong-version, and malformed eligibility metrics are rejected rather than defaulted', () => {
  const base = {
    run_id: 'r',
    series_id: 's',
    game_number: 1,
    position_index: 1,
    position_digest: 'digest',
    pid: 'p1',
    state_value: 0,
  };
  const rows = [
    base,
    { ...base, position_index: 2, eligibility_metrics: { version: 2, legalActions: 2, heldOutSpanValue: 1 } },
    { ...base, position_index: 3, eligibility_metrics: { version: 1, legalActions: 2 } },
    {
      ...base,
      position_index: 4,
      eligibility_metrics: { version: 1, legalActions: 2, heldOutSpanValue: Number.NaN },
    },
    { ...base, position_index: 5, eligibility_metrics: { version: 1, legalActions: 1.5, heldOutSpanValue: 1 } },
  ];
  assert.deepEqual(readCandidates(rows), []);
});

test('a position does not tell a model who played it or who it faced', () => {
  const names = { p1: 'p1-openrouter:anthropic/claude-opus-5', p2: 'p2-openrouter:x-ai/grok-4.5' };
  const seen = anonymiseLog(
    [
      '|player|p1|p1-openrouter:anthropic/claude-opus-5||',
      '|player|p2|p2-openrouter:x-ai/grok-4.5||',
      '|switch|p1a: Whimsicott|Whimsicott, L50, F|137/137',
      '|win|p2-openrouter:x-ai/grok-4.5',
    ],
    names,
  );
  assert.equal(
    seen.some((line) => line.includes('openrouter')),
    false,
  );
  assert.equal(seen[0], '|player|p1|Player 1||');
  assert.equal(seen[3], `|win|${ANONYMOUS.p2}`);
  assert.equal(seen[2], '|switch|p1a: Whimsicott|Whimsicott, L50, F|137/137');
});

test('the complete public request removes the source battle name', () => {
  const request = {
    side: {
      name: 'p1-openrouter:model-a',
      pokemon: [{ ident: 'p1: Lead', details: 'Lead', condition: '100/100', active: true }],
    },
    active: [{ moves: [] }],
  } as never;
  const cleaned = anonymiseRequest(request, {
    p1: 'p1-openrouter:model-a',
    p2: 'p2-anthropic:model-b',
  });
  const serialized = JSON.stringify(cleaned);
  assert.ok(!serialized.includes('openrouter:model-a'));
  assert.ok(serialized.includes(ANONYMOUS.p1));
});

test('duplicate source decisions cannot fill a position set', () => {
  const repeated = Array.from({ length: 10 }, () => candidate());
  const selected = selectPositions(repeated, { size: 10, perGame: 10 });
  assert.equal(selected.positions.length, 1);
  assert.equal(new Set(selected.positions.map(keyOf)).size, selected.positions.length);
});

test('a seat whose name contains the other seat name is still replaced whole', () => {
  const seen = anonymiseLog(['|player|p1|alpha||', '|player|p2|alpha-two||'], { p1: 'alpha', p2: 'alpha-two' });
  assert.deepEqual(seen, ['|player|p1|Player 1||', '|player|p2|Player 2||']);
});
