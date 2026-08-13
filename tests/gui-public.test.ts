import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildLeague, buildLeagueGame } from '../src/archive.js';
import { buildTournamentGame, buildTournaments } from '../src/evidence.js';
import { GuiServer } from '../src/gui/server.js';
import { TEAMS_DIR } from '../src/paths.js';
import { loadSeriesRecords } from '../src/records.js';
import { leagueTeamBuildJournalRow } from './fixtures/team-build.js';

const LEAGUE_RUN = '20260808T120000.000000Z-public01';
const TOURNAMENT_RUN = '20260808T130000.000000Z-public02';

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value)}\n`, 'utf8');
}

function writeArchiveFixture(root: string): { runsDir: string; recordsPath: string } {
  const runsDir = path.join(root, 'runs');
  const recordsPath = path.join(root, 'records.jsonl');
  const leagueDir = path.join(runsDir, LEAGUE_RUN);
  const leagueSeries = path.join(leagueDir, 'series', 'league-series');
  fs.mkdirSync(path.join(leagueDir, 'draft'), { recursive: true });
  fs.mkdirSync(path.join(leagueDir, 'teambuild'), { recursive: true });
  fs.mkdirSync(leagueSeries, { recursive: true });
  writeJson(path.join(leagueDir, 'config.json'), {
    mode: 'draft',
    entrants: ['openai:alpha', 'openai:beta'],
    team_names: ['Alpha Aces', 'Beta Bandits'],
    weeks: 1,
    board: 'regmb-202607',
    format: 'gen9championsvgc2026regmbbo3',
    closed_sheets: true,
    trade_window: { after_week: 1, trades_allowed: 0 },
  });
  writeJson(path.join(leagueDir, 'rosters.json'), [
    {
      model: 'openai:alpha',
      team_name: 'Alpha Aces',
      spent: 20,
      budget_left: 80,
      roster: [{ id: 'pikachu', name: 'Pikachu', cost: 20 }],
    },
    {
      model: 'openai:beta',
      team_name: 'Beta Bandits',
      spent: 20,
      budget_left: 80,
      roster: [{ id: 'eevee', name: 'Eevee', cost: 20 }],
    },
  ]);
  writeJson(path.join(leagueDir, 'draft', 'draft.jsonl'), {
    pick: 1,
    model: 'openai:alpha',
    mon: 'pikachu',
    name: 'Pikachu',
    cost: 20,
    budget_left: 80,
    rationale: 'Drafted for exact speed control.',
    fallback: false,
  });
  writeJson(
    path.join(leagueDir, 'teambuild', 'teambuild.jsonl'),
    leagueTeamBuildJournalRow({
      teamPlan: 'The exact imported build rationale.',
      notebook: 'The exact imported matchup notebook.',
      attempts: 7,
      sheetPolicy: 'closed',
    }),
  );
  writeJson(path.join(leagueDir, 'window.json'), {
    after_week: 1,
    order: [0, 1],
    offers: [],
    decisions: [
      {
        entrant: 0,
        model: 'openai:alpha',
        swaps: [{ drop: 'pikachu', add: 'raichu' }],
        reasoning: 'The exact imported window reasoning.',
        notebook: 'Use Raichu next week.',
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
        entrant: 0,
        model: 'openai:alpha',
        team_name: 'Alpha Aces',
        budget_left: 80,
        spent: 20,
        roster: [{ id: 'raichu', name: 'Raichu', cost: 20 }],
      },
      {
        entrant: 1,
        model: 'openai:beta',
        team_name: 'Beta Bandits',
        budget_left: 80,
        spent: 20,
        roster: [{ id: 'eevee', name: 'Eevee', cost: 20 }],
      },
    ],
  });
  writeJson(path.join(leagueDir, 'season.jsonl'), {
    entrant: 1,
    outcome: 'eliminated',
    summary: 'The exact imported season review.',
    did_well: 'Protected the win condition.',
    did_poorly: 'Lost speed control.',
    would_change: 'Preserve the lead.',
    fallback: false,
  });
  fs.writeFileSync(
    path.join(leagueSeries, 'game-1.log'),
    [
      '|player|p1|openai:alpha|',
      '|player|p2|openai:beta|',
      '|turn|1',
      '|move|p1a: Pikachu|Thunderbolt|p2a: Eevee',
      '|-damage|p2a: Eevee|123/321',
      '|win|openai:alpha',
    ].join('\n'),
    'utf8',
  );
  fs.writeFileSync(
    path.join(leagueSeries, 'p1-decisions.jsonl'),
    `${JSON.stringify({
      kind: 'decision',
      game_number: 1,
      turn: 1,
      phase: 'turn',
      selection: ['move 1'],
      action: 'move 1 +1',
      rationale: 'The exact imported decision rationale.',
      notebook: 'The exact imported notebook.',
      latency_ms: 100,
      total_tokens: 200,
      reasoning_tokens: 100,
    })}\n${JSON.stringify({
      kind: 'game_reflection',
      game_number: 1,
      result: 'won',
      summary: 'The exact imported reflection.',
      adjustment: 'Keep the same lead.',
      notebook: 'Carry this notebook forward.',
      series_over: true,
    })}\n`,
    'utf8',
  );

  const tournamentDir = path.join(runsDir, TOURNAMENT_RUN);
  const tournamentSeries = path.join(tournamentDir, 'series', 'tournament-series');
  fs.mkdirSync(tournamentSeries, { recursive: true });
  writeJson(path.join(tournamentDir, 'config.json'), {
    mode: 'tournament',
    pool: 'vr-aug26-top8',
    entrants: [
      { model: 'openai:alpha', team: '3rd-zuniga-froslass-scovillain', seed: 0 },
      { model: 'openai:beta', team: '6th-markl-floette-sneasler', seed: 1 },
    ],
  });
  fs.writeFileSync(
    path.join(tournamentSeries, 'game-1.log'),
    ['|player|p1|openai:alpha|', '|player|p2|openai:beta|', '|turn|1', '|win|openai:alpha'].join('\n'),
    'utf8',
  );
  writeJson(path.join(tournamentSeries, 'p1-decisions.jsonl'), {
    kind: 'decision',
    game_number: 1,
    turn: 1,
    action: 'move 1 +1',
    rationale: 'The exact tournament decision.',
    notebook: 'The exact tournament notebook.',
  });

  const common = {
    schema_version: 1,
    protocol_version: 1,
    scaffold: 'fixture',
    format: 'gen9championsvgc2026regmbbo3',
    winner: 'openai:alpha',
    winner_side: 'p1',
    score: { p1: 2, p2: 0 },
    turns: 1,
    games: [{ number: 1, winner: 'openai:alpha', winner_side: 'p1', turns: 1, seed: [1, 2, 3, 4] }],
    engine_seeds: { p1: 101, p2: 202 },
    reasoning: null,
    decision_stats: { p1: { decisions: 1, tool_lookups: 99 }, p2: { decisions: 1 } },
    run_seed: 303,
    ps_commit: '0000000000000000000000000000000000000000',
    origin: { source: 'import', at: '2026-08-08T14:00:00.000Z' },
  };
  const rows = [
    {
      ...common,
      mode: 'draft',
      run_id: LEAGUE_RUN,
      series_id: 'league-series',
      series_index: 0,
      stage: 'playoff',
      round: 1,
      timestamp: '2026-08-08T12:30:00.000Z',
      players: { p1: 'openai:alpha', p2: 'openai:beta' },
      teams: { p1: 'Alpha Aces', p2: 'Beta Bandits' },
    },
    {
      ...common,
      mode: 'tournament',
      run_id: TOURNAMENT_RUN,
      series_id: 'tournament-series',
      series_index: 0,
      entrant_count: 2,
      round: 1,
      timestamp: '2026-08-08T13:30:00.000Z',
      pool: 'vr-aug26-top8',
      players: { p1: 'openai:alpha', p2: 'openai:beta' },
      teams: { p1: '3rd-zuniga-froslass-scovillain', p2: '6th-markl-floette-sneasler' },
      seeds: { p1: 0, p2: 1 },
      advanced: 'openai:alpha',
    },
  ];
  fs.writeFileSync(recordsPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  return { runsDir, recordsPath };
}

async function archiveGet(port: number, pathname: string): Promise<{ status: number; body: string; json: unknown }> {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: pathname }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({ status: response.statusCode ?? 0, body, json: JSON.parse(body) as unknown });
      });
    });
    request.on('error', reject);
    request.end();
  });
}

test('the archive routes render imported league and tournament evidence exactly', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-public-archive-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixture = writeArchiveFixture(root);
  const rows = loadSeriesRecords(fixture.recordsPath);
  const gui = new GuiServer({
    ...fixture,
    teamsDir: TEAMS_DIR,
    host: '127.0.0.1',
  });
  await gui.listen(0);
  const address = gui.server.address();
  assert.ok(address && typeof address === 'object');
  t.after(() => gui.close());

  const league = await archiveGet(address.port, `/api/league?run=${LEAGUE_RUN}`);
  assert.equal(league.status, 200);
  assert.deepEqual(league.json, buildLeague(rows, fixture.runsDir, LEAGUE_RUN));
  assert.match(league.body, /Drafted for exact speed control/);
  assert.match(league.body, /"evs":\{"hp":2,"atk":32,"def":0,"spa":0,"spd":0,"spe":32\}/);
  assert.match(league.body, /exact imported build rationale/);
  assert.match(league.body, /exact imported matchup notebook/);
  assert.match(league.body, /exact imported window reasoning/);
  assert.match(league.body, /exact imported season review/);
  assert.match(league.body, /"toolLookups":99/);
  assert.match(league.body, /"seriesId":"league-series"/);

  const leagueGame = await archiveGet(address.port, `/api/league/game?run=${LEAGUE_RUN}&series=0&game=1`);
  assert.equal(leagueGame.status, 200);
  assert.deepEqual(leagueGame.json, buildLeagueGame(rows, fixture.runsDir, LEAGUE_RUN, 0, 1));
  assert.match(leagueGame.body, /exact imported decision rationale/);
  assert.match(leagueGame.body, /exact imported notebook/);
  assert.match(leagueGame.body, /exact imported reflection/);
  assert.match(leagueGame.body, /Eevee → 38%/);

  const tournaments = await archiveGet(address.port, '/api/tournaments');
  assert.equal(tournaments.status, 200);
  assert.deepEqual(tournaments.json, buildTournaments(rows, fixture.runsDir, null, TEAMS_DIR));
  assert.match(tournaments.body, /"evs":/);
  assert.match(tournaments.body, /"seed":3/);
  assert.match(tournaments.body, /"paste":/);

  const tournamentGame = await archiveGet(address.port, `/api/tournament/game?run=${TOURNAMENT_RUN}&series=0&game=1`);
  assert.equal(tournamentGame.status, 200);
  assert.deepEqual(tournamentGame.json, buildTournamentGame(rows, fixture.runsDir, TOURNAMENT_RUN, 0, 1, TEAMS_DIR));
  assert.match(tournamentGame.body, /exact tournament decision/);
  assert.match(tournamentGame.body, /exact tournament notebook/);
});
