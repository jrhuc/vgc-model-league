import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import type { DraftBoard, DraftBoardMon } from './draft.js';
import { draftScaffoldRevision, loadBoard, runDraft, snakeOrder } from './draft.js';
import type { BracketView, DraftPickView, DraftTableRow, DraftView, TeambuildView } from './gui/api.js';
import { appendJsonlObject, readJsonlObjects } from './jsonl.js';
import { scaffoldComponents, scaffoldRevision } from './llm-engine.js';
import { BOARDS_DIR, defaultPsDir, RESULTS_PATH } from './paths.js';
import { parseRoutingPreferences, validateModelExecution } from './providers.js';
import { resolveSeed, seededRng, seriesEntropy, shuffle } from './random.js';
import type { SeriesRecord } from './records.js';
import { appendRow, loadSeriesRecords } from './records.js';
import { runSeasonReview, seasonReviewScaffoldRevision } from './season-review.js';
import type { ExperimentOptions, RecordedSeriesContext } from './series.js';
import { mapLimit, playRecordedSeries, readCompletedSeriesEvidence } from './series.js';
import { showdownCommit } from './showdown.js';
import {
  replayTeamBuildArtifact,
  runTeambuild,
  type TeamBuildSheetPolicy,
  teambuildScaffoldRevision,
} from './teambuild.js';
import { validateTeam } from './teams.js';
import { DEFAULT_TIMER_SCALE } from './timer.js';
import { applyBracketOutcome, type BracketMatch, type TournamentEvent } from './tournament.js';
import {
  DEFAULT_TRADE_WINDOW,
  MAX_TRADE_OFFERS,
  MAX_TRADE_SWAPS,
  readValidatedTradeWindow,
  runTradeWindow,
  type TradeWindowArtifact,
  type TradeWindowConfig,
  type TradeWindowResult,
  tradeWindowScaffoldRevision,
  transactionArtifactPaths,
  validateLeagueRosterState,
  validateTradesAllowed,
} from './trade-window.js';
import type { Pid } from './types.js';
import { ordinal } from './value.js';

export const DRAFT_PROTOCOL_VERSION = 9;

export type DraftLeagueEvent = TournamentEvent | { type: 'draft'; draft: DraftView };

export interface DraftLeagueOptions extends ExperimentOptions {
  boardsDir?: string;
  board?: string;
  onEvent?: (event: DraftLeagueEvent) => void;
  throughWeek?: number;
  resume?: boolean;
  sequentialWeeks?: boolean;
  tradeWindow?: TradeWindowConfig | null;
  draftOnly?: boolean;
}

interface SeriesPlanned {
  index: number;
  stage: 'roundrobin' | 'playoff';
  round: number;
  entrants: [number, number] | null;
  gameSeeds: Array<[number, number, number, number]>;
  engineSeeds: Record<Pid, number>;
}

interface StoredSeriesOutcome {
  score: Record<Pid, number>;
  winnerSide: Pid | undefined;
}

function buildDraftPlayoffBracket(plans: readonly SeriesPlanned[], seeding: readonly number[]): BracketMatch[][] {
  return plans.length === 3
    ? [
        [
          { round: 0, seriesIndex: plans[0]!.index, slots: [seeding[0]!, seeding[3]!], winner: null },
          { round: 0, seriesIndex: plans[1]!.index, slots: [seeding[1]!, seeding[2]!], winner: null },
        ],
        [{ round: 1, seriesIndex: plans[2]!.index, slots: [null, null], winner: null }],
      ]
    : [[{ round: 0, seriesIndex: plans[0]!.index, slots: [seeding[0]!, seeding[1]!], winner: null }]];
}

function builtTeamSummary(build: TeambuildView): string {
  const sets = build.sets.map((set) => {
    const evs = Object.entries(set.evs)
      .filter(([, value]) => Number(value) > 0)
      .map(([stat, value]) => `${stat} ${value}`)
      .join('/');
    return `${set.species} @ ${set.item}; ${set.ability}; ${set.nature}; ${set.moves.join('/')}; ${evs || '0 investment'}`;
  });
  return `Plan: ${build.rationale || '(none)'} Registered sets: ${sets.join(' | ')}`;
}

function initialBattleNotebook(build: TeambuildView): string {
  return `Matchup build carried from teambuilding. ${builtTeamSummary(build)}`;
}

function draftRosterSummary(roster: readonly DraftBoardMon[], build: TeambuildView): string {
  const registered = new Set(build.brought);
  const names = (mons: readonly DraftBoardMon[]) => mons.map((mon) => mon.name).join(', ') || '(none)';
  return (
    `registered for this series: ${names(roster.filter((mon) => registered.has(mon.id)))}; ` +
    `left behind: ${names(roster.filter((mon) => !registered.has(mon.id)))}.`
  );
}

/** A resumed league skips the draft entirely, so the picks a season review is judged against are rebuilt
 * from the transcript; seats are recovered from the snake order rather than the logged model name, which
 * repeats when the same model holds two seats. */
function loadStoredPicks(runDir: string, entrants: number, board: DraftBoard): DraftPickView[] {
  const rows = [...readJsonlObjects(path.join(runDir, 'draft', 'draft.jsonl'))].sort(
    (a, b) => Number(a.pick) - Number(b.pick),
  );
  const order = snakeOrder(entrants, board.picks);
  return rows.flatMap((row, index) => {
    const entrant = order[index];
    if (entrant === undefined || typeof row.mon !== 'string') return [];
    return [
      {
        pick: Number(row.pick),
        entrant,
        mon: row.mon,
        rationale: typeof row.rationale === 'string' ? row.rationale : '',
        fallback: row.fallback === true,
      },
    ];
  });
}

function playoffReview(summary: string, build: TeambuildView, notebook: string): string {
  return `${summary}. ${builtTeamSummary(build)} Final private battle note: ${notebook || '(empty)'}`;
}

export function roundRobinWeeks(entrants: number): Array<Array<[number, number]>> {
  const seats = [...Array(entrants).keys()];
  if (seats.length % 2) seats.push(-1);
  const weeks: Array<Array<[number, number]>> = [];
  for (let week = 0; week < seats.length - 1; week += 1) {
    const pairs: Array<[number, number]> = [];
    for (let match = 0; match < seats.length / 2; match += 1) {
      const home = seats[match]!;
      const away = seats[seats.length - 1 - match]!;
      if (home >= 0 && away >= 0) pairs.push(week % 2 ? [away, home] : [home, away]);
    }
    weeks.push(pairs);
    seats.splice(1, 0, seats.pop()!);
  }
  return weeks;
}

export async function runDraftLeague(
  models: string[],
  runDir: string,
  options: DraftLeagueOptions = {},
): Promise<SeriesRecord[]> {
  if (models.length < 2) throw new Error('a draft league needs at least two models');
  validateModelExecution(models, options);

  fs.mkdirSync(runDir, { recursive: true });
  const recordsPath = options.recordsPath ?? RESULTS_PATH;
  const psDir = options.psDir ?? defaultPsDir();
  const board = loadBoard(options.board ?? 'regmb-202607', options.boardsDir ?? BOARDS_DIR, psDir);
  const distinctBases = new Set(board.mons.map((mon) => mon.base)).size;
  if (models.length * board.picks > distinctBases) {
    throw new Error(
      `board ${JSON.stringify(board.id)} holds ${distinctBases} distinct species, too few for ${models.length} rosters of ${board.picks}`,
    );
  }
  const seed = resolveSeed(options.seed);
  const timerScale = options.timerScale ?? DEFAULT_TIMER_SCALE;
  const sheetPolicy: TeamBuildSheetPolicy = options.closedSheets === true ? 'closed' : 'open';
  const random = seededRng(seed);
  const scaffold = scaffoldRevision();
  const scaffoldParts = scaffoldComponents();
  const openRouterRouting = parseRoutingPreferences();
  const draftScaffold = draftScaffoldRevision();
  const teambuildScaffold = teambuildScaffoldRevision(sheetPolicy);
  const windowScaffold = tradeWindowScaffoldRevision();
  const seasonScaffold = seasonReviewScaffoldRevision();

  const stored = options.resume ? loadStoredLeague(runDir) : undefined;
  if (stored) {
    validateStoredLeagueConfig(runDir, stored, {
      models,
      seed,
      board,
      closedSheets: options.closedSheets === true,
      timerScale,
    });
  }
  const draftOnly = options.draftOnly === true;
  /** A draft-only run never held a window, so its resume chooses one like a fresh league. */
  const storedWindow = stored ? stored.tradeWindow : undefined;
  const storedTransactionArtifacts = stored ? transactionArtifactPaths(runDir) : [];
  if (storedWindow === null && storedTransactionArtifacts.length) {
    throw new Error(
      `run ${path.basename(runDir)} configures no trade window but holds transaction artifacts: ${storedTransactionArtifacts.join(', ')}`,
    );
  }
  if (storedWindow === undefined && stored && storedTransactionArtifacts.length) {
    throw new Error(
      `draft-only run ${path.basename(runDir)} cannot be promoted while transaction artifacts exist: ${storedTransactionArtifacts.join(', ')}`,
    );
  }
  /** A window is chosen on standings, so a league that plays no games cannot hold one. */
  let tradeWindow = draftOnly
    ? null
    : storedWindow !== undefined
      ? storedWindow
      : options.tradeWindow === undefined
        ? { ...DEFAULT_TRADE_WINDOW }
        : options.tradeWindow;
  if (tradeWindow && (!Number.isSafeInteger(tradeWindow.afterWeek) || tradeWindow.afterWeek < 1)) {
    throw new Error('trade window week must be a positive integer');
  }
  if (tradeWindow) validateTradesAllowed(tradeWindow.tradesAllowed, 'trade window trades allowed');
  const entrants = stored ? stored.entrants : shuffle(models, random);
  const weeks = roundRobinWeeks(entrants.length);
  if (tradeWindow && tradeWindow.afterWeek > weeks.length) {
    if (storedWindow === undefined && options.tradeWindow === undefined) {
      tradeWindow = { afterWeek: weeks.length, tradesAllowed: DEFAULT_TRADE_WINDOW.tradesAllowed };
    } else throw new Error(`trade window week must be between 1 and ${weeks.length}`);
  }
  const sequentialWeeks = stored
    ? stored.sequentialWeeks
    : options.sequentialWeeks === true || options.throughWeek !== undefined;
  const playoffRounds = entrants.length >= 5 ? 2 : 1;
  const playoffSeriesCount = playoffRounds === 2 ? 3 : 1;
  const plans: SeriesPlanned[] = [];
  for (const [week, pairs] of weeks.entries()) {
    for (const pair of pairs) {
      plans.push({
        index: plans.length,
        stage: 'roundrobin',
        round: week + 1,
        entrants: pair,
        ...seriesEntropy(seededRng(`${seed}:series:${plans.length}`)),
      });
    }
  }
  for (let series = 0; series < playoffSeriesCount; series += 1) {
    plans.push({
      index: plans.length,
      stage: 'playoff',
      round: playoffRounds === 1 || series < 2 ? 1 : 2,
      entrants: null,
      ...seriesEntropy(seededRng(`${seed}:series:${plans.length}`)),
    });
  }
  const runId = path.basename(runDir);
  if (stored && storedWindow === undefined) {
    const storedRows = loadSeriesRecords(recordsPath).filter((row) => row.run_id === runId);
    const evidence = draftOnlyPromotionEvidence(runDir, storedRows);
    if (evidence.length) {
      throw new Error(
        `draft-only run ${runId} cannot be promoted while season evidence exists: ${evidence.join(', ')}`,
      );
    }
  }
  const completed = new Map<number, SeriesRecord>();
  const storedOutcomes = new Map<number, StoredSeriesOutcome>();
  const storedRoundRobinRows = new Map<number, SeriesRecord>();
  const storedPlayoffRows = new Map<number, SeriesRecord>();
  const storedRunRows: SeriesRecord[] = [];
  if (stored) {
    const seen = new Set<number>();
    for (const row of loadSeriesRecords(recordsPath)) {
      if (row.run_id !== runId || row.mode !== 'draft') continue;
      const seriesIndex = row.series_index;
      const plan = Number.isSafeInteger(seriesIndex) ? plans[seriesIndex as number] : undefined;
      if (!plan || plan.stage !== row.stage || plan.round !== row.round) {
        throw new Error(
          `run ${runId} series ${String(seriesIndex)} does not match the rebuilt schedule; it cannot resume`,
        );
      }
      if (seen.has(plan.index)) {
        throw new Error(`run ${runId} repeats scheduled series ${plan.index}; it cannot resume`);
      }
      seen.add(plan.index);
      if (row.board !== board.id || row.run_seed !== seed || !isDeepStrictEqual(row.engine_seeds, plan.engineSeeds)) {
        throw new Error(`run ${runId} series ${plan.index} is not bound to its scheduled entropy and board`);
      }
      if (plan.stage === 'roundrobin') storedRoundRobinRows.set(plan.index, row);
      else storedPlayoffRows.set(plan.index, row);
      storedRunRows.push(row);
    }
  }
  const storedPostWindowEvidence =
    stored && tradeWindow ? postWindowEvidence(runDir, storedRunRows, plans, tradeWindow.afterWeek) : [];
  const table: DraftTableRow[] = entrants.map((_, entrant) => ({ entrant, w: 0, l: 0, gw: 0, gl: 0 }));
  const teambuilds: TeambuildView[] = [];
  const coachingPath = path.join(runDir, 'coaching.jsonl');
  const playoffContext = entrants.map(() => new Map<number, string>());
  const reflectionNotes = entrants.map(() => new Map<number, string>());
  for (const row of readJsonlObjects(coachingPath)) {
    const entrant = Number(row.entrant);
    const seriesIndex = Number(row.series_index);
    if (
      Number.isInteger(entrant) &&
      playoffContext[entrant] &&
      Number.isInteger(seriesIndex) &&
      typeof row.context === 'string'
    ) {
      playoffContext[entrant].set(seriesIndex, row.context);
      if (typeof row.notebook === 'string') reflectionNotes[entrant]!.set(seriesIndex, row.notebook);
    }
  }
  let draftNotes: string[] = entrants.map(() => '');
  let phase: DraftView['phase'] = 'draft';
  let week = 0;
  let rosters: DraftBoardMon[][] = entrants.map(() => []);
  let budgets: number[] = entrants.map(() => board.budget);
  let teamNames: string[] = entrants.map(() => '');
  let picks: DraftView['picks'] = stored ? loadStoredPicks(runDir, entrants.length, board) : [];
  const draftView = (withTable: boolean): DraftView => ({
    boardId: board.id,
    budget: board.budget,
    picksPerEntrant: board.picks,
    entrants: [...entrants],
    teamNames: [...teamNames],
    picks: [...picks],
    rosters: rosters.map((roster) => roster.map((mon) => mon.id)),
    budgets: [...budgets],
    table: withTable ? rankedTable(table) : null,
    teambuilds: [...teambuilds],
    week,
    weeks: weeks.length,
    phase,
  });

  options.onEvent?.({
    type: 'plans',
    mode: 'draft',
    protocolVersion: DRAFT_PROTOCOL_VERSION,
    plans: plans.map((plan) => ({
      index: plan.index,
      players: plan.entrants
        ? { p1: entrants[plan.entrants[0]]!, p2: entrants[plan.entrants[1]]! }
        : { p1: 'TBD', p2: 'TBD' },
    })),
    pool: board.id,
    seed,
  });
  options.onEvent?.({ type: 'draft', draft: draftView(false) });

  /** In-progress writes leave out rosters and draft notes: loadStoredLeague reads their
   * presence as a completed draft, and resume must not mistake a half-drafted league for one. */
  const writeConfig = (outcome?: Record<string, unknown>): void => {
    fs.writeFileSync(
      path.join(runDir, 'config.json'),
      `${JSON.stringify(
        {
          mode: 'draft',
          protocol_version: DRAFT_PROTOCOL_VERSION,
          scaffold,
          scaffold_components: scaffoldParts,
          ...(openRouterRouting ? { openrouter_routing: openRouterRouting } : {}),
          draft_scaffold: draftScaffold,
          teambuild_scaffold: teambuildScaffold,
          window_scaffold: windowScaffold,
          season_scaffold: seasonScaffold,
          models,
          seed,
          concurrency: options.concurrency ?? 2,
          reasoning: options.reasoning ?? null,
          reasoning_by_model: options.reasoningByModel ?? null,
          timer_scale: timerScale,
          board: board.id,
          format: board.format,
          sequential_weeks: sequentialWeeks,
          closed_sheets: options.closedSheets === true,
          draft_only: draftOnly,
          trade_window: tradeWindow
            ? { after_week: tradeWindow.afterWeek, trades_allowed: tradeWindow.tradesAllowed }
            : null,
          entrants,
          team_names: teamNames,
          weeks: weeks.length,
          ...(outcome ?? {}),
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  };

  if (stored) {
    const monById = new Map(board.mons.map((mon) => [mon.id, mon] as const));
    rosters = stored.rosterIds.map((ids) =>
      ids.map((id) => {
        const mon = monById.get(id);
        if (!mon) throw new Error(`run ${runId} drafted ${id}, which board ${board.id} does not hold`);
        return mon;
      }),
    );
    budgets = rosters.map((roster) => board.budget - roster.reduce((sum, mon) => sum + mon.cost, 0));
    teamNames = stored.teamNames;
    draftNotes = stored.draftNotes;
  } else {
    writeConfig();
    const outcome = await runDraft(entrants, board, {
      psDir,
      logDir: path.join(runDir, 'draft'),
      rng: random,
      rosterPolicy: tradeWindow
        ? `- A mid-season transaction window opens after round-robin week ${tradeWindow.afterWeek}. Each coach may make up to ${tradeWindow.tradesAllowed} one-for-one coach-trade ${tradeWindow.tradesAllowed === 1 ? 'offer' : 'offers'}, then may make up to ${MAX_TRADE_SWAPS} free-agent swaps; the resulting roster is used for the rest of the season.`
        : '- After the draft this roster is locked for the whole season: a round robin of best-of-three matches, then playoffs.',
      ...(options.reasoning === undefined ? {} : { reasoning: options.reasoning }),
      ...(options.reasoningByModel === undefined ? {} : { reasoningByModel: options.reasoningByModel }),
      ...(options.apiKeys === undefined ? {} : { apiKeys: options.apiKeys }),
      ...(options.recovery === undefined ? {} : { recovery: options.recovery }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      onPick: (view, state) => {
        picks = [...picks, view];
        rosters = state.rosters;
        budgets = state.budgets;
        writeConfig();
        options.onEvent?.({ type: 'draft', draft: draftView(false) });
      },
      onName: (_entrant, _teamName, state) => {
        teamNames = [...state.teamNames];
        writeConfig();
        options.onEvent?.({ type: 'draft', draft: draftView(false) });
      },
    });
    rosters = outcome.rosters;
    budgets = outcome.budgets;
    teamNames = outcome.teamNames;
    draftNotes = outcome.notebooks;
  }
  const initialRosters = rosters.map((roster) => [...roster]);
  if (stored) {
    validateLeagueRosterState(
      {
        board,
        models: entrants,
        teamNames,
        rosters,
        budgets,
        notebooks: draftNotes,
        standings: rankedTable(table),
        results: entrants.map(() => []),
        reflections: entrants.map(() => []),
      },
      `resumed initial roster for run ${runId}`,
    );
  }
  let windowArtifact: TradeWindowArtifact | undefined;

  if (!stored) {
    fs.writeFileSync(
      path.join(runDir, 'rosters.json'),
      `${JSON.stringify(
        entrants.map((model, entrant) => ({
          entrant,
          model,
          team_name: teamNames[entrant],
          budget_left: budgets[entrant],
          spent: board.budget - budgets[entrant]!,
          roster: rosters[entrant]!.map((mon) => ({ id: mon.id, name: mon.name, cost: mon.cost })),
        })),
        null,
        2,
      )}\n`,
      'utf8',
    );
    writeConfig({
      rosters: rosters.map((roster) => roster.map((mon) => mon.id)),
      draft_notes: draftNotes,
      contributor: options.contributor ?? null,
    });
  }

  if (draftOnly) {
    options.onEvent?.({ type: 'draft', draft: draftView(true) });
    return [];
  }

  phase = 'roundrobin';
  options.onEvent?.({ type: 'draft', draft: draftView(true) });

  const storedTeambuilds = stored ? loadStoredTeambuilds(path.join(runDir, 'teambuild')) : new Map();
  const storedBuildFor = (
    plan: SeriesPlanned,
    entrant: number,
    opponent: number,
    rosterState: readonly DraftBoardMon[][],
  ): { packed: string; view: TeambuildView } => {
    const rows = storedTeambuilds.get(`${plan.index}:${entrant}`) ?? [];
    const row = rows.at(-1);
    const linked = row
      ? linkedStoredArtifact(row.artifact, {
          model: entrants[entrant]!,
          opponentModel: entrants[opponent]!,
          format: board.format,
          psDir,
          sheetPolicy,
          stage: plan.stage,
          seriesIndex: plan.index,
          entrant,
          opponent,
          rosterIds: rosterState[entrant]!.map((mon) => mon.id),
          opponentRosterIds: rosterState[opponent]!.map((mon) => mon.id),
        })
      : undefined;
    if (!linked) {
      throw new Error(
        `run ${runId} completed series ${plan.index} lacks an exact current construction for entrant ${entrant}`,
      );
    }
    return linked;
  };
  const validateStoredSeriesEvidence = (
    row: SeriesRecord,
    plan: SeriesPlanned,
    pair: [number, number],
    builds: Record<Pid, { packed: string; view: TeambuildView }>,
    rosterState: readonly DraftBoardMon[][],
  ): StoredSeriesOutcome => {
    const players = { p1: entrants[pair[0]]!, p2: entrants[pair[1]]! };
    const teams = {
      p1: { id: `${players.p1} wk${plan.round}`, packed: builds.p1.packed },
      p2: { id: `${players.p2} wk${plan.round}`, packed: builds.p2.packed },
    };
    const evidenceContext: RecordedSeriesContext = {
      players,
      teams,
      seriesIndex: plan.index,
      gameSeeds: plan.gameSeeds,
      engineSeeds: plan.engineSeeds,
      format: board.format,
      psDir,
      runDir,
      initialNotebooks: {
        p1: initialBattleNotebook(builds.p1.view),
        p2: initialBattleNotebook(builds.p2.view),
      },
      draftRosters: {
        p1: draftRosterSummary(rosterState[pair[0]]!, builds.p1.view),
        p2: draftRosterSummary(rosterState[pair[1]]!, builds.p2.view),
      },
      ...(plan.stage === 'playoff' ? { requireWinner: true } : {}),
      ...(options.closedSheets === true ? { closedSheets: true } : {}),
      ...(options.reasoning === undefined ? {} : { reasoning: options.reasoning }),
      ...(options.reasoningByModel === undefined ? {} : { reasoningByModel: options.reasoningByModel }),
      timerScale,
    };
    const canonical = readCompletedSeriesEvidence(evidenceContext);
    const storedFields = {
      series_id: row.series_id,
      attempt_id: row.attempt_id,
      format: row.format,
      players: row.players,
      teams: row.teams,
      packed_team_digests: row.packed_team_digests,
      winner: row.winner,
      winner_side: row.winner_side,
      score: row.score,
      turns: row.turns,
      games: row.games,
      engine_seeds: row.engine_seeds,
      timer_scale: row.timer_scale,
      ...(row.closed_sheets === undefined ? {} : { closed_sheets: row.closed_sheets }),
      reasoning: row.reasoning,
      ...(row.reasoning_by_player === undefined ? {} : { reasoning_by_player: row.reasoning_by_player }),
    };
    const expectedTradeWindow = tradeWindow
      ? { after_week: tradeWindow.afterWeek, trades_allowed: tradeWindow.tradesAllowed }
      : null;
    if (
      row.schema_version !== 1 ||
      row.mode !== 'draft' ||
      row.protocol_version !== DRAFT_PROTOCOL_VERSION ||
      row.scaffold !== scaffold ||
      row.draft_scaffold !== draftScaffold ||
      row.teambuild_scaffold !== teambuildScaffold ||
      row.window_scaffold !== windowScaffold ||
      row.season_scaffold !== seasonScaffold ||
      row.ps_commit !== showdownCommit(psDir) ||
      row.series_index !== plan.index ||
      !isDeepStrictEqual(row.trade_window, expectedTradeWindow)
    ) {
      throw new Error(`run ${runId} series ${plan.index} is not bound to its current construction and policies`);
    }
    if (!isDeepStrictEqual(storedFields, canonical.fields)) {
      throw new Error(`run ${runId} series ${plan.index} does not match its canonical completed series evidence`);
    }
    return { score: canonical.fields.score, winnerSide: canonical.winnerSide };
  };

  const teambuildFor = async (plan: SeriesPlanned, entrant: number, opponent: number, signal: AbortSignal) => {
    const storedRows = storedTeambuilds.get(`${plan.index}:${entrant}`) ?? [];
    let reused: { packed: string; view: TeambuildView } | undefined;
    for (let index = storedRows.length - 1; index >= 0 && !reused; index -= 1) {
      const row = storedRows[index]!;
      reused = linkedStoredArtifact(row.artifact, {
        model: entrants[entrant]!,
        opponentModel: entrants[opponent]!,
        format: board.format,
        psDir,
        sheetPolicy,
        stage: plan.stage,
        seriesIndex: plan.index,
        entrant,
        opponent,
        rosterIds: rosters[entrant]!.map((mon) => mon.id),
        opponentRosterIds: rosters[opponent]!.map((mon) => mon.id),
      });
    }
    if (reused) {
      try {
        validateTeam(reused.packed, board.format, psDir);
        teambuilds.push(reused.view);
        options.onEvent?.({ type: 'draft', draft: draftView(true) });
        return reused;
      } catch {}
    }

    const result = await runTeambuild(
      {
        seriesIndex: plan.index,
        entrant,
        opponent,
        stage: plan.stage,
        model: entrants[entrant]!,
        opponentModel: entrants[opponent]!,
        franchiseName: teamNames[entrant]!,
        roster: rosters[entrant]!,
        opponentRoster: rosters[opponent]!,
        draftNote: draftNotes[entrant]!,
        playoffContext:
          plan.stage === 'playoff'
            ? [...playoffContext[entrant]!.entries()].sort(([a], [b]) => a - b).map(([, context]) => context)
            : [],
        format: board.format,
        sheetPolicy,
      },
      {
        psDir,
        logDir: path.join(runDir, 'teambuild'),
        rng: seededRng(`${seed}:tb:${plan.index}:${entrant}`),
        signal,
        ...(options.reasoning === undefined ? {} : { reasoning: options.reasoning }),
        ...(options.reasoningByModel === undefined ? {} : { reasoningByModel: options.reasoningByModel }),
        ...(options.apiKeys === undefined ? {} : { apiKeys: options.apiKeys }),
        ...(options.recovery === undefined ? {} : { recovery: options.recovery }),
      },
    );
    validateTeam(result.packed, board.format, psDir);
    teambuilds.push(result.view);
    options.onEvent?.({ type: 'draft', draft: draftView(true) });
    return result;
  };

  const results: SeriesRecord[] = [];
  let seeding: number[] = [];
  let playoffBracketRounds: BracketMatch[][] | undefined;
  const playSeries = async (plan: SeriesPlanned, signal: AbortSignal): Promise<SeriesRecord> => {
    const [a, b] = plan.entrants!;
    const players: Record<Pid, string> = { p1: entrants[a]!, p2: entrants[b]! };
    options.onEvent?.({ type: 'series-players', index: plan.index, players });
    const [home, away] = await Promise.all([teambuildFor(plan, a, b, signal), teambuildFor(plan, b, a, signal)]);
    options.onEvent?.({ type: 'series-start', index: plan.index });
    const { winnerSide, fields, coachNotes } = await playRecordedSeries({
      seriesIndex: plan.index,
      players,
      teams: {
        p1: { id: `${entrants[a]} wk${plan.round}`, packed: home.packed },
        p2: { id: `${entrants[b]} wk${plan.round}`, packed: away.packed },
      },
      initialNotebooks: {
        p1: initialBattleNotebook(home.view),
        p2: initialBattleNotebook(away.view),
      },
      draftRosters: {
        p1: draftRosterSummary(rosters[a]!, home.view),
        p2: draftRosterSummary(rosters[b]!, away.view),
      },
      gameSeeds: plan.gameSeeds,
      engineSeeds: plan.engineSeeds,
      format: board.format,
      psDir,
      runDir,
      signal,
      ...(plan.stage === 'playoff' ? { requireWinner: true } : {}),
      ...(options.closedSheets === true ? { closedSheets: true } : {}),
      ...(options.reasoning === undefined ? {} : { reasoning: options.reasoning }),
      ...(options.apiKeys === undefined ? {} : { apiKeys: options.apiKeys }),
      ...(options.recovery === undefined ? {} : { recovery: options.recovery }),
      ...(options.reasoningByModel === undefined ? {} : { reasoningByModel: options.reasoningByModel }),
      timerScale,
      onGameUpdate: (game, lines, publicLines) =>
        options.onEvent?.({ type: 'game-update', index: plan.index, game, lines, publicLines }),
      onGameEnd: (game, winner, turns, score) =>
        options.onEvent?.({ type: 'game-end', index: plan.index, game, winner, turns, score }),
      onDecision: (pid, row) => options.onEvent?.({ type: 'decision', index: plan.index, pid, row }),
    });
    if (plan.stage === 'playoff' && !winnerSide) {
      throw new Error(`draft playoff series ${plan.index + 1} ended without a winner`);
    }
    const row: SeriesRecord = {
      schema_version: 1,
      mode: 'draft',
      protocol_version: DRAFT_PROTOCOL_VERSION,
      scaffold,
      draft_scaffold: draftScaffold,
      teambuild_scaffold: teambuildScaffold,
      window_scaffold: windowScaffold,
      season_scaffold: seasonScaffold,
      series_index: plan.index,
      stage: plan.stage,
      round: plan.round,
      ...(plan.stage === 'playoff' ? { advanced: entrants[winnerSide === 'p1' ? a : b]! } : {}),
      board: board.id,
      trade_window: tradeWindow
        ? { after_week: tradeWindow.afterWeek, trades_allowed: tradeWindow.tradesAllowed }
        : null,
      ...(options.contributor === undefined ? {} : { contributor: options.contributor }),
      run_seed: seed,
      ps_commit: showdownCommit(psDir),
      ...fields,
    } as SeriesRecord;
    appendRow(recordsPath, row);
    completed.set(plan.index, row);
    applyOutcome(plan, row, {
      p1: { build: home.view, notebook: coachNotes.p1 },
      p2: { build: away.view, notebook: coachNotes.p2 },
    });
    options.onEvent?.({ type: 'series-end', index: plan.index, record: row });
    return row;
  };

  const applyOutcome = (
    plan: SeriesPlanned,
    row: SeriesRecord,
    coaching?: Record<Pid, { build: TeambuildView; notebook: string }>,
  ): void => {
    const [a, b] = plan.entrants!;
    const storedOutcome = storedOutcomes.get(plan.index);
    const winnerSide = storedOutcome?.winnerSide ?? ((row.winner_side ?? undefined) as Pid | undefined);
    const score = storedOutcome?.score ?? (row.score as Record<Pid, number>);
    for (const [entrant, opponent, side] of [
      [a, b, 'p1'],
      [b, a, 'p2'],
    ] as const) {
      const won = winnerSide === side;
      const result = winnerSide ? (won ? 'beat' : 'lost to') : 'drew with';
      const summary =
        `${plan.stage === 'playoff' ? `Playoff round ${plan.round}` : `Round-robin week ${plan.round}`}: ${result} ` +
        `${entrants[opponent]} ${score[side]}-${score[side === 'p1' ? 'p2' : 'p1']}`;
      const context = coaching ? playoffReview(summary, coaching[side].build, coaching[side].notebook) : summary;
      if (coaching || !playoffContext[entrant]!.has(plan.index)) {
        playoffContext[entrant]!.set(plan.index, context);
      }
      if (coaching) {
        reflectionNotes[entrant]!.set(plan.index, coaching[side].notebook);
        appendJsonlObject(coachingPath, {
          series_index: plan.index,
          entrant,
          context,
          notebook: coaching[side].notebook,
        });
      }
    }
    if (plan.stage === 'roundrobin') {
      table[a]!.gw += score.p1;
      table[a]!.gl += score.p2;
      table[b]!.gw += score.p2;
      table[b]!.gl += score.p1;
      if (winnerSide) {
        table[winnerSide === 'p1' ? a : b]!.w += 1;
        table[winnerSide === 'p1' ? b : a]!.l += 1;
      }
      options.onEvent?.({ type: 'draft', draft: draftView(true) });
    }
  };

  const validateStoredRoundRobin = (include: (plan: SeriesPlanned) => boolean): void => {
    for (const [seriesIndex, row] of storedRoundRobinRows) {
      const plan = plans[seriesIndex]!;
      if (completed.has(plan.index) || !include(plan)) continue;
      const pair = plan.entrants!;
      const rosterState = tradeWindow && plan.round > tradeWindow.afterWeek ? rosters : initialRosters;
      const builds = {
        p1: storedBuildFor(plan, pair[0], pair[1], rosterState),
        p2: storedBuildFor(plan, pair[1], pair[0], rosterState),
      };
      const outcome = validateStoredSeriesEvidence(row, plan, pair, builds, rosterState);
      storedOutcomes.set(plan.index, outcome);
      teambuilds.push(builds.p1.view, builds.p2.view);
      completed.set(plan.index, row);
    }
  };

  validateStoredRoundRobin((plan) => !tradeWindow || plan.round <= tradeWindow.afterWeek);
  if (stored && !tradeWindow && storedTransactionArtifacts.length) {
    throw new Error(`run ${runId} has transaction artifacts but no configured trade window`);
  }
  if (stored && tradeWindow) {
    if (storedTransactionArtifacts.length) {
      requireTransactionResultPrefix(runId, storedRunRows, plans, tradeWindow.afterWeek);
    }
    const windowTable: DraftTableRow[] = entrants.map((_, entrant) => ({ entrant, w: 0, l: 0, gw: 0, gl: 0 }));
    for (const plan of plans) {
      if (plan.stage !== 'roundrobin' || plan.round > tradeWindow.afterWeek || !plan.entrants) continue;
      const storedOutcome = storedOutcomes.get(plan.index);
      if (!storedOutcome) continue;
      const [a, b] = plan.entrants;
      const score = storedOutcome.score;
      const winner = storedOutcome.winnerSide;
      windowTable[a]!.gw += score.p1;
      windowTable[a]!.gl += score.p2;
      windowTable[b]!.gw += score.p2;
      windowTable[b]!.gl += score.p1;
      if (winner) {
        windowTable[winner === 'p1' ? a : b]!.w += 1;
        windowTable[winner === 'p1' ? b : a]!.l += 1;
      }
    }
    windowArtifact = readValidatedTradeWindow(
      runDir,
      {
        board,
        models: entrants,
        teamNames,
        rosters,
        budgets,
        notebooks: draftNotes,
        standings: rankedTable(windowTable),
        results: entrants.map(() => []),
        reflections: entrants.map(() => []),
      },
      { afterWeek: tradeWindow.afterWeek, tradesAllowed: tradeWindow.tradesAllowed },
    );
    if (!windowArtifact && storedPostWindowEvidence.length) {
      throw new Error(
        `run ${runId} has evidence past its transaction barrier but lacks authoritative window artifacts: ${storedPostWindowEvidence.join(', ')}`,
      );
    }
    if (windowArtifact) {
      const monById = new Map(board.mons.map((mon) => [mon.id, mon] as const));
      rosters = windowArtifact.rosters.map(({ roster }) => roster.map(({ id }) => monById.get(id)!));
      budgets = windowArtifact.rosters.map(({ budget_left }) => budget_left);
      for (const decision of windowArtifact.decisions) draftNotes[decision.entrant] = decision.notebook;
    }
  }

  validateStoredRoundRobin(() => true);

  for (const plan of plans) {
    if (plan.stage !== 'roundrobin') continue;
    const row = completed.get(plan.index);
    if (row) {
      applyOutcome(plan, row);
      results.push(row);
    }
  }

  if (storedPlayoffRows.size) {
    const missingRoundRobin = plans.find((plan) => plan.stage === 'roundrobin' && !completed.has(plan.index));
    if (missingRoundRobin) {
      throw new Error(
        `run ${runId} has a playoff result before scheduled round-robin series ${missingRoundRobin.index}; it cannot resume`,
      );
    }
    const playoffPlans = plans.filter((plan) => plan.stage === 'playoff');
    playoffBracketRounds = buildDraftPlayoffBracket(
      playoffPlans,
      rankedTable(table).map((row) => row.entrant),
    );
    let adopted = true;
    while (adopted) {
      adopted = false;
      for (const match of playoffBracketRounds.flat()) {
        if (
          match.seriesIndex === null ||
          match.slots[0] === null ||
          match.slots[1] === null ||
          completed.has(match.seriesIndex)
        ) {
          continue;
        }
        const row = storedPlayoffRows.get(match.seriesIndex);
        if (!row) continue;
        const plan = playoffPlans.find((candidate) => candidate.index === match.seriesIndex)!;
        const pair: [number, number] = [match.slots[0], match.slots[1]];
        plan.entrants = pair;
        const builds = {
          p1: storedBuildFor(plan, pair[0], pair[1], rosters),
          p2: storedBuildFor(plan, pair[1], pair[0], rosters),
        };
        const outcome = validateStoredSeriesEvidence(row, plan, pair, builds, rosters);
        if (!outcome.winnerSide) throw new Error(`run ${runId} playoff series ${plan.index} has no canonical winner`);
        const expectedAdvanced = entrants[outcome.winnerSide === 'p1' ? pair[0] : pair[1]];
        if (row.advanced !== expectedAdvanced) {
          throw new Error(`run ${runId} series ${plan.index} advances a player other than its canonical winner`);
        }
        playoffBracketRounds = applyBracketOutcome(playoffBracketRounds, match, outcome.winnerSide);
        teambuilds.push(builds.p1.view, builds.p2.view);
        completed.set(plan.index, row);
        storedOutcomes.set(plan.index, outcome);
        adopted = true;
      }
    }
    const unresolved = [...storedPlayoffRows.keys()].find((index) => !completed.has(index));
    if (unresolved !== undefined) {
      throw new Error(
        `run ${runId} playoff series ${unresolved} has unresolved bracket prerequisites; it cannot resume`,
      );
    }
  }

  if (stored && storedWindow === undefined) promoteDraftOnlyConfig(runDir, stored, tradeWindow);

  const stopWeek = options.throughWeek;
  const openTradeWindow = async (): Promise<void> => {
    if (!tradeWindow || windowArtifact) return;
    phase = 'window';
    week = tradeWindow.afterWeek;
    options.onEvent?.({ type: 'draft', draft: draftView(true) });
    const preWindowRosters = rosters.map((roster) => [...roster]);
    const windowResults: TradeWindowResult[][] = entrants.map(() => []);
    for (const plan of plans) {
      if (plan.stage !== 'roundrobin' || plan.round > tradeWindow.afterWeek || !plan.entrants) continue;
      const row = completed.get(plan.index);
      if (!row) continue;
      const [a, b] = plan.entrants;
      const storedOutcome = storedOutcomes.get(plan.index);
      const score = storedOutcome?.score ?? (row.score as Record<Pid, number>);
      const winner = storedOutcome?.winnerSide ?? ((row.winner_side ?? undefined) as Pid | undefined);
      for (const [entrant, opponent, side] of [
        [a, b, 'p1'],
        [b, a, 'p2'],
      ] as const) {
        const other = side === 'p1' ? 'p2' : 'p1';
        windowResults[entrant]!.push({
          entrant,
          opponent,
          week: plan.round,
          score: [score[side], score[other]],
          result: winner === undefined ? 'drew' : winner === side ? 'won' : 'lost',
          opponentRoster: preWindowRosters[opponent]!.map((mon) => `${mon.id} (${mon.cost})`).join(', '),
        });
      }
    }
    windowArtifact = await runTradeWindow(
      {
        board,
        models: entrants,
        teamNames,
        rosters,
        budgets,
        notebooks: draftNotes,
        standings: rankedTable(table),
        results: windowResults,
        reflections: reflectionNotes.map((notes) =>
          [...notes.entries()].sort(([a], [b]) => a - b).map(([, note]) => note),
        ),
      },
      {
        runDir,
        psDir,
        afterWeek: tradeWindow.afterWeek,
        tradesAllowed: tradeWindow.tradesAllowed,
        ...(options.reasoning === undefined ? {} : { reasoning: options.reasoning }),
        ...(options.reasoningByModel === undefined ? {} : { reasoningByModel: options.reasoningByModel }),
        ...(options.apiKeys === undefined ? {} : { apiKeys: options.apiKeys }),
        ...(options.recovery === undefined ? {} : { recovery: options.recovery }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    );
    phase = 'roundrobin';
    options.onEvent?.({ type: 'draft', draft: draftView(true) });
  };
  /** A coach reviews its season at the moment that season ends, so a team knocked out in the round robin
   * judges its draft without seeing playoff results it was never part of. */
  const closeSeason = async (finished: Array<{ entrant: number; outcome: string }>): Promise<void> => {
    if (!finished.length || options.signal?.aborted) return;
    await runSeasonReview(
      finished,
      {
        board,
        models: entrants,
        picks,
        rosters,
        window: windowArtifact,
        standings: rankedTable(table),
        series: playoffContext.map((context) =>
          [...context.entries()].sort(([a], [b]) => a - b).map(([, entry]) => entry),
        ),
        notebooks: draftNotes,
      },
      {
        runDir,
        psDir,
        ...(options.reasoning === undefined ? {} : { reasoning: options.reasoning }),
        ...(options.reasoningByModel === undefined ? {} : { reasoningByModel: options.reasoningByModel }),
        ...(options.apiKeys === undefined ? {} : { apiKeys: options.apiKeys }),
        ...(options.recovery === undefined ? {} : { recovery: options.recovery }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    );
  };
  /** A retrospective buys nothing later games depend on, so an eliminated coach writes its review while the
   * bracket plays on; the run joins the outstanding reviews, and surfaces their failures, before it returns. */
  const seasonJobs: Promise<void>[] = [];
  let seasonFailure: unknown;
  const startSeasonClose = (finished: Array<{ entrant: number; outcome: string }>): void => {
    seasonJobs.push(
      closeSeason(finished).catch((error: unknown) => {
        seasonFailure ??= error;
      }),
    );
  };
  const finish = async (): Promise<SeriesRecord[]> => {
    await Promise.all(seasonJobs);
    if (seasonFailure !== undefined && !options.signal?.aborted) throw seasonFailure;
    return sorted(results);
  };
  const scheduleRoundRobin = async (scheduled: SeriesPlanned[]): Promise<void> => {
    results.push(
      ...(await mapLimit(scheduled, options.concurrency ?? 2, options.signal, (plan, signal) =>
        playSeries(plan, signal),
      )),
    );
  };
  if (sequentialWeeks || stopWeek !== undefined) {
    for (const index of weeks.keys()) {
      if (options.signal?.aborted) return sorted(results);
      week = index + 1;
      options.onEvent?.({ type: 'draft', draft: draftView(true) });
      await scheduleRoundRobin(
        plans.filter((plan) => plan.stage === 'roundrobin' && plan.round === week && !completed.has(plan.index)),
      );
      if (stopWeek !== undefined && week >= stopWeek) {
        options.onEvent?.({ type: 'draft', draft: draftView(true) });
        return sorted(results);
      }
      if (tradeWindow?.afterWeek === week) await openTradeWindow();
    }
    if (tradeWindow && tradeWindow.afterWeek >= weeks.length) await openTradeWindow();
  } else if (tradeWindow) {
    week = tradeWindow.afterWeek;
    options.onEvent?.({ type: 'draft', draft: draftView(true) });
    await scheduleRoundRobin(
      plans.filter(
        (plan) => plan.stage === 'roundrobin' && plan.round <= tradeWindow.afterWeek && !completed.has(plan.index),
      ),
    );
    if (options.signal?.aborted) return sorted(results);
    await openTradeWindow();
    week = weeks.length;
    options.onEvent?.({ type: 'draft', draft: draftView(true) });
    await scheduleRoundRobin(
      plans.filter(
        (plan) => plan.stage === 'roundrobin' && plan.round > tradeWindow.afterWeek && !completed.has(plan.index),
      ),
    );
  } else {
    week = weeks.length;
    options.onEvent?.({ type: 'draft', draft: draftView(true) });
    await scheduleRoundRobin(plans.filter((plan) => plan.stage === 'roundrobin' && !completed.has(plan.index)));
  }
  if (options.signal?.aborted) return sorted(results);

  seeding = rankedTable(table).map((row) => row.entrant);
  phase = 'playoffs';
  week = 0;
  options.onEvent?.({ type: 'draft', draft: draftView(true) });

  startSeasonClose(
    seeding.slice(playoffRounds === 2 ? 4 : 2).map((entrant, index) => ({
      entrant,
      outcome: `You finished ${ordinal((playoffRounds === 2 ? 4 : 2) + index + 1)} of ${entrants.length} in the round robin and missed the playoffs. Your season is over.`,
    })),
  );
  if (options.signal?.aborted) return finish();

  const playoffs = plans.filter((plan) => plan.stage === 'playoff');
  playoffBracketRounds ??= buildDraftPlayoffBracket(playoffs, seeding);
  const bracketView = (): BracketView => ({
    entrants: entrants.map((model, index) => ({
      model,
      team: teamNames[index] || `seed ${seeding.indexOf(index) + 1}`,
    })),
    rounds: playoffBracketRounds!.map((round) =>
      round.map((match) => ({
        seriesIndex: match.seriesIndex,
        slots: [...match.slots],
        winner: match.winner,
      })),
    ),
    champion: playoffBracketRounds!.at(-1)![0]!.winner,
  });
  options.onEvent?.({ type: 'bracket', bracket: bracketView() });

  const resolve = (scheduled: BracketMatch, winnerSide: Pid): number => {
    const winner = scheduled.slots[winnerSide === 'p1' ? 0 : 1]!;
    playoffBracketRounds = applyBracketOutcome(playoffBracketRounds!, scheduled, winnerSide);
    options.onEvent?.({ type: 'bracket', bracket: bracketView() });
    return winner;
  };

  if (playoffRounds === 2) {
    const semis = await mapLimit(
      [0, 1],
      Math.min(options.concurrency ?? 2, 2),
      options.signal,
      async (matchIndex, signal) => {
        const plan = playoffs[matchIndex]!;
        const scheduled = playoffBracketRounds![0]![matchIndex]!;
        plan.entrants = [...scheduled.slots] as [number, number];
        const existing = completed.get(plan.index);
        if (existing) {
          applyOutcome(plan, existing);
          return existing;
        }
        const row = await playSeries(plan, signal);
        resolve(scheduled, row.winner_side as Pid);
        return row;
      },
    );
    results.push(...semis);
    if (options.signal?.aborted) return finish();
    startSeasonClose(
      playoffBracketRounds![0]!.flatMap((match) => {
        const loser = match.slots.find((slot) => slot !== null && slot !== match.winner);
        return loser === null || loser === undefined
          ? []
          : [
              {
                entrant: loser,
                outcome: `You reached the playoffs as the ${ordinal(seeding.indexOf(loser) + 1)} seed and were eliminated in the semifinals. Your season is over.`,
              },
            ];
      }),
    );
    if (options.signal?.aborted) return finish();
  }
  const finalPlan = playoffs[playoffs.length - 1]!;
  const finalRound = playoffRounds - 1;
  const scheduledFinal = playoffBracketRounds[finalRound]![0]!;
  finalPlan.entrants = [...scheduledFinal.slots] as [number, number];
  if (finalPlan.entrants[0] === null || finalPlan.entrants[1] === null) return finish();
  const storedFinal = completed.get(finalPlan.index);
  const finalRow = storedFinal
    ? [storedFinal]
    : await mapLimit([finalPlan], 1, options.signal, (plan, signal) => playSeries(plan, signal));
  if (finalRow[0]) {
    if (storedFinal) applyOutcome(finalPlan, storedFinal);
    const champion = storedFinal ? scheduledFinal.winner! : resolve(scheduledFinal, finalRow[0].winner_side as Pid);
    results.push(finalRow[0]);
    const runnerUp = finalPlan.entrants.find((entrant) => entrant !== champion);
    await closeSeason([
      ...(runnerUp === undefined || runnerUp === null
        ? []
        : [
            {
              entrant: runnerUp,
              outcome: 'You reached the final and lost it. You are the league runner-up and your season is over.',
            },
          ]),
      { entrant: champion, outcome: 'You won the final. You are the league champion and the season is over.' },
    ]);
    phase = 'done';
    options.onEvent?.({ type: 'draft', draft: draftView(true) });
  }
  return finish();
}

function sorted(rows: SeriesRecord[]): SeriesRecord[] {
  return [...rows].sort((a, b) => (a.series_index as number) - (b.series_index as number));
}

function draftOnlyPromotionEvidence(runDir: string, rows: readonly SeriesRecord[]): string[] {
  const evidence = rows.length ? ['stored results'] : [];
  for (const relative of ['teambuild/teambuild.jsonl', 'coaching.jsonl', 'season.jsonl']) {
    try {
      if (fs.statSync(path.join(runDir, relative)).size > 0) evidence.push(relative);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
    }
  }
  try {
    if (fs.readdirSync(path.join(runDir, 'series')).length) evidence.push('series/');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
  }
  return evidence;
}

function postWindowEvidence(
  runDir: string,
  rows: readonly SeriesRecord[],
  plans: readonly SeriesPlanned[],
  afterWeek: number,
): string[] {
  const pastBarrier = new Set(
    plans.filter((plan) => plan.stage === 'playoff' || plan.round > afterWeek).map((plan) => plan.index),
  );
  const evidence = rows
    .filter((row) => pastBarrier.has(row.series_index as number))
    .map((row) => `result series ${String(row.series_index)}`);
  for (const [relative, key] of [
    ['teambuild/teambuild.jsonl', 'seriesIndex'],
    ['coaching.jsonl', 'series_index'],
  ] as const) {
    const file = path.join(runDir, relative);
    for (const row of readJsonlObjects(file)) {
      if (pastBarrier.has(row[key] as number)) evidence.push(`${relative} series ${String(row[key])}`);
    }
  }
  const seriesRoot = path.join(runDir, 'series');
  let seriesDirectories: string[] = [];
  try {
    seriesDirectories = fs.readdirSync(seriesRoot);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
  }
  for (const directory of seriesDirectories) {
    let meta: Record<string, unknown>;
    try {
      meta = JSON.parse(fs.readFileSync(path.join(seriesRoot, directory, 'series.json'), 'utf8')) as Record<
        string,
        unknown
      >;
    } catch {
      continue;
    }
    const identity =
      meta.schema_version === 3 &&
      typeof meta.identity === 'object' &&
      meta.identity !== null &&
      !Array.isArray(meta.identity)
        ? (meta.identity as Record<string, unknown>)
        : undefined;
    const seriesIndex = identity?.series_index;
    if (typeof seriesIndex === 'number' && pastBarrier.has(seriesIndex)) evidence.push(`series/${directory}`);
  }
  if (readJsonlObjects(path.join(runDir, 'season.jsonl')).length) evidence.push('season.jsonl');
  return [...new Set(evidence)];
}

function requireTransactionResultPrefix(
  runId: string,
  rows: readonly SeriesRecord[],
  plans: readonly SeriesPlanned[],
  afterWeek: number,
): void {
  const expected = plans.filter((plan) => plan.stage === 'roundrobin' && plan.round <= afterWeek);
  if (rows.length < expected.length) {
    throw new Error(
      `run ${runId} transaction artifacts have only ${rows.length} results before a ${expected.length}-series pre-window barrier`,
    );
  }
  const expectedIndexes = new Set(expected.map((plan) => plan.index));
  const prefix = rows.slice(0, expected.length);
  const crossed = prefix.find((row) => !expectedIndexes.has(row.series_index as number));
  if (crossed) {
    throw new Error(
      `run ${runId} later-round series ${String(crossed.series_index)} crosses the transaction barrier before the exact pre-window result prefix`,
    );
  }
  const prefixIndexes = new Set(prefix.map((row) => row.series_index as number));
  const missing = expected.filter((plan) => !prefixIndexes.has(plan.index));
  if (missing.length || prefixIndexes.size !== expected.length) {
    throw new Error(
      `run ${runId} transaction artifacts lack the exact pre-window result prefix; missing scheduled series ${missing.map((plan) => plan.index).join(', ') || 'none'}`,
    );
  }
}

interface StoredLeague {
  config: Record<string, unknown>;
  configBytes: string;
  entrants: string[];
  teamNames: string[];
  rosterIds: string[][];
  draftNotes: string[];
  sequentialWeeks: boolean;
  tradeWindow: TradeWindowConfig | null | undefined;
}

function validateStoredLeagueConfig(
  runDir: string,
  stored: StoredLeague,
  request: {
    models: readonly string[];
    seed: number;
    board: DraftBoard;
    closedSheets: boolean;
    timerScale: unknown;
  },
): void {
  const config = stored.config;
  if (
    config.protocol_version !== DRAFT_PROTOCOL_VERSION ||
    config.seed !== request.seed ||
    config.board !== request.board.id ||
    config.format !== request.board.format ||
    !isDeepStrictEqual(config.models, request.models) ||
    config.closed_sheets !== request.closedSheets ||
    config.timer_scale !== request.timerScale
  ) {
    throw new Error(`${runDir} stored config does not match the resumed league invocation and board`);
  }
  const expectedEntrants = shuffle(request.models, seededRng(request.seed));
  if (!isDeepStrictEqual(stored.entrants, expectedEntrants)) {
    throw new Error(`${runDir} stored entrants do not match the seeded draft seating`);
  }
}

function promoteDraftOnlyConfig(runDir: string, stored: StoredLeague, tradeWindow: TradeWindowConfig | null): void {
  const configPath = path.join(runDir, 'config.json');
  if (fs.readFileSync(configPath, 'utf8') !== stored.configBytes) {
    throw new Error(`${configPath} changed while its draft-only promotion was being validated`);
  }
  const nextConfig = {
    ...stored.config,
    draft_only: false,
    trade_window: tradeWindow ? { after_week: tradeWindow.afterWeek, trades_allowed: tradeWindow.tradesAllowed } : null,
  };
  const temporary = `${configPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(nextConfig, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, configPath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/** A resume reuses only a current construction artifact whose semantics replay exactly. */
function linkedStoredArtifact(
  value: unknown,
  context: {
    model: string;
    opponentModel: string;
    format: string;
    psDir: string;
    sheetPolicy: TeamBuildSheetPolicy;
    stage: SeriesPlanned['stage'];
    seriesIndex: number;
    entrant: number;
    opponent: number;
    rosterIds: string[];
    opponentRosterIds: string[];
  },
): { packed: string; view: TeambuildView } | undefined {
  let replayed: ReturnType<typeof replayTeamBuildArtifact>;
  try {
    replayed = replayTeamBuildArtifact(value, { psDir: context.psDir });
  } catch {
    return undefined;
  }
  const artifact = replayed.artifact;
  const task = artifact.task;
  const action = artifact.action!;
  if (
    artifact.executionPolicy !== 'league-resilient' ||
    task.executionPolicy !== 'league-resilient' ||
    task.model !== context.model ||
    task.format !== context.format ||
    task.sheetPolicy !== context.sheetPolicy ||
    task.constraint.kind !== 'draft-picks' ||
    task.objective.kind !== 'matchup' ||
    task.objective.stage !== context.stage ||
    task.objective.opponent.model !== context.opponentModel ||
    task.provenance.source !== 'draft-league' ||
    task.provenance.seriesIndex !== context.seriesIndex ||
    task.provenance.entrant !== context.entrant ||
    task.provenance.opponent !== context.opponent ||
    !isDeepStrictEqual(
      task.constraint.candidates.map((candidate) => candidate.id),
      context.rosterIds,
    ) ||
    !isDeepStrictEqual(
      task.objective.opponent.candidates.map((candidate) => candidate.id),
      context.opponentRosterIds,
    )
  ) {
    return undefined;
  }
  return {
    packed: replayed.packed,
    view: {
      seriesIndex: context.seriesIndex,
      entrant: context.entrant,
      opponent: context.opponent,
      brought: [...action.selected],
      sets: structuredClone(action.sets),
      rationale: artifact.evidence.rationale,
      attempts: artifact.attempts,
    },
  };
}

interface StoredTeambuildRow {
  artifact: unknown;
}

function loadStoredTeambuilds(teambuildDir: string): Map<string, StoredTeambuildRow[]> {
  const rowsBySeries = new Map<string, StoredTeambuildRow[]>();
  for (const row of readJsonlObjects(path.join(teambuildDir, 'teambuild.jsonl'))) {
    const artifact = row.artifact;
    if (typeof artifact !== 'object' || artifact === null || Array.isArray(artifact)) continue;
    const task = (artifact as { task?: unknown }).task;
    if (typeof task !== 'object' || task === null || Array.isArray(task)) continue;
    const provenance = (task as { provenance?: unknown }).provenance;
    if (typeof provenance !== 'object' || provenance === null || Array.isArray(provenance)) continue;
    const entrant = Number((provenance as Record<string, unknown>).entrant);
    const seriesIndex = Number((provenance as Record<string, unknown>).seriesIndex);
    if (!Number.isSafeInteger(entrant) || !Number.isSafeInteger(seriesIndex)) continue;
    const key = `${seriesIndex}:${entrant}`;
    const stored = rowsBySeries.get(key) ?? [];
    stored.push({ artifact });
    rowsBySeries.set(key, stored);
  }
  return rowsBySeries;
}

/** Undefined means the draft is still in progress: re-enter the draft path and replay its transcript. */
function loadStoredLeague(runDir: string): StoredLeague | undefined {
  const configPath = path.join(runDir, 'config.json');
  let configBytes: string;
  try {
    configBytes = fs.readFileSync(configPath, 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`${runDir} holds no draft league config to resume`);
    }
    throw cause;
  }
  const parsed = JSON.parse(configBytes) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${runDir} draft league config must be one object`);
  }
  const config = parsed as Record<string, unknown>;
  if (config.mode !== 'draft') throw new Error(`${runDir} is not a draft league run`);
  if (!Object.hasOwn(config, 'rosters')) return undefined;
  if (
    !Array.isArray(config.entrants) ||
    config.entrants.length < 2 ||
    config.entrants.some((model) => typeof model !== 'string') ||
    !Array.isArray(config.team_names) ||
    config.team_names.length !== config.entrants.length ||
    config.team_names.some((name) => typeof name !== 'string') ||
    !Array.isArray(config.rosters) ||
    config.rosters.length !== config.entrants.length ||
    config.rosters.some(
      (roster) => !Array.isArray(roster) || roster.some((id) => typeof id !== 'string' || id.length === 0),
    ) ||
    !Array.isArray(config.draft_notes) ||
    config.draft_notes.length !== config.entrants.length ||
    config.draft_notes.some((note) => typeof note !== 'string') ||
    typeof config.sequential_weeks !== 'boolean' ||
    typeof config.draft_only !== 'boolean'
  ) {
    throw new Error(`${runDir} is not a structurally complete drafted-league config`);
  }
  let tradeWindow: TradeWindowConfig | null | undefined;
  if (config.draft_only) {
    if (config.trade_window !== null) {
      throw new Error(`${runDir} draft-only config must record a null trade window`);
    }
    tradeWindow = undefined;
  } else if (config.trade_window === null) {
    tradeWindow = null;
  } else {
    const window = config.trade_window;
    if (typeof window !== 'object' || window === null || Array.isArray(window)) {
      throw new Error(`${runDir} season config has an invalid trade window`);
    }
    const record = window as Record<string, unknown>;
    if (
      !Number.isSafeInteger(record.after_week) ||
      Number(record.after_week) < 1 ||
      !Number.isSafeInteger(record.trades_allowed) ||
      Number(record.trades_allowed) < 0 ||
      Number(record.trades_allowed) > MAX_TRADE_OFFERS
    ) {
      throw new Error(`${runDir} season config has an invalid trade window`);
    }
    tradeWindow = { afterWeek: Number(record.after_week), tradesAllowed: Number(record.trades_allowed) };
  }
  return {
    config,
    configBytes,
    entrants: config.entrants as string[],
    teamNames: config.team_names as string[],
    rosterIds: config.rosters as string[][],
    draftNotes: config.draft_notes as string[],
    sequentialWeeks: config.sequential_weeks,
    tradeWindow,
  };
}

function rankedTable(table: DraftTableRow[]): DraftTableRow[] {
  return [...table].sort((a, b) => b.w - a.w || b.gw - b.gl - (a.gw - a.gl) || b.gw - a.gw || a.entrant - b.entrant);
}
