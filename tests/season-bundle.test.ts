import assert from 'node:assert/strict';
import test from 'node:test';

import { buildDraftLeagueSchedule, type DraftLeagueSeriesPlan } from '../src/draftleague.js';
import type { LeagueFranchiseView, LeagueResponse, LeagueSeriesView } from '../src/gui/api.js';
import { buildPublicSeasonBundle, type PublicSeasonGameInput } from '../src/public/season-bundle.js';

const PRIVATE_SENTINEL = 'TOP_SECRET_MATCHUP_NOTEBOOK';

function franchise(entrant: number, pick: number): LeagueFranchiseView {
  const pokemon = {
    id: `pokemon-${entrant}`,
    name: `Pokémon ${entrant}`,
    spriteId: `pokemon-${entrant}`,
    cost: 10,
    pick,
    rationale: 'PUBLIC_PICK_RATIONALE',
    fallback: false,
    acquired: 'draft' as const,
  };
  return {
    entrant,
    model: `provider:model-${entrant}`,
    teamName: `Franchise ${entrant}`,
    spent: 10,
    budgetLeft: 90,
    overallRecord: { w: 0, l: 0, gw: 0, gl: 0 },
    roundRobinRecord: { w: 0, l: 0, gw: 0, gl: 0 },
    finish: '',
    roster: [pokemon],
    draftRoster: [pokemon],
    stats: {
      decisions: 0,
      latency: null,
      reasoningTokens: null,
      cost: null,
      toolLookups: 0,
      parseFailures: 0,
      fallbacks: 0,
      moveSelections: 0,
      switchSelections: 0,
      protectSelections: 0,
      consecutiveProtects: 0,
      spreadSelections: 0,
      megaSelections: 0,
      buildAttempts: 0,
      leadChanges: 0,
      bringChanges: 0,
    },
  };
}

function completedSeries(
  seriesIndex: number,
  round: number,
  sides: [number, number],
  winner: number,
): LeagueSeriesView {
  return {
    seriesIndex,
    seriesId: `series-${seriesIndex}`,
    stage: 'roundrobin',
    round,
    timestamp: '2026-08-20T00:00:00.000Z',
    sides,
    score: winner === sides[0] ? [2, 0] : [0, 2],
    winner,
    turns: 12,
    games: [
      { winner, turns: 5 },
      { winner, turns: 7 },
    ],
  };
}

function fixture(): { league: LeagueResponse; plans: DraftLeagueSeriesPlan[] } {
  const { plans } = buildDraftLeagueSchedule(4, 7);
  const released = plans.slice(0, 2).map((plan) => {
    assert.ok(plan.entrants);
    return completedSeries(plan.index, plan.round, plan.entrants, plan.entrants[0]);
  });
  const future = plans[2]!;
  assert.ok(future.entrants);
  return {
    plans,
    league: {
      runId: 'season-test',
      when: '2026-08-20T00:00:00.000Z',
      lastPlayed: '2026-08-20T01:00:00.000Z',
      board: 'board-test',
      format: 'gen9championsvgc2026regmbbo3',
      budget: 100,
      picksPerEntrant: 1,
      weeks: 3,
      playoffRounds: 1,
      phase: 'complete',
      week: 3,
      champion: { entrant: 0, model: 'provider:model-0', team: 'Franchise 0' },
      draftOnly: false,
      lifecycle: 'complete',
      liveSeries: [],
      transactions: [],
      seasonReviews: [
        {
          entrant: 0,
          outcome: PRIVATE_SENTINEL,
          summary: PRIVATE_SENTINEL,
          didWell: PRIVATE_SENTINEL,
          didPoorly: PRIVATE_SENTINEL,
          wouldChange: PRIVATE_SENTINEL,
          fallback: false,
        },
      ],
      franchises: [0, 1, 2, 3].map((entrant) => franchise(entrant, entrant + 1)),
      series: [...released, completedSeries(future.index, future.round, future.entrants, future.entrants[1])],
      teambuilds: [
        {
          seriesIndex: 0,
          entrant: 0,
          opponent: 3,
          brought: ['pokemon-0'],
          sets: [],
          rationale: 'PUBLIC_BUILD_RATIONALE',
          notebook: PRIVATE_SENTINEL,
          attempts: 1,
        },
      ],
      spend: { decisions: 0, tokens: null, reasoningTokens: null, cost: null },
      usage: [],
      distribution: { speciesDrafted: 4, speciesBuilt: 0, speciesFielded: 0, itemsUsed: 0, topItems: [] },
    },
  };
}

function gamesFor(series: LeagueSeriesView[]): Map<string, PublicSeasonGameInput[]> {
  return new Map(
    series.map((entry) => [
      entry.seriesId,
      entry.games.map((game, index) => ({
        game: index + 1,
        winner: game.winner,
        log: [
          {
            turn: 0,
            kind: 'switch' as const,
            text: 'P1 sent out Pokémon',
            actor: { side: 0 as const, slot: 0 },
            species: 'Pokémon',
            hp: 100,
          },
          { turn: game.turns, kind: 'win' as const, text: `Franchise ${game.winner} won` },
        ],
        decisions: [
          {
            side: 0 as const,
            turn: 1,
            phase: 'turn',
            selection: ['move 1'],
            action: 'Protect',
            rationale: 'PUBLIC_DECISION_RATIONALE',
            notebook: PRIVATE_SENTINEL,
            fallback: false,
            automatic: false,
            latencyMs: 1200,
            totalTokens: 900,
            reasoningTokens: 300,
          },
        ],
        reflections: [
          {
            side: 1 as const,
            result: 'lost' as const,
            summary: 'PUBLIC_REFLECTION',
            adjustment: 'Lead differently',
            notebook: PRIVATE_SENTINEL,
            fallback: false,
            seriesOver: false,
          },
        ],
      })),
    ]),
  );
}

const COMMON = {
  board: [],
  tradeOrder: null,
  title: 'Public season',
  closedSheets: true,
  harnessCommit: 'abc',
  showdownCommit: 'def',
  generatedAt: '2026-08-20T02:00:00.000Z',
};

test('season-bundle-v2 publishes one complete week with its public evidence and nothing private or future', () => {
  const { league, plans } = fixture();
  const released = league.series.slice(0, 2);
  const bundle = buildPublicSeasonBundle({
    ...COMMON,
    league,
    plans,
    releasedThroughWeek: 1,
    games: gamesFor(released),
  });

  assert.equal(bundle.protocolVersion, 'season-bundle-v2');
  assert.equal(bundle.season.releasedThroughWeek, 1);
  assert.equal(bundle.weeks[0]?.status, 'released');
  assert.equal(bundle.weeks[1]?.status, 'scheduled');
  assert.equal(bundle.weeks[1]?.matches[0]?.score, null);
  assert.deepEqual(Object.keys(bundle.replays).sort(), released.map((series) => series.seriesId).sort());
  assert.equal(bundle.standings.filter((standing) => standing.seriesWins === 1).length, 2);
  const text = JSON.stringify(bundle);
  assert.equal(text.includes(PRIVATE_SENTINEL), false, 'notebooks and unreleased reviews stay private');
  assert.equal(text.includes(league.series[2]!.seriesId), false);
  assert.ok(text.includes('PUBLIC_DECISION_RATIONALE'));
  assert.ok(text.includes('PUBLIC_REFLECTION'));
  assert.equal(bundle.draft.picks[0]?.rationale, 'PUBLIC_PICK_RATIONALE');
  assert.equal(bundle.weeks[0]?.matches[0]?.builds[0]?.sets, null, 'closed sheets stay closed mid-season');
  assert.equal(bundle.weeks[0]?.matches[0]?.builds[0]?.rationale, 'PUBLIC_BUILD_RATIONALE');
  assert.equal(bundle.replays[released[0]!.seriesId]?.games[0]?.events[0]?.hp, 100);
  assert.equal(bundle.reviews.length, 0);
  assert.equal(bundle.playoffs, null);
});

test('season-bundle-v2 rejects a partial released week', () => {
  const { league, plans } = fixture();
  league.series.length = 0;
  assert.throws(
    () => buildPublicSeasonBundle({ ...COMMON, league, plans, releasedThroughWeek: 1, games: new Map() }),
    /cannot be released/,
  );
});

test('season-bundle-v2 releases playoff rounds past the last week and reviews only at season end', () => {
  const { league, plans } = fixture();
  const playoffPlan = plans.find((plan) => plan.stage === 'playoff');
  assert.ok(playoffPlan);
  const roundRobin = plans.filter((plan) => plan.stage === 'roundrobin');
  league.series = roundRobin.map((plan) => completedSeries(plan.index, plan.round, plan.entrants!, plan.entrants![0]));
  league.series.push({ ...completedSeries(playoffPlan.index, 1, [0, 1], 0), stage: 'playoff' });
  const all = buildPublicSeasonBundle({
    ...COMMON,
    league,
    plans,
    releasedThroughWeek: 4,
    games: gamesFor(league.series),
  });
  assert.equal(all.season.status, 'complete');
  assert.equal(all.season.championId, 'franchise-0');
  assert.equal(all.playoffs?.rounds[0]?.[0]?.match?.winnerId, 'franchise-0');
  assert.equal(all.reviews.length, 1);
  assert.equal(all.weeks[0]?.matches[0]?.builds[0]?.sets?.length, 0, 'closed sheets open once the season is over');
  const regular = buildPublicSeasonBundle({
    ...COMMON,
    league,
    plans,
    releasedThroughWeek: 3,
    games: gamesFor(league.series.filter((series) => series.stage === 'roundrobin')),
  });
  assert.equal(regular.season.status, 'playoffs');
  assert.equal(regular.playoffs, null);
  assert.equal(regular.reviews.length, 0);
  assert.throws(
    () => buildPublicSeasonBundle({ ...COMMON, league, plans, releasedThroughWeek: 5, games: new Map() }),
    /between 0 and 4/,
  );
});
