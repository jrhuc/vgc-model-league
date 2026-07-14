import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { SeriesRecord } from '../src/records.js';

import { appendRow, h2h, standings } from '../src/records.js';
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

test('ratings follow scheduled order rather than completion order', () => {
  const rows = [
    { ...row('a', 'b', 'a'), run_id: 'run', series_index: 0 },
    { ...row('a', 'b', 'b'), run_id: 'run', series_index: 1 },
    { ...row('a', 'c', 'a'), run_id: 'run', series_index: 2 },
  ];
  assert.deepEqual(standings(rows), standings([...rows].reverse()));
});

test('HTML reports include nested games and filter pools', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgcbench-records-'));
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
  const report = path.join(directory, 'report.html');
  writeReport(records, report, 'alpha');
  const html = fs.readFileSync(report, 'utf8');
  assert.match(html, /1 completed series for pool alpha/);
  assert.match(html, /series-1/);
  assert.match(html, /game-1\.log/);
  assert.doesNotMatch(html, /excluded-c/);
});
