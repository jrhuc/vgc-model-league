import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { AgentContextEvent, AgentContextKind } from './agent-context.js';
import type { DecisionLog, GameEnd, GameStart } from './battle-agent.js';
import { RandomEngine } from './battle-agent.js';
import { appendJsonlObject, readJsonlObjects } from './jsonl.js';
import { LLMEngine } from './llm-engine.js';
import { REPO_ROOT } from './paths.js';
import type { ModelReasoningConfig, ReasoningLevel } from './providers.js';
import { reasoningForModel } from './providers.js';
import { seededRng } from './random.js';
import type { RecoveryGate } from './recovery.js';
import { ShowdownReference } from './reference.js';
import { loadShowdown, showdownCommit } from './showdown.js';
import { SimBattle } from './sim.js';
import type { Team } from './teams.js';
import { DEFAULT_TIMER_SCALE } from './timer.js';
import type { BattleOutcome, ContributorAttribution, JsonObject, Pid, PlayerOptions, TimerScale } from './types.js';

export interface ExperimentOptions extends ModelReasoningConfig {
  seed?: number;
  concurrency?: number;
  timerScale?: TimerScale;
  recordsPath?: string;
  psDir?: string;
  apiKeys?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
  contributor?: ContributorAttribution;
  recovery?: RecoveryGate;
  closedSheets?: boolean;
}

export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  signal: AbortSignal | undefined,
  task: (item: T, signal: AbortSignal) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R | undefined>(items.length);
  const controller = new AbortController();
  const forward = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', forward, { once: true });
  let failure: { error: unknown } | undefined;
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length && !controller.signal.aborted) {
      const index = next++;
      try {
        results[index] = await task(items[index]!, controller.signal);
      } catch (error) {
        if (!controller.signal.aborted) {
          failure ??= { error };
          controller.abort();
        }
        return;
      }
    }
  });
  await Promise.all(workers);
  signal?.removeEventListener('abort', forward);
  if (failure && !signal?.aborted) throw failure.error;
  return results.filter((result): result is R => result !== undefined);
}

export interface EngineSetup {
  pid: Pid;
  spec: string;
  seed: number;
  decisionLog: DecisionLog;
  traceLog: DecisionLog;
  contextLog?: DecisionLog;
  initialContext?: readonly AgentContextEvent[];
  format: string;
  psDir: string;
  reasoning?: ReasoningLevel | undefined;
  reference?: ShowdownReference | undefined;
  signal?: AbortSignal | undefined;
  apiKey?: string | undefined;
  recovery?: RecoveryGate | undefined;
  initialNotebook?: string | undefined;
  draftRoster?: string | undefined;
  briefing?: string | undefined;
}

export function makeEngine(setup: EngineSetup): RandomEngine | LLMEngine {
  const { pid, spec, seed, ...rest } = setup;
  if (spec === 'random') return new RandomEngine(pid, seed, setup.decisionLog);
  return new LLMEngine(pid, spec, {
    ...Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined)),
    decisionLog: setup.decisionLog,
    traceLog: setup.traceLog,
    format: setup.format,
    psDir: setup.psDir,
  });
}

export interface ChanceEventCounts extends JsonObject {
  misses: number;
  crits_taken: number;
  flinched_turns: number;
  full_paralysis: number;
}

export const SERIES_GAME_COMPLETION_SCHEMA_VERSION = 1 as const;

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const gameSeedSchema = z.tuple([
  z.number().int().nonnegative().max(0xffff),
  z.number().int().nonnegative().max(0xffff),
  z.number().int().nonnegative().max(0xffff),
  z.number().int().nonnegative().max(0xffff),
]);
const sideCountSchema = z.strictObject({
  p1: z.number().int().nonnegative(),
  p2: z.number().int().nonnegative(),
});
const chanceEventCountsSchema = z.strictObject({
  misses: z.number().int().nonnegative(),
  crits_taken: z.number().int().nonnegative(),
  flinched_turns: z.number().int().nonnegative(),
  full_paralysis: z.number().int().nonnegative(),
});
const sideChanceEventsSchema = z.strictObject({ p1: chanceEventCountsSchema, p2: chanceEventCountsSchema });
const seriesGameSummarySchema = z.strictObject({
  winner: z.string().min(1).nullable(),
  winner_side: z.enum(['p1', 'p2']).nullable(),
  turns: z.number().int().nonnegative(),
  errors: sideCountSchema,
  model_choice_fallbacks: sideCountSchema,
  simulator_substitutions: sideCountSchema,
  timer_autodefaults: sideCountSchema,
  chance_events: sideChanceEventsSchema,
  log: z.string().min(1),
});
const seriesGameResultSchema = z.strictObject({
  number: z.number().int().positive(),
  seed: gameSeedSchema,
  ...seriesGameSummarySchema.shape,
});
const gameCompletionMarkerSchema = z.strictObject({
  kind: z.literal('game_complete'),
  schema_version: z.literal(SERIES_GAME_COMPLETION_SCHEMA_VERSION),
  series_id: z.string().min(1),
  game_number: z.number().int().positive(),
  attempt_id: z.string().min(1),
  seed: gameSeedSchema,
  log_sha256: sha256Schema,
  summary: seriesGameSummarySchema,
});

export type SeriesGameResult = z.infer<typeof seriesGameResultSchema>;
type GameCompletionMarker = z.infer<typeof gameCompletionMarkerSchema>;

export function chanceEventCounts(log: string[]): Record<Pid, ChanceEventCounts> {
  const counts: Record<Pid, ChanceEventCounts> = {
    p1: { misses: 0, crits_taken: 0, flinched_turns: 0, full_paralysis: 0 },
    p2: { misses: 0, crits_taken: 0, flinched_turns: 0, full_paralysis: 0 },
  };
  for (const line of log) {
    if (!line.startsWith('|')) continue;
    const [, kind = '', ...args] = line.split('|');
    const pid = args[0]?.startsWith('p1') ? 'p1' : args[0]?.startsWith('p2') ? 'p2' : undefined;
    if (!pid) continue;
    if (kind === '-miss') counts[pid].misses += 1;
    else if (kind === '-crit') counts[pid].crits_taken += 1;
    else if (kind === 'cant' && args[1] === 'flinch') counts[pid].flinched_turns += 1;
    else if (kind === 'cant' && args[1] === 'par') counts[pid].full_paralysis += 1;
  }
  return counts;
}

export interface Bo3Context {
  engines: Record<Pid, RandomEngine | LLMEngine>;
  /** Showdown player names; game winners come back as these. */
  names: Record<Pid, string>;
  /** Recorded participant labels (model specs or seat names). */
  players: Record<Pid, string>;
  teams: Record<Pid, Team>;
  gameSeeds: Array<[number, number, number, number]>;
  seriesId: string;
  seriesDir: string;
  format: string;
  psDir: string;
  timerScale?: TimerScale;
  attemptId?: string;
  signal?: AbortSignal;
  onGameStart?: (game: number) => void;
  onGameUpdate?: (game: number, lines: string[], publicLines: string[]) => void;
  onGameEnd?: (game: number, winner: string | null, turns: number, score: Record<Pid, number>) => void;
  requireWinner?: boolean;
  recovery?: RecoveryGate;
  completedGames?: JsonObject[];
  runBattle?: (
    seed: [number, number, number, number],
    onUpdate: (lines: string[], publicLines: string[]) => void,
  ) => Promise<BattleOutcome>;
}

export interface Bo3Result {
  score: Record<Pid, number>;
  games: JsonObject[];
  winnerSide: Pid | undefined;
}

export const SINGLE_ELIMINATION_GAME_LIMIT = 9;

export type GameSeed = [number, number, number, number];

export function seriesSeedSchedule(regulationSeeds: readonly GameSeed[], requireWinner = false): GameSeed[] {
  if (requireWinner && regulationSeeds.length !== 3) {
    throw new Error('single-elimination series requires exactly three regulation game seeds');
  }
  const seeds = regulationSeeds.map((seed) => [...seed] as GameSeed);
  if (!requireWinner) return seeds;
  const random = seededRng(JSON.stringify(regulationSeeds));
  while (seeds.length < SINGLE_ELIMINATION_GAME_LIMIT) {
    seeds.push(Array.from({ length: 4 }, () => 1 + Math.floor(random() * 0xffff)) as GameSeed);
  }
  return seeds;
}

export interface SeriesFold {
  score: Record<Pid, number>;
  winnerSide: Pid | undefined;
  complete: boolean;
  nextSeed: GameSeed | undefined;
}

/** Pure authority for a series prefix: it expands deterministic playoff seeds, validates every game,
 * rejects suffixes after a terminal result, and folds the score used by live play and resume. */
export function foldSeriesGames(
  regulationSeeds: readonly GameSeed[],
  games: readonly unknown[],
  options: {
    requireWinner?: boolean | undefined;
    players?: Record<Pid, string> | undefined;
    label?: string | undefined;
  } = {},
): SeriesFold {
  const label = options.label ?? 'series';
  const requireWinner = options.requireWinner === true;
  let seeds: GameSeed[];
  try {
    seeds = seriesSeedSchedule(regulationSeeds, requireWinner);
  } catch (cause) {
    throw new Error(`${label} ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  const score: Record<Pid, number> = { p1: 0, p2: 0 };
  const isComplete = (count: number): boolean => {
    if (Math.max(score.p1, score.p2) >= 2) return true;
    if (count < regulationSeeds.length) return false;
    return !requireWinner || score.p1 !== score.p2;
  };
  for (const [index, value] of games.entries()) {
    if (isComplete(index)) throw new Error(`${label} records game ${index + 1} after the series was clinched`);
    if (index >= SINGLE_ELIMINATION_GAME_LIMIT || index >= seeds.length) {
      throw new Error(`${label} exceeds the ${SINGLE_ELIMINATION_GAME_LIMIT}-game playoff limit`);
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`${label} game ${index + 1} is not a result object`);
    }
    const game = value as Record<string, unknown>;
    if (game.number !== index + 1) throw new Error(`${label} game indexes are not consecutive from one`);
    if (!isDeepStrictEqual(game.seed, seeds[index])) {
      throw new Error(`${label} game ${index + 1} is not bound to its exact scheduled seed`);
    }
    const side = game.winner_side;
    if (side !== null && side !== 'p1' && side !== 'p2') {
      throw new Error(`${label} game ${index + 1} has an invalid winner side`);
    }
    if (options.players && game.winner !== (side === null ? null : options.players[side])) {
      throw new Error(`${label} game ${index + 1} winner does not match its scheduled side`);
    }
    if (side !== null) score[side] += 1;
  }
  const complete = games.length > 0 && isComplete(games.length);
  const winnerSide = score.p1 === score.p2 ? undefined : score.p1 > score.p2 ? 'p1' : 'p2';
  return {
    score,
    winnerSide,
    complete,
    nextSeed: complete || games.length >= SINGLE_ELIMINATION_GAME_LIMIT ? undefined : seeds[games.length],
  };
}

export async function playBo3(context: Bo3Context): Promise<Bo3Result> {
  const { engines, names, seriesId } = context;
  const submissionNamespace = context.attemptId ?? randomUUID();
  const games: JsonObject[] = [...(context.completedGames ?? [])];
  let folded = foldSeriesGames(context.gameSeeds, games, {
    requireWinner: context.requireWinner,
    players: context.players,
  });

  while (!folded.complete) {
    const gameSeed = folded.nextSeed;
    if (!gameSeed) {
      throw new Error(`single-elimination series remained tied after ${SINGLE_ELIMINATION_GAME_LIMIT} games`);
    }
    const score = folded.score;
    const index = games.length;
    context.signal?.throwIfAborted();
    const gameNumber = index + 1;
    const gameId = `${seriesId}-${gameNumber}`;
    fs.rmSync(gameCompletionMarkerPath(context.seriesDir, gameNumber), { force: true });
    const start: GameStart = { gameId, gameNumber, seriesId, seriesScore: { ...score } };
    const modelFallbacksAtStart = Object.fromEntries(
      (['p1', 'p2'] as const).map((pid) => [pid, engines[pid].decisionStats().fallbacks ?? 0]),
    ) as Record<Pid, number>;
    for (const engine of Object.values(engines)) engine.beginGame(start);
    context.onGameStart?.(gameNumber);
    const players: Record<Pid, PlayerOptions> = {
      p1: { name: names.p1, team: context.teams.p1.packed },
      p2: { name: names.p2, team: context.teams.p2.packed },
    };
    /** The log streams to disk during play so a live game is watchable from another process; the
     * canonical rewrite at game end makes the file authoritative, and resume already trusts only
     * logs that carry a win or tie line. */
    const logPath = path.join(context.seriesDir, `game-${gameNumber}.log`);
    fs.writeFileSync(logPath, '', 'utf8');
    const onUpdate = (lines: string[], publicLines: string[]) => {
      if (lines.length) fs.appendFileSync(logPath, `${lines.join('\n')}\n`, 'utf8');
      context.onGameUpdate?.(gameNumber, lines, publicLines);
    };
    const outcome = context.runBattle
      ? await context.runBattle(gameSeed, onUpdate)
      : await new SimBattle(
          context.format,
          players,
          gameSeed,
          context.psDir,
          context.timerScale ?? DEFAULT_TIMER_SCALE,
          undefined,
          `${submissionNamespace}:${gameNumber}`,
        ).run(engines, onUpdate, context.signal, context.recovery);
    context.signal?.throwIfAborted();
    const winnerSide = (['p1', 'p2'] as const).find((pid) => names[pid] === outcome.winner);
    if (winnerSide) score[winnerSide] += 1;
    const modelChoiceFallbacks = Object.fromEntries(
      (['p1', 'p2'] as const).map((pid) => [
        pid,
        (engines[pid].decisionStats().fallbacks ?? 0) - modelFallbacksAtStart[pid],
      ]),
    ) as Record<Pid, number>;
    await Promise.all(
      (['p1', 'p2'] as const).map(async (pid) => {
        const end: GameEnd = {
          outcome: {
            winner: outcome.winner,
            winner_side: winnerSide ?? null,
            won: winnerSide === pid,
            turns: outcome.turns,
            pov_lines: outcome.pov[pid],
            errors: outcome.errors[pid],
            model_choice_fallbacks: modelChoiceFallbacks[pid],
            simulator_substitutions: outcome.simulatorSubstitutions[pid],
            timer_autodefaults: outcome.timerAutodefaults[pid],
          },
          gameNumber,
          seriesScore: { ...score },
        };
        await engines[pid].endGame(end);
      }),
    );
    const canonicalLog = Buffer.from(`${outcome.log.join('\n')}\n`, 'utf8');
    fs.writeFileSync(logPath, canonicalLog);
    const completed = completedGameEvidence({
      seriesId,
      attemptId: submissionNamespace,
      gameNumber,
      seed: gameSeed,
      players: context.players,
      winnerSide,
      outcome,
      modelChoiceFallbacks,
      log: relative(logPath),
      logBytes: canonicalLog,
    });
    writeGameCompletionMarker(context.seriesDir, completed.marker);
    games.push(completed.result);
    context.onGameEnd?.(gameNumber, winnerSide ? context.players[winnerSide] : null, outcome.turns, { ...score });
    folded = foldSeriesGames(context.gameSeeds, games, {
      requireWinner: context.requireWinner,
      players: context.players,
    });
  }

  return { score: folded.score, games, winnerSide: folded.winnerSide };
}

export interface RecordedSeriesContext extends ModelReasoningConfig {
  players: Record<Pid, string>;
  teams: Record<Pid, Team>;
  gameSeeds: Array<[number, number, number, number]>;
  /** League schedule slot; lets a resumed run adopt the prior attempt's series directory and replay
   * only the games that never finished. */
  seriesIndex?: number;
  initialNotebooks?: Partial<Record<Pid, string>>;
  draftRosters?: Partial<Record<Pid, string>>;
  briefings?: Partial<Record<Pid, string>>;
  engineSeeds: Record<Pid, number>;
  format: string;
  psDir: string;
  runDir: string;
  apiKeys?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
  onGameUpdate?: (game: number, lines: string[], publicLines: string[]) => void;
  onGameEnd?: (game: number, winner: string | null, turns: number, score: Record<Pid, number>) => void;
  onDecision?: (pid: Pid, row: JsonObject) => void;
  requireWinner?: boolean;
  timerScale?: TimerScale;
  recovery?: RecoveryGate;
  closedSheets?: boolean;
}

interface RecordedSeriesFields extends JsonObject {
  timestamp: string;
  run_id: string;
  series_id: string;
  attempt_id: string;
  format: string;
  players: Record<Pid, string>;
  teams: Record<Pid, string>;
  packed_team_digests: Record<Pid, string>;
  winner: string | null;
  winner_side: Pid | null;
  score: Record<Pid, number>;
  turns: number;
  games: JsonObject[];
  engine_seeds: Record<Pid, number>;
  timer_scale: TimerScale;
  closed_sheets?: true;
  reasoning: ReasoningLevel | null;
  reasoning_by_player?: Record<Pid, ReasoningLevel | null>;
  decision_stats: JsonObject;
}

type CompletedSeriesFields = Pick<
  RecordedSeriesFields,
  | 'series_id'
  | 'attempt_id'
  | 'format'
  | 'players'
  | 'teams'
  | 'packed_team_digests'
  | 'winner'
  | 'winner_side'
  | 'score'
  | 'turns'
  | 'games'
  | 'engine_seeds'
  | 'timer_scale'
  | 'closed_sheets'
  | 'reasoning'
  | 'reasoning_by_player'
>;

export interface RecordedSeries {
  coachNotes: Record<Pid, string>;
  winnerSide: Pid | undefined;
  fields: RecordedSeriesFields;
}

interface AdoptedSeries {
  seriesId: string;
  seriesDir: string;
  started: string | undefined;
  games: JsonObject[];
  folded: SeriesFold;
  attemptRows: SeriesAttemptRow[];
  decisions: Record<Pid, JsonObject[]>;
  notebooks: Partial<Record<Pid, string>>;
  replay: Record<Pid, JsonObject[]>;
  resumeFrom: string | undefined;
}

function optionalTextDigests(values: Partial<Record<Pid, string>> | undefined): Record<Pid, string | null> {
  const digest = (value: string | undefined): string | null =>
    value === undefined ? null : createHash('sha256').update(value).digest('hex');
  return { p1: digest(values?.p1), p2: digest(values?.p2) };
}

export const RECORDED_SERIES_METADATA_SCHEMA_VERSION = 3 as const;

const pidTextSchema = z.strictObject({ p1: z.string().min(1), p2: z.string().min(1) });
const pidPackedTeamSchema = z.strictObject({ p1: z.string(), p2: z.string() });
const pidDigestSchema = z.strictObject({ p1: sha256Schema, p2: sha256Schema });
const pidOptionalDigestSchema = z.strictObject({
  p1: sha256Schema.nullable(),
  p2: sha256Schema.nullable(),
});
const reasoningLevelSchema = z.enum(['minimal', 'low', 'medium', 'high', 'xhigh']);
const recordedSeriesIdentitySchema = z.strictObject({
  players: pidTextSchema,
  team_ids: pidTextSchema,
  packed_teams: pidPackedTeamSchema,
  packed_team_digests: pidDigestSchema,
  format: z.string().min(1),
  game_seeds: z.array(gameSeedSchema).min(1),
  series_index: z.number().int().nonnegative().nullable(),
  engine_seeds: z.strictObject({ p1: z.number().int(), p2: z.number().int() }),
  showdown_commit: z.union([z.string().regex(/^[0-9a-f]{40}$/u), z.literal('unknown')]),
  scaffold: z.strictObject({
    timer_scale: z.union([z.literal('off'), z.number().positive()]),
    require_winner: z.boolean(),
    closed_sheets: z.boolean(),
    reasoning: reasoningLevelSchema.nullable(),
    reasoning_by_model: z.record(z.string(), reasoningLevelSchema).nullable(),
    initial_notebook_digests: pidOptionalDigestSchema,
    draft_roster_digests: pidOptionalDigestSchema,
    briefing_digests: pidOptionalDigestSchema,
  }),
});
const recordedSeriesMetadataSchema = z.strictObject({
  schema_version: z.literal(RECORDED_SERIES_METADATA_SCHEMA_VERSION),
  series_id: z.string().min(1),
  started: z.string().min(1),
  identity: recordedSeriesIdentitySchema,
});

type RecordedSeriesIdentity = z.infer<typeof recordedSeriesIdentitySchema>;
type RecordedSeriesMetadata = z.infer<typeof recordedSeriesMetadataSchema>;

function recordedSeriesIdentity(context: RecordedSeriesContext): RecordedSeriesIdentity {
  const packedTeams = { p1: context.teams.p1.packed, p2: context.teams.p2.packed };
  return recordedSeriesIdentitySchema.parse({
    players: context.players,
    team_ids: { p1: context.teams.p1.id, p2: context.teams.p2.id },
    packed_teams: packedTeams,
    packed_team_digests: {
      p1: createHash('sha256').update(packedTeams.p1).digest('hex'),
      p2: createHash('sha256').update(packedTeams.p2).digest('hex'),
    },
    format: context.format,
    game_seeds: context.gameSeeds,
    series_index: context.seriesIndex ?? null,
    engine_seeds: context.engineSeeds,
    showdown_commit: showdownCommit(context.psDir),
    scaffold: {
      timer_scale: context.timerScale ?? DEFAULT_TIMER_SCALE,
      require_winner: context.requireWinner ?? false,
      closed_sheets: context.closedSheets ?? false,
      reasoning: context.reasoning ?? null,
      reasoning_by_model: context.reasoningByModel ?? null,
      initial_notebook_digests: optionalTextDigests(context.initialNotebooks),
      draft_roster_digests: optionalTextDigests(context.draftRosters),
      briefing_digests: optionalTextDigests(context.briefings),
    },
  });
}

function storedSeriesIndex(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const identity = (value as Record<string, unknown>).identity;
  return identity && typeof identity === 'object' && !Array.isArray(identity)
    ? (identity as Record<string, unknown>).series_index
    : undefined;
}

function adoptSeriesDir(
  context: RecordedSeriesContext,
  expectedIdentity: RecordedSeriesIdentity,
): AdoptedSeries | undefined {
  const root = path.join(context.runDir, 'series');
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return undefined;
  }
  const candidates: AdoptedSeries[] = [];
  for (const seriesId of entries) {
    const seriesDir = path.join(root, seriesId);
    let value: unknown;
    try {
      value = JSON.parse(fs.readFileSync(path.join(seriesDir, 'series.json'), 'utf8')) as unknown;
    } catch {
      continue;
    }
    const parsed = recordedSeriesMetadataSchema.safeParse(value);
    if (!parsed.success) {
      if (storedSeriesIndex(value) === context.seriesIndex) {
        throw new Error(
          `recorded series metadata for schedule slot ${String(context.seriesIndex)} (${seriesId}) is not current: ${z.prettifyError(parsed.error)}`,
        );
      }
      continue;
    }
    const meta: RecordedSeriesMetadata = parsed.data;
    if (meta.identity.series_index !== context.seriesIndex) continue;
    if (meta.series_id !== seriesId) {
      throw new Error(`recorded series metadata identity does not match directory ${seriesId}`);
    }
    if (!isDeepStrictEqual(meta.identity, expectedIdentity)) {
      throw new Error(
        `recorded series identity mismatch for schedule slot ${String(context.seriesIndex)} (${seriesId})`,
      );
    }
    candidates.push(reconstructAdoptedSeries(context, meta.identity.players, seriesId, seriesDir, meta.started));
  }
  if (!candidates.length) return undefined;
  const completedGames = Math.max(...candidates.map((candidate) => candidate.games.length));
  const best = candidates.filter((candidate) => candidate.games.length === completedGames);
  if (best.length > 1) {
    const ids = best.map(({ seriesId }) => seriesId).sort();
    throw new Error(
      `ambiguous recorded series adoption for schedule slot ${String(context.seriesIndex)} (${ids.join(', ')})`,
    );
  }
  return best[0];
}

function gameCompletionMarkerPath(seriesDir: string, gameNumber: number): string {
  return path.join(seriesDir, `game-${gameNumber}.complete.json`);
}

function seriesGameResult(marker: GameCompletionMarker): SeriesGameResult {
  const result = seriesGameResultSchema.parse({
    number: marker.game_number,
    seed: marker.seed,
    ...marker.summary,
  });
  if ((result.winner_side === null) !== (result.winner === null)) {
    throw new Error(`game ${result.number} winner and winner side do not agree`);
  }
  return result;
}

function completedGameEvidence(input: {
  seriesId: string;
  attemptId: string;
  gameNumber: number;
  seed: GameSeed;
  players: Record<Pid, string>;
  winnerSide: Pid | undefined;
  outcome: BattleOutcome;
  modelChoiceFallbacks: Record<Pid, number>;
  log: string;
  logBytes: Buffer;
}): { marker: GameCompletionMarker; result: SeriesGameResult } {
  const marker = gameCompletionMarkerSchema.parse({
    kind: 'game_complete',
    schema_version: SERIES_GAME_COMPLETION_SCHEMA_VERSION,
    series_id: input.seriesId,
    game_number: input.gameNumber,
    attempt_id: input.attemptId,
    seed: input.seed,
    log_sha256: createHash('sha256').update(input.logBytes).digest('hex'),
    summary: {
      winner: input.winnerSide ? input.players[input.winnerSide] : null,
      winner_side: input.winnerSide ?? null,
      turns: input.outcome.turns,
      errors: input.outcome.errors,
      model_choice_fallbacks: input.modelChoiceFallbacks,
      simulator_substitutions: input.outcome.simulatorSubstitutions,
      timer_autodefaults: input.outcome.timerAutodefaults,
      chance_events: chanceEventCounts(input.outcome.log),
      log: input.log,
    },
  });
  return { marker, result: seriesGameResult(marker) };
}

function writeGameCompletionMarker(seriesDir: string, marker: GameCompletionMarker): void {
  const file = gameCompletionMarkerPath(seriesDir, marker.game_number);
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(gameCompletionMarkerSchema.parse(marker))}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function gameCompletionMarker(
  seriesDir: string,
  seriesId: string,
  gameNumber: number,
): GameCompletionMarker | undefined {
  const file = gameCompletionMarkerPath(seriesDir, gameNumber);
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch (cause) {
    throw new Error(`invalid game completion marker ${file}`, { cause });
  }
  const parsed = gameCompletionMarkerSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`invalid game completion marker ${file}: ${z.prettifyError(parsed.error)}`);
  }
  const marker = parsed.data;
  if (marker.series_id !== seriesId || marker.game_number !== gameNumber) {
    throw new Error(`game completion marker ${file} does not match its series and game identity`);
  }
  const logPath = path.join(seriesDir, `game-${gameNumber}.log`);
  if (marker.summary.log !== relative(logPath)) {
    throw new Error(`game completion marker ${file} does not bind its canonical log path`);
  }
  let logBytes: Buffer;
  try {
    logBytes = fs.readFileSync(logPath);
  } catch (cause) {
    throw new Error(`game completion marker ${file} has no canonical game log`, { cause });
  }
  const actualDigest = createHash('sha256').update(logBytes).digest('hex');
  if (actualDigest !== marker.log_sha256) {
    throw new Error(`canonical game log digest does not match completion marker ${file}`);
  }
  seriesGameResult(marker);
  return marker;
}

/** A completed game is owned by the attempt named in its marker. Interrupted games use only
 * terminal submissions from the latest attempt lineage, so a restart branch cannot inherit a
 * sibling's choices. */
function reconstructAdoptedSeries(
  context: RecordedSeriesContext,
  storedPlayers: Record<Pid, string>,
  seriesId: string,
  seriesDir: string,
  started: string | undefined,
): AdoptedSeries {
  const attemptRows = attemptLedgerRows(attemptLedgerPath(seriesDir));
  const markerNumbers = fs
    .readdirSync(seriesDir)
    .flatMap((entry) => {
      if (!entry.startsWith('game-') || !entry.endsWith('.complete.json')) return [];
      const match = /^game-([1-9]\d*)\.complete\.json$/u.exec(entry);
      if (!match) throw new Error(`recorded series ${seriesId} has an invalid completion marker filename ${entry}`);
      return [Number(match[1])];
    })
    .sort((left, right) => left - right);
  const completedLineages = new Map<number, Set<string>>();
  const games: JsonObject[] = [];
  let folded = foldSeriesGames(context.gameSeeds, games, {
    requireWinner: context.requireWinner,
    players: storedPlayers,
    label: `recorded series ${seriesId}`,
  });
  for (let number = 1; ; number += 1) {
    const marker = gameCompletionMarker(seriesDir, seriesId, number);
    if (folded.complete) {
      if (marker) throw new Error(`recorded series ${seriesId} records game ${number} after the series was clinched`);
      break;
    }
    const gameSeed = folded.nextSeed;
    if (!gameSeed || !marker) break;
    const markerStart = attemptRows.find(
      (row) => row.kind === 'attempt_started' && row.attempt_id === marker.attempt_id,
    );
    const lineage = resolveAttemptLineage(attemptRows, marker.attempt_id);
    if (markerStart?.series_id !== seriesId || !lineage) {
      throw new Error(`game completion marker for recorded series ${seriesId} has no valid attempt lineage`);
    }
    if (!isDeepStrictEqual(marker.seed, gameSeed)) {
      throw new Error(`game completion marker for recorded series ${seriesId} game ${number} has the wrong seed`);
    }
    completedLineages.set(number, new Set(lineage));
    games.push(seriesGameResult(marker));
    folded = foldSeriesGames(context.gameSeeds, games, {
      requireWinner: context.requireWinner,
      players: storedPlayers,
      label: `recorded series ${seriesId}`,
    });
  }
  if (
    !isDeepStrictEqual(
      markerNumbers,
      games.map((_, index) => index + 1),
    )
  ) {
    throw new Error(`recorded series ${seriesId} completion markers are not its exact consecutive game prefix`);
  }

  const currentAttemptId = attemptRows.findLast(
    (row) => row.kind === 'attempt_started' && row.series_id === seriesId,
  )?.attempt_id;
  const currentLineage =
    typeof currentAttemptId === 'string' ? resolveAttemptLineage(attemptRows, currentAttemptId) : undefined;
  const currentAttempts = new Set(currentLineage ?? []);
  const decisions: Record<Pid, JsonObject[]> = { p1: [], p2: [] };
  const replay: Record<Pid, JsonObject[]> = { p1: [], p2: [] };
  const notebooks: Partial<Record<Pid, string>> = {};
  for (const pid of ['p1', 'p2'] as const) {
    const rows = readJsonlObjects(path.join(seriesDir, `${pid}-decisions.jsonl`));
    for (const row of rows) {
      const attemptId = typeof row.attempt_id === 'string' ? row.attempt_id : undefined;
      const gameNumber = Number(row.game_number);
      const completedLineage = completedLineages.get(gameNumber);
      if (attemptId && completedLineage?.has(attemptId)) {
        if (row.kind === 'game_reflection' || isTerminalDecision(row)) decisions[pid].push(row);
        if ((row.kind === 'decision' || row.kind === 'game_reflection') && typeof row.notebook === 'string') {
          notebooks[pid] = row.notebook;
        }
        continue;
      }
      if (attemptId && currentAttempts.has(attemptId) && gameNumber === games.length + 1 && isTerminalDecision(row)) {
        replay[pid].push(row);
      }
    }
  }

  /** Random and timed restarts are live branches because their hidden cursors cannot be restored.
   * Model and automatic submissions retain rejection rows so Showdown errors replay exactly. */
  const replayable =
    currentLineage !== undefined &&
    storedPlayers.p1 !== 'random' &&
    storedPlayers.p2 !== 'random' &&
    (['p1', 'p2'] as const).every((pid) =>
      replay[pid].every(
        (row) =>
          typeof row.request_digest === 'string' &&
          ['model', 'automatic', 'model-default'].includes(String(row.submission_source)) &&
          !row.timer,
      ),
    );
  const hasReplay = replay.p1.length > 0 || replay.p2.length > 0;
  if (replayable && hasReplay) {
    for (const pid of ['p1', 'p2'] as const) {
      decisions[pid].push(...replay[pid]);
      for (const row of replay[pid]) {
        if (typeof row.notebook === 'string') notebooks[pid] = row.notebook;
      }
    }
  } else {
    replay.p1 = [];
    replay.p2 = [];
  }
  return {
    seriesId,
    seriesDir,
    started,
    games,
    folded,
    attemptRows,
    decisions,
    notebooks,
    replay,
    resumeFrom: replayable && hasReplay && typeof currentAttemptId === 'string' ? currentAttemptId : undefined,
  };
}

function isTerminalDecision(row: JsonObject): boolean {
  return (
    row.kind === 'decision' &&
    (row.outcome === 'accepted' || row.outcome === 'rejected') &&
    typeof row.submission_id === 'string' &&
    typeof row.action === 'string'
  );
}

export const SERIES_ATTEMPT_SCHEMA_VERSION = 1 as const;

const contextLedgerHeadSchema = z.strictObject({
  context_id: z.string().min(1).nullable(),
  sequence: z.number().int().nonnegative(),
  byte_length: z.number().int().nonnegative(),
  sha256: sha256Schema,
});
const contextLedgerHeadsSchema = z.strictObject({ p1: contextLedgerHeadSchema, p2: contextLedgerHeadSchema });
const contextLedgerBoundsSchema = z.strictObject({
  start: contextLedgerHeadsSchema,
  end: contextLedgerHeadsSchema,
});
const attemptBaseShape = {
  schema_version: z.literal(SERIES_ATTEMPT_SCHEMA_VERSION),
  timestamp: z.string().min(1),
  attempt_id: z.string().min(1),
  series_id: z.string().min(1),
  adopted_completed_games: z.number().int().nonnegative(),
  context_heads: contextLedgerBoundsSchema,
};
const seriesAttemptRowSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('attempt_started'),
    ...attemptBaseShape,
    resumed_from: z.string().min(1).optional(),
  }),
  z.strictObject({ kind: z.literal('attempt_superseded'), ...attemptBaseShape, superseded_by: z.string().min(1) }),
  z.strictObject({
    kind: z.literal('attempt_completed'),
    ...attemptBaseShape,
    completed_games: z.number().int().positive(),
  }),
  z.strictObject({
    kind: z.literal('attempt_aborted'),
    ...attemptBaseShape,
    error: z.strictObject({ name: z.string().min(1), message: z.string() }),
  }),
]);

type SeriesAttemptRow = z.infer<typeof seriesAttemptRowSchema>;

function attemptLedgerRows(file: string): SeriesAttemptRow[] {
  return readJsonlObjects(file).map((row, index) => {
    const parsed = seriesAttemptRowSchema.safeParse(row);
    if (!parsed.success) {
      throw new Error(`invalid series attempt row ${index + 1}: ${z.prettifyError(parsed.error)}`);
    }
    return parsed.data;
  });
}

export function resolveAttemptLineage(
  rows: readonly JsonObject[],
  attemptId: string,
  cutoff = rows.length,
): string[] | undefined {
  if (!attemptId || !Number.isInteger(cutoff) || cutoff < 0 || cutoff > rows.length) return undefined;
  const starts = new Map<string, { row: JsonObject; index: number }>();
  for (const [index, row] of rows.slice(0, cutoff).entries()) {
    if (row.kind !== 'attempt_started' || typeof row.attempt_id !== 'string') continue;
    if (starts.has(row.attempt_id)) return undefined;
    starts.set(row.attempt_id, { row, index });
  }
  const reverse: string[] = [];
  const seen = new Set<string>();
  let current: string | undefined = attemptId;
  let childIndex = cutoff;
  let seriesId: string | undefined;
  while (current !== undefined) {
    if (seen.has(current)) return undefined;
    seen.add(current);
    const entry = starts.get(current);
    const currentSeriesId = entry?.row.series_id;
    if (!entry || entry.index >= childIndex || typeof currentSeriesId !== 'string' || !currentSeriesId) {
      return undefined;
    }
    const start = entry.row;
    childIndex = entry.index;
    if (seriesId === undefined) seriesId = currentSeriesId;
    else if (currentSeriesId !== seriesId) return undefined;
    reverse.push(current);
    if (!Object.hasOwn(start, 'resumed_from')) current = undefined;
    else if (typeof start.resumed_from === 'string' && start.resumed_from) current = start.resumed_from;
    else return undefined;
  }
  return reverse.reverse();
}

function canonicalCompletedAttempt(adopted: AdoptedSeries): Extract<SeriesAttemptRow, { kind: 'attempt_completed' }> {
  const starts = new Map<string, Extract<SeriesAttemptRow, { kind: 'attempt_started' }>>();
  const terminal = new Set<string>();
  for (const row of adopted.attemptRows) {
    if (row.series_id !== adopted.seriesId) {
      throw new Error(`recorded series ${adopted.seriesId} attempt ledger contains another series identity`);
    }
    if (row.kind === 'attempt_started') {
      if (starts.has(row.attempt_id) || !isDeepStrictEqual(row.context_heads.start, row.context_heads.end)) {
        throw new Error(`recorded series ${adopted.seriesId} has an invalid attempt start`);
      }
      starts.set(row.attempt_id, row);
      continue;
    }
    const start = starts.get(row.attempt_id);
    if (
      !start ||
      terminal.has(row.attempt_id) ||
      start.adopted_completed_games !== row.adopted_completed_games ||
      !isDeepStrictEqual(start.context_heads.start, row.context_heads.start)
    ) {
      throw new Error(`recorded series ${adopted.seriesId} has an invalid terminal attempt row`);
    }
    if (row.kind === 'attempt_superseded' && !starts.has(row.superseded_by)) {
      throw new Error(`recorded series ${adopted.seriesId} supersedes an attempt with an unknown branch`);
    }
    if (row.kind === 'attempt_completed' && row.completed_games !== adopted.games.length) {
      throw new Error(`recorded series ${adopted.seriesId} completion attempt has the wrong game count`);
    }
    terminal.add(row.attempt_id);
  }
  const completed = adopted.attemptRows.at(-1);
  if (
    !adopted.folded.complete ||
    completed?.kind !== 'attempt_completed' ||
    terminal.size !== starts.size ||
    !resolveAttemptLineage(adopted.attemptRows, completed.attempt_id) ||
    !isDeepStrictEqual(completed.context_heads.end, contextLedgerHeads(adopted.seriesDir))
  ) {
    throw new Error(`recorded series ${adopted.seriesId} has no canonical terminal completion attempt`);
  }
  return completed;
}

/** Reads the series owner's strict metadata, marker-bound log evidence, and attempt ledger for the
 * exact expected invocation, then exposes only the completed result fields persisted by outer modes. */
export function readCompletedSeriesEvidence(context: RecordedSeriesContext): {
  winnerSide: Pid | undefined;
  fields: CompletedSeriesFields;
} {
  if (context.seriesIndex === undefined) throw new Error('completed series evidence requires a schedule slot');
  const identity = recordedSeriesIdentity(context);
  const adopted = adoptSeriesDir(context, identity);
  if (!adopted) {
    throw new Error(`schedule slot ${context.seriesIndex} has no exact recorded series evidence`);
  }
  const completed = canonicalCompletedAttempt(adopted);
  const winnerSide = adopted.folded.winnerSide;
  const reasoning = (pid: Pid): ReasoningLevel | null =>
    reasoningForModel(identity.players[pid], {
      ...(identity.scaffold.reasoning === null ? {} : { reasoning: identity.scaffold.reasoning }),
      ...(identity.scaffold.reasoning_by_model === null
        ? {}
        : { reasoningByModel: identity.scaffold.reasoning_by_model }),
    }) ?? null;
  const fields: CompletedSeriesFields = {
    series_id: adopted.seriesId,
    attempt_id: completed.attempt_id,
    format: identity.format,
    players: identity.players,
    teams: identity.team_ids,
    packed_team_digests: identity.packed_team_digests,
    winner: winnerSide ? identity.players[winnerSide] : null,
    winner_side: winnerSide ?? null,
    score: adopted.folded.score,
    turns: adopted.games.reduce((sum, game) => sum + Number(game.turns), 0),
    games: adopted.games,
    engine_seeds: identity.engine_seeds,
    timer_scale: identity.scaffold.timer_scale,
    ...(identity.scaffold.closed_sheets ? { closed_sheets: true as const } : {}),
    reasoning: identity.scaffold.reasoning,
    ...(identity.scaffold.reasoning_by_model === null
      ? {}
      : { reasoning_by_player: { p1: reasoning('p1'), p2: reasoning('p2') } }),
  };
  return { winnerSide, fields };
}

type ContextLedgerHead = z.infer<typeof contextLedgerHeadSchema>;
type ContextLedgerHeads = z.infer<typeof contextLedgerHeadsSchema>;

interface IncompleteAttempt {
  attemptId: string;
  adoptedCompletedGames: number;
  contextStartHeads: ContextLedgerHeads;
}

const SERIES_ATTEMPTS_FILE = 'series-attempts.jsonl';

function contextLedgerHead(seriesDir: string, pid: Pid): ContextLedgerHead {
  const file = path.join(seriesDir, `${pid}-context.jsonl`);
  let contents: Buffer;
  try {
    contents = fs.readFileSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    contents = Buffer.alloc(0);
  }
  let contextId: string | null = null;
  let sequence = 0;
  for (const line of contents.toString('utf8').split('\n')) {
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      break;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) break;
    const row = parsed as JsonObject;
    if (typeof row.context_id !== 'string' || typeof row.sequence !== 'number') break;
    contextId = row.context_id;
    sequence = row.sequence;
  }
  return {
    context_id: contextId,
    sequence,
    byte_length: contents.byteLength,
    sha256: createHash('sha256').update(contents).digest('hex'),
  };
}

function contextLedgerHeads(seriesDir: string): ContextLedgerHeads {
  return {
    p1: contextLedgerHead(seriesDir, 'p1'),
    p2: contextLedgerHead(seriesDir, 'p2'),
  };
}

function attemptLedgerPath(seriesDir: string): string {
  return path.join(seriesDir, SERIES_ATTEMPTS_FILE);
}

function appendAttemptRecord(seriesDir: string, record: SeriesAttemptRow): void {
  const file = attemptLedgerPath(seriesDir);
  attemptLedgerRows(file);
  appendJsonlObject(file, record);
}

function incompleteAttempts(seriesDir: string, seriesId: string): IncompleteAttempt[] {
  const started = new Map<string, IncompleteAttempt>();
  const terminal = new Set<string>();
  for (const row of attemptLedgerRows(attemptLedgerPath(seriesDir))) {
    if (row.series_id !== seriesId) continue;
    if (row.kind === 'attempt_started') {
      started.set(row.attempt_id, {
        attemptId: row.attempt_id,
        adoptedCompletedGames: row.adopted_completed_games,
        contextStartHeads: row.context_heads.start,
      });
    } else {
      terminal.add(row.attempt_id);
    }
  }
  return [...started.values()]
    .filter((attempt) => !terminal.has(attempt.attemptId))
    .sort((left, right) => (left.attemptId < right.attemptId ? -1 : left.attemptId > right.attemptId ? 1 : 0));
}

function attemptRecord(
  kind: SeriesAttemptRow['kind'],
  attemptId: string,
  seriesId: string,
  adoptedCompletedGames: number,
  startHeads: ContextLedgerHeads,
  endHeads: ContextLedgerHeads,
  extra: JsonObject = {},
): SeriesAttemptRow {
  return seriesAttemptRowSchema.parse({
    kind,
    schema_version: SERIES_ATTEMPT_SCHEMA_VERSION,
    timestamp: new Date().toISOString(),
    attempt_id: attemptId,
    series_id: seriesId,
    adopted_completed_games: adoptedCompletedGames,
    context_heads: { start: startHeads, end: endHeads },
    ...extra,
  });
}

function projectedDecisionStats(rows: JsonObject[]): Record<string, number> {
  const stats: Record<string, number> = {};
  const add = (key: string, value = 1) => {
    stats[key] = (stats[key] ?? 0) + value;
  };
  for (const row of rows) {
    if (row.kind === 'game_reflection') {
      add('reflections');
      if (row.fallback === true) add('reflection_fallbacks');
      if (typeof row.reasoning_tokens === 'number') add('reasoning_tokens', row.reasoning_tokens);
      if (typeof row.cost === 'number') add('cost', row.cost);
      continue;
    }
    if (row.kind !== 'decision') continue;
    if (row.submission_source !== 'model' && row.submission_source !== 'model-default') continue;
    if (row.automatic === true) continue;
    add('decisions');
    if (row.fallback === true) add('fallbacks');
    if (Array.isArray(row.tool_lookups)) add('tool_lookups', row.tool_lookups.length);
    if (typeof row.parse_failures === 'number') add('parse_failures', row.parse_failures);
    if (typeof row.provider_retries === 'number') add('provider_retries', row.provider_retries);
    if (typeof row.reasoning_tokens === 'number') add('reasoning_tokens', row.reasoning_tokens);
    if (typeof row.cost === 'number') add('cost', row.cost);
    if (row.requested_choices !== undefined) add('substituted_actions');
    const action = typeof row.action === 'string' ? row.action : '';
    const parts = action.split(',');
    add('move_selections', parts.filter((part) => /(?:^|\s)move\s/.test(part)).length);
    add('switch_selections', parts.filter((part) => /(?:^|\s)switch\s/.test(part)).length);
    add('mega_selections', parts.filter((part) => part.trimEnd().endsWith(' mega')).length);
    add('ally_target_selections', parts.filter((part) => / -[12](?:\s|$)/.test(part)).length);
    if (row.phase === 'team_preview') add('team_previews');
    if (Array.isArray(row.selection)) {
      add('protect_selections', row.selection.filter((label) => /^Protect(?:\b|\s)/i.test(String(label))).length);
      add(
        'spread_move_selections',
        row.selection.filter((label) => /\((?:both foes|your side|all adjacent|spread)/i.test(String(label))).length,
      );
    }
  }
  return stats;
}

function combinedDecisionStats(
  restored: Record<string, number>,
  current: Record<string, number>,
): Record<string, number> {
  const combined = { ...current };
  for (const [key, value] of Object.entries(restored)) combined[key] = (combined[key] ?? 0) + value;
  if (combined.cost !== undefined) combined.cost = Math.round(combined.cost * 1e6) / 1e6;
  return combined;
}

function loadAgentContext(seriesDir: string, seriesId: string, pid: Pid): AgentContextEvent[] {
  const file = path.join(seriesDir, `${pid}-context.jsonl`);
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, 'utf8');
  const lines = raw.split('\n');
  let lastNonempty = lines.length - 1;
  while (lastNonempty >= 0 && !lines[lastNonempty]) lastNonempty -= 1;
  const events: AgentContextEvent[] = [];
  let byteOffset = 0;
  for (const [index, line] of lines.entries()) {
    const lineOffset = byteOffset;
    byteOffset += Buffer.byteLength(line, 'utf8') + (index < lines.length - 1 ? 1 : 0);
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch (error) {
      if (index !== lastNonempty) throw new Error(`invalid ${pid} context row ${index + 1}`, { cause: error });
      fs.truncateSync(file, lineOffset);
      break;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error(`invalid ${pid} context row ${index + 1}`);
    const row = parsed as JsonObject;
    const kind = row.context_kind;
    const sequence = events.length + 1;
    if (
      row.kind !== 'agent_context' ||
      row.pid !== pid ||
      row.series_id !== seriesId ||
      row.context_id !== `ctx-${String(sequence).padStart(8, '0')}` ||
      row.sequence !== sequence ||
      !['episode', 'observation', 'decision', 'reflection'].includes(String(kind)) ||
      !row.payload ||
      typeof row.payload !== 'object' ||
      Array.isArray(row.payload)
    )
      throw new Error(`invalid ${pid} context row ${index + 1}`);
    events.push({
      id: row.context_id,
      sequence,
      kind: kind as AgentContextKind,
      payload: row.payload as JsonObject,
    });
  }
  return events;
}

export async function playRecordedSeries(context: RecordedSeriesContext): Promise<RecordedSeries> {
  context.signal?.throwIfAborted();
  const timerScale = context.timerScale ?? DEFAULT_TIMER_SCALE;
  const identity = recordedSeriesIdentity(context);
  const adopted = context.seriesIndex === undefined ? undefined : adoptSeriesDir(context, identity);
  const seriesId = adopted?.seriesId ?? randomUUID().replaceAll('-', '').slice(0, 12);
  const seriesDir = adopted?.seriesDir ?? path.join(context.runDir, 'series', seriesId);
  const adoptedCompletedGames = adopted?.games.length ?? 0;
  fs.mkdirSync(seriesDir, { recursive: true });
  if (!adopted) {
    const metadata = recordedSeriesMetadataSchema.parse({
      schema_version: RECORDED_SERIES_METADATA_SCHEMA_VERSION,
      series_id: seriesId,
      started: new Date().toISOString(),
      identity,
    });
    fs.writeFileSync(path.join(seriesDir, 'series.json'), `${JSON.stringify(metadata)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
  }
  const attemptId = randomUUID();
  const startHeads = contextLedgerHeads(seriesDir);
  const priorIncomplete = incompleteAttempts(seriesDir, seriesId);
  appendAttemptRecord(
    seriesDir,
    attemptRecord(
      'attempt_started',
      attemptId,
      seriesId,
      adoptedCompletedGames,
      startHeads,
      startHeads,
      adopted?.resumeFrom ? { resumed_from: adopted.resumeFrom } : {},
    ),
  );

  try {
    for (const prior of priorIncomplete) {
      appendAttemptRecord(
        seriesDir,
        attemptRecord(
          'attempt_superseded',
          prior.attemptId,
          seriesId,
          prior.adoptedCompletedGames,
          prior.contextStartHeads,
          startHeads,
          { superseded_by: attemptId },
        ),
      );
    }
    const names: Record<Pid, string> = { p1: `p1-${context.players.p1}`, p2: `p2-${context.players.p2}` };
    const reference = Object.values(context.players).some((player) => player !== 'random')
      ? new ShowdownReference(context.format, context.psDir)
      : undefined;
    const reasoning: Record<Pid, ReasoningLevel | undefined> = {
      p1: reasoningForModel(context.players.p1, context),
      p2: reasoningForModel(context.players.p2, context),
    };
    const decisionSink = (pid: Pid): DecisionLog => {
      const file = path.join(seriesDir, `${pid}-decisions.jsonl`);
      let first = true;
      return (row) => {
        const recordedRow = { ...row, attempt_id: attemptId };
        if (first) appendJsonlObject(file, recordedRow);
        else fs.appendFileSync(file, `${JSON.stringify(recordedRow)}\n`, 'utf8');
        first = false;
        context.onDecision?.(pid, recordedRow);
      };
    };

    const engines = Object.fromEntries(
      (['p1', 'p2'] as const).map((pid) => [
        pid,
        makeEngine({
          pid,
          spec: context.players[pid],
          seed: context.engineSeeds[pid],
          decisionLog: decisionSink(pid),
          traceLog: path.join(seriesDir, `${pid}-trace.jsonl`),
          contextLog: path.join(seriesDir, `${pid}-context.jsonl`),
          initialContext: adopted ? loadAgentContext(seriesDir, seriesId, pid) : [],
          format: context.format,
          psDir: context.psDir,
          reasoning: reasoning[pid],
          reference,
          signal: context.signal,
          apiKey: context.apiKeys?.[context.players[pid]],
          recovery: context.recovery,
          initialNotebook: adopted?.notebooks[pid] ?? context.initialNotebooks?.[pid],
          draftRoster: context.draftRosters?.[pid],
          briefing: context.briefings?.[pid],
        }),
      ]),
    ) as Record<Pid, RandomEngine | LLMEngine>;
    for (const pid of ['p1', 'p2'] as const) {
      const engine = engines[pid];
      if (adopted?.replay[pid].length && engine instanceof LLMEngine) engine.primeReplay(adopted.replay[pid]);
    }
    const battleFormat = context.closedSheets ? closedSheetsFormat(context.format, context.psDir) : context.format;
    const { score, games, winnerSide } = await playBo3({
      engines,
      names,
      players: context.players,
      teams: context.teams,
      gameSeeds: context.gameSeeds,
      seriesId,
      seriesDir,
      format: battleFormat,
      psDir: context.psDir,
      ...(adopted?.games.length ? { completedGames: adopted.games } : {}),
      ...(context.requireWinner === undefined ? {} : { requireWinner: context.requireWinner }),
      timerScale,
      attemptId,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
      ...(context.onGameUpdate === undefined ? {} : { onGameUpdate: context.onGameUpdate }),
      ...(context.onGameEnd === undefined ? {} : { onGameEnd: context.onGameEnd }),
    });
    const stats = Object.fromEntries(
      (['p1', 'p2'] as const).map((pid) => [
        pid,
        combinedDecisionStats(projectedDecisionStats(adopted?.decisions[pid] ?? []), engines[pid].decisionStats()),
      ]),
    ) as JsonObject;
    const result: RecordedSeries = {
      coachNotes: Object.fromEntries(
        (['p1', 'p2'] as const).map((pid) => [pid, engines[pid].coachingNote()]),
      ) as Record<Pid, string>,
      winnerSide,
      fields: {
        timestamp: new Date().toISOString(),
        run_id: path.basename(context.runDir),
        series_id: seriesId,
        attempt_id: attemptId,
        format: context.format,
        players: context.players,
        teams: { p1: context.teams.p1.id, p2: context.teams.p2.id },
        packed_team_digests: {
          p1: createHash('sha256').update(context.teams.p1.packed).digest('hex'),
          p2: createHash('sha256').update(context.teams.p2.packed).digest('hex'),
        },
        winner: winnerSide ? context.players[winnerSide] : null,
        winner_side: winnerSide ?? null,
        score,
        turns: games.reduce((sum, game) => sum + Number(game.turns), 0),
        games,
        engine_seeds: context.engineSeeds,
        timer_scale: timerScale,
        ...(context.closedSheets ? { closed_sheets: true } : {}),
        reasoning: context.reasoning ?? null,
        ...(context.reasoningByModel === undefined
          ? {}
          : { reasoning_by_player: { p1: reasoning.p1 ?? null, p2: reasoning.p2 ?? null } }),
        decision_stats: stats,
      },
    };
    appendAttemptRecord(
      seriesDir,
      attemptRecord(
        'attempt_completed',
        attemptId,
        seriesId,
        adoptedCompletedGames,
        startHeads,
        contextLedgerHeads(seriesDir),
        { completed_games: games.length },
      ),
    );
    return result;
  } catch (error) {
    appendAttemptRecord(
      seriesDir,
      attemptRecord(
        'attempt_aborted',
        attemptId,
        seriesId,
        adoptedCompletedGames,
        startHeads,
        contextLedgerHeads(seriesDir),
        {
          error: {
            name: error instanceof Error ? error.name : 'Error',
            message: error instanceof Error ? error.message : String(error),
          },
        },
      ),
    );
    throw error;
  }
}

export function closedSheetsFormat(format: string, psDir: string): string {
  const { Dex } = loadShowdown(psDir);
  const ruleTable = Dex.formats.getRuleTable(Dex.formats.get(format));
  const repeals = [
    ...(ruleTable.has('forceopenteamsheets') ? ['!Force Open Team Sheets'] : []),
    ...(ruleTable.has('openteamsheets') ? ['!Open Team Sheets'] : []),
  ];
  return repeals.length ? `${format}@@@${repeals.join(',')}` : format;
}

function relative(file: string): string {
  const value = path.relative(REPO_ROOT, file);
  return value.startsWith('..') ? file : value;
}
