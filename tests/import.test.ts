import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { GuiServer } from '../src/gui/server.js';
import { importSeries, removeImportedRun } from '../src/import.js';
import { loadSeriesRecords } from '../src/records.js';

const TOKEN = 'test-import-token';

interface Scratch {
  paths: { recordsPath: string; runsDir: string; teamsDir: string };
  dispose: () => void;
}

function scratch(): Scratch {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-import-'));
  const teamsDir = path.join(root, 'teams');
  fs.mkdirSync(teamsDir, { recursive: true });
  return {
    paths: { recordsPath: path.join(root, 'records', 'results.jsonl'), runsDir: path.join(root, 'runs'), teamsDir },
    dispose: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function bundleRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    mode: 'rotation',
    protocol_version: 1,
    scaffold: 'fixture',
    run_id: '20260725T000000.000000Z-abcd1234',
    series_id: 'aaaabbbbcccc',
    series_index: 0,
    pool: 'majors',
    timestamp: '2026-07-25T00:10:00.000Z',
    format: 'test',
    players: { p1: 'google:gemini-3.5-flash-lite', p2: 'random' },
    teams: { p1: 'team-a', p2: 'team-b' },
    winner: 'google:gemini-3.5-flash-lite',
    winner_side: 'p1',
    score: { p1: 2, p2: 0 },
    turns: 21,
    games: [
      {
        number: 1,
        winner: 'google:gemini-3.5-flash-lite',
        winner_side: 'p1',
        turns: 10,
        seed: [1, 2, 3, 4],
      },
      {
        number: 2,
        winner: 'google:gemini-3.5-flash-lite',
        winner_side: 'p1',
        turns: 11,
        seed: [5, 6, 7, 8],
      },
    ],
    engine_seeds: { p1: 1, p2: 2 },
    reasoning: null,
    decision_stats: { p1: {}, p2: {} },
    run_seed: 1,
    ps_commit: '0000000000000000000000000000000000000000',
    ...overrides,
  };
}

test('importSeries stores a row with its decision logs and stamps provenance', () => {
  const store = scratch();
  try {
    const result = importSeries(
      {
        row: bundleRow(),
        logs: { p1: '{"kind":"decision","latency_ms":1200}\n{"kind":"decision","latency_ms":900}' },
        runConfig: { mode: 'rotation', models: ['google:gemini-3.5-flash-lite', 'random'] },
      },
      store.paths,
    );
    assert.equal(result.imported, true);
    assert.deepEqual(result.logs, ['p1']);
    assert.equal(result.pool, null);

    const rows = loadSeriesRecords(store.paths.recordsPath);
    assert.equal(rows.length, 1);
    const origin = rows[0]!.origin as { source: string; at: string };
    assert.equal(origin.source, 'import');
    assert.ok(Date.parse(origin.at) > 0, 'the row records when the deployment accepted it');
    assert.equal(rows[0]!.players.p1, 'google:gemini-3.5-flash-lite', 'the row survives the trip unchanged');

    const logFile = path.join(
      store.paths.runsDir,
      String(rows[0]!.run_id),
      'series',
      'aaaabbbbcccc',
      'p1-decisions.jsonl',
    );
    assert.match(fs.readFileSync(logFile, 'utf8'), /latency_ms":1200/);
    assert.ok(fs.existsSync(path.join(store.paths.runsDir, String(rows[0]!.run_id), 'config.json')));

    const repeat = importSeries({ row: bundleRow() }, store.paths);
    assert.deepEqual(
      { imported: repeat.imported, duplicate: repeat.duplicate },
      { imported: false, duplicate: true },
      'a series already held is reported, not appended twice',
    );
    assert.equal(loadSeriesRecords(store.paths.recordsPath).length, 1);
  } finally {
    store.dispose();
  }
});

test('removeImportedRun deletes imported rows and mirrors but refuses local results', () => {
  const store = scratch();
  try {
    importSeries({ row: bundleRow(), games: { 'game-1.log': '|start\n' } }, store.paths);
    const runDir = path.join(store.paths.runsDir, '20260725T000000.000000Z-abcd1234');
    assert.ok(fs.existsSync(runDir));

    const lease = `${store.paths.recordsPath}.lease`;
    fs.writeFileSync(lease, JSON.stringify({ id: 'other-writer', pid: process.pid }));
    assert.throws(
      () => removeImportedRun('20260725T000000.000000Z-abcd1234', store.paths),
      /records.*owned by live pid/,
    );
    assert.equal(loadSeriesRecords(store.paths.recordsPath).length, 1, 'another records writer leaves rows untouched');
    assert.equal(fs.existsSync(runDir), true, 'another records writer leaves the imported mirror untouched');
    fs.rmSync(lease);

    const result = removeImportedRun('20260725T000000.000000Z-abcd1234', store.paths);
    assert.equal(result.removed, 1);
    assert.equal(loadSeriesRecords(store.paths.recordsPath).length, 0);
    assert.equal(fs.existsSync(runDir), false, 'the imported run mirror is deleted with its rows');

    assert.throws(() => removeImportedRun('20260725T000000.000000Z-abcd1234', store.paths), /no series held/);

    const local = bundleRow({ run_id: '20260725T111111.000000Z-eeee5678' });
    fs.mkdirSync(path.dirname(store.paths.recordsPath), { recursive: true });
    fs.appendFileSync(store.paths.recordsPath, `${JSON.stringify(local)}\n`);
    assert.throws(
      () => removeImportedRun('20260725T111111.000000Z-eeee5678', store.paths),
      /refusing to remove locally recorded results/,
    );
    assert.equal(loadSeriesRecords(store.paths.recordsPath).length, 1, 'local rows survive');
  } finally {
    store.dispose();
  }
});

test('importSeries stores game logs, backfilling rows it already holds', () => {
  const store = scratch();
  try {
    const games = { 'game-1.log': '|start\n|turn|1\n', 'game-2.log': '|start\n|turn|1\n|win|Testers\n' };
    const first = importSeries({ row: bundleRow(), games }, store.paths);
    assert.equal(first.imported, true);
    assert.deepEqual(first.games?.sort(), ['game-1.log', 'game-2.log']);

    const seriesDir = path.join(store.paths.runsDir, '20260725T000000.000000Z-abcd1234', 'series', 'aaaabbbbcccc');
    assert.match(fs.readFileSync(path.join(seriesDir, 'game-2.log'), 'utf8'), /win\|Testers/);

    const later = { ...games, 'game-3.log': '|start\n' };
    const backfill = importSeries({ row: bundleRow(), games: later }, store.paths);
    assert.equal(backfill.duplicate, true);
    assert.deepEqual(backfill.games, ['game-3.log'], 'only missing logs are written for a known series');
    assert.ok(fs.existsSync(path.join(seriesDir, 'game-3.log')));

    assert.throws(
      () => importSeries({ row: bundleRow({ series_id: 'ddddeeeeffff' }), games: { '../evil.log': '' } }, store.paths),
      /unsafe name/,
    );
  } finally {
    store.dispose();
  }
});

test('importSeries stores league assets, even for rows it already holds', () => {
  const store = scratch();
  try {
    const first = importSeries({ row: bundleRow({ mode: 'draft', pool: undefined }) }, store.paths);
    assert.equal(first.imported, true);
    assert.deepEqual(first.league, []);

    const league = {
      rosters: [{ model: 'random', team_name: 'Testers', roster: [{ id: 'pikachu', cost: 1 }] }],
      draft: '{"pick":1,"mon":"pikachu","rationale":"volt tackle"}',
      teambuild: '{"seriesIndex":1,"brought":["pikachu"]}',
      window: { after_week: 1, decisions: [], rosters: [] },
      season: '{"entrant":0,"review":"drafted for speed control and never used it"}',
    };
    const backfill = importSeries({ row: bundleRow({ mode: 'draft', pool: undefined }), league }, store.paths);
    assert.equal(backfill.duplicate, true);
    assert.deepEqual(backfill.league, [
      'rosters.json',
      'draft/draft.jsonl',
      'teambuild/teambuild.jsonl',
      'window.json',
      'season.jsonl',
    ]);

    const runDir = path.join(store.paths.runsDir, '20260725T000000.000000Z-abcd1234');
    const rosters = JSON.parse(fs.readFileSync(path.join(runDir, 'rosters.json'), 'utf8')) as unknown[];
    assert.equal((rosters[0] as { team_name: string }).team_name, 'Testers');
    assert.match(fs.readFileSync(path.join(runDir, 'draft', 'draft.jsonl'), 'utf8'), /volt tackle/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(runDir, 'window.json'), 'utf8')).after_week, 1);
    assert.match(fs.readFileSync(path.join(runDir, 'season.jsonl'), 'utf8'), /speed control/);

    const repeat = importSeries({ row: bundleRow({ mode: 'draft', pool: undefined }), league }, store.paths);
    assert.deepEqual(repeat.league, [], 'assets already on disk are left untouched');

    assert.throws(
      () => importSeries({ row: bundleRow({ series_id: 'ddddeeeeffff' }), league: { draft: 'not json' } }, store.paths),
      /not JSON/,
    );
    assert.throws(
      () =>
        importSeries(
          { row: bundleRow({ series_id: 'ddddeeeeffff' }), league: { rosters: 'nope' as unknown as unknown[] } },
          store.paths,
        ),
      /must be an array/,
    );
    assert.throws(
      () =>
        importSeries(
          {
            row: bundleRow({ series_id: 'ddddeeeeffff' }),
            league: { window: [] as unknown as Record<string, unknown> },
          },
          store.paths,
        ),
      /must be an object/,
    );
  } finally {
    store.dispose();
  }
});

test('importSeries rejects rows it cannot place on disk', () => {
  const store = scratch();
  try {
    assert.throws(() => importSeries({ row: bundleRow({ run_id: '../escape' }) }, store.paths), /path-safe/);
    assert.throws(() => importSeries({ row: bundleRow({ run_id: '..' }) }, store.paths), /path-safe/);
    assert.throws(() => importSeries({ row: bundleRow({ run_id: '.' }) }, store.paths), /path-safe/);
    assert.throws(() => importSeries({ row: bundleRow({ series_id: '..' }) }, store.paths), /path-safe/);
    assert.throws(() => removeImportedRun('..', store.paths), /path-safe/);
    assert.throws(() => importSeries({ row: bundleRow({ players: { p1: 'a' } }) }, store.paths), /both seats/);
    assert.throws(() => importSeries({ row: bundleRow({ mode: 'ladder' }) }, store.paths), /unknown mode/);
    assert.throws(() => importSeries({ row: bundleRow(), logs: { p1: 'not json' } }, store.paths), /not JSON/);
    assert.equal(loadSeriesRecords(store.paths.recordsPath).length, 0, 'a rejected bundle writes nothing');
    assert.equal(fs.existsSync(store.paths.runsDir), false);
  } finally {
    store.dispose();
  }
});

test('the import route answers only to the configured operator token', async () => {
  const store = scratch();
  const gui = new GuiServer({ ...store.paths, importToken: TOKEN });
  const base = await gui.listen(0);
  const post = (headers: Record<string, string>, body: unknown) =>
    fetch(`${base}api/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  try {
    assert.equal((await post({}, { row: bundleRow() })).status, 401);
    const wrong = await post({ authorization: 'Bearer wrong-credential-value' }, { row: bundleRow() });
    assert.equal(wrong.status, 401);
    assert.doesNotMatch(await wrong.text(), /wrong-credential-value|test-import-token/);
    const rejected = await post({ authorization: `Bearer ${TOKEN}` }, { row: { players: {} } });
    assert.equal(rejected.status, 400);
    const accepted = await post({ authorization: `Bearer ${TOKEN}` }, { row: bundleRow() });
    assert.equal(accepted.status, 200);
    assert.equal(((await accepted.json()) as { imported: boolean }).imported, true);

    const records = loadSeriesRecords(store.paths.recordsPath);
    assert.equal(records.length, 1);
    assert.equal(
      (records[0]?.origin as { source?: string } | undefined)?.source,
      'import',
      'the authoritative row retains its import provenance',
    );
  } finally {
    gui.close();
    store.dispose();
  }
});

test('a deployment without an import token has no import route', async () => {
  const store = scratch();
  const gui = new GuiServer(store.paths);
  const base = await gui.listen(0);
  try {
    const response = await fetch(`${base}api/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ row: bundleRow() }),
    });
    assert.equal(response.status, 404);
  } finally {
    gui.close();
    store.dispose();
  }
});
