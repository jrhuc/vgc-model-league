import { z } from 'zod';

import type { DraftLeagueSeriesPlan } from '../draftleague.js';
import { buildDraftPlayoffBracket, rankedTable } from '../draftleague.js';
import type {
  DraftBoardMonView,
  DraftTableRow,
  LeagueGameResponse,
  LeagueResponse,
  LeagueTeambuildView,
} from '../gui/api.js';
import type { BattleLogEntry } from '../gui/battlelog.js';

export const PUBLIC_SEASON_BUNDLE_VERSION = 'season-bundle-v2' as const;

const id = z.string().min(1);
const franchiseRef = z.string().regex(/^franchise-\d+$/);

const pokemonSchema = z.strictObject({
  id,
  name: id,
  spriteId: id,
  cost: z.number().int().nonnegative(),
});

const rosterSlotSchema = pokemonSchema.extend({
  acquired: z.enum(['draft', 'trade', 'free-agency']),
  overallPick: z.number().int().positive().nullable(),
  rationale: z.string(),
  fallback: z.boolean(),
});

const recordSchema = z.strictObject({
  seriesWins: z.number().int().nonnegative(),
  seriesLosses: z.number().int().nonnegative(),
  gameWins: z.number().int().nonnegative(),
  gameLosses: z.number().int().nonnegative(),
});

const setSchema = z.strictObject({
  species: id,
  spriteId: id,
  item: z.string(),
  ability: z.string(),
  nature: z.string(),
  moves: z.array(z.string()),
  evs: z.record(z.string(), z.number().int().nonnegative()),
});

const buildSchema = z.strictObject({
  franchiseId: franchiseRef,
  prepared: z.array(id),
  /** Null while the season's sheet policy keeps this build closed. */
  sets: z.array(setSchema).nullable(),
  rationale: z.string(),
  attempts: z.number().int().positive(),
});

const slotRefSchema = z.strictObject({
  side: z.union([z.literal(0), z.literal(1)]),
  slot: z.number().int().nonnegative(),
});

const eventSchema = z.strictObject({
  turn: z.number().int().nonnegative(),
  kind: z.enum(['turn', 'move', 'switch', 'faint', 'status', 'field', 'win', 'timer', 'detail', 'preview']),
  text: z.string(),
  actor: slotRefSchema.optional(),
  target: slotRefSchema.optional(),
  species: z.string().optional(),
  hp: z.number().int().min(0).max(100).optional(),
  status: z.string().nullable().optional(),
});

const decisionSchema = z.strictObject({
  franchiseId: franchiseRef,
  turn: z.number().int().nonnegative(),
  phase: z.string(),
  action: z.string(),
  rationale: z.string(),
  fallback: z.boolean(),
  automatic: z.boolean(),
  latencyMs: z.number().nonnegative().nullable(),
  reasoningTokens: z.number().int().nonnegative().nullable(),
});

const reflectionSchema = z.strictObject({
  franchiseId: franchiseRef,
  result: z.enum(['won', 'lost']),
  summary: z.string(),
  adjustment: z.string(),
  fallback: z.boolean(),
});

const gameSummarySchema = z.strictObject({
  number: z.number().int().positive(),
  winnerId: franchiseRef.nullable(),
  turns: z.number().int().nonnegative(),
});

const matchSchema = z.strictObject({
  id,
  seriesIndex: z.number().int().nonnegative(),
  seriesId: id.nullable(),
  franchises: z.tuple([franchiseRef, franchiseRef]),
  status: z.enum(['scheduled', 'complete']),
  score: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]).nullable(),
  winnerId: franchiseRef.nullable(),
  games: z.array(gameSummarySchema),
  builds: z.array(buildSchema),
});

export const publicSeasonBundleSchema = z.strictObject({
  protocolVersion: z.literal(PUBLIC_SEASON_BUNDLE_VERSION),
  generatedAt: z.iso.datetime(),
  season: z.strictObject({
    id,
    title: id,
    format: id,
    board: z.strictObject({
      id,
      budget: z.number().int().nonnegative(),
      picksPerFranchise: z.number().int().nonnegative(),
    }),
    startedAt: z.iso.datetime(),
    status: z.enum(['draft', 'regular-season', 'playoffs', 'complete']),
    releasedThroughWeek: z.number().int().nonnegative(),
    releasedPlayoffRounds: z.number().int().nonnegative(),
    totalWeeks: z.number().int().nonnegative(),
    playoffRounds: z.number().int().nonnegative(),
    sheets: z.enum(['open', 'closed']),
    championId: franchiseRef.nullable(),
  }),
  provenance: z.strictObject({
    harnessCommit: z.string().nullable(),
    showdownCommit: z.string().nullable(),
    models: z.array(z.strictObject({ franchiseId: franchiseRef, spec: z.string() })),
  }),
  franchises: z.array(
    z.strictObject({
      id: franchiseRef,
      name: id,
      model: z.string(),
      budget: z.strictObject({
        total: z.number().int().nonnegative(),
        spent: z.number().int().nonnegative(),
        remaining: z.number().int(),
      }),
      roster: z.array(rosterSlotSchema),
      record: recordSchema,
      /** Set only once the season is complete and released. */
      finish: z.string().nullable(),
    }),
  ),
  board: z.array(
    z.strictObject({
      id,
      name: id,
      spriteId: id,
      cost: z.number().int().nonnegative(),
      types: z.array(z.string()),
      abilities: z.array(z.string()),
      baseStats: z.record(z.string(), z.number().int()),
      megaStone: z.string().nullable(),
      draftedBy: franchiseRef.nullable(),
    }),
  ),
  draft: z.strictObject({
    picks: z.array(
      z.strictObject({
        overall: z.number().int().positive(),
        round: z.number().int().positive(),
        franchiseId: franchiseRef,
        pokemon: pokemonSchema,
        rationale: z.string(),
        fallback: z.boolean(),
      }),
    ),
  }),
  standings: z.array(
    recordSchema.extend({
      rank: z.number().int().positive(),
      franchiseId: franchiseRef,
      differential: z.number().int(),
    }),
  ),
  weeks: z.array(
    z.strictObject({
      number: z.number().int().positive(),
      status: z.enum(['released', 'scheduled']),
      matches: z.array(matchSchema),
    }),
  ),
  transactions: z.array(
    z.strictObject({
      afterWeek: z.number().int().positive(),
      order: z.array(franchiseRef),
      offers: z.array(
        z.strictObject({
          from: franchiseRef,
          to: franchiseRef.nullable(),
          give: z.string().nullable(),
          get: z.string().nullable(),
          message: z.string().nullable(),
          accepted: z.boolean().nullable(),
          offerReasoning: z.string(),
          responseReasoning: z.string(),
        }),
      ),
      moves: z.array(
        z.strictObject({
          franchiseId: franchiseRef,
          swaps: z.array(z.strictObject({ drop: z.string(), add: z.string() })),
          reasoning: z.string(),
          fallback: z.boolean(),
        }),
      ),
    }),
  ),
  playoffs: z
    .strictObject({
      rounds: z.array(
        z.array(
          z.strictObject({
            seriesIndex: z.number().int().nonnegative(),
            round: z.number().int().positive(),
            slots: z.tuple([franchiseRef.nullable(), franchiseRef.nullable()]),
            match: matchSchema.nullable(),
          }),
        ),
      ),
    })
    .nullable(),
  replays: z.record(
    id,
    z.strictObject({
      seriesId: id,
      franchises: z.tuple([franchiseRef, franchiseRef]),
      games: z.array(
        gameSummarySchema.extend({
          events: z.array(eventSchema),
          decisions: z.array(decisionSchema),
          reflections: z.array(reflectionSchema),
        }),
      ),
    }),
  ),
  reviews: z.array(
    z.strictObject({
      franchiseId: franchiseRef,
      outcome: z.string(),
      summary: z.string(),
      didWell: z.string(),
      didPoorly: z.string(),
      wouldChange: z.string(),
      fallback: z.boolean(),
    }),
  ),
});

export type PublicSeasonBundle = z.infer<typeof publicSeasonBundleSchema>;
export type PublicMatch = z.infer<typeof matchSchema>;

export function publicSeasonBundleJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(publicSeasonBundleSchema, { target: 'draft-2020-12' }) as Record<string, unknown>;
}

export type PublicSeasonGameInput = Pick<LeagueGameResponse, 'game' | 'winner' | 'log' | 'decisions' | 'reflections'>;

export interface BuildPublicSeasonBundleOptions {
  league: LeagueResponse;
  plans: readonly DraftLeagueSeriesPlan[];
  board: readonly DraftBoardMonView[];
  /** Every completed game of every series the release boundary admits, keyed by series id. */
  games: ReadonlyMap<string, readonly PublicSeasonGameInput[]>;
  tradeOrder: readonly number[] | null;
  title: string;
  /** Weeks beyond `totalWeeks` release playoff rounds: totalWeeks + 1 releases the semifinals, + 2 the final. */
  releasedThroughWeek: number;
  closedSheets: boolean;
  harnessCommit: string | null;
  showdownCommit: string | null;
  generatedAt?: string;
}

function franchiseId(entrant: number): string {
  return `franchise-${entrant}`;
}

function publicEvent(entry: BattleLogEntry): z.infer<typeof eventSchema> {
  const event: z.infer<typeof eventSchema> = { turn: entry.turn, kind: entry.kind, text: entry.text };
  if (entry.actor) event.actor = entry.actor;
  if (entry.target) event.target = entry.target;
  if (entry.species !== undefined) event.species = entry.species;
  if (entry.hp !== undefined) event.hp = entry.hp;
  if (entry.status !== undefined) event.status = entry.status;
  return event;
}

function publicBuild(build: LeagueTeambuildView, revealSets: boolean): z.infer<typeof buildSchema> {
  return {
    franchiseId: franchiseId(build.entrant),
    prepared: [...build.brought],
    sets: revealSets
      ? build.sets.map((set) => ({
          species: set.species,
          spriteId: set.spriteId,
          item: set.item,
          ability: set.ability,
          nature: set.nature,
          moves: [...set.moves],
          evs: { ...set.evs },
        }))
      : null,
    rationale: build.rationale,
    attempts: build.attempts,
  };
}

/** The projection accepts rich internal DTOs but emits only fields explicitly allowed by the public protocol. */
export function buildPublicSeasonBundle(options: BuildPublicSeasonBundleOptions): PublicSeasonBundle {
  const { league } = options;
  const totalWeeks = league.weeks ?? Math.max(0, ...options.plans.map((plan) => plan.round));
  const playoffRounds = league.playoffRounds;
  const maxRelease = totalWeeks + playoffRounds;
  if (
    !Number.isSafeInteger(options.releasedThroughWeek) ||
    options.releasedThroughWeek < 0 ||
    options.releasedThroughWeek > maxRelease
  ) {
    throw new Error(
      `released week must be between 0 and ${maxRelease} (${totalWeeks} weeks + ${playoffRounds} playoff rounds)`,
    );
  }
  const releasedThroughWeek = Math.min(options.releasedThroughWeek, totalWeeks);
  const releasedPlayoffRounds = Math.max(0, options.releasedThroughWeek - totalWeeks);
  const seasonReleased = releasedPlayoffRounds === playoffRounds && league.phase === 'complete';
  if (!league.board || !league.format || league.budget === null || league.picksPerEntrant === null) {
    throw new Error(`league ${league.runId} is missing its public draft identity`);
  }

  const seriesByIndex = new Map(league.series.map((series) => [series.seriesIndex, series]));
  const buildsBySeries = new Map<number, LeagueTeambuildView[]>();
  for (const build of league.teambuilds) {
    const list = buildsBySeries.get(build.seriesIndex) ?? [];
    list.push(build);
    buildsBySeries.set(build.seriesIndex, list);
  }
  const released = (plan: DraftLeagueSeriesPlan): boolean =>
    plan.stage === 'roundrobin' ? plan.round <= releasedThroughWeek : plan.round <= releasedPlayoffRounds;

  const replays: PublicSeasonBundle['replays'] = {};
  const matchFor = (plan: DraftLeagueSeriesPlan, matchId: string, sides: [number, number]): PublicMatch => {
    const ids: [string, string] = [franchiseId(sides[0]), franchiseId(sides[1])];
    const series = seriesByIndex.get(plan.index);
    if (!released(plan)) {
      return {
        id: matchId,
        seriesIndex: plan.index,
        seriesId: null,
        franchises: ids,
        status: 'scheduled',
        score: null,
        winnerId: null,
        games: [],
        builds: [],
      };
    }
    if (!series || series.winner === null) {
      throw new Error(`${matchId} cannot be released before series ${plan.index} is complete`);
    }
    const games = options.games.get(series.seriesId);
    if (!games || games.length !== series.games.length) {
      throw new Error(
        `released series ${series.seriesId} has ${games?.length ?? 0} verified replays for ${series.games.length} games`,
      );
    }
    const builds = (buildsBySeries.get(plan.index) ?? [])
      .filter((build) => sides.includes(build.entrant))
      .sort((a, b) => sides.indexOf(a.entrant) - sides.indexOf(b.entrant))
      .map((build) => publicBuild(build, !options.closedSheets || seasonReleased));
    replays[series.seriesId] = {
      seriesId: series.seriesId,
      franchises: ids,
      games: games.map((game) => {
        const summary = series.games[game.game - 1];
        if (!summary) throw new Error(`released series ${series.seriesId} has no result for game ${game.game}`);
        return {
          number: game.game,
          winnerId: game.winner === null ? null : franchiseId(game.winner),
          turns: summary.turns,
          events: game.log.map(publicEvent),
          decisions: game.decisions.map((decision) => ({
            franchiseId: franchiseId(sides[decision.side]),
            turn: decision.turn,
            phase: decision.phase,
            action: decision.action,
            rationale: decision.rationale,
            fallback: decision.fallback,
            automatic: decision.automatic,
            latencyMs: decision.latencyMs,
            reasoningTokens: decision.reasoningTokens,
          })),
          reflections: game.reflections.map((reflection) => ({
            franchiseId: franchiseId(sides[reflection.side]),
            result: reflection.result,
            summary: reflection.summary,
            adjustment: reflection.adjustment,
            fallback: reflection.fallback,
          })),
        };
      }),
    };
    return {
      id: matchId,
      seriesIndex: plan.index,
      seriesId: series.seriesId,
      franchises: ids,
      status: 'complete',
      score: series.score,
      winnerId: franchiseId(series.winner),
      games: series.games.map((game, index) => ({
        number: index + 1,
        winnerId: game.winner === null ? null : franchiseId(game.winner),
        turns: game.turns,
      })),
      builds,
    };
  };

  const weeks = Array.from({ length: totalWeeks }, (_, weekIndex) => {
    const number = weekIndex + 1;
    const plans = options.plans.filter((plan) => plan.stage === 'roundrobin' && plan.round === number);
    return {
      number,
      status: number <= releasedThroughWeek ? ('released' as const) : ('scheduled' as const),
      matches: plans.map((plan, matchIndex) => {
        if (!plan.entrants) throw new Error(`round-robin series ${plan.index} has no entrants`);
        return matchFor(plan, `week-${number}-match-${matchIndex + 1}`, plan.entrants);
      }),
    };
  });

  const table: DraftTableRow[] = league.franchises.map((franchise) => ({
    entrant: franchise.entrant,
    w: 0,
    l: 0,
    gw: 0,
    gl: 0,
  }));
  for (const series of league.series) {
    if (series.stage !== 'roundrobin' || series.round > releasedThroughWeek || series.winner === null) continue;
    const [a, b] = series.sides;
    const rowA = table[a];
    const rowB = table[b];
    if (!rowA || !rowB) throw new Error(`series ${series.seriesIndex} references an unknown franchise`);
    if (series.winner === a) {
      rowA.w += 1;
      rowB.l += 1;
    } else {
      rowB.w += 1;
      rowA.l += 1;
    }
    rowA.gw += series.score[0];
    rowA.gl += series.score[1];
    rowB.gw += series.score[1];
    rowB.gl += series.score[0];
  }
  const ranked = rankedTable(table);
  const standings = ranked.map((row, index) => ({
    rank: index + 1,
    franchiseId: franchiseId(row.entrant),
    seriesWins: row.w,
    seriesLosses: row.l,
    gameWins: row.gw,
    gameLosses: row.gl,
    differential: row.gw - row.gl,
  }));

  let playoffs: PublicSeasonBundle['playoffs'] = null;
  if (releasedThroughWeek === totalWeeks && releasedPlayoffRounds > 0) {
    const playoffPlans = options.plans.filter((plan) => plan.stage === 'playoff');
    const seeding = ranked.map((row) => row.entrant);
    const bracket = buildDraftPlayoffBracket(playoffPlans, seeding);
    const winnerOf = (seriesIndex: number): number | null => seriesByIndex.get(seriesIndex)?.winner ?? null;
    playoffs = {
      rounds: bracket.map((round, roundIndex) =>
        round.map((entry, matchIndex) => {
          const seriesIndex = entry.seriesIndex;
          if (seriesIndex === null)
            throw new Error(`playoff round ${roundIndex + 1} match ${matchIndex + 1} has no series`);
          const plan = playoffPlans.find((candidate) => candidate.index === seriesIndex);
          if (!plan) throw new Error(`playoff series ${seriesIndex} has no plan`);
          let slots: [number | null, number | null] = entry.slots;
          if (roundIndex > 0) {
            const feeders = bracket[roundIndex - 1]!.slice(matchIndex * 2, matchIndex * 2 + 2);
            const feederWinner = (feeder: { seriesIndex: number | null } | undefined) =>
              feeder?.seriesIndex === null || feeder === undefined ? null : winnerOf(feeder.seriesIndex);
            slots = [feederWinner(feeders[0]), feederWinner(feeders[1])];
          }
          const id = `playoff-${roundIndex + 1}-match-${matchIndex + 1}`;
          const match =
            slots[0] !== null && slots[1] !== null && released(plan) ? matchFor(plan, id, [slots[0], slots[1]]) : null;
          return {
            seriesIndex,
            round: roundIndex + 1,
            slots: [slots[0] === null ? null : franchiseId(slots[0]), slots[1] === null ? null : franchiseId(slots[1])],
            match,
          };
        }),
      ),
    };
  }

  const tradeWindow = league.tradeWindow;
  const transactions: PublicSeasonBundle['transactions'] = [];
  if (tradeWindow && tradeWindow.state === 'complete' && tradeWindow.afterWeek <= releasedThroughWeek) {
    transactions.push({
      afterWeek: tradeWindow.afterWeek,
      order: (options.tradeOrder ?? []).map(franchiseId),
      offers: tradeWindow.offers.map((offer) => ({
        from: franchiseId(offer.from),
        to: offer.to === null ? null : franchiseId(offer.to),
        give: offer.give,
        get: offer.get,
        message: offer.message,
        accepted: offer.accepted,
        offerReasoning: offer.offerReasoning,
        responseReasoning: offer.responseReasoning,
      })),
      moves: tradeWindow.decisions.map((decision) => ({
        franchiseId: franchiseId(decision.entrant),
        swaps: decision.swaps.map(({ drop, add }) => ({ drop, add })),
        reasoning: decision.reasoning,
        fallback: decision.fallback,
      })),
    });
  }
  const tradedIn = new Set<string>();
  for (const window of transactions) {
    for (const offer of window.offers) {
      if (offer.accepted && offer.to && offer.give && offer.get) {
        tradedIn.add(`${offer.from}:${offer.get}`);
        tradedIn.add(`${offer.to}:${offer.give}`);
      }
    }
  }

  const rosterReleased = transactions.length > 0;
  const franchises = league.franchises.map((franchise) => {
    const fid = franchiseId(franchise.entrant);
    const source = rosterReleased ? franchise.roster : franchise.draftRoster;
    const roster = source.map((slot) => ({
      id: slot.id,
      name: slot.name,
      spriteId: slot.spriteId,
      cost: slot.cost,
      acquired:
        slot.acquired === 'draft'
          ? ('draft' as const)
          : tradedIn.has(`${fid}:${slot.id}`)
            ? ('trade' as const)
            : ('free-agency' as const),
      overallPick: slot.pick,
      rationale: slot.rationale,
      fallback: slot.fallback,
    }));
    const spent = roster.reduce((total, slot) => total + slot.cost, 0);
    const record = table[franchise.entrant]!;
    return {
      id: fid,
      name: franchise.teamName,
      model: franchise.model,
      budget: { total: league.budget!, spent, remaining: league.budget! - spent },
      roster,
      record: { seriesWins: record.w, seriesLosses: record.l, gameWins: record.gw, gameLosses: record.gl },
      finish: seasonReleased && franchise.finish ? franchise.finish : null,
    };
  });

  const picks = league.franchises
    .flatMap((franchise) =>
      franchise.draftRoster
        .filter((slot) => slot.pick !== null)
        .map((slot) => ({
          overall: slot.pick!,
          round: Math.ceil(slot.pick! / league.franchises.length),
          franchiseId: franchiseId(franchise.entrant),
          pokemon: { id: slot.id, name: slot.name, spriteId: slot.spriteId, cost: slot.cost },
          rationale: slot.rationale,
          fallback: slot.fallback,
        })),
    )
    .sort((a, b) => a.overall - b.overall);
  const draftedBy = new Map(picks.map((pick) => [pick.pokemon.id, pick.franchiseId]));

  const status = (() => {
    if (options.releasedThroughWeek === 0) return 'draft' as const;
    if (seasonReleased) return 'complete' as const;
    if (releasedPlayoffRounds > 0 || (releasedThroughWeek === totalWeeks && league.phase !== 'roundrobin'))
      return 'playoffs' as const;
    return 'regular-season' as const;
  })();
  const lastReleased = league.series
    .filter((series) => seriesByIndex.has(series.seriesIndex) && options.games.has(series.seriesId))
    .map((series) => series.timestamp)
    .filter(Boolean)
    .sort()
    .at(-1);

  return publicSeasonBundleSchema.parse({
    protocolVersion: PUBLIC_SEASON_BUNDLE_VERSION,
    generatedAt: options.generatedAt ?? lastReleased ?? league.when,
    season: {
      id: league.runId,
      title: options.title,
      format: league.format,
      board: { id: league.board, budget: league.budget, picksPerFranchise: league.picksPerEntrant },
      startedAt: league.when,
      status,
      releasedThroughWeek,
      releasedPlayoffRounds,
      totalWeeks,
      playoffRounds,
      sheets: options.closedSheets ? 'closed' : 'open',
      championId: seasonReleased && league.champion ? franchiseId(league.champion.entrant) : null,
    },
    provenance: {
      harnessCommit: options.harnessCommit,
      showdownCommit: options.showdownCommit,
      models: league.franchises.map((franchise) => ({
        franchiseId: franchiseId(franchise.entrant),
        spec: franchise.model,
      })),
    },
    franchises,
    board: options.board.map((mon) => ({
      id: mon.id,
      name: mon.name,
      spriteId: mon.spriteId,
      cost: mon.cost,
      types: [...mon.types],
      abilities: [...mon.abilities],
      baseStats: { ...mon.baseStats },
      megaStone: mon.item || null,
      draftedBy: draftedBy.get(mon.id) ?? null,
    })),
    draft: { picks },
    standings,
    weeks,
    transactions,
    playoffs,
    replays,
    reviews: seasonReleased
      ? league.seasonReviews.map((review) => ({
          franchiseId: franchiseId(review.entrant),
          outcome: review.outcome,
          summary: review.summary,
          didWell: review.didWell,
          didPoorly: review.didPoorly,
          wouldChange: review.wouldChange,
          fallback: review.fallback,
        }))
      : [],
  });
}
