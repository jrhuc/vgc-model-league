import fs from 'node:fs';
import path from 'node:path';

import type { DraftBoard, DraftBoardMon } from './draft.js';
import { draftScaffoldRevision, loadBoard, runDraft, snakeOrder } from './draft.js';
import type { BracketView, DraftPickView, DraftTableRow, DraftView, TeambuildView } from './gui/api.js';
import { scaffoldComponents, scaffoldRevision } from './llm-engine.js';
import { BOARDS_DIR, defaultPsDir, RESULTS_PATH } from './paths.js';
import { parseRoutingPreferences, validateModelExecution } from './providers.js';
import { resolveSeed, seededRng, seriesEntropy, shuffle } from './random.js';
import type { SeriesRecord } from './records.js';
import { appendRow, loadRows } from './records.js';
import { runSeasonReview, seasonReviewScaffoldRevision } from './season-review.js';
import type { ExperimentOptions } from './series.js';
import { mapLimit, playRecordedSeries } from './series.js';
import { showdownCommit } from './showdown.js';
import {
  runTeambuild,
  type TeamBuildArtifact,
  type TeamBuildSheetPolicy,
  teamBuildScaffoldRevision,
  teambuildScaffoldRevision,
} from './teambuild.js';
import { validateTeam } from './teams.js';
import { DEFAULT_TIMER_SCALE } from './timer.js';
import type { TournamentEvent } from './tournament.js';
import {
  DEFAULT_TRADE_WINDOW,
  MAX_TRADE_SWAPS,
  readTradeWindow,
  runTradeWindow,
  type TradeWindowConfig,
  type TradeWindowResult,
  tradeWindowScaffoldRevision,
} from './trade-window.js';
import type { Pid } from './types.js';
import { ordinal } from './value.js';

export const DRAFT_PROTOCOL_VERSION = 8;

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
  const rows = [...loadRows(path.join(runDir, 'draft', 'draft.jsonl'))].sort((a, b) => Number(a.pick) - Number(b.pick));
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
  const draftOnly = options.draftOnly === true;
  /** A draft-only run never held a window, so its resume chooses one like a fresh league. */
  const storedWindow = stored ? stored.tradeWindow : undefined;
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
  if (tradeWindow && (!Number.isSafeInteger(tradeWindow.tradesAllowed) || tradeWindow.tradesAllowed < 0)) {
    throw new Error('trade window trades allowed must be a non-negative integer');
  }
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
  const completed = new Map<number, SeriesRecord>();
  if (stored) {
    for (const row of loadRows(recordsPath)) {
      if (row.run_id !== runId || row.mode !== 'draft') continue;
      const plan = plans[row.series_index as number];
      if (!plan || plan.stage !== row.stage || plan.round !== row.round) {
        throw new Error(
          `run ${runId} series ${row.series_index} does not match the rebuilt schedule; it cannot resume`,
        );
      }
      completed.set(row.series_index as number, row);
    }
  }

  const table: DraftTableRow[] = entrants.map((_, entrant) => ({ entrant, w: 0, l: 0, gw: 0, gl: 0 }));
  const teambuilds: TeambuildView[] = [];
  const coachingPath = path.join(runDir, 'coaching.jsonl');
  const playoffContext = entrants.map(() => new Map<number, string>());
  const reflectionNotes = entrants.map(() => new Map<number, string>());
  for (const row of loadRows(coachingPath)) {
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
    if (storedWindow === undefined) {
      /** Resuming a draft-only run turns it into a season with a window, but the recorded scaffold
       * hashes are the draft's provenance: rewrite the two fields the resume changes, nothing else. */
      const configPath = path.join(runDir, 'config.json');
      const priorConfig = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
      const nextConfig = {
        ...priorConfig,
        draft_only: false,
        trade_window: tradeWindow
          ? { after_week: tradeWindow.afterWeek, trades_allowed: tradeWindow.tradesAllowed }
          : null,
      };
      fs.writeFileSync(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, 'utf8');
    }
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
  let windowArtifact = stored ? readTradeWindow(runDir) : undefined;
  if (windowArtifact) {
    if (!tradeWindow || windowArtifact.after_week !== tradeWindow.afterWeek) {
      throw new Error(`run ${runId} trade-window artifact does not match its config`);
    }
    const monById = new Map(board.mons.map((mon) => [mon.id, mon] as const));
    rosters = entrants.map((model, entrant) => {
      const storedRoster = windowArtifact!.rosters.find((entry) => entry.model === model);
      if (!storedRoster) throw new Error(`run ${runId} trade window has no roster for entrant ${entrant + 1}`);
      return storedRoster.roster.map(({ id }) => {
        const mon = monById.get(id);
        if (!mon) throw new Error(`run ${runId} trade window added ${id}, which board ${board.id} does not hold`);
        return mon;
      });
    });
    budgets = rosters.map((roster) => board.budget - roster.reduce((sum, mon) => sum + mon.cost, 0));
    for (const decision of windowArtifact.decisions) {
      if (draftNotes[decision.entrant] !== undefined) draftNotes[decision.entrant] = decision.notebook;
    }
  }

  if (!stored) {
    fs.writeFileSync(
      path.join(runDir, 'rosters.json'),
      `${JSON.stringify(
        entrants.map((model, index) => ({
          model,
          team_name: teamNames[index],
          budget_left: budgets[index],
          spent: board.budget - budgets[index]!,
          roster: rosters[index]!.map((mon) => ({ id: mon.id, name: mon.name, cost: mon.cost })),
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

  const storedTeambuilds = stored
    ? loadStoredTeambuilds(path.join(runDir, 'teambuild'), entrants, board.format, sheetPolicy, showdownCommit(psDir))
    : new Map();
  const teambuildFor = async (plan: SeriesPlanned, entrant: number, opponent: number, signal: AbortSignal) => {
    const reused = storedTeambuilds.get(`${plan.index}:${entrant}`);
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
    const winnerSide = (row.winner_side ?? undefined) as Pid | undefined;
    const score = row.score as Record<Pid, number>;
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
        appendRow(coachingPath, {
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

  for (const plan of plans) {
    if (plan.stage !== 'roundrobin') continue;
    const row = completed.get(plan.index);
    if (row) {
      applyOutcome(plan, row);
      results.push(row);
    }
  }

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
      const score = row.score as Record<Pid, number>;
      const winner = (row.winner_side ?? undefined) as Pid | undefined;
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
  const bracket: BracketView = {
    entrants: entrants.map((model, index) => ({
      model,
      team: teamNames[index] || `seed ${seeding.indexOf(index) + 1}`,
    })),
    rounds:
      playoffRounds === 2
        ? [
            [
              { seriesIndex: playoffs[0]!.index, slots: [seeding[0]!, seeding[3]!], winner: null },
              { seriesIndex: playoffs[1]!.index, slots: [seeding[1]!, seeding[2]!], winner: null },
            ],
            [{ seriesIndex: playoffs[2]!.index, slots: [null, null], winner: null }],
          ]
        : [[{ seriesIndex: playoffs[0]!.index, slots: [seeding[0]!, seeding[1]!], winner: null }]],
    champion: null,
  };
  options.onEvent?.({ type: 'bracket', bracket });

  const resolve = (matchIndex: number, roundIndex: number, winnerSide: Pid): number => {
    const match = bracket.rounds[roundIndex]![matchIndex]!;
    const winner = match.slots[winnerSide === 'p1' ? 0 : 1]!;
    match.winner = winner;
    const next = bracket.rounds[roundIndex + 1]?.[matchIndex >> 1];
    if (next) next.slots[matchIndex % 2] = winner;
    else bracket.champion = winner;
    options.onEvent?.({ type: 'bracket', bracket });
    return winner;
  };

  if (playoffRounds === 2) {
    const semis = await mapLimit(
      [0, 1],
      Math.min(options.concurrency ?? 2, 2),
      options.signal,
      async (matchIndex, signal) => {
        const plan = playoffs[matchIndex]!;
        plan.entrants = bracket.rounds[0]![matchIndex]!.slots as [number, number];
        const existing = completed.get(plan.index);
        if (existing) {
          applyOutcome(plan, existing);
          resolve(matchIndex, 0, existing.winner_side as Pid);
          return existing;
        }
        const row = await playSeries(plan, signal);
        resolve(matchIndex, 0, row.winner_side as Pid);
        return row;
      },
    );
    results.push(...semis);
    if (options.signal?.aborted) return finish();
    startSeasonClose(
      bracket.rounds[0]!.flatMap((match) => {
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
  finalPlan.entrants = bracket.rounds[finalRound]![0]!.slots as [number, number];
  if (finalPlan.entrants[0] === null || finalPlan.entrants[1] === null) return finish();
  const storedFinal = completed.get(finalPlan.index);
  const finalRow = storedFinal
    ? [storedFinal]
    : await mapLimit([finalPlan], 1, options.signal, (plan, signal) => playSeries(plan, signal));
  if (finalRow[0]) {
    if (storedFinal) applyOutcome(finalPlan, storedFinal);
    const champion = resolve(0, finalRound, finalRow[0].winner_side as Pid);
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

interface StoredLeague {
  entrants: string[];
  teamNames: string[];
  rosterIds: string[][];
  draftNotes: string[];
  sequentialWeeks: boolean;
  tradeWindow: TradeWindowConfig | null | undefined;
}

/** A resume re-buys nothing a prior attempt already built: completed teambuilds are replayed from the
 * teambuild log, keyed to the schedule slot and guarded by the seat's current model so a swapped seat
 * still builds its own team. */
function linkedStoredArtifact(
  value: unknown,
  context: {
    model: unknown;
    packed: unknown;
    legacyView: Record<string, unknown>;
    entrants: readonly string[];
    format: string;
    sheetPolicy: TeamBuildSheetPolicy;
    showdownCommit: string;
  },
): { packed: string; view: TeambuildView } | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const artifact = value as TeamBuildArtifact;
  const task = artifact.task;
  const action = artifact.action;
  if (
    artifact.schemaVersion !== 1 ||
    artifact.status !== 'valid' ||
    artifact.executionPolicy !== 'league-resilient' ||
    artifact.showdownCommit !== context.showdownCommit ||
    artifact.validation?.showdown !== true ||
    !task ||
    task.model !== context.model ||
    task.format !== context.format ||
    task.sheetPolicy !== context.sheetPolicy ||
    task.executionPolicy !== artifact.executionPolicy ||
    task.objective?.kind !== 'matchup' ||
    !Array.isArray(task.constraint?.candidates) ||
    task.constraint.candidates.some(
      (candidate) => typeof candidate !== 'object' || candidate === null || typeof candidate.id !== 'string',
    ) ||
    !action ||
    typeof action.packed !== 'string' ||
    action.packed !== context.packed ||
    !Array.isArray(action.selected) ||
    action.selected.some((id) => typeof id !== 'string') ||
    !Array.isArray(action.sets) ||
    typeof artifact.evidence?.rationale !== 'string' ||
    !Number.isInteger(artifact.attempts)
  ) {
    return undefined;
  }
  if (
    action.selected.length !== task.constraint.teamSize ||
    action.sets.length !== task.constraint.teamSize ||
    new Set(action.selected).size !== action.selected.length
  ) {
    return undefined;
  }
  const candidates = new Map(task.constraint.candidates.map((candidate) => [candidate.id, candidate]));
  for (const [index, id] of action.selected.entries()) {
    const set = action.sets[index] as Record<string, unknown> | undefined;
    if (!set || set.species !== candidates.get(id)?.name) return undefined;
  }
  const entrant = Number(task.provenance?.entrant);
  const opponent = Number(task.provenance?.opponent);
  const seriesIndex = Number(task.provenance?.seriesIndex);
  if (
    !Number.isInteger(entrant) ||
    !Number.isInteger(opponent) ||
    !Number.isInteger(seriesIndex) ||
    task.objective.opponent.model !== context.entrants[opponent] ||
    artifact.scaffold !== teamBuildScaffoldRevision(task.objective, context.sheetPolicy, artifact.executionPolicy)
  ) {
    return undefined;
  }
  const view: TeambuildView = {
    seriesIndex,
    entrant,
    opponent,
    brought: action.selected,
    sets: action.sets,
    rationale: artifact.evidence.rationale,
    attempts: artifact.attempts,
  };
  for (const [key, expected] of Object.entries(view)) {
    if (JSON.stringify(context.legacyView[key]) !== JSON.stringify(expected)) return undefined;
  }
  return { packed: action.packed, view };
}

function loadStoredTeambuilds(
  teambuildDir: string,
  entrants: readonly string[],
  format: string,
  sheetPolicy: TeamBuildSheetPolicy,
  currentShowdownCommit: string,
): Map<string, { packed: string; view: TeambuildView }> {
  const reusable = new Map<string, { packed: string; view: TeambuildView }>();
  for (const row of loadRows(path.join(teambuildDir, 'teambuild.jsonl'))) {
    const { model, team_name: _teamName, packed, artifact, timestamp: _timestamp, ...legacyView } = row;
    const entrant = Number(legacyView.entrant);
    const seriesIndex = Number(legacyView.seriesIndex);
    if (!Number.isInteger(entrant) || !Number.isInteger(seriesIndex)) continue;
    if (typeof packed !== 'string' || !packed) continue;
    if (model !== entrants[entrant]) continue;
    if (artifact !== undefined) {
      const linked = linkedStoredArtifact(artifact, {
        model,
        packed,
        legacyView,
        entrants,
        format,
        sheetPolicy,
        showdownCommit: currentShowdownCommit,
      });
      if (!linked) continue;
      reusable.set(`${seriesIndex}:${entrant}`, linked);
      continue;
    }
    reusable.set(`${seriesIndex}:${entrant}`, {
      packed,
      view: legacyView as unknown as TeambuildView,
    });
  }
  return reusable;
}

/** Undefined means the draft is still in progress: re-enter the draft path and replay its transcript. */
function loadStoredLeague(runDir: string): StoredLeague | undefined {
  const configPath = path.join(runDir, 'config.json');
  if (!fs.existsSync(configPath)) throw new Error(`${runDir} holds no draft league config to resume`);
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
    mode?: string;
    entrants?: string[];
    team_names?: string[];
    rosters?: string[][];
    draft_notes?: string[];
    sequential_weeks?: boolean;
    draft_only?: boolean;
    trade_window?: { after_week?: number; trades_allowed?: number } | null;
  };
  if (config.mode !== 'draft') throw new Error(`${runDir} is not a draft league run`);
  if (!config.rosters) return undefined;
  if (!config.entrants || !config.team_names) {
    throw new Error(`${runDir} is not a completed-draft league run`);
  }
  const draftNotes =
    config.draft_notes?.length === config.entrants.length
      ? config.draft_notes.map((note) => (typeof note === 'string' ? note : ''))
      : config.entrants.map(() => '');
  const afterWeek = config.trade_window?.after_week;
  const tradesAllowed = config.trade_window?.trades_allowed;
  const tradeWindow =
    config.draft_only === true
      ? undefined
      : Number.isSafeInteger(afterWeek) && Number(afterWeek) > 0
        ? {
            afterWeek: Number(afterWeek),
            tradesAllowed:
              Number.isSafeInteger(tradesAllowed) && Number(tradesAllowed) >= 0 ? Number(tradesAllowed) : 0,
          }
        : null;
  return {
    entrants: config.entrants,
    teamNames: config.team_names,
    rosterIds: config.rosters,
    draftNotes,
    sequentialWeeks: config.sequential_weeks === true,
    tradeWindow,
  };
}

function rankedTable(table: DraftTableRow[]): DraftTableRow[] {
  return [...table].sort((a, b) => b.w - a.w || b.gw - b.gl - (a.gw - a.gl) || b.gw - a.gw || a.entrant - b.entrant);
}
