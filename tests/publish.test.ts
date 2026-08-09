import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { ImportRequest } from '../src/gui/api.js';
import { publishRecords } from '../src/publish.js';
import type { SeriesRecord } from '../src/records.js';

const TOURNAMENT = '20260806T000000.000000Z-aaaa1111';
const LEAGUE = '20260805T000000.000000Z-bbbb2222';
const SCRATCH = '20260804T000000.000000Z-cccc3333';

interface Store {
  recordsPath: string;
  runsDir: string;
  teamsDir: string;
  dispose: () => void;
}

function store(): Store {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-publish-'));
  const recordsPath = path.join(root, 'records', 'results.jsonl');
  fs.mkdirSync(path.dirname(recordsPath), { recursive: true });
  const row = (
    mode: SeriesRecord['mode'],
    runId: string,
    seriesId: string,
    players: SeriesRecord['players'],
    pool?: string,
  ): SeriesRecord => ({
    schema_version: 1,
    mode,
    protocol_version: 1,
    scaffold: 'fixture',
    timestamp: '2026-08-06T00:00:00.000Z',
    run_id: runId,
    series_id: seriesId,
    series_index: 0,
    format: 'test',
    ...(pool === undefined ? {} : { pool }),
    players,
    teams: { p1: 'team-a', p2: 'team-b' },
    winner: null,
    winner_side: null,
    score: { p1: 0, p2: 0 },
    turns: 0,
    games: [],
    engine_seeds: {},
    reasoning: null,
    decision_stats: { p1: {}, p2: {} },
    run_seed: 1,
    ps_commit: '0000000000000000000000000000000000000000',
  });
  const rows = [
    row('tournament', TOURNAMENT, 'aaaa', { p1: 'a', p2: 'b' }, 'majors'),
    row('draft', LEAGUE, 'bbbb', { p1: 'c', p2: 'd' }),
    row('rotation', SCRATCH, 'cccc', { p1: 'e', p2: 'f' }, 'test'),
  ];
  fs.writeFileSync(recordsPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  return {
    recordsPath,
    runsDir: path.join(root, 'runs'),
    teamsDir: path.join(root, 'teams'),
    dispose: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/** Dry runs still ask the deployment which pools it holds, so the fetch has to answer. */
async function withRemoteState<T>(body: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ pools: [{ name: 'majors' }, { name: 'test' }] }))) as typeof fetch;
  try {
    return await body();
  } finally {
    globalThis.fetch = real;
  }
}

test('--run publishes exactly the named runs whatever their mode or pool', async () => {
  const paths = store();
  try {
    const lines: string[] = [];
    await withRemoteState(() =>
      publishRecords({
        origin: 'https://deployment.invalid',
        token: 'unused',
        recordsPath: paths.recordsPath,
        runsDir: paths.runsDir,
        teamsDir: paths.teamsDir,
        runs: [LEAGUE, SCRATCH],
        dryRun: true,
        log: (line) => lines.push(line),
      }),
    );
    assert.equal(lines.filter((line) => line.startsWith('would publish')).length, 2);
    assert.ok(lines.some((line) => line.includes(LEAGUE.slice(0, 15))));
    assert.ok(
      lines.some((line) => line.includes(SCRATCH.slice(0, 15))),
      'naming a run overrides the test-pool exclusion',
    );
    assert.ok(!lines.some((line) => line.includes(TOURNAMENT.slice(0, 15))));
  } finally {
    paths.dispose();
  }
});

test('naming a run with no recorded series fails instead of publishing the rest', async () => {
  const paths = store();
  try {
    await assert.rejects(
      withRemoteState(() =>
        publishRecords({
          origin: 'https://deployment.invalid',
          token: 'unused',
          recordsPath: paths.recordsPath,
          runsDir: paths.runsDir,
          teamsDir: paths.teamsDir,
          runs: [LEAGUE, 'not-a-run'],
          dryRun: true,
        }),
      ),
      /not-a-run/,
    );
  } finally {
    paths.dispose();
  }
});

test('publish sends the complete stored evidence bundle without putting its bearer credential in the body', async () => {
  const paths = store();
  const runDir = path.join(paths.runsDir, LEAGUE);
  const seriesDir = path.join(runDir, 'series', 'bbbb');
  fs.mkdirSync(path.join(runDir, 'draft'), { recursive: true });
  fs.mkdirSync(path.join(runDir, 'teambuild'), { recursive: true });
  fs.mkdirSync(seriesDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'config.json'), JSON.stringify({ mode: 'draft', closed_sheets: true }));
  fs.writeFileSync(path.join(runDir, 'rosters.json'), JSON.stringify([{ model: 'c', roster: [] }]));
  fs.writeFileSync(path.join(runDir, 'draft', 'draft.jsonl'), '{"rationale":"draft evidence"}\n');
  fs.writeFileSync(
    path.join(runDir, 'teambuild', 'teambuild.jsonl'),
    '{"sets":[{"evs":{"spe":252},"note":"exact set note"}],"rationale":"build evidence"}\n',
  );
  fs.writeFileSync(path.join(runDir, 'window.json'), JSON.stringify({ reasoning: 'window evidence' }));
  fs.writeFileSync(path.join(runDir, 'season.jsonl'), '{"summary":"season evidence"}\n');
  fs.writeFileSync(
    path.join(seriesDir, 'p1-decisions.jsonl'),
    '{"kind":"decision","rationale":"decision evidence","notebook":"notebook evidence"}\n',
  );
  fs.writeFileSync(path.join(seriesDir, 'game-1.log'), '|turn|1\n|win|c\n');

  const token = 'operator-token-that-must-not-enter-evidence';
  let received: ImportRequest | undefined;
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.pathname === '/api/state') return new Response(JSON.stringify({ pools: [] }));
    assert.equal(url.pathname, '/api/import');
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${token}`);
    received = JSON.parse(String(init?.body)) as ImportRequest;
    return new Response(
      JSON.stringify({
        imported: true,
        runId: LEAGUE,
        seriesId: 'bbbb',
        logs: ['p1'],
        games: ['game-1.log'],
        pool: null,
        league: ['rosters.json', 'draft/draft.jsonl', 'teambuild/teambuild.jsonl', 'window.json', 'season.jsonl'],
      }),
    );
  }) as typeof fetch;
  try {
    await publishRecords({
      origin: 'https://deployment.invalid',
      token,
      recordsPath: paths.recordsPath,
      runsDir: paths.runsDir,
      teamsDir: paths.teamsDir,
      runs: [LEAGUE],
    });
    assert.ok(received);
    const body = JSON.stringify(received);
    for (const evidence of [
      'draft evidence',
      'build evidence',
      'exact set note',
      'window evidence',
      'season evidence',
      'decision evidence',
      'notebook evidence',
      '|win|c',
      'closed_sheets',
      'run_seed',
    ]) {
      assert.match(body, new RegExp(evidence));
    }
    assert.doesNotMatch(body, new RegExp(token));
  } finally {
    globalThis.fetch = real;
    paths.dispose();
  }
});
