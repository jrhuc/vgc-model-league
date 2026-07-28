import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildEvidence, buildTournaments } from '../src/evidence.js';
import type { SeriesRecord } from '../src/records.js';

function decisionLine(latency: number, turn: number, extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ kind: 'decision', latency_ms: latency, game_number: 1, turn, phase: 'turn', ...extra })}\n`;
}

test('buildEvidence aggregates decision logs, rates, and luck', () => {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-evidence-'));
  const seriesDir = path.join(runsDir, 'run-1', 'series', 'abc123');
  fs.mkdirSync(seriesDir, { recursive: true });
  fs.writeFileSync(
    path.join(seriesDir, 'p1-decisions.jsonl'),
    decisionLine(10_000, 1) +
      decisionLine(20_000, 2) +
      decisionLine(30_000, 3) +
      `${JSON.stringify({ kind: 'game_reflection', game_number: 1 })}\n` +
      'not json\n',
  );
  const row: SeriesRecord = {
    mode: 'rotation',
    run_id: 'run-1',
    series_id: 'abc123',
    timestamp: '2026-07-24T12:00:00.000Z',
    pool: 'test',
    players: { p1: 'omp:cursor/example-model', p2: 'random' },
    winner: 'omp:cursor/example-model',
    score: { p1: 2, p2: 1 },
    turns: 12,
    games: [
      {
        number: 1,
        luck: {
          p1: { misses: 1, crits_taken: 0, flinched_turns: 0, full_paralysis: 0 },
          p2: { misses: 0, crits_taken: 2, flinched_turns: 1, full_paralysis: 0 },
        },
      },
    ],
    decision_stats: {
      p1: {
        decisions: 3,
        fallbacks: 1,
        reflections: 1,
        reflection_fallbacks: 0,
        move_selections: 4,
        switch_selections: 2,
        protect_selections: 1,
        tool_lookups: 6,
        parse_failures: 2,
        provider_retries: 0,
        threat_turns: 4,
        threat_hits: 3,
      },
      p2: {},
    },
  };
  const evidence = buildEvidence([row], runsDir, 'test');
  assert.equal(evidence.count, 1);
  assert.equal(evidence.decisions, 3);
  assert.equal(evidence.models.length, 1, 'the reference side carries no evidence');
  const model = evidence.models[0]!;
  assert.equal(model.spec, 'example-model');
  assert.deepEqual(model.providers, ['omp:cursor/example-model']);
  assert.equal(model.points.length, 3);
  assert.equal(model.latency?.median, 20_000);
  assert.equal(model.latency?.max, 30_000);
  assert.equal(model.rates.fallback, 1 / 3);
  assert.equal(model.rates.switch, 2 / 6);
  assert.equal(model.rates.toolLookups, 2);
  assert.equal(model.rates.threatConversion, 3 / 4);
  const series = evidence.series[0]!;
  assert.equal(series.winner, 'example-model');
  assert.deepEqual(series.luck, { p1: 1, p2: 3 });
  assert.equal(series.winnerLuckDelta, -2, 'the winner suffered two fewer adverse events');
  const traversal = buildEvidence([{ ...row, run_id: '../run-1' } as SeriesRecord], runsDir, 'test');
  assert.equal(traversal.models[0]!.points.length, 0, 'unsafe run ids never reach the filesystem');
  fs.rmSync(runsDir, { recursive: true, force: true });
});

test('overall play evidence includes every mode and excludes the test pool', () => {
  const modes: SeriesRecord['mode'][] = ['rotation', 'draft', 'tournament', 'exhibition'];
  const rows = modes.map(
    (mode, index) =>
      ({
        mode,
        run_id: `run-${index}`,
        series_id: `series-${index}`,
        timestamp: `2026-07-24T12:00:0${index}.000Z`,
        pool: mode === 'draft' ? undefined : 'regmb',
        players: { p1: `provider:model-${index}`, p2: 'random' },
        winner: `provider:model-${index}`,
        score: { p1: 2, p2: 0 },
        turns: 8,
        games: [],
        decision_stats: { p1: { decisions: 2 }, p2: {} },
      }) as SeriesRecord,
  );
  rows.push({ ...rows[0]!, run_id: 'scratch', series_id: 'scratch', pool: 'test' });
  const evidence = buildEvidence(rows, '/missing-runs', null);
  assert.equal(evidence.count, 4);
  assert.equal(evidence.decisions, 8);
  assert.deepEqual(
    evidence.models.map((model) => model.spec),
    ['model-0', 'model-1', 'model-2', 'model-3'],
  );
});

test('buildTournaments counts placements by distance from the final', () => {
  const match = (round: number, p1: string, p2: string, winner: string): SeriesRecord =>
    ({
      mode: 'tournament',
      run_id: 'cup-1',
      round,
      pool: 'majors',
      players: { p1, p2 },
      winner,
      advanced: winner,
    }) as SeriesRecord;
  const rows = [
    match(1, 'openai:alpha', 'openai:beta', 'openai:alpha'),
    match(1, 'openai:gamma', 'openai:delta', 'openai:delta'),
    match(2, 'openai:alpha', 'openai:delta', 'openai:alpha'),
  ];
  const summary = buildTournaments(rows, '/nonexistent', null).summary;
  assert.equal(summary.tournaments, 1);
  assert.equal(summary.matches, 3);
  const bySpec = Object.fromEntries(summary.standings.map((entry) => [entry.spec, entry]));
  assert.deepEqual({ titles: bySpec.alpha!.titles, wins: bySpec.alpha!.matchWins }, { titles: 1, wins: 2 });
  assert.equal(bySpec.delta!.runnerUp, 1);
  assert.equal(bySpec.beta!.semis, 1);
  assert.equal(bySpec.gamma!.semis, 1);
  assert.equal(summary.standings[0]!.spec, 'alpha', 'titles lead the sort');
  const scoped = buildTournaments(rows, '/nonexistent', 'other-pool').summary;
  assert.equal(scoped.tournaments, 0, 'pool scoping applies to tournament rows');
});

test('buildTournaments reconstructs a bracket with byes from row seeds', () => {
  const match = (
    seriesIndex: number,
    round: number,
    seeds: [number, number],
    p1: string,
    p2: string,
    winnerSide: 'p1' | 'p2',
  ): SeriesRecord =>
    ({
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
    }) as SeriesRecord;
  const rows = [
    match(0, 1, [1, 2], 'openai:beta', 'openai:gamma', 'p2'),
    match(1, 2, [0, 2], 'openai:alpha', 'openai:gamma', 'p1'),
  ];
  const response = buildTournaments(rows, '/nonexistent', null);
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
