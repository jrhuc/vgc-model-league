import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readJsonlObjects } from '../src/jsonl.js';
import type { SeriesRecord } from '../src/records.js';

import { appendRow, loadSeriesRecords, modelKey, scopeRows } from '../src/records.js';
import { writeReport } from '../src/report.js';

function row(p1: string, p2: string, winner: string | null): SeriesRecord {
  const winnerSide = winner === p1 ? 'p1' : winner === p2 ? 'p2' : null;
  return {
    schema_version: 1,
    mode: 'rotation',
    protocol_version: 1,
    scaffold: 'fixture',
    timestamp: '2026-07-14T12:00:00Z',
    run_id: `run-${p1}-${p2}`,
    series_id: `series-${p1}-${p2}`,
    series_index: 0,
    format: 'test',
    players: { p1, p2 },
    teams: { p1: 'team-a', p2: 'team-b' },
    winner,
    winner_side: winnerSide,
    score: { p1: winnerSide === 'p1' ? 1 : 0, p2: winnerSide === 'p2' ? 1 : 0 },
    turns: 1,
    games: [
      {
        number: 1,
        winner,
        winner_side: winnerSide,
        turns: 1,
        seed: [1, 2, 3, 4],
      },
    ],
    engine_seeds: { p1: 1, p2: 2 },
    reasoning: null,
    decision_stats: { p1: {}, p2: {} },
    run_seed: 1,
    ps_commit: '0000000000000000000000000000000000000000',
  };
}

test('model identities normalize across providers and gateways', () => {
  assert.equal(modelKey('openai:gpt-5.6-terra'), 'gpt-5.6-terra');
  assert.equal(modelKey('opencode-go:gpt-5.6-terra'), 'gpt-5.6-terra');
  assert.equal(modelKey('openrouter:deepseek/deepseek-v4'), 'deepseek-v4');
  assert.equal(modelKey('deepseek:DeepSeek-V4'), 'deepseek-v4');
  assert.equal(modelKey('random'), 'random');
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
    ['a', 'legacy-a', 't1', 'e1'],
    'overall play data includes every non-test mode',
  );
  assert.equal(scopeRows(rows, 'regmb-202607').length, 3);
  assert.deepEqual(
    scopeRows(rows, 'test').map((item) => item.players.p2),
    ['b'],
  );
});

test('generic journals remain JSON objects while result authority requires the current series schema', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-model-league-record-types-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const journal = path.join(directory, 'draft.jsonl');
  fs.writeFileSync(journal, '{"kind":"draft_pick","pick":1}\n');
  assert.deepEqual(readJsonlObjects(journal), [{ kind: 'draft_pick', pick: 1 }]);
  assert.throws(() => loadSeriesRecords(journal), /not a current series record/);

  const results = path.join(directory, 'results.jsonl');
  fs.writeFileSync(results, `${JSON.stringify({ ...row('a', 'b', 'a'), unexpected: true })}\n`);
  assert.throws(() => loadSeriesRecords(results), /Unrecognized key: "unexpected"/);
});

test('record loading ignores whitespace-only lines', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-model-league-records-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const records = path.join(directory, 'results.jsonl');
  fs.writeFileSync(records, `${JSON.stringify(row('a', 'b', 'a'))}\n   \n`);
  assert.deepEqual(loadSeriesRecords(records), [row('a', 'b', 'a')]);
});

test('record loading retains valid rows before a torn final JSONL fragment', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-model-league-records-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const records = path.join(directory, 'results.jsonl');
  const first = row('a', 'b', 'a');
  const second = row('c', 'd', 'c');
  fs.writeFileSync(records, `${JSON.stringify(first)}\n${JSON.stringify(second)}\n{"players":{"p1":"partial"`);
  assert.deepEqual(loadSeriesRecords(records), [first, second]);
});

test('record append removes a torn tail before committing the new row', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-model-league-records-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const records = path.join(directory, 'results.jsonl');
  const first = row('a', 'b', 'a');
  const replacement = row('c', 'd', 'd');
  fs.writeFileSync(records, `${JSON.stringify(first)}\n{"players":{"p1":"partial"`);

  appendRow(records, replacement);

  assert.deepEqual(loadSeriesRecords(records), [first, replacement]);
  assert.doesNotMatch(fs.readFileSync(records, 'utf8'), /partial/);
});

test('record append preserves a valid unterminated object with a separator', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-model-league-records-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const records = path.join(directory, 'results.jsonl');
  const first = row('a', 'b', 'a');
  const second = row('c', 'd', 'c');
  fs.writeFileSync(records, JSON.stringify(first));

  appendRow(records, second);

  assert.deepEqual(loadSeriesRecords(records), [first, second]);
});

test('record append rejects committed malformed rows without changing the journal', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-model-league-records-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const records = path.join(directory, 'results.jsonl');
  const malformed = `${JSON.stringify(row('a', 'b', 'a'))}\n{"players":\n`;
  fs.writeFileSync(records, malformed);

  assert.throws(() => appendRow(records, row('c', 'd', 'c')), /invalid JSONL line 2/);
  assert.equal(fs.readFileSync(records, 'utf8'), malformed);
});

test('record append rejects malformed interior rows without changing the journal', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-model-league-records-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const records = path.join(directory, 'results.jsonl');
  const malformed = `${JSON.stringify(row('a', 'b', 'a'))}\n{"players":\n${JSON.stringify(row('c', 'd', 'c'))}`;
  fs.writeFileSync(records, malformed);

  assert.throws(() => appendRow(records, row('e', 'f', 'e')), /invalid JSONL line 2/);
  assert.equal(fs.readFileSync(records, 'utf8'), malformed);
});

test('record append refuses a semantic-invalid unterminated tail', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-model-league-records-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const records = path.join(directory, 'results.jsonl');
  fs.writeFileSync(records, '42');

  assert.throws(() => appendRow(records, row('a', 'b', 'a')), /invalid unterminated JSONL tail/);
  assert.equal(fs.readFileSync(records, 'utf8'), '42');
});

test('record loading rejects a terminated malformed final JSONL row', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-model-league-records-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const records = path.join(directory, 'results.jsonl');
  fs.writeFileSync(records, `${JSON.stringify(row('a', 'b', 'a'))}\n{"players":\n`);
  assert.throws(() => loadSeriesRecords(records), /invalid JSONL line 2.*results\.jsonl/);
});

test('record loading rejects a malformed interior JSONL row with its line number', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-model-league-records-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const records = path.join(directory, 'results.jsonl');
  fs.writeFileSync(
    records,
    `${JSON.stringify(row('a', 'b', 'a'))}\n{"players":\n${JSON.stringify(row('c', 'd', 'c'))}\n`,
  );
  assert.throws(() => loadSeriesRecords(records), /invalid JSONL line 2.*results\.jsonl/);
});

test('record loading invalidates a cached torn tail after it is completed by an append', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-model-league-records-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const records = path.join(directory, 'results.jsonl');
  const first = row('a', 'b', 'a');
  const second = row('c', 'd', 'c');
  const secondJson = JSON.stringify(second);
  const cut = Math.floor(secondJson.length / 2);
  fs.writeFileSync(records, `${JSON.stringify(first)}\n${secondJson.slice(0, cut)}`);
  const cached = loadSeriesRecords(records);
  assert.deepEqual(cached, [first]);
  assert.equal(loadSeriesRecords(records), cached, 'an unchanged torn snapshot returns the cached valid prefix');

  fs.appendFileSync(records, `${secondJson.slice(cut)}\n`);

  const completed = loadSeriesRecords(records);
  assert.deepEqual(completed, [first, second]);
  assert.notEqual(completed, cached, 'the changed size invalidates the cached torn snapshot');
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
      {
        number: 1,
        winner: 'included-a',
        winner_side: 'p1',
        turns: 5,
        seed: [1, 2, 3, 4],
        log: 'game-1.log',
      },
      {
        number: 2,
        winner: 'included-a',
        winner_side: 'p1',
        turns: 7,
        seed: [5, 6, 7, 8],
        log: 'game-2.log',
      },
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
  assert.match(html, /not an aggregate model ranking/);
  assert.doesNotMatch(html, /Elo|Head-to-head|Win rate/);
  assert.doesNotMatch(html, /excluded-c/);

  const overall = path.join(directory, 'report-overall.html');
  writeReport(records, overall);
  const overallHtml = fs.readFileSync(overall, 'utf8');
  assert.match(overallHtml, /2 completed series across all pools \(pool test excluded\)/);
  assert.match(overallHtml, /excluded-c/);
  assert.doesNotMatch(overallHtml, /scratch-e/);
});
