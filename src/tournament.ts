import fs from 'node:fs';
import path from 'node:path';
import { scaffoldRevision } from './engines.js';
import type { BracketView } from './gui/api.js';
import { defaultPsDir, RESULTS_PATH } from './paths.js';
import type { ModelReasoningConfig } from './providers.js';
import { validateModelExecution } from './providers.js';
import { resolveSeed, seededRng, seriesEntropy, shuffle } from './random.js';
import type { SeriesRecord } from './records.js';
import { appendRow } from './records.js';
import type { RecoveryGate } from './recovery.js';
import type { RotationEvent } from './rotation.js';
import { playRecordedSeries } from './series.js';
import { showdownCommit } from './showdown.js';
import type { Team } from './teams.js';
import { loadPool, validatePool, validateTeam } from './teams.js';
import { DEFAULT_TIMER_SCALE } from './timer.js';
import type { ContributorAttribution, Pid, TimerScale } from './types.js';

export const TOURNAMENT_PROTOCOL_VERSION = 1;

export type TournamentEvent =
  | RotationEvent
  | { type: 'bracket'; bracket: BracketView }
  | { type: 'series-players'; index: number; players: Record<Pid, string> };

export interface TournamentOptions extends ModelReasoningConfig {
  seed?: number;
  concurrency?: number;
  timerScale?: TimerScale;
  recordsPath?: string;
  psDir?: string;
  apiKeys?: Readonly<Record<string, string>>;
  pool?: string;
  teams?: Team[];
  format?: string;
  onEvent?: (event: TournamentEvent) => void;
  onNotice?: (message: string) => void;
  signal?: AbortSignal;
  contributor?: ContributorAttribution;
  recovery?: RecoveryGate;
}

interface Entrant {
  model: string;
  team: Team;
}

export interface BracketMatch {
  round: number;
  seriesIndex: number | null;
  slots: [number | null, number | null];
  winner: number | null;
}

/**
 * Classic single-elimination seed order: seed 0 meets the highest seed, so byes
 * (seeds beyond the entrant count) spread across distinct first-round matches.
 */
export function seedPositions(size: number): number[] {
  let order = [0];
  while (order.length < size) {
    const doubled = order.length * 2;
    order = order.flatMap((position) => [position, doubled - 1 - position]);
  }
  return order;
}

export function buildBracket(count: number): BracketMatch[][] {
  let size = 1;
  while (size < count) size *= 2;
  const order = seedPositions(size);
  let series = 0;
  const first: BracketMatch[] = [];
  for (let position = 0; position < size; position += 2) {
    const a = order[position]! < count ? order[position]! : null;
    const b = order[position + 1]! < count ? order[position + 1]! : null;
    const played = a !== null && b !== null;
    first.push({ round: 0, seriesIndex: played ? series++ : null, slots: [a, b], winner: played ? null : (a ?? b) });
  }
  const rounds = [first];
  for (let width = size / 4; width >= 1; width /= 2) {
    rounds.push(
      Array.from({ length: width }, () => ({
        round: rounds.length,
        seriesIndex: series++,
        slots: [null, null] as [number | null, number | null],
        winner: null,
      })),
    );
  }
  return rounds;
}

export async function runTournament(
  models: string[],
  runDir: string,
  options: TournamentOptions = {},
): Promise<SeriesRecord[]> {
  if (models.length < 2) throw new Error('a tournament needs at least two models');
  validateModelExecution(models, options);

  fs.mkdirSync(runDir, { recursive: true });
  const recordsPath = options.recordsPath ?? RESULTS_PATH;
  const psDir = options.psDir ?? defaultPsDir();
  const seed = resolveSeed(options.seed);
  const timerScale = options.timerScale ?? DEFAULT_TIMER_SCALE;
  const random = seededRng(seed);
  const scaffold = scaffoldRevision();

  let format: string;
  let poolId: string | null;
  let assignedTeams: Team[];
  if (options.teams) {
    if (options.teams.length !== models.length) throw new Error('inline tournaments need one team per model');
    if (!options.format) throw new Error('inline teams need an explicit format');
    format = options.format;
    for (const team of options.teams) {
      try {
        validateTeam(team.packed, format, psDir);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`invalid team ${JSON.stringify(team.id)}: ${detail}`);
      }
    }
    poolId = null;
    assignedTeams = options.teams;
    fs.writeFileSync(path.join(runDir, 'teams.json'), `${JSON.stringify(options.teams, null, 2)}\n`, 'utf8');
  } else {
    const pool = loadPool(options.pool ?? 'test');
    validatePool(pool, psDir);
    if (pool.teams.length < models.length) {
      throw new Error(`pool ${JSON.stringify(pool.id)} has ${pool.teams.length} teams for ${models.length} entrants`);
    }
    format = pool.format;
    poolId = pool.id;
    assignedTeams = shuffle(pool.teams, random).slice(0, models.length);
  }

  const placement = shuffle(
    models.map((_, index) => index),
    random,
  );
  const entrants: Entrant[] = placement.map((index) => ({ model: models[index]!, team: assignedTeams[index]! }));
  const rounds = buildBracket(entrants.length);
  const matches = rounds.flat();
  const seriesCount = entrants.length - 1;
  const seriesSeeds = Array.from({ length: seriesCount }, () => seriesEntropy(random));

  const bracketView = (): BracketView => ({
    entrants: entrants.map((entrant) => ({ model: entrant.model, team: entrant.team.id })),
    rounds: rounds.map((round) =>
      round.map((match) => ({ seriesIndex: match.seriesIndex, slots: [...match.slots], winner: match.winner })),
    ),
    champion: rounds[rounds.length - 1]![0]!.winner,
  });

  fs.writeFileSync(
    path.join(runDir, 'config.json'),
    `${JSON.stringify(
      {
        mode: 'tournament',
        protocol_version: TOURNAMENT_PROTOCOL_VERSION,
        scaffold,
        models,
        seed,
        concurrency: options.concurrency ?? 2,
        reasoning: options.reasoning ?? null,
        pool: poolId,
        reasoning_by_model: options.reasoningByModel ?? null,
        timer_scale: timerScale,
        format,
        entrants: entrants.map((entrant) => ({ model: entrant.model, team: entrant.team.id })),
        contributor: options.contributor ?? null,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const playersFor = (match: BracketMatch): Record<Pid, string> => ({
    p1: match.slots[0] === null ? 'TBD' : entrants[match.slots[0]]!.model,
    p2: match.slots[1] === null ? 'TBD' : entrants[match.slots[1]]!.model,
  });
  options.onEvent?.({
    type: 'plans',
    mode: 'tournament',
    protocolVersion: TOURNAMENT_PROTOCOL_VERSION,
    plans: matches
      .filter((match) => match.seriesIndex !== null)
      .sort((a, b) => a.seriesIndex! - b.seriesIndex!)
      .map((match) => ({ index: match.seriesIndex!, players: playersFor(match) })),
    pool: poolId ?? '',
    seed,
  });

  const propagate = (match: BracketMatch): void => {
    const roundMatches = rounds[match.round]!;
    const position = roundMatches.indexOf(match);
    const next = rounds[match.round + 1]?.[position >> 1];
    if (next && match.winner !== null) next.slots[position % 2] = match.winner;
  };
  for (const match of rounds[0]!) if (match.seriesIndex === null) propagate(match);
  options.onEvent?.({ type: 'bracket', bracket: bracketView() });

  const results: SeriesRecord[] = [];
  const started = new Set<BracketMatch>();
  const active = new Set<Promise<void>>();
  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener('abort', forwardAbort, { once: true });
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 2, seriesCount));
  let failure: { error: unknown } | undefined;

  const runMatch = async (match: BracketMatch): Promise<void> => {
    try {
      const row = await playMatch(match, entrants, {
        runDir,
        format,
        poolId,
        runSeed: seed,
        scaffold,
        psDir,
        signal: controller.signal,
        seriesSeeds: seriesSeeds[match.seriesIndex!]!,
        ...(options.reasoning === undefined ? {} : { reasoning: options.reasoning }),
        ...(options.apiKeys === undefined ? {} : { apiKeys: options.apiKeys }),
        ...(options.recovery === undefined ? {} : { recovery: options.recovery }),
        ...(options.reasoningByModel === undefined ? {} : { reasoningByModel: options.reasoningByModel }),
        timerScale,
        ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
        ...(options.contributor === undefined ? {} : { contributor: options.contributor }),
      });
      appendRow(recordsPath, row);
      results.push(row);
      propagate(match);
      options.onEvent?.({ type: 'series-end', index: match.seriesIndex!, record: row });
      options.onEvent?.({ type: 'bracket', bracket: bracketView() });
    } catch (error) {
      if (!controller.signal.aborted) {
        failure ??= { error };
        controller.abort();
      }
    }
  };

  const startReady = (): void => {
    while (active.size < concurrency && !controller.signal.aborted) {
      const match = matches.find(
        (candidate) =>
          candidate.seriesIndex !== null &&
          candidate.slots[0] !== null &&
          candidate.slots[1] !== null &&
          !started.has(candidate),
      );
      if (!match) break;
      started.add(match);
      const task = runMatch(match);
      active.add(task);
      void task.finally(() => {
        active.delete(task);
        startReady();
      });
    }
  };

  startReady();
  while (active.size) await Promise.race(active);
  options.signal?.removeEventListener('abort', forwardAbort);
  if (failure && !options.signal?.aborted) throw failure.error;
  results.sort((a, b) => a.series_index! - b.series_index!);
  return results;
}

async function playMatch(
  match: BracketMatch,
  entrants: Entrant[],
  context: {
    runDir: string;
    format: string;
    poolId: string | null;
    runSeed: number;
    scaffold: string;
    psDir: string;
    seriesSeeds: { gameSeeds: Array<[number, number, number, number]>; engineSeeds: Record<Pid, number> };
    apiKeys?: Readonly<Record<string, string>>;
    onEvent?: (event: TournamentEvent) => void;
    signal?: AbortSignal;
    contributor?: ContributorAttribution;
    timerScale: TimerScale;
    recovery?: RecoveryGate;
  } & ModelReasoningConfig,
): Promise<SeriesRecord> {
  context.signal?.throwIfAborted();
  const index = match.seriesIndex!;
  const sides: Record<Pid, Entrant> = { p1: entrants[match.slots[0]!]!, p2: entrants[match.slots[1]!]! };
  const players: Record<Pid, string> = { p1: sides.p1.model, p2: sides.p2.model };
  context.onEvent?.({ type: 'series-players', index, players });
  context.onEvent?.({ type: 'series-start', index });
  const { winnerSide, fields } = await playRecordedSeries({
    players,
    teams: { p1: sides.p1.team, p2: sides.p2.team },
    gameSeeds: context.seriesSeeds.gameSeeds,
    engineSeeds: context.seriesSeeds.engineSeeds,
    format: context.format,
    psDir: context.psDir,
    runDir: context.runDir,
    requireWinner: true,
    ...(context.reasoningByModel === undefined ? {} : { reasoningByModel: context.reasoningByModel }),
    ...(context.reasoning === undefined ? {} : { reasoning: context.reasoning }),
    timerScale: context.timerScale,
    ...(context.apiKeys === undefined ? {} : { apiKeys: context.apiKeys }),
    ...(context.recovery === undefined ? {} : { recovery: context.recovery }),
    ...(context.signal === undefined ? {} : { signal: context.signal }),
    onGameUpdate: (game, lines, publicLines) =>
      context.onEvent?.({ type: 'game-update', index, game, lines, publicLines }),
    onGameEnd: (game, winner, turns, score) =>
      context.onEvent?.({ type: 'game-end', index, game, winner, turns, score }),
    onDecision: (pid, row) => context.onEvent?.({ type: 'decision', index, pid, row }),
  });

  if (!winnerSide) throw new Error(`single-elimination series ${index + 1} ended without a winner`);
  match.winner = match.slots[winnerSide === 'p1' ? 0 : 1]!;

  return {
    schema_version: 1,
    mode: 'tournament',
    protocol_version: TOURNAMENT_PROTOCOL_VERSION,
    scaffold: context.scaffold,
    series_index: index,
    round: match.round + 1,
    ...(context.poolId === null ? {} : { pool: context.poolId }),
    ...(context.contributor === undefined ? {} : { contributor: context.contributor }),
    advanced: entrants[match.winner]!.model,
    run_seed: context.runSeed,
    ps_commit: showdownCommit(context.psDir),
    ...fields,
  } as SeriesRecord;
}
