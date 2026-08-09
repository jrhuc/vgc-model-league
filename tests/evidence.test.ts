import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildTournamentGame, buildTournaments } from '../src/evidence.js';
import { TEAMS_DIR } from '../src/paths.js';
import type { SeriesRecord } from '../src/records.js';

function decisionLine(latency: number, turn: number, extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ kind: 'decision', latency_ms: latency, game_number: 1, turn, phase: 'turn', ...extra })}\n`;
}

function tournamentMatch(
  seriesIndex: number,
  round: number,
  seeds: [number, number],
  p1: string,
  p2: string,
  winnerSide: 'p1' | 'p2',
): SeriesRecord {
  return {
    mode: 'tournament',
    run_id: 'cup-2',
    timestamp: `2026-07-25T0${seriesIndex}:00:00.000Z`,
    series_index: seriesIndex,
    round,
    entrant_count: 3,
    seeds: { p1: seeds[0], p2: seeds[1] },
    pool: 'majors',
    players: { p1, p2 },
    teams: { p1: `team-${seeds[0]}`, p2: `team-${seeds[1]}` },
    winner: winnerSide === 'p1' ? p1 : p2,
    winner_side: winnerSide,
    score: winnerSide === 'p1' ? { p1: 2, p2: 0 } : { p1: 1, p2: 2 },
    turns: 12,
    advanced: winnerSide === 'p1' ? p1 : p2,
  } as unknown as SeriesRecord;
}

function threeEntrantRows(): SeriesRecord[] {
  return [
    tournamentMatch(0, 1, [1, 2], 'openai:beta', 'openai:gamma', 'p2'),
    tournamentMatch(1, 2, [0, 2], 'openai:alpha', 'openai:gamma', 'p1'),
  ];
}

test('buildTournaments reconstructs a bracket with byes from row seeds', () => {
  const rows = threeEntrantRows();
  const response = buildTournaments(rows, '/nonexistent', null);
  assert.deepEqual(response.summary, { tournaments: 1, matches: 2 });
  assert.ok(!('records' in response.summary), 'cross-tournament model placements are not exposed');
  assert.equal(response.tournaments.length, 1);
  const archive = response.tournaments[0]!;
  assert.equal(archive.complete, true);
  assert.equal(archive.champion, 0);
  assert.equal(archive.entrants[0]!.model, 'openai:alpha');
  assert.equal(archive.entrants[2]!.team, 'team-2');
  assert.equal(archive.rounds.length, 2);
  const bye = archive.rounds[0]!.find((view) => view.score === null);
  assert.ok(bye, 'the bye survives reconstruction');
  assert.equal(bye!.winner, 0, 'the bye advances seed 0');
  const final = archive.rounds[1]![0]!;
  assert.deepEqual(final.slots, [0, 2]);
  assert.deepEqual(final.score, [2, 0]);
  assert.equal(buildTournaments(rows, '/nonexistent', 'other-pool').tournaments.length, 0);
});

test('tournament folds reject contradictory structural facts', () => {
  const repeatedIdentity = threeEntrantRows();
  repeatedIdentity[1]!.players.p1 = 'openai:beta';
  const duplicateSeries = threeEntrantRows();
  duplicateSeries.push(structuredClone(duplicateSeries[0]!));
  const conflictingSides = threeEntrantRows();
  conflictingSides[1]!.seeds = { p1: 0, p2: 1 };
  conflictingSides[1]!.players.p2 = 'openai:beta';
  conflictingSides[1]!.teams = { p1: 'team-0', p2: 'team-1' };
  const conflictingResult = threeEntrantRows();
  conflictingResult[1]!.score = { p1: 0, p2: 2 };
  const ambiguousModels = threeEntrantRows();
  ambiguousModels[0]!.players.p1 = 'openai:gamma';

  for (const [name, rows] of Object.entries({
    repeatedIdentity,
    duplicateSeries,
    conflictingSides,
    conflictingResult,
    ambiguousModels,
  })) {
    assert.equal(buildTournaments(rows, '/nonexistent', null).tournaments.length, 0, name);
  }
});

test('tournament archives include open team sheets for the shared match viewer', () => {
  const rows: SeriesRecord[] = [
    {
      mode: 'tournament',
      run_id: 'cup-sheets',
      timestamp: '2026-08-06T21:00:00.000Z',
      series_index: 0,
      round: 1,
      entrant_count: 2,
      seeds: { p1: 0, p2: 1 },
      pool: 'test',
      players: { p1: 'provider:alpha', p2: 'provider:beta' },
      teams: { p1: 'boschmans-mega-pyroar', p2: 'cybertron-mega-staraptor' },
      winner: 'provider:alpha',
      winner_side: 'p1',
      score: { p1: 2, p2: 0 },
      turns: 8,
    } as unknown as SeriesRecord,
  ];
  const archive = buildTournaments(rows, '/nonexistent', 'test', TEAMS_DIR).tournaments[0]!;
  assert.equal(archive.entrants[0]!.teamSheet?.length, 6);
  assert.equal(archive.entrants[1]!.teamSheet?.length, 6);
  assert.ok(archive.entrants[0]!.teamSheet?.every((set) => set.spriteId && set.moves.length > 0));
});

test('live CLI tournament series join the bracket by their current series index', () => {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-live-tournament-'));
  const runId = 'cup-live';
  const runDir = path.join(runsDir, runId);
  const seriesDir = path.join(runDir, 'series', 'series-live');
  fs.mkdirSync(seriesDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, 'config.json'),
    `${JSON.stringify({
      mode: 'tournament',
      pool: null,
      entrants: [
        { model: 'provider:alpha', team: 'Alpha team' },
        { model: 'provider:beta', team: 'Beta team' },
        { model: 'provider:gamma', team: 'Gamma team' },
        { model: 'provider:delta', team: 'Delta team' },
      ],
    })}\n`,
    'utf8',
  );
  fs.writeFileSync(
    path.join(runDir, 'status.json'),
    `${JSON.stringify({ state: 'running', pid: process.pid, start_time: '2026-08-06T21:00:00.000Z' })}\n`,
    'utf8',
  );
  fs.writeFileSync(
    path.join(seriesDir, 'series.json'),
    `${JSON.stringify({ schema_version: 3, identity: { series_index: 1 } })}\n`,
    'utf8',
  );
  fs.writeFileSync(path.join(seriesDir, 'p1-decisions.jsonl'), decisionLine(900, 2), 'utf8');
  fs.writeFileSync(
    path.join(seriesDir, 'game-1.log'),
    '|player|p1|p1-provider:beta||\n|player|p2|p2-provider:gamma||\n|turn|2\n',
    'utf8',
  );
  try {
    const archive = buildTournaments([], runsDir, null).tournaments[0]!;
    assert.equal(archive.when, '2026-08-06T21:00:00.000Z');
    assert.deepEqual(archive.liveSeries[0], {
      seriesId: 'series-live',
      seriesIndex: 1,
      round: 0,
      slots: [1, 2],
      game: 1,
      turn: 2,
      decisions: 1,
    });
    const game = buildTournamentGame([], runsDir, runId, 1, 1);
    assert.ok(game, 'the inferred series index opens the live game');
    assert.deepEqual(game.teamNames, ['Beta team', 'Gamma team']);
    assert.equal(game.snapshot?.turn, 2);
  } finally {
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
});
