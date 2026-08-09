import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { BracketView } from '../src/gui/api.js';
import { loadSeriesRecords } from '../src/records.js';
import { loadPool } from '../src/teams.js';
import type { TournamentEvent } from '../src/tournament.js';
import {
  briefEvent,
  buildBracket,
  runTournament,
  seedPositions,
  TOURNAMENT_PROTOCOL_VERSION,
} from '../src/tournament.js';

test('seed order spreads byes across distinct first-round matches', () => {
  assert.deepEqual(seedPositions(4), [0, 3, 1, 2]);
  assert.deepEqual(seedPositions(8), [0, 7, 3, 4, 1, 6, 2, 5]);
});

test('every bracket size plays exactly n-1 series and byes auto-advance', () => {
  for (let count = 2; count <= 9; count += 1) {
    const rounds = buildBracket(count);
    const matches = rounds.flat();
    assert.equal(matches.filter((match) => match.seriesIndex !== null).length, count - 1, `${count} entrants`);
    const indices = matches
      .filter((match) => match.seriesIndex !== null)
      .map((match) => match.seriesIndex)
      .sort((a, b) => a! - b!);
    assert.deepEqual(
      indices,
      Array.from({ length: count - 1 }, (_, index) => index),
    );
    for (const match of rounds[0]!) {
      assert.ok(match.slots[0] !== null || match.slots[1] !== null, 'no empty first-round match');
      if (match.seriesIndex === null) {
        assert.equal(match.winner, match.slots[0] ?? match.slots[1], 'a bye advances its only entrant');
      }
    }
    assert.equal(rounds[rounds.length - 1]!.length, 1, 'a single final');
  }
});

test('a tournament crowns a champion and records rounds coherently', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-model-league-tournament-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const recordsPath = path.join(directory, 'results.jsonl');
  const events: TournamentEvent[] = [];
  const rows = await runTournament(['random', 'random', 'random', 'random', 'random'], directory, {
    seed: 11,
    concurrency: 2,
    recordsPath,
    onEvent: (event) => events.push(event),
  });

  assert.equal(rows.length, 4);
  assert.deepEqual(
    rows.map((row) => row.series_index),
    [0, 1, 2, 3],
  );
  const config = JSON.parse(fs.readFileSync(path.join(directory, 'config.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(config.mode, 'tournament');
  assert.equal(config.protocol_version, TOURNAMENT_PROTOCOL_VERSION);
  assert.equal((config.entrants as unknown[]).length, 5);

  const planned = events[0];
  assert.equal(planned?.type, 'plans');
  if (planned?.type === 'plans') {
    assert.equal(planned.mode, 'tournament');
    assert.equal(planned.plans.length, 4);
  }
  const firstEnd = events.findIndex((event) => event.type === 'series-end');
  assert.deepEqual(
    events
      .slice(0, firstEnd)
      .filter((event): event is Extract<TournamentEvent, { type: 'series-start' }> => event.type === 'series-start')
      .map((event) => event.index),
    [0, 2],
    'a post-bye semifinal starts without waiting for the unrelated first-round match',
  );

  const brackets = events.filter(
    (event): event is Extract<TournamentEvent, { type: 'bracket' }> => event.type === 'bracket',
  );
  assert.ok(brackets.length >= 2, 'bracket updates stream during the run');
  const final: BracketView = brackets[brackets.length - 1]!.bracket;
  assert.notEqual(final.champion, null);
  assert.equal(final.entrants.length, 5);
  assert.equal(new Set(final.entrants.map((entrant) => entrant.team)).size, 5, 'every entrant has a distinct team');

  const persisted = loadSeriesRecords(recordsPath);
  assert.equal(persisted.length, 4);
  for (const match of final.rounds.flat()) {
    if (match.seriesIndex === null) continue;
    const record = persisted.find((row) => row.series_index === match.seriesIndex)!;
    assert.equal(record.mode, 'tournament');
    assert.equal(record.pool, 'test');
    assert.deepEqual(
      (record as { teams?: Record<string, string> }).teams,
      { p1: final.entrants[match.slots[0]!]!.team, p2: final.entrants[match.slots[1]!]!.team },
      'recorded teams follow the entrants through the bracket',
    );
    assert.notEqual(match.winner, null);
  }
  const championSeries = final.rounds[final.rounds.length - 1]![0]!;
  assert.equal(final.champion, championSeries.winner);
});

test('inline teams pair to models by index and record no pool', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-model-league-tournament-inline-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const recordsPath = path.join(directory, 'results.jsonl');
  const pool = loadPool('test');
  const rows = await runTournament(['random', 'random'], directory, {
    seed: 3,
    concurrency: 1,
    recordsPath,
    format: pool.format,
    teams: [
      { id: 'alpha', packed: pool.teams[0]!.packed },
      { id: 'beta', packed: pool.teams[1]!.packed },
    ],
  });
  assert.equal(rows.length, 1);
  const record = rows[0]!;
  assert.equal(record.mode, 'tournament');
  assert.equal(record.pool, undefined);
  assert.equal(record.format, pool.format);
  assert.deepEqual(Object.values((record as { teams?: Record<string, string> }).teams ?? {}).sort(), ['alpha', 'beta']);
  assert.ok(fs.existsSync(path.join(directory, 'teams.json')), 'inline teams are captured for provenance');
});

test('inline teams must cover every model', async () => {
  const pool = loadPool('test');
  await assert.rejects(
    runTournament(['random', 'random', 'random'], fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-tournament-bad-')), {
      format: pool.format,
      teams: [{ id: 'only', packed: pool.teams[0]!.packed }],
    }),
    /one team per model/,
  );
});

test('a seeded pool keeps the real bracket order and briefs both sides on it', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-model-league-tournament-seeded-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const pool = loadPool('vr-aug26-top8');
  assert.ok(pool.event, 'the pool carries its event');
  assert.equal(pool.teams.length, 8);

  const events: TournamentEvent[] = [];
  await runTournament(
    Array.from({ length: 8 }, () => 'random'),
    directory,
    {
      seed: 5,
      concurrency: 4,
      pool: 'vr-aug26-top8',
      recordsPath: path.join(directory, 'results.jsonl'),
      onEvent: (event) => events.push(event),
    },
  );

  const bracket = events.filter(
    (event): event is Extract<TournamentEvent, { type: 'bracket' }> => event.type === 'bracket',
  )[0]!.bracket;
  const placementOf = (slot: number): number =>
    pool.teams.find((team) => team.id === bracket.entrants[slot]!.team)!.seed!;
  assert.deepEqual(
    bracket.entrants.map((_, index) => placementOf(index)),
    [1, 2, 3, 4, 5, 6, 7, 8],
    'bracket positions follow the finishing order the event published',
  );
  assert.deepEqual(
    bracket.rounds[0]!.map((match) => [placementOf(match.slots[0]!), placementOf(match.slots[1]!)]),
    [
      [1, 8],
      [4, 5],
      [2, 7],
      [3, 6],
    ],
    'the quarterfinals pair the standard seeding',
  );

  const config = JSON.parse(fs.readFileSync(path.join(directory, 'config.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(config.provenance, 'disclosed');
  assert.equal(config.event, pool.event!.name);
});

test('a stopped bracket resumes on its records and replays the interrupted series', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-model-league-tournament-resume-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const recordsPath = path.join(directory, 'results.jsonl');
  const models = Array.from({ length: 4 }, () => 'random');
  const controller = new AbortController();
  const stopped = await runTournament(models, directory, {
    seed: 7,
    concurrency: 1,
    recordsPath,
    signal: controller.signal,
    onEvent: (event) => {
      if (event.type === 'game-end') controller.abort();
    },
  });
  assert.equal(stopped.length, 0, 'the bracket stops inside its first series');
  const interrupted = fs.readdirSync(path.join(directory, 'series'));
  assert.equal(interrupted.length, 1, 'the interrupted series left one directory behind');
  const config = fs.readFileSync(path.join(directory, 'config.json'), 'utf8');

  const resumed = await runTournament(models, directory, {
    seed: 7,
    concurrency: 1,
    recordsPath,
    resume: true,
  });

  assert.equal(resumed.length, 3, 'the resumed bracket plays every series once');
  assert.deepEqual(
    resumed.map((row) => row.series_index),
    [0, 1, 2],
  );
  assert.equal(loadSeriesRecords(recordsPath).length, 3, 'no series is recorded twice');
  const played = fs.readdirSync(path.join(directory, 'series'));
  assert.equal(played.length, 3, 'the interrupted series reuses its directory');
  assert.ok(played.includes(interrupted[0]!), 'and keeps the one it already opened');
  const first = resumed.find((row) => row.series_index === 0)!;
  assert.equal(
    (first.games as Array<Record<string, unknown>>)[0]?.resumed,
    undefined,
    'adoption preserves the exact completed game result instead of adding resume metadata',
  );
  assert.equal(fs.readFileSync(path.join(directory, 'config.json'), 'utf8'), config, 'a resume rewrites no provenance');
});

test('a resume refuses a tournament result whose defaults diverge from canonical series evidence', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-model-league-tournament-mismatch-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const models = ['random', 'random'];
  const recordsPath = path.join(directory, 'results.jsonl');
  await runTournament(models, directory, { seed: 3, concurrency: 1, recordsPath });
  const rows = fs
    .readFileSync(recordsPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const game = (rows[0]!.games as Array<Record<string, unknown>>)[0]!;
  const defaults = game.timer_autodefaults as Record<'p1' | 'p2', number>;
  defaults.p1 += 1;
  fs.writeFileSync(recordsPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');

  await assert.rejects(
    runTournament(models, directory, { seed: 3, concurrency: 1, recordsPath, resume: true }),
    /canonical completed series evidence/,
  );
});

test('a briefing establishes the cut without ranking anyone inside it', () => {
  const pool = loadPool('vr-aug26-top8');
  const brief = briefEvent(pool.event!, 8);
  assert.match(brief, /Victory Road August Challenge #1/);
  assert.match(brief, /top 8/);
  assert.match(brief, /took to that top cut/i);
  assert.match(brief, /placed where is not disclosed/i);
  assert.match(brief, /no stat points/i, 'the seat is told the spreads are not the players own');
  assert.doesNotMatch(brief, /\b(1st|2nd|3rd|[4-8]th)\b/, 'no seat learns which team outplaced which');
  assert.doesNotMatch(brief, /Kazuki|Jonathan|Markl/, 'player names stay out of competitive context');
});
