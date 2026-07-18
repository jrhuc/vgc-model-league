import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { BracketView } from '../src/gui/api.js';
import { loadRows } from '../src/records.js';
import { loadPool } from '../src/teams.js';
import type { TournamentEvent } from '../src/tournament.js';
import { buildBracket, runTournament, seedPositions, TOURNAMENT_PROTOCOL_VERSION } from '../src/tournament.js';

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

  const brackets = events.filter(
    (event): event is Extract<TournamentEvent, { type: 'bracket' }> => event.type === 'bracket',
  );
  assert.ok(brackets.length >= 2, 'bracket updates stream during the run');
  const final: BracketView = brackets[brackets.length - 1]!.bracket;
  assert.notEqual(final.champion, null);
  assert.equal(final.entrants.length, 5);
  assert.equal(new Set(final.entrants.map((entrant) => entrant.team)).size, 5, 'every entrant has a distinct team');

  const persisted = loadRows(recordsPath);
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
