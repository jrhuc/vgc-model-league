import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildLeague, buildLeagueGame, buildLeagues, buildModelProfile } from '../src/archive.js';
import { appendRow, loadRows, type SeriesRecord } from '../src/records.js';

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
        model: 'compat:beta:nitro',
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
      model: 'compat:beta:nitro',
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

test('a live run with no recorded series surfaces as a drafting league', () => {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-archive-live-'));
  const liveId = '20260728T210000.000000Z-feed0001';
  const runDir = path.join(runsDir, liveId);
  fs.mkdirSync(path.join(runDir, 'draft'), { recursive: true });
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
    path.join(runDir, 'status.json'),
    JSON.stringify({
      state: 'running',
      error: null,
      notices: [],
      start_time: '2026-07-28T21:00:00.000Z',
      end_time: null,
      pid: process.pid,
    }),
  );
  fs.writeFileSync(
    path.join(runDir, 'draft', 'draft.jsonl'),
    `${JSON.stringify({ pick: 1, model: 'openai:alpha', mon: 'pikachu', name: 'Pikachu', cost: 12, budget_left: 88, rationale: 'Speed.', fallback: false })}\n`,
  );
  try {
    const { leagues } = buildLeagues([], runsDir);
    assert.equal(leagues.length, 1);
    assert.equal(leagues[0]!.live, true);
    assert.equal(leagues[0]!.phase, 'drafting');
    assert.equal(leagues[0]!.picks, 1);

    const league = buildLeague([], runsDir, liveId);
    assert.ok(league, 'a live run builds a league view before any series lands');
    assert.equal(league!.live, true);
    assert.equal(league!.phase, 'drafting');
    const alpha = league!.franchises.find((franchise) => franchise.model === 'openai:alpha');
    assert.equal(alpha?.roster[0]?.id, 'pikachu', 'rosters synthesize from draft picks before rosters.json fills in');
    assert.equal(alpha?.spent, 12);
    assert.equal(alpha?.budgetLeft, 88);

    fs.writeFileSync(
      path.join(runDir, 'status.json'),
      JSON.stringify({
        state: 'running',
        error: null,
        notices: [],
        start_time: '2026-07-28T21:00:00.000Z',
        end_time: null,
        pid: 999999999,
      }),
    );
    assert.equal(buildLeagues([], runsDir).leagues.length, 0, 'a dead pid means the rowless run is not live');
    assert.equal(buildLeague([], runsDir, liveId), null);
  } finally {
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
});

test('live league games expose battlefield sprites before the series is recorded', () => {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-archive-live-game-'));
  const runId = '20260728T220000.000000Z-feed0002';
  const runDir = path.join(runsDir, runId);
  const seriesDir = path.join(runDir, 'series', 'live001');
  fs.mkdirSync(seriesDir, { recursive: true });
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
    path.join(runDir, 'status.json'),
    JSON.stringify({
      state: 'running',
      error: null,
      notices: [],
      start_time: '2026-07-28T22:00:00.000Z',
      end_time: null,
      pid: process.pid,
    }),
  );
  fs.writeFileSync(
    path.join(seriesDir, 'series.json'),
    JSON.stringify({ players: { p1: 'openai:alpha', p2: 'openai:beta' }, series_index: 0 }),
  );
  fs.writeFileSync(path.join(seriesDir, 'game-1.log'), '');
  fs.writeFileSync(
    path.join(seriesDir, 'p1-decisions.jsonl'),
    `${JSON.stringify({
      kind: 'game_reflection',
      game_number: 1,
      result: 'won',
      summary: 'The speed plan worked.',
      adjustment: 'Keep the matchup notes for a rematch.',
      notebook: 'Protect turn one.',
      series_over: true,
    })}\n`,
  );
  try {
    const starting = buildLeagueGame([], runsDir, runId, 0, 1);
    assert.ok(starting?.snapshot, 'an empty streamed log is a live team-preview state, not a missing battlefield');
    assert.equal(starting.live, true);

    fs.writeFileSync(
      path.join(seriesDir, 'game-1.log'),
      [
        '|player|p1|openai:alpha|',
        '|player|p2|openai:beta|',
        '|teamsize|p1|1',
        '|teamsize|p2|1',
        '|poke|p1|Pikachu, L50|',
        '|poke|p2|Eevee, L50|',
        '|teampreview|',
      ].join('\n'),
    );
    const preview = buildLeagueGame([], runsDir, runId, 0, 1);
    assert.deepEqual(
      preview?.snapshot?.sides.p1.mons.map((mon) => mon.spriteId),
      ['pikachu'],
      'the disk-backed live view resolves the same sprites as the arena',
    );
    assert.equal(preview?.reflections[0]?.seriesOver, true);
  } finally {
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
});

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
  assert.equal(card.tradeWindowAfterWeek, null);
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
  assert.equal(alpha.draftRoster[0]!.id, 'pikachu');
  assert.equal(league.tradeWindow, null);
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

test('archived leagues overlay post-window rosters without rewriting the draft', () => {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-archive-window-'));
  try {
    writeLeagueFixture(runsDir);
    const runDir = path.join(runsDir, RUN_ID);
    const config = JSON.parse(fs.readFileSync(path.join(runDir, 'config.json'), 'utf8')) as Record<string, unknown>;
    config.trade_window = { after_week: 1 };
    fs.writeFileSync(path.join(runDir, 'config.json'), JSON.stringify(config));
    fs.writeFileSync(
      path.join(runDir, 'window.json'),
      JSON.stringify({
        after_week: 1,
        order: [0, 1],
        decisions: [
          {
            entrant: 0,
            model: 'openai:alpha',
            swaps: [{ drop: 'pikachu', add: 'raichu' }],
            reasoning: 'The extra speed matters.',
            notebook: 'Use Raichu.',
            fallback: false,
          },
          {
            entrant: 1,
            model: 'openai:beta',
            swaps: [],
            reasoning: 'Keep the roster.',
            notebook: 'No change.',
            fallback: false,
          },
        ],
        rosters: [
          {
            model: 'openai:alpha',
            team_name: 'Alpha Aces',
            budget_left: 20,
            spent: 80,
            roster: [{ id: 'raichu', name: 'Raichu', cost: 80 }],
          },
          {
            model: 'compat:beta:nitro',
            team_name: 'Beta Bandits',
            budget_left: 40,
            spent: 60,
            roster: [{ id: 'eevee', name: 'Eevee', cost: 60 }],
          },
        ],
      }),
    );

    const card = buildLeagues(LEAGUE_ROWS, runsDir).leagues[0]!;
    assert.equal(card.tradeWindowAfterWeek, 1);
    const league = buildLeague(LEAGUE_ROWS, runsDir, RUN_ID)!;
    assert.equal(league.tradeWindow?.afterWeek, 1);
    assert.equal(league.tradeWindow?.complete, true);
    assert.deepEqual(league.tradeWindow?.decisions[0]?.swaps, [{ drop: 'pikachu', add: 'raichu' }]);
    assert.equal(league.franchises[0]!.draftRoster[0]!.id, 'pikachu');
    assert.equal(league.franchises[0]!.roster[0]!.id, 'raichu');
    assert.equal(league.franchises[0]!.spent, 80);
  } finally {
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
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
