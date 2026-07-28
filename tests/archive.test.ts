import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildLeague, buildLeagues, buildModelProfile } from '../src/archive.js';
import { appendRow, loadRows, type SeriesRecord } from '../src/records.js';
import { backfillDecisionLog } from '../tools/backfill-reasoning.js';

const RUN_ID = 'league-run-1';

function writeLeagueFixture(runsDir: string): void {
  const runDir = path.join(runsDir, RUN_ID);
  fs.mkdirSync(path.join(runDir, 'draft'), { recursive: true });
  fs.mkdirSync(path.join(runDir, 'teambuild'), { recursive: true });
  fs.writeFileSync(
    path.join(runDir, 'config.json'),
    JSON.stringify({
      mode: 'draft',
      entrants: ['openai:alpha', 'openai:beta'],
      team_names: ['Alpha Aces', 'Beta Bandits'],
      weeks: 1,
      board: 'test-board',
      format: 'gen9testformat',
    }),
  );
  fs.writeFileSync(
    path.join(runDir, 'rosters.json'),
    JSON.stringify([
      {
        model: 'openai:alpha',
        team_name: 'Alpha Aces',
        budget_left: 10,
        spent: 90,
        roster: [{ id: 'pikachu', name: 'Pikachu', cost: 90 }],
      },
      {
        model: 'openai:beta',
        team_name: 'Beta Bandits',
        budget_left: 40,
        spent: 60,
        roster: [{ id: 'eevee', name: 'Eevee', cost: 60 }],
      },
    ]),
  );
  fs.writeFileSync(
    path.join(runDir, 'draft', 'draft.jsonl'),
    `${JSON.stringify({
      pick: 1,
      model: 'openai:alpha',
      team_name: 'Alpha Aces',
      mon: 'pikachu',
      name: 'Pikachu',
      cost: 90,
      rationale: 'Fast pivot.',
      fallback: false,
    })}\n${JSON.stringify({
      pick: 2,
      model: 'openai:beta',
      team_name: 'Beta Bandits',
      mon: 'eevee',
      name: 'Eevee',
      cost: 60,
      rationale: 'Flexible evolutions.',
      fallback: true,
    })}\n`,
  );
  fs.writeFileSync(
    path.join(runDir, 'teambuild', 'teambuild.jsonl'),
    `${JSON.stringify({
      model: 'openai:alpha',
      team_name: 'Alpha Aces',
      seriesIndex: 0,
      entrant: 0,
      opponent: 1,
      brought: ['pikachu'],
      sets: [],
      rationale: 'Lead fast.',
      attempts: 1,
    })}\n`,
  );
  for (const [seriesId, tokens] of [
    ['aaa111', 100],
    ['bbb222', 200],
  ] as const) {
    const seriesDir = path.join(runDir, 'series', seriesId);
    fs.mkdirSync(seriesDir, { recursive: true });
    fs.writeFileSync(
      path.join(seriesDir, 'p1-decisions.jsonl'),
      `${JSON.stringify({
        kind: 'decision',
        game_number: 1,
        turn: 1,
        phase: 'turn',
        latency_ms: 5000,
        total_tokens: tokens,
        reasoning_tokens: 40,
      })}\n`,
    );
  }
}

function leagueRow(overrides: Record<string, unknown>): SeriesRecord {
  return {
    mode: 'draft',
    run_id: RUN_ID,
    board: 'test-board',
    format: 'gen9testformat',
    players: { p1: 'openai:alpha', p2: 'openai:beta' },
    decision_stats: { p1: { decisions: 10, cost: 0.5 }, p2: { decisions: 12 } },
    ...overrides,
  } as SeriesRecord;
}

const LEAGUE_ROWS: SeriesRecord[] = [
  leagueRow({
    series_index: 0,
    series_id: 'aaa111',
    stage: 'roundrobin',
    round: 1,
    timestamp: '2026-07-20T10:00:00.000Z',
    teams: { p1: 'Alpha Aces wk1', p2: 'Beta Bandits wk1' },
    winner: 'openai:alpha',
    winner_side: 'p1',
    score: { p1: 2, p2: 1 },
    turns: 20,
    games: [
      { number: 1, winner_side: 'p1', turns: 8 },
      { number: 2, winner_side: 'p2', turns: 6 },
      { number: 3, winner_side: 'p1', turns: 6 },
    ],
  }),
  leagueRow({
    series_index: 1,
    series_id: 'bbb222',
    stage: 'playoff',
    round: 1,
    timestamp: '2026-07-20T14:00:00.000Z',
    players: { p1: 'openai:beta', p2: 'openai:alpha' },
    teams: { p1: 'Beta Bandits wk1', p2: 'Alpha Aces wk1' },
    winner: 'openai:beta',
    winner_side: 'p1',
    score: { p1: 2, p2: 0 },
    turns: 12,
    games: [
      { number: 1, winner_side: 'p1', turns: 6 },
      { number: 2, winner_side: 'p1', turns: 6 },
    ],
  }),
];

test('buildLeagues lists a stored league with its champion', () => {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-archive-'));
  writeLeagueFixture(runsDir);
  const { leagues } = buildLeagues(LEAGUE_ROWS, runsDir);
  assert.equal(leagues.length, 1);
  const card = leagues[0]!;
  assert.equal(card.runId, RUN_ID);
  assert.equal(card.board, 'test-board');
  assert.deepEqual(card.teamNames, ['Alpha Aces', 'Beta Bandits']);
  assert.equal(card.phase, 'complete');
  assert.equal(card.week, 1);
  assert.equal(card.champion?.team, 'Beta Bandits');
  assert.equal(card.seriesCount, 2);
  fs.rmSync(runsDir, { recursive: true, force: true });
});

test('buildLeague joins config, rosters, draft, teambuilds, results, and spend', () => {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-archive-'));
  writeLeagueFixture(runsDir);
  const league = buildLeague(LEAGUE_ROWS, runsDir, RUN_ID);
  assert.ok(league);
  assert.equal(league.budget, 100);
  assert.equal(league.picksPerEntrant, 1);
  assert.equal(league.phase, 'complete');
  assert.equal(league.champion?.entrant, 1);
  const alpha = league.franchises[0]!;
  assert.equal(alpha.teamName, 'Alpha Aces');
  assert.deepEqual(alpha.overallRecord, { w: 1, l: 1, gw: 2, gl: 3 });
  assert.deepEqual(alpha.roundRobinRecord, { w: 1, l: 0, gw: 2, gl: 1 });
  assert.deepEqual(league.franchises[1]!.overallRecord, { w: 1, l: 1, gw: 3, gl: 2 });
  assert.equal(alpha.finish, 'Runner-up');
  assert.equal(league.franchises[1]!.finish, 'Champion');
  const slot = alpha.roster[0]!;
  assert.deepEqual(
    { pick: slot.pick, rationale: slot.rationale, fallback: slot.fallback },
    { pick: 1, rationale: 'Fast pivot.', fallback: false },
  );
  assert.equal(league.franchises[1]!.roster[0]!.fallback, true);
  assert.equal(league.series.length, 2);
  const final = league.series[1]!;
  assert.deepEqual(final.sides, [1, 0], 'team labels map sides to entrants');
  assert.equal(final.winner, 1);
  assert.deepEqual(
    final.games.map((game) => game.winner),
    [1, 1],
  );
  assert.equal(league.teambuilds.length, 1);
  assert.equal(league.spend.decisions, 44);
  assert.equal(league.spend.tokens, 300);
  assert.equal(league.spend.reasoningTokens, 80);
  assert.equal(league.spend.cost, 1);
  assert.equal(buildLeague(LEAGUE_ROWS, runsDir, '../evil'), null, 'unsafe run ids never reach the filesystem');
  assert.equal(buildLeague(LEAGUE_ROWS, runsDir, 'unknown-run'), null);
  fs.rmSync(runsDir, { recursive: true, force: true });
});

test('buildModelProfile aggregates every mode with per-mode records and run links', () => {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-archive-'));
  writeLeagueFixture(runsDir);
  const rotation: SeriesRecord = {
    mode: 'rotation',
    run_id: 'rot-run',
    series_id: 'ccc333',
    timestamp: '2026-07-21T10:00:00.000Z',
    pool: 'majors',
    players: { p1: 'openrouter:lab/alpha', p2: 'openai:beta' },
    winner: 'openrouter:lab/alpha',
    winner_side: 'p1',
    score: { p1: 2, p2: 0 },
    games: [{ number: 1 }, { number: 2 }],
    decision_stats: {
      p1: { decisions: 5, fallbacks: 1, move_selections: 8, switch_selections: 2, team_previews: 2 },
      p2: { decisions: 4 },
    },
  } as SeriesRecord;
  const profile = buildModelProfile([...LEAGUE_ROWS, rotation], runsDir, 'alpha');
  assert.ok(profile);
  assert.deepEqual(profile.providers, ['openai:alpha', 'openrouter:lab/alpha'], 'aliases merge by model key');
  assert.equal(profile.series, 3);
  assert.equal(profile.games, 7);
  assert.equal(profile.decisions, 27);
  assert.equal(profile.totalTokens, 100, 'only logs for the sides this model played');
  assert.equal(profile.reasoningTokens, 40);
  assert.equal(profile.cost, 0.5);
  assert.equal(profile.rates.switch, 2 / 10);
  const modes = Object.fromEntries(profile.modes.map((mode) => [mode.mode, mode]));
  assert.deepEqual([modes.draft!.w, modes.draft!.l], [1, 1]);
  assert.deepEqual([modes.rotation!.w, modes.rotation!.l], [1, 0]);
  assert.equal(modes.draft!.runs[0]!.runId, RUN_ID);
  assert.equal(modes.rotation!.runs.length, 0, 'only draft and tournament runs link out');
  assert.equal(buildModelProfile([rotation], runsDir, 'nobody'), null);
  const testPool = { ...rotation, pool: 'test' } as SeriesRecord;
  assert.equal(buildModelProfile([testPool], runsDir, 'alpha'), null, 'the test pool stays out of profiles');
  fs.rmSync(runsDir, { recursive: true, force: true });
});

test('loadRows caches by mtime and size but sees appended rows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-records-cache-'));
  const file = path.join(dir, 'results.jsonl');
  appendRow(file, { players: { p1: 'a', p2: 'b' } });
  const first = loadRows(file);
  assert.equal(first.length, 1);
  assert.equal(loadRows(file), first, 'unchanged files return the cached array');
  appendRow(file, { players: { p1: 'c', p2: 'd' } });
  assert.equal(loadRows(file).length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('backfill copies reasoning tokens from traces onto matching decision rows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-backfill-'));
  const decisions = path.join(dir, 'p1-decisions.jsonl');
  const traces = path.join(dir, 'p1-trace.jsonl');
  fs.writeFileSync(
    decisions,
    [
      JSON.stringify({ kind: 'decision', game_id: 'g1', turn: 1, phase: 'turn', total_tokens: 50 }),
      JSON.stringify({ kind: 'decision', game_id: 'g1', turn: 2, phase: 'turn', automatic: true }),
      JSON.stringify({ kind: 'decision', game_id: 'g1', turn: 3, phase: 'turn', reasoning_tokens: 7 }),
      JSON.stringify({ kind: 'game_reflection', game_id: 'g1', game_number: 1 }),
    ]
      .map((line) => `${line}\n`)
      .join(''),
  );
  fs.writeFileSync(
    traces,
    [
      JSON.stringify({
        kind: 'decision_trace',
        game_id: 'g1',
        turn: 1,
        phase: 'turn',
        usage: { reasoning_tokens: 11 },
      }),
      JSON.stringify({
        kind: 'decision_trace',
        game_id: 'g1',
        turn: 3,
        phase: 'turn',
        usage: { reasoning_tokens: 99 },
      }),
      JSON.stringify({ kind: 'reflection_trace', game_id: 'g1', game_number: 1, usage: { reasoning_tokens: 23 } }),
    ]
      .map((line) => `${line}\n`)
      .join(''),
  );
  assert.equal(backfillDecisionLog(decisions, traces), 2);
  const rows = fs
    .readFileSync(decisions, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(rows[0]!.reasoning_tokens, 11);
  assert.equal(rows[1]!.reasoning_tokens, undefined, 'automatic rows have no model usage');
  assert.equal(rows[2]!.reasoning_tokens, 7, 'already-populated rows stay untouched');
  assert.equal(rows[3]!.reasoning_tokens, 23, 'reflections match by game number');
  assert.equal(backfillDecisionLog(decisions, traces), 0, 'the backfill is idempotent');
  fs.rmSync(dir, { recursive: true, force: true });
});
