import fs from 'node:fs';
import path from 'node:path';

import type { DraftBoardMon } from './draft.js';
import { draftScaffoldRevision, loadBoard, runDraft } from './draft.js';
import type { BracketView, DraftTableRow, DraftView, TeambuildView } from './gui/api.js';
import { scaffoldRevision } from './llm-engine.js';
import { BOARDS_DIR, defaultPsDir, RESULTS_PATH } from './paths.js';
import { validateModelExecution } from './providers.js';
import { resolveSeed, seededRng, seriesEntropy, shuffle } from './random.js';
import type { SeriesRecord } from './records.js';
import { appendRow, loadRows } from './records.js';
import type { ExperimentOptions } from './series.js';
import { mapLimit, playRecordedSeries } from './series.js';
import { showdownCommit } from './showdown.js';
import { runTeambuild, teambuildScaffoldRevision } from './teambuild.js';
import { validateTeam } from './teams.js';
import { DEFAULT_TIMER_SCALE } from './timer.js';
import type { TournamentEvent } from './tournament.js';
import type { Pid } from './types.js';

export const DRAFT_PROTOCOL_VERSION = 2;

export type DraftLeagueEvent = TournamentEvent | { type: 'draft'; draft: DraftView };

export interface DraftLeagueOptions extends ExperimentOptions {
  boardsDir?: string;
  board?: string;
  onEvent?: (event: DraftLeagueEvent) => void;
  throughWeek?: number;
  resume?: boolean;
}

interface SeriesPlanned {
  index: number;
  stage: 'roundrobin' | 'playoff';
  round: number;
  entrants: [number, number] | null;
  gameSeeds: Array<[number, number, number, number]>;
  engineSeeds: Record<Pid, number>;
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
  const random = seededRng(seed);
  const scaffold = scaffoldRevision();
  const draftScaffold = draftScaffoldRevision();
  const teambuildScaffold = teambuildScaffoldRevision();

  const stored = options.resume ? loadStoredLeague(runDir) : undefined;
  const entrants = stored ? stored.entrants : shuffle(models, random);
  const weeks = roundRobinWeeks(entrants.length);
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
  const history: string[][] = entrants.map(() => []);
  let phase: DraftView['phase'] = 'draft';
  let week = 0;
  let rosters: DraftBoardMon[][] = entrants.map(() => []);
  let budgets: number[] = entrants.map(() => board.budget);
  let teamNames: string[] = entrants.map(() => '');
  let picks: DraftView['picks'] = [];
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
  } else {
    const outcome = await runDraft(entrants, board, {
      psDir,
      logDir: path.join(runDir, 'draft'),
      rng: random,
      ...(options.reasoning === undefined ? {} : { reasoning: options.reasoning }),
      ...(options.reasoningByModel === undefined ? {} : { reasoningByModel: options.reasoningByModel }),
      ...(options.apiKeys === undefined ? {} : { apiKeys: options.apiKeys }),
      ...(options.recovery === undefined ? {} : { recovery: options.recovery }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      onPick: (view, state) => {
        picks = [...picks, view];
        rosters = state.rosters;
        budgets = state.budgets;
        teamNames = state.teamNames;
        options.onEvent?.({ type: 'draft', draft: draftView(false) });
      },
    });
    rosters = outcome.rosters;
    budgets = outcome.budgets;
    teamNames = outcome.teamNames;
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
    fs.writeFileSync(
      path.join(runDir, 'config.json'),
      `${JSON.stringify(
        {
          mode: 'draft',
          protocol_version: DRAFT_PROTOCOL_VERSION,
          scaffold,
          draft_scaffold: draftScaffold,
          teambuild_scaffold: teambuildScaffold,
          models,
          seed,
          concurrency: options.concurrency ?? 2,
          reasoning: options.reasoning ?? null,
          reasoning_by_model: options.reasoningByModel ?? null,
          timer_scale: timerScale,
          board: board.id,
          format: board.format,
          entrants,
          team_names: teamNames,
          weeks: weeks.length,
          rosters: rosters.map((roster) => roster.map((mon) => mon.id)),
          contributor: options.contributor ?? null,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  }

  phase = 'roundrobin';
  options.onEvent?.({ type: 'draft', draft: draftView(true) });

  const teambuildFor = async (plan: SeriesPlanned, entrant: number, opponent: number, signal: AbortSignal) => {
    const result = await runTeambuild(
      {
        seriesIndex: plan.index,
        entrant,
        opponent,
        model: entrants[entrant]!,
        opponentModel: entrants[opponent]!,
        teamName: teamNames[entrant]!,
        opponentTeamName: teamNames[opponent]!,
        roster: rosters[entrant]!,
        opponentRoster: rosters[opponent]!,
        history: history[entrant]!,
        format: board.format,
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
    const { winnerSide, fields } = await playRecordedSeries({
      players,
      teams: {
        p1: { id: `${teamNames[a] || entrants[a]} wk${plan.round}`, packed: home.packed },
        p2: { id: `${teamNames[b] || entrants[b]} wk${plan.round}`, packed: away.packed },
      },
      gameSeeds: plan.gameSeeds,
      engineSeeds: plan.engineSeeds,
      format: board.format,
      psDir,
      runDir,
      signal,
      ...(plan.stage === 'playoff' ? { requireWinner: true } : {}),
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
      series_index: plan.index,
      stage: plan.stage,
      round: plan.round,
      ...(plan.stage === 'playoff' ? { advanced: entrants[winnerSide === 'p1' ? a : b]! } : {}),
      board: board.id,
      ...(options.contributor === undefined ? {} : { contributor: options.contributor }),
      run_seed: seed,
      ps_commit: showdownCommit(psDir),
      ...fields,
    } as SeriesRecord;
    appendRow(recordsPath, row);
    applyOutcome(plan, row);
    options.onEvent?.({ type: 'series-end', index: plan.index, record: row });
    return row;
  };

  const applyOutcome = (plan: SeriesPlanned, row: SeriesRecord): void => {
    const [a, b] = plan.entrants!;
    const winnerSide = (row.winner_side ?? undefined) as Pid | undefined;
    const score = row.score as Record<Pid, number>;
    for (const [entrant, opponent, side] of [
      [a, b, 'p1'],
      [b, a, 'p2'],
    ] as const) {
      const won = winnerSide === side;
      const result = winnerSide ? (won ? 'beat' : 'lost to') : 'drew with';
      history[entrant]!.push(
        `${plan.stage === 'playoff' ? 'Playoffs' : `Week ${plan.round}`}: ${result} ` +
          `${teamNames[opponent] || entrants[opponent]} ${score[side]}-${score[side === 'p1' ? 'p2' : 'p1']}`,
      );
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
  for (const index of weeks.keys()) {
    if (options.signal?.aborted) return sorted(results);
    week = index + 1;
    options.onEvent?.({ type: 'draft', draft: draftView(true) });
    const scheduled = plans.filter(
      (plan) => plan.stage === 'roundrobin' && plan.round === week && !completed.has(plan.index),
    );
    results.push(
      ...(await mapLimit(scheduled, options.concurrency ?? 2, options.signal, (plan, signal) =>
        playSeries(plan, signal),
      )),
    );
    if (stopWeek !== undefined && week >= stopWeek) {
      options.onEvent?.({ type: 'draft', draft: draftView(true) });
      return sorted(results);
    }
  }
  if (options.signal?.aborted) return sorted(results);

  seeding = rankedTable(table).map((row) => row.entrant);
  phase = 'playoffs';
  week = 0;
  options.onEvent?.({ type: 'draft', draft: draftView(true) });

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
    if (options.signal?.aborted) return sorted(results);
  }
  const finalPlan = playoffs[playoffs.length - 1]!;
  const finalRound = playoffRounds - 1;
  finalPlan.entrants = bracket.rounds[finalRound]![0]!.slots as [number, number];
  if (finalPlan.entrants[0] === null || finalPlan.entrants[1] === null) return sorted(results);
  const storedFinal = completed.get(finalPlan.index);
  const finalRow = storedFinal
    ? [storedFinal]
    : await mapLimit([finalPlan], 1, options.signal, (plan, signal) => playSeries(plan, signal));
  if (finalRow[0]) {
    if (storedFinal) applyOutcome(finalPlan, storedFinal);
    resolve(0, finalRound, finalRow[0].winner_side as Pid);
    results.push(finalRow[0]);
    phase = 'done';
    options.onEvent?.({ type: 'draft', draft: draftView(true) });
  }
  return sorted(results);
}

function sorted(rows: SeriesRecord[]): SeriesRecord[] {
  return [...rows].sort((a, b) => (a.series_index as number) - (b.series_index as number));
}

interface StoredLeague {
  entrants: string[];
  teamNames: string[];
  rosterIds: string[][];
}

function loadStoredLeague(runDir: string): StoredLeague {
  const configPath = path.join(runDir, 'config.json');
  if (!fs.existsSync(configPath)) throw new Error(`${runDir} holds no draft league config to resume`);
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
    mode?: string;
    entrants?: string[];
    team_names?: string[];
    rosters?: string[][];
  };
  if (config.mode !== 'draft' || !config.entrants || !config.team_names || !config.rosters) {
    throw new Error(`${runDir} is not a completed-draft league run`);
  }
  return { entrants: config.entrants, teamNames: config.team_names, rosterIds: config.rosters };
}

function rankedTable(table: DraftTableRow[]): DraftTableRow[] {
  return [...table].sort((a, b) => b.w - a.w || b.gw - b.gl - (a.gw - a.gl) || b.gw - a.gw || a.entrant - b.entrant);
}
