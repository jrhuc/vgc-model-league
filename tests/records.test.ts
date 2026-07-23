import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { SeriesRecord } from '../src/records.js';

import { appendRow, h2h, loadRows, modelKey, scopeRows, speedGroups, speedLabel, standings } from '../src/records.js';
import { writeReport } from '../src/report.js';

function row(p1: string, p2: string, winner: string | null): SeriesRecord {
  return { players: { p1, p2 }, winner, games: [] };
}

test('standings calculate Elo, ties, and unknown winners', () => {
  const table = Object.fromEntries(
    standings([row('a', 'b', 'a'), row('a', 'b', null)]).map((item) => [item.spec, item]),
  );
  assert.equal(table.a!.w, 1);
  assert.equal(table.a!.t, 1);
  assert.equal(table.a!.winrate, 0.75);
  assert.ok(Math.abs(table.a!.elo - 1011.172385) < 0.0001);
  const unknown = Object.fromEntries(standings([row('a', 'b', 'ghost')]).map((item) => [item.spec, item]));
  assert.equal(unknown.a!.t, 1);
  assert.equal(unknown.b!.t, 1);
});

test('head-to-head and self-play use each model perspective', () => {
  const matrix = h2h([row('a', 'b', 'a'), row('b', 'a', null), row('b', 'a', 'b')]);
  assert.deepEqual(matrix.a!.b, [1, 1, 1]);
  assert.deepEqual(matrix.b!.a, [1, 1, 1]);
  const self = standings([row('a', 'a', 'a')])[0]!;
  assert.equal(self.elo, 1000);
  assert.equal(self.series, 2);
  assert.deepEqual(h2h([row('a', 'a', 'a')]).a!.a, [1, 1, 0]);
});

test('the same model merges across providers and gateways', () => {
  assert.equal(modelKey('openai:gpt-5.6-terra'), 'gpt-5.6-terra');
  assert.equal(modelKey('opencode-go:gpt-5.6-terra'), 'gpt-5.6-terra');
  assert.equal(modelKey('openrouter:deepseek/deepseek-v4'), 'deepseek-v4');
  assert.equal(modelKey('deepseek:DeepSeek-V4'), 'deepseek-v4');
  assert.equal(modelKey('random'), 'random');

  const merged = standings([
    row('openai:gpt-5.6-terra', 'anthropic:claude-opus-4-10', 'openai:gpt-5.6-terra'),
    row('opencode-go:gpt-5.6-terra', 'anthropic:claude-opus-4-10', 'anthropic:claude-opus-4-10'),
  ]);
  assert.deepEqual(merged.map((item) => [item.spec, item.series, item.w, item.l]).sort(), [
    ['claude-opus-4-10', 2, 1, 1],
    ['gpt-5.6-terra', 2, 1, 1],
  ]);
  const matrix = h2h([row('openai:gpt-5', 'openrouter:openai/gpt-5', 'openai:gpt-5')]);
  assert.deepEqual(matrix['gpt-5']!['gpt-5'], [1, 1, 0], 'colliding identities count as self-play');
});

test('speed groups split rows with untimed first and legacy rows on the standard clock', () => {
  const rows = [
    { ...row('a', 'b', 'a'), timer_scale: 'off' as const },
    { ...row('a', 'b', 'b'), timer_scale: 1.5 },
    row('a', 'b', 'a'),
    { ...row('a', 'b', 'b'), timer_scale: 1 },
  ];
  const groups = speedGroups(rows);
  assert.deepEqual(
    groups.map(({ scale, rows: grouped }) => [scale, grouped.length]),
    [
      ['off', 1],
      [1, 2],
      [1.5, 1],
    ],
  );
  assert.equal(speedLabel('off'), 'Untimed');
  assert.equal(speedLabel(1.5), '1.5x clock');
});

test('scoping keeps the test pool out of overall views but selectable', () => {
  const rows = [
    { ...row('a', 'b', 'a'), pool: 'regmb-202607' },
    { ...row('a', 'b', 'b'), pool: 'test' },
    row('legacy-a', 'legacy-b', null),
    { ...row('t1', 't2', 't1'), pool: 'regmb-202607', mode: 'tournament' as const },
    { ...row('e1', 'e2', 'e1'), pool: 'regmb-202607', mode: 'exhibition' as const },
  ];
  assert.deepEqual(
    scopeRows(rows).map((item) => item.players.p1),
    ['a', 'legacy-a'],
  );
  assert.equal(scopeRows(rows, 'regmb-202607').length, 3);
  const rated = standings(scopeRows(rows, 'regmb-202607'));
  assert.deepEqual(
    rated.map((item) => item.spec),
    ['a', 'b'],
    'explicit pool views list every mode but rate only rotation rows',
  );
  assert.deepEqual(Object.keys(h2h(scopeRows(rows, 'regmb-202607'))), ['a', 'b']);
  assert.deepEqual(
    scopeRows(rows, 'test').map((item) => item.players.p2),
    ['b'],
  );
});

test('standings and head-to-head tolerate rows without players', () => {
  const malformed = { games: [] } as unknown as SeriesRecord;
  const table = standings([row('a', 'b', 'a'), malformed]);
  assert.equal(table.length, 2);
  assert.deepEqual(h2h([malformed]), {});
});

test('ratings follow scheduled order rather than completion order', () => {
  const rows = [
    { ...row('a', 'b', 'a'), run_id: 'run', series_index: 0 },
    { ...row('a', 'b', 'b'), run_id: 'run', series_index: 1 },
    { ...row('a', 'c', 'a'), run_id: 'run', series_index: 2 },
  ];
  assert.deepEqual(standings(rows), standings([...rows].reverse()));
});

test('record loading ignores whitespace-only lines', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-model-league-records-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const records = path.join(directory, 'results.jsonl');
  fs.writeFileSync(records, `${JSON.stringify(row('a', 'b', 'a'))}\n   \n`);
  assert.deepEqual(loadRows(records), [row('a', 'b', 'a')]);
});

test('HTML reports include nested games and filter pools', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-model-league-records-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const records = path.join(directory, 'results.jsonl');
  appendRow(records, {
    ...row('included-a', 'included-b', 'included-a'),
    timestamp: '2026-07-14T12:00:00Z',
    series_id: 'series-1',
    winner_side: 'p1',
    pool: 'alpha',
    teams: { p1: 'team-a', p2: 'team-b' },
    score: { p1: 2, p2: 0 },
    turns: 12,
    games: [
      { number: 1, winner: 'included-a', winner_side: 'p1', turns: 5, log: 'game-1.log' },
      { number: 2, winner: 'included-a', winner_side: 'p1', turns: 7, log: 'game-2.log' },
    ],
  });
  appendRow(records, { ...row('excluded-c', 'excluded-d', 'excluded-c'), pool: 'beta' });
  appendRow(records, { ...row('scratch-e', 'scratch-f', 'scratch-e'), pool: 'test' });
  const report = path.join(directory, 'report.html');
  writeReport(records, report, 'alpha');
  const html = fs.readFileSync(report, 'utf8');
  assert.match(html, /VGC Model League records/);
  assert.match(html, /1 completed series for pool alpha/);
  assert.match(html, /series-1/);
  assert.match(html, /game-1\.log/);
  assert.doesNotMatch(html, /excluded-c/);

  const overall = path.join(directory, 'report-overall.html');
  writeReport(records, overall);
  const overallHtml = fs.readFileSync(overall, 'utf8');
  assert.match(overallHtml, /2 completed series across all pools \(pool test excluded\)/);
  assert.match(overallHtml, /excluded-c/);
  assert.doesNotMatch(overallHtml, /scratch-e/);
});
