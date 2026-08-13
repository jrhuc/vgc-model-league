import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertGameRecordCorpusDigest,
  type CorpusOptions,
  gameRecordCorpusDigest,
  loadGameRecordCorpus,
  verifyGame,
} from '../src/eval/corpus.js';
import { type GameSource, newBattle, pendingSides } from '../src/eval/fork.js';
import { defaultPsDir } from '../src/paths.js';
import { showdownCommit } from '../src/showdown.js';
import { loadPool } from '../src/teams.js';
import type { JsonObject, Pid } from '../src/types.js';
import { omniscientLog, requestActionCandidates } from './fixtures/eval.js';

const SEED: [number, number, number, number] = [7, 14, 21, 28];
const RUN_ID = '20260101T000000.000000Z-testrun';
const SERIES_ID = 'aaaaaaaaaaaa';
const ATTEMPT_ID = 'attempt-current';

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
      const action = requestActionCandidates(battle.getSide(pid).activeRequest as never)[0];
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
  fs.writeFileSync(
    path.join(seriesDir, 'series.json'),
    JSON.stringify({ schema_version: 3, identity: { packed_teams: source.packed } }),
    'utf8',
  );
  for (const pid of ['p1', 'p2'] as const) {
    const rows = choices[pid].map((action, index) =>
      JSON.stringify({
        kind: 'decision',
        attempt_id: ATTEMPT_ID,
        game_number: 1,
        turn: index,
        pid,
        submission_id: `${ATTEMPT_ID}:1:${pid}:${index + 1}`,
        submission_source: 'model',
        outcome: 'accepted',
        action,
        rationale: `because ${index}`,
        fallback: false,
      }),
    );
    fs.writeFileSync(path.join(seriesDir, `${pid}-decisions.jsonl`), `${rows.join('\n')}\n`, 'utf8');
  }
  fs.writeFileSync(
    path.join(seriesDir, 'series-attempts.jsonl'),
    `${[
      { kind: 'attempt_started', attempt_id: ATTEMPT_ID, series_id: SERIES_ID },
      { kind: 'attempt_completed', attempt_id: ATTEMPT_ID, series_id: SERIES_ID, completed_games: 1 },
    ]
      .map((attempt) => JSON.stringify(attempt))
      .join('\n')}\n`,
    'utf8',
  );
  fs.writeFileSync(
    path.join(seriesDir, 'game-1.complete.json'),
    `${JSON.stringify({
      kind: 'game_complete',
      series_id: SERIES_ID,
      game_number: 1,
      attempt_id: ATTEMPT_ID,
    })}\n`,
    'utf8',
  );
  fs.writeFileSync(
    path.join(root, 'runs', RUN_ID, 'config.json'),
    JSON.stringify({ scaffold: 'abcabcabcabc', scaffold_components: { system: 'sss' } }),
    'utf8',
  );

  const row: JsonObject = {
    schema_version: 1,
    mode: 'tournament',
    protocol_version: 1,
    scaffold: 'abcabcabcabc',
    timestamp: '2026-01-01T00:00:00.000Z',
    run_id: RUN_ID,
    series_id: SERIES_ID,
    attempt_id: ATTEMPT_ID,
    series_index: 0,
    format: pool.format,
    pool: 'fixture',
    players,
    teams: { p1: first.id, p2: second.id },
    packed_team_digests: {
      p1: createHash('sha256').update(source.packed.p1).digest('hex'),
      p2: createHash('sha256').update(source.packed.p2).digest('hex'),
    },
    winner: null,
    winner_side: null,
    score: { p1: 0, p2: 0 },
    turns: 1,
    games: [
      {
        number: 1,
        winner: null,
        winner_side: null,
        turns: 1,
        seed: SEED,
        log: logPath,
        simulator_substitutions: { p1: 0, p2: 0 },
        timer_autodefaults: { p1: 0, p2: 0 },
        model_choice_fallbacks: { p1: 0, p2: 0 },
      },
    ],
    engine_seeds: { p1: 1, p2: 2 },
    reasoning: null,
    decision_stats: { p1: {}, p2: {} },
    run_seed: 1,
    ps_commit: showdownCommit(defaultPsDir()),
  };
  mutate(row);
  const recordsPath = path.join(root, 'records', 'results.jsonl');
  fs.mkdirSync(path.dirname(recordsPath), { recursive: true });
  fs.writeFileSync(recordsPath, `${JSON.stringify(row)}\n`, 'utf8');

  return { root, seriesDir, recordsPath, runsDir: path.join(root, 'runs') };
}

test('a recorded game is found, replayed and verified against its own log', () => {
  const corpus = buildCorpus();
  const records = loadGameRecordCorpus(corpus);
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

  const gradedSourceDigest = gameRecordCorpusDigest(records);
  const sourceRow = JSON.parse(fs.readFileSync(corpus.recordsPath, 'utf8')) as JsonObject;
  (sourceRow.players as Record<Pid, string>).p1 = 'metadata-mutated-player';
  fs.writeFileSync(
    corpus.recordsPath,
    `${JSON.stringify(sourceRow)}
`,
    'utf8',
  );
  const mutatedRecords = loadGameRecordCorpus(corpus);
  assert.notEqual(gameRecordCorpusDigest(mutatedRecords), gradedSourceDigest);
  assert.throws(
    () => assertGameRecordCorpusDigest(mutatedRecords, gradedSourceDigest, 'exporter source boundary'),
    /exporter source boundary digest does not match/u,
  );
});

test('corpus follows the completing game lineage and keeps every accepted transition', () => {
  const corpus = buildCorpus();
  const file = path.join(corpus.seriesDir, 'p1-decisions.jsonl');
  const rows = fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as JsonObject);
  assert.ok(rows.length >= 3);
  rows[1]!.submission_source = 'automatic';
  rows[1]!.automatic = true;
  fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  fs.appendFileSync(
    file,
    `${JSON.stringify({
      ...rows[0],
      attempt_id: 'restart-sibling',
      submission_id: 'restart-sibling:p1:1',
    })}\n${JSON.stringify({
      ...rows[0],
      submission_id: `${ATTEMPT_ID}:rejected`,
      outcome: 'rejected',
      action: 'invalid',
    })}\n`,
    'utf8',
  );

  const record = loadGameRecordCorpus(corpus)[0];
  assert.ok(record);
  assert.equal(record.skipped, null);
  assert.equal(record.decisions.p1.length, rows.length);
  assert.equal(record.decisions.p1[1]?.submission_source, 'automatic');
  assert.ok(record.decisions.p1.every((row) => row.outcome === 'accepted'));
  assert.ok(verifyGame(record));
});

test('exact packed teams are bound to the result provenance', () => {
  const corpus = buildCorpus();
  const record = loadGameRecordCorpus(corpus)[0];
  assert.ok(record);
  assert.equal(record.skipped, null);

  const series = JSON.parse(fs.readFileSync(path.join(corpus.seriesDir, 'series.json'), 'utf8')) as JsonObject;
  const identity = series.identity as JsonObject;
  const packed = identity.packed_teams as Record<Pid, string>;
  packed.p1 = `${packed.p1}x`;
  fs.writeFileSync(path.join(corpus.seriesDir, 'series.json'), JSON.stringify(series), 'utf8');
  assert.equal(loadGameRecordCorpus(corpus)[0]?.skipped, 'unbound-team-provenance');
});

test('answer provenance does not remove accepted transitions from exact replay', () => {
  const corpus = buildCorpus((row) => {
    (row.games as JsonObject[])[0]!.timer_autodefaults = { p1: 0, p2: 2 };
  });
  const record = loadGameRecordCorpus(corpus)[0];
  assert.ok(record);
  assert.equal(record.skipped, null);
  assert.ok(verifyGame(record));
});

test('a game whose log does not match the teams on file is refused, not repaired', () => {
  const corpus = buildCorpus();
  const records = loadGameRecordCorpus(corpus);
  const record = records[0];
  assert.ok(record);
  record.seed = [1, 1, 1, 1];
  assert.equal(verifyGame(record), null);
});

test('schema-invalid inputs fail closed while missing game evidence remains explicit', () => {
  const seedless = buildCorpus((row) => {
    delete (row.games as JsonObject[])[0]!.seed;
  });
  assert.throws(() => loadGameRecordCorpus(seedless), /not-current-series-record: 1/u);

  const logless = buildCorpus();
  fs.rmSync(path.join(logless.seriesDir, 'game-1.log'));
  assert.equal(loadGameRecordCorpus(logless)[0]?.skipped, 'no-log');

  const teamless = buildCorpus();
  fs.rmSync(path.join(teamless.seriesDir, 'series.json'));
  assert.equal(loadGameRecordCorpus(teamless)[0]?.skipped, 'unbound-team-provenance');

  const decisionless = buildCorpus();
  fs.rmSync(path.join(decisionless.seriesDir, 'p2-decisions.jsonl'));
  assert.equal(loadGameRecordCorpus(decisionless)[0]?.skipped, 'no-decisions');
});

test('top-level corpus rejection summarizes every selected exclusion', () => {
  const corpus = buildCorpus();
  const current = JSON.parse(fs.readFileSync(corpus.recordsPath, 'utf8')) as JsonObject;
  const withoutAttempt = { ...current };
  delete withoutAttempt.attempt_id;
  const withoutGames = { ...current, games: [] };
  fs.appendFileSync(
    corpus.recordsPath,
    `{"broken"
${JSON.stringify({ schema_version: 0 })}
${JSON.stringify(withoutAttempt)}
${JSON.stringify(withoutGames)}
`,
    'utf8',
  );

  assert.throws(
    () => loadGameRecordCorpus(corpus),
    /rejected 4 selected inputs \(malformed-json: 1, not-current-series-record: 1, missing-attempt-id: 1, no-games: 1\)/u,
  );
});

test('mode mismatches are unselected and unreadable source corpora fail', () => {
  const corpus = buildCorpus();
  assert.deepEqual(loadGameRecordCorpus({ ...corpus, modes: ['draft'] }), []);
  fs.rmSync(corpus.recordsPath);
  assert.throws(() => loadGameRecordCorpus(corpus), /unable to read source corpus/u);
});

test('record identifiers cannot escape the pinned runs root', () => {
  const escapedRun = buildCorpus((row) => {
    row.run_id = '../escape';
  });
  assert.throws(() => loadGameRecordCorpus(escapedRun), /unsafe-source-identifiers: 1/u);

  const escapedSeries = buildCorpus((row) => {
    row.series_id = '..';
  });
  assert.throws(() => loadGameRecordCorpus(escapedSeries), /unsafe-source-identifiers: 1/u);
});
