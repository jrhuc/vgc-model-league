import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { type CorpusOptions, loadGameRecords, verifyGame } from '../src/eval/corpus.js';
import { type GameSource, legalActions, newBattle, omniscientLog, pendingSides } from '../src/eval/fork.js';
import { defaultPsDir } from '../src/paths.js';
import { showdownCommit } from '../src/showdown.js';
import { loadPool } from '../src/teams.js';
import type { JsonObject, Pid } from '../src/types.js';

const SEED: [number, number, number, number] = [7, 14, 21, 28];
const RUN_ID = '20260101T000000.000000Z-testrun';
const SERIES_ID = 'aaaaaaaaaaaa';

interface Corpus extends CorpusOptions {
  root: string;
  seriesDir: string;
  recordsPath: string;
}

function playOut(source: GameSource): { choices: Record<Pid, string[]>; log: string[] } {
  const battle = newBattle(source);
  const choices: Record<Pid, string[]> = { p1: [], p2: [] };
  let steps = 0;
  while (!battle.ended && steps++ < 400) {
    const pending = pendingSides(battle);
    if (!pending.length) break;
    const taken: Partial<Record<Pid, string>> = {};
    for (const pid of pending) {
      const action = legalActions(battle.getSide(pid).activeRequest as never)[0];
      if (action === undefined) throw new Error(`no legal action for ${pid}`);
      taken[pid] = action;
      choices[pid].push(action);
    }
    for (const pid of pending) battle.choose(pid, taken[pid] as string);
  }
  return { choices, log: omniscientLog(battle.log) };
}

function buildCorpus(mutate: (row: JsonObject) => void = () => {}): Corpus {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-'));
  const pool = loadPool();
  const [first, second] = pool.teams;
  if (!first || !second) throw new Error('the test pool needs two teams');

  const teamsDir = path.join(root, 'teams', 'fixture');
  fs.mkdirSync(teamsDir, { recursive: true });
  fs.writeFileSync(path.join(teamsDir, `${first.id}.team`), `${first.packed}\n`, 'utf8');
  fs.writeFileSync(path.join(teamsDir, `${second.id}.team`), `${second.packed}\n`, 'utf8');

  const players: Record<Pid, string> = { p1: 'model-a', p2: 'model-b' };
  const source: GameSource = {
    format: pool.format,
    seed: SEED,
    names: { p1: `p1-${players.p1}`, p2: `p2-${players.p2}` },
    packed: { p1: first.packed, p2: second.packed },
    choices: { p1: [], p2: [] },
  };
  const { choices, log } = playOut(source);

  const seriesDir = path.join(root, 'runs', RUN_ID, 'series', SERIES_ID);
  fs.mkdirSync(seriesDir, { recursive: true });
  const logPath = path.join(seriesDir, 'game-1.log');
  fs.writeFileSync(logPath, `${log.join('\n')}\n`, 'utf8');
  fs.writeFileSync(path.join(seriesDir, 'series.json'), JSON.stringify({ packed_teams: source.packed }), 'utf8');
  for (const pid of ['p1', 'p2'] as const) {
    const rows = choices[pid].map((action, index) =>
      JSON.stringify({ kind: 'decision', game_number: 1, turn: index, pid, action, rationale: `because ${index}` }),
    );
    fs.writeFileSync(path.join(seriesDir, `${pid}-decisions.jsonl`), `${rows.join('\n')}\n`, 'utf8');
  }
  fs.writeFileSync(
    path.join(root, 'runs', RUN_ID, 'config.json'),
    JSON.stringify({ scaffold: 'abcabcabcabc', scaffold_components: { system: 'sss' } }),
    'utf8',
  );

  const row: JsonObject = {
    mode: 'tournament',
    run_id: RUN_ID,
    series_id: SERIES_ID,
    format: pool.format,
    pool: 'fixture',
    players,
    teams: { p1: first.id, p2: second.id },
    ps_commit: showdownCommit(defaultPsDir()),
    packed_team_digests: {
      p1: createHash('sha256').update(source.packed.p1).digest('hex'),
      p2: createHash('sha256').update(source.packed.p2).digest('hex'),
    },
    games: [
      {
        number: 1,
        seed: SEED,
        log: logPath,
        simulator_substitutions: { p1: 0, p2: 0 },
        timer_autodefaults: { p1: 0, p2: 0 },
        model_choice_fallbacks: { p1: 0, p2: 0 },
      },
    ],
  };
  mutate(row);
  const recordsPath = path.join(root, 'records', 'results.jsonl');
  fs.mkdirSync(path.dirname(recordsPath), { recursive: true });
  fs.writeFileSync(recordsPath, `${JSON.stringify(row)}\n`, 'utf8');

  return { root, seriesDir, recordsPath, runsDir: path.join(root, 'runs') };
}

test('a recorded game is found, replayed and verified against its own log', () => {
  const corpus = buildCorpus();
  const records = loadGameRecords(corpus);
  assert.equal(records.length, 1);
  const record = records[0];
  assert.ok(record);
  assert.equal(record.skipped, null);
  assert.equal(record.scaffold.revision, 'abcabcabcabc');

  const game = verifyGame(record);
  assert.ok(game, 'the recorded game replays exactly');
  assert.equal(game.replay.verified, true);
  assert.ok(game.replay.positions.length > 0);
  assert.equal(game.replay.positions[0]?.actual.p1, record.decisions.p1[0]?.action);
});

test('exact packed teams are bound to the result provenance', () => {
  const corpus = buildCorpus();
  const record = loadGameRecords(corpus)[0];
  assert.ok(record);
  assert.equal(record.skipped, null);

  const series = JSON.parse(fs.readFileSync(path.join(corpus.seriesDir, 'series.json'), 'utf8')) as JsonObject;
  const packed = series.packed_teams as Record<Pid, string>;
  packed.p1 = `${packed.p1}x`;
  fs.writeFileSync(path.join(corpus.seriesDir, 'series.json'), JSON.stringify(series), 'utf8');
  assert.equal(loadGameRecords(corpus)[0]?.skipped, 'unbound-team-provenance');
});

test('a game the simulator answered for a player never reaches the position set', () => {
  const corpus = buildCorpus((row) => {
    (row.games as JsonObject[])[0]!.timer_autodefaults = { p1: 0, p2: 2 };
  });
  const records = loadGameRecords(corpus);
  assert.equal(records[0]?.skipped, 'answered-for-player');
  assert.equal(verifyGame(records[0]), null);
});

test('a game whose log does not match the teams on file is refused, not repaired', () => {
  const corpus = buildCorpus();
  const records = loadGameRecords(corpus);
  const record = records[0];
  assert.ok(record);
  record.seed = [1, 1, 1, 1];
  assert.equal(verifyGame(record), null);
});

test('missing pieces are named rather than dropped', () => {
  const seedless = buildCorpus((row) => {
    delete (row.games as JsonObject[])[0]!.seed;
  });
  assert.equal(loadGameRecords(seedless)[0]?.skipped, 'no-seed');

  const logless = buildCorpus();
  fs.rmSync(path.join(logless.seriesDir, 'game-1.log'));
  assert.equal(loadGameRecords(logless)[0]?.skipped, 'no-log');

  const teamless = buildCorpus();
  fs.rmSync(path.join(teamless.seriesDir, 'series.json'));
  assert.equal(loadGameRecords(teamless)[0]?.skipped, 'unbound-team-provenance');

  const decisionless = buildCorpus();
  fs.rmSync(path.join(decisionless.seriesDir, 'p2-decisions.jsonl'));
  assert.equal(loadGameRecords(decisionless)[0]?.skipped, 'no-decisions');
});

test('record identifiers cannot escape the pinned runs root', () => {
  const escapedRun = buildCorpus((row) => {
    row.run_id = '../escape';
  });
  assert.throws(() => loadGameRecords(escapedRun), /path-safe identifiers/);

  const escapedSeries = buildCorpus((row) => {
    row.series_id = '..';
  });
  assert.throws(() => loadGameRecords(escapedSeries), /path-safe identifiers/);
});
