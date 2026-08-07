import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { publishRecords } from '../src/publish.js';

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
  const rows = [
    { mode: 'tournament', run_id: TOURNAMENT, series_id: 'aaaa', pool: 'majors', players: { p1: 'a', p2: 'b' } },
    { mode: 'draft', run_id: LEAGUE, series_id: 'bbbb', players: { p1: 'c', p2: 'd' } },
    { mode: 'rotation', run_id: SCRATCH, series_id: 'cccc', pool: 'test', players: { p1: 'e', p2: 'f' } },
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
