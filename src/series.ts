import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
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
  if (spec === 'random') return new RandomEngine(pid, seed);
  return new LLMEngine(pid, spec, {
    ...Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined)),
    decisionLog: setup.decisionLog,
    traceLog: setup.traceLog,
    format: setup.format,
    psDir: setup.psDir,
  });
}

export interface ChanceEventCounts {
  misses: number;
  crits_taken: number;
  flinched_turns: number;
  full_paralysis: number;
}

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

export async function playBo3(context: Bo3Context): Promise<Bo3Result> {
  const { engines, names, seriesId } = context;
  if (context.requireWinner && context.gameSeeds.length !== 3) {
    throw new Error('single-elimination series require exactly three regulation game seeds');
  }
  const score: Record<Pid, number> = { p1: 0, p2: 0 };
  const games: JsonObject[] = [...(context.completedGames ?? [])];
  const gameSeeds = [...context.gameSeeds];
  const tiebreakRandom = seededRng(JSON.stringify(context.gameSeeds));
  for (const game of games) {
    if (game.winner_side === 'p1' || game.winner_side === 'p2') score[game.winner_side as Pid] += 1;
  }
  while (
    gameSeeds.length < games.length ||
    (context.requireWinner === true &&
      gameSeeds.length === games.length &&
      games.length >= context.gameSeeds.length &&
      games.length < SINGLE_ELIMINATION_GAME_LIMIT &&
      score.p1 === score.p2 &&
      games.length > 0)
  ) {
    gameSeeds.push(
      Array.from({ length: 4 }, () => 1 + Math.floor(tiebreakRandom() * 0xffff)) as [number, number, number, number],
    );
  }

  for (let index = games.length; index < gameSeeds.length && Math.max(score.p1, score.p2) < 2; index += 1) {
    const gameSeed = gameSeeds[index]!;
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
    fs.writeFileSync(logPath, `${outcome.log.join('\n')}\n`, 'utf8');
    writeGameCompletionMarker(context.seriesDir, seriesId, gameNumber);
    games.push({
      number: gameNumber,
      winner: winnerSide ? context.players[winnerSide] : null,
      winner_side: winnerSide ?? null,
      turns: outcome.turns,
      seed: gameSeed,
      errors: outcome.errors,
      model_choice_fallbacks: modelChoiceFallbacks,
      simulator_substitutions: outcome.simulatorSubstitutions,
      timer_autodefaults: outcome.timerAutodefaults,
      chance_events: chanceEventCounts(outcome.log),
      log: relative(logPath),
    });
    context.onGameEnd?.(gameNumber, winnerSide ? context.players[winnerSide] : null, outcome.turns, { ...score });
    if (Math.max(...Object.values(score)) === 2) break;
    if (index + 1 < context.gameSeeds.length) continue;
    if (!context.requireWinner || score.p1 !== score.p2) break;
    if (games.length >= SINGLE_ELIMINATION_GAME_LIMIT) {
      throw new Error(`single-elimination series remained tied after ${SINGLE_ELIMINATION_GAME_LIMIT} games`);
    }
    gameSeeds.push(
      Array.from({ length: 4 }, () => 1 + Math.floor(tiebreakRandom() * 0xffff)) as [number, number, number, number],
    );
  }

  return { score, games, winnerSide: score.p1 === score.p2 ? undefined : score.p1 > score.p2 ? 'p1' : 'p2' };
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
  reasoning: ReasoningLevel | null;
  reasoning_by_player?: Record<Pid, ReasoningLevel | null>;
  decision_stats: JsonObject;
}

export interface RecordedSeries {
  coachNotes: Record<Pid, string>;
  winnerSide: Pid | undefined;
  fields: RecordedSeriesFields;
}

interface DecisionFileHead extends JsonObject {
  nonempty_row_count: number;
  byte_length: number;
  sha256: string;
}

interface DecisionProjectionEvidence {
  decisionFileHead: DecisionFileHead;
  activeRowIndexes: number[];
  replayRowIndexes: number[];
  abandonedRowIndexes: number[];
  abandonedRowsSha256: string;
}

interface AdoptedSeries {
  seriesId: string;
  seriesDir: string;
  started: string | undefined;
  games: JsonObject[];
  decisions: Record<Pid, JsonObject[]>;
  notebooks: Partial<Record<Pid, string>>;
  replay: Record<Pid, JsonObject[]>;
  decisionProjection: Record<Pid, DecisionProjectionEvidence>;
}

function optionalTextDigests(values: Partial<Record<Pid, string>> | undefined): Record<Pid, string | null> {
  return Object.fromEntries(
    (['p1', 'p2'] as const).map((pid) => [
      pid,
      values?.[pid] === undefined ? null : createHash('sha256').update(values[pid]).digest('hex'),
    ]),
  ) as Record<Pid, string | null>;
}

function recordedSeriesIdentity(context: RecordedSeriesContext): JsonObject {
  const packedTeams = { p1: context.teams.p1.packed, p2: context.teams.p2.packed };
  return {
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
  };
}

function adoptSeriesDir(context: RecordedSeriesContext, expectedIdentity: JsonObject): AdoptedSeries | undefined {
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
    let meta: JsonObject;
    try {
      meta = JSON.parse(fs.readFileSync(path.join(seriesDir, 'series.json'), 'utf8')) as JsonObject;
    } catch {
      continue;
    }
    const storedIdentity =
      meta.identity && typeof meta.identity === 'object' && !Array.isArray(meta.identity)
        ? (meta.identity as JsonObject)
        : undefined;
    const storedIndex = storedIdentity?.series_index ?? meta.series_index;
    if (storedIndex !== context.seriesIndex) continue;
    if (!storedIdentity || !isDeepStrictEqual(storedIdentity, expectedIdentity)) {
      throw new Error(
        `recorded series identity mismatch for schedule slot ${String(context.seriesIndex)} (${seriesId})`,
      );
    }
    const storedPlayers = storedIdentity.players;
    if (!storedPlayers || typeof storedPlayers !== 'object' || Array.isArray(storedPlayers)) {
      throw new Error(`invalid recorded series identity for ${seriesId}`);
    }
    const candidate = reconstructAdoptedSeries(
      context,
      storedPlayers as Record<Pid, string>,
      seriesId,
      seriesDir,
      typeof meta.started === 'string' ? meta.started : undefined,
    );
    candidates.push(candidate);
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

function writeGameCompletionMarker(seriesDir: string, seriesId: string, gameNumber: number): void {
  const file = gameCompletionMarkerPath(seriesDir, gameNumber);
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(
      temporary,
      `${JSON.stringify({ kind: 'game_complete', series_id: seriesId, game_number: gameNumber })}\n`,
      'utf8',
    );
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function hasGameCompletionMarker(seriesDir: string, seriesId: string, gameNumber: number): boolean {
  try {
    const marker = JSON.parse(fs.readFileSync(gameCompletionMarkerPath(seriesDir, gameNumber), 'utf8')) as JsonObject;
    return marker.kind === 'game_complete' && marker.series_id === seriesId && marker.game_number === gameNumber;
  } catch {
    return false;
  }
}

/** A game is trusted as finished only when its log carries a result and its marker proves both
 * post-game reflections completed. Runs from before completion markers fail closed and replay. The
 * interrupted game's decision rows become a replay queue for deterministic re-simulation. */
function reconstructAdoptedSeries(
  context: RecordedSeriesContext,
  storedPlayers: Record<Pid, string>,
  seriesId: string,
  seriesDir: string,
  started: string | undefined,
): AdoptedSeries {
  const games: JsonObject[] = [];
  const score: Record<Pid, number> = { p1: 0, p2: 0 };
  for (let number = 1; score.p1 < 2 && score.p2 < 2; number += 1) {
    if (!hasGameCompletionMarker(seriesDir, seriesId, number)) break;
    const logPath = path.join(seriesDir, `game-${number}.log`);
    let lines: string[];
    try {
      lines = fs.readFileSync(logPath, 'utf8').split('\n');
    } catch {
      break;
    }
    const sides = new Map<string, Pid>();
    for (const line of lines) {
      const match = /^\|player\|(p[12])\|([^|]+)\|/.exec(line);
      if (match) sides.set(match[2]!, match[1] as Pid);
    }
    const winLine = lines.find((line) => line.startsWith('|win|'));
    const tied = lines.some((line) => line.startsWith('|tie|') || line === '|tie');
    if (winLine === undefined && !tied) break;
    const winnerSide = winLine === undefined ? undefined : sides.get(winLine.slice(5).trim());
    if (winLine !== undefined && winnerSide === undefined) break;
    if (winnerSide) score[winnerSide] += 1;
    let turns = 0;
    for (const line of lines) {
      if (line.startsWith('|turn|')) turns = Math.max(turns, Number(line.slice(6)) || 0);
    }
    games.push({
      number,
      winner: winnerSide ? storedPlayers[winnerSide] : null,
      winner_side: winnerSide ?? null,
      turns,
      seed: context.gameSeeds[number - 1] ?? null,
      errors: { p1: [], p2: [] },
      model_choice_fallbacks: { p1: 0, p2: 0 },
      simulator_substitutions: { p1: 0, p2: 0 },
      timer_autodefaults: { p1: 0, p2: 0 },
      chance_events: chanceEventCounts(lines),
      log: relative(logPath),
      resumed: true,
    });
  }
  const decisions: Record<Pid, JsonObject[]> = { p1: [], p2: [] };
  const replay: Record<Pid, JsonObject[]> = { p1: [], p2: [] };
  const completedSourceRows: Record<Pid, DecisionSourceRow[]> = { p1: [], p2: [] };
  const replaySourceRows: Record<Pid, DecisionSourceRow[]> = { p1: [], p2: [] };
  const sourceRows: Record<Pid, DecisionSourceRow[]> = { p1: [], p2: [] };
  const decisionFileHeads: Record<Pid, DecisionFileHead> = {
    p1: emptyDecisionFileHead(),
    p2: emptyDecisionFileHead(),
  };
  const notebooks: Partial<Record<Pid, string>> = {};
  const priorBranch = latestDecisionBranch(seriesDir, seriesId);
  for (const pid of ['p1', 'p2'] as const) {
    const file = path.join(seriesDir, `${pid}-decisions.jsonl`);
    let contents: Buffer;
    try {
      contents = fs.readFileSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      contents = Buffer.alloc(0);
    }
    const rows = contents
      .toString('utf8')
      .split('\n')
      .map((line, index): DecisionSourceRow | undefined => {
        if (!line.trim()) return undefined;
        let row: JsonObject | undefined;
        try {
          const parsed = JSON.parse(line) as unknown;
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) row = parsed as JsonObject;
        } catch {}
        return { index: index + 1, line, row };
      })
      .filter((row): row is DecisionSourceRow => row !== undefined);
    sourceRows[pid] = rows;
    decisionFileHeads[pid] = {
      nonempty_row_count: rows.length,
      byte_length: contents.byteLength,
      sha256: createHash('sha256').update(contents).digest('hex'),
    };
    let eligibleIndexes = priorBranch
      ? new Set(priorBranch.activeRowIndexes[pid])
      : new Set(rows.map(({ index }) => index));
    if (priorBranch) {
      const currentAttemptRows = rows.filter(({ row }) => row?.attempt_id === priorBranch.attemptId);
      const currentAttemptHasInflightDecision = currentAttemptRows.some(
        ({ row }) => row?.kind === 'decision' && Number(row.game_number) > games.length,
      );
      if (currentAttemptHasInflightDecision) {
        eligibleIndexes = new Set(
          rows
            .filter(
              ({ index, row }) =>
                (eligibleIndexes.has(index) && Number(row?.game_number) <= games.length) ||
                row?.attempt_id === priorBranch.attemptId,
            )
            .map(({ index }) => index),
        );
      } else {
        for (const { index } of currentAttemptRows) eligibleIndexes.add(index);
      }
    }
    for (const source of rows) {
      const row = source.row;
      if (!eligibleIndexes.has(source.index) || !row) continue;
      if (Number(row.game_number) > games.length) {
        if (Number(row.game_number) === games.length + 1 && row.kind === 'decision') {
          replay[pid].push(row);
          replaySourceRows[pid].push(source);
        }
        continue;
      }
      decisions[pid].push(row);
      completedSourceRows[pid].push(source);
      if ((row.kind === 'decision' || row.kind === 'game_reflection') && typeof row.notebook === 'string') {
        notebooks[pid] = row.notebook;
      }
    }
  }
  /** The interrupted game replays from its recording only when the recording is complete: a
   * random seat's RNG cursor is not restored across attempts, and timer autodefaults answer
   * requests without logging a decision row, so those games start fresh instead. */
  const replayable =
    storedPlayers.p1 !== 'random' &&
    storedPlayers.p2 !== 'random' &&
    (['p1', 'p2'] as const).every((pid) => replay[pid].every((row) => !row.timer));
  const decisionProjection = Object.fromEntries(
    (['p1', 'p2'] as const).map((pid) => {
      const active = replayable ? [...completedSourceRows[pid], ...replaySourceRows[pid]] : completedSourceRows[pid];
      const activeIndexes = new Set(active.map(({ index }) => index));
      const abandoned = sourceRows[pid].filter(({ index }) => !activeIndexes.has(index));
      const abandonedBytes = abandoned.length ? `${abandoned.map(({ line }) => line).join('\n')}\n` : '';
      if (replayable) decisions[pid].push(...replay[pid]);
      else replay[pid] = [];
      return [
        pid,
        {
          decisionFileHead: decisionFileHeads[pid],
          activeRowIndexes: [...activeIndexes].sort((left, right) => left - right),
          replayRowIndexes: replayable ? replaySourceRows[pid].map(({ index }) => index) : [],
          abandonedRowIndexes: abandoned.map(({ index }) => index),
          abandonedRowsSha256: createHash('sha256').update(abandonedBytes).digest('hex'),
        },
      ];
    }),
  ) as Record<Pid, DecisionProjectionEvidence>;
  return { seriesId, seriesDir, started, games, decisions, notebooks, replay, decisionProjection };
}

interface DecisionSourceRow {
  index: number;
  line: string;
  row: JsonObject | undefined;
}

interface StoredDecisionBranch {
  attemptId: string;
  activeRowIndexes: Record<Pid, number[]>;
}

const ATTEMPT_KINDS = new Set(['attempt_started', 'attempt_superseded', 'attempt_completed', 'attempt_aborted']);

function attemptLedgerRows(file: string): JsonObject[] {
  return readJsonlObjects(file).map((row, index) => {
    const valid =
      row.schema_version === 1 &&
      typeof row.timestamp === 'string' &&
      typeof row.attempt_id === 'string' &&
      typeof row.series_id === 'string' &&
      Number.isSafeInteger(row.adopted_completed_games) &&
      Number(row.adopted_completed_games) >= 0 &&
      typeof row.kind === 'string' &&
      ATTEMPT_KINDS.has(row.kind) &&
      typeof row.context_heads === 'object' &&
      row.context_heads !== null &&
      !Array.isArray(row.context_heads);
    if (!valid) throw new Error(`invalid series attempt row ${index + 1}`);
    return row;
  });
}

function emptyDecisionFileHead(): DecisionFileHead {
  return {
    nonempty_row_count: 0,
    byte_length: 0,
    sha256: createHash('sha256').update('').digest('hex'),
  };
}

function latestDecisionBranch(seriesDir: string, seriesId: string): StoredDecisionBranch | undefined {
  let latest: StoredDecisionBranch | undefined;
  for (const [index, row] of attemptLedgerRows(path.join(seriesDir, 'series-attempts.jsonl')).entries()) {
    if (row.kind !== 'attempt_started' || row.series_id !== seriesId) continue;
    const projection = row.decision_projection;
    if (!projection || typeof projection !== 'object' || Array.isArray(projection)) continue;
    const indexes = Object.fromEntries(
      (['p1', 'p2'] as const).map((pid) => {
        const seat = (projection as JsonObject)[pid];
        if (!seat || typeof seat !== 'object' || Array.isArray(seat))
          throw new Error(`invalid decision projection in series attempt row ${index + 1}`);
        const active = (seat as JsonObject).active_row_indexes;
        if (!Array.isArray(active) || !active.every((value) => Number.isInteger(value) && Number(value) > 0))
          throw new Error(`invalid decision projection in series attempt row ${index + 1}`);
        return [pid, active.map(Number)];
      }),
    ) as Record<Pid, number[]>;
    latest = { attemptId: row.attempt_id as string, activeRowIndexes: indexes };
  }
  return latest;
}

interface ContextLedgerHead extends JsonObject {
  context_id: string | null;
  sequence: number;
  byte_length: number;
  sha256: string;
}

type ContextLedgerHeads = Record<Pid, ContextLedgerHead>;

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

function appendAttemptRecord(seriesDir: string, record: JsonObject): void {
  const file = attemptLedgerPath(seriesDir);
  attemptLedgerRows(file);
  appendJsonlObject(file, record);
}

function incompleteAttempts(seriesDir: string, seriesId: string): IncompleteAttempt[] {
  const started = new Map<string, IncompleteAttempt>();
  const terminal = new Set<string>();
  for (const [index, row] of attemptLedgerRows(attemptLedgerPath(seriesDir)).entries()) {
    if (row.series_id !== seriesId) continue;
    const attemptId = row.attempt_id as string;
    if (row.kind === 'attempt_started') {
      const contextHeads = row.context_heads as JsonObject;
      const startHeads = contextHeads.start;
      if (!startHeads || typeof startHeads !== 'object' || Array.isArray(startHeads))
        throw new Error(`invalid series attempt row ${index + 1}`);
      started.set(attemptId, {
        attemptId,
        adoptedCompletedGames: Number(row.adopted_completed_games),
        contextStartHeads: startHeads as ContextLedgerHeads,
      });
    } else if (
      row.kind === 'attempt_completed' ||
      row.kind === 'attempt_aborted' ||
      row.kind === 'attempt_superseded'
    ) {
      terminal.add(attemptId);
    }
  }
  return [...started.values()]
    .filter((attempt) => !terminal.has(attempt.attemptId))
    .sort((left, right) => (left.attemptId < right.attemptId ? -1 : left.attemptId > right.attemptId ? 1 : 0));
}

function attemptRecord(
  kind: 'attempt_started' | 'attempt_superseded' | 'attempt_completed' | 'attempt_aborted',
  attemptId: string,
  seriesId: string,
  adoptedCompletedGames: number,
  startHeads: ContextLedgerHeads,
  endHeads: ContextLedgerHeads,
  extra: JsonObject = {},
): JsonObject {
  return {
    kind,
    schema_version: 1,
    timestamp: new Date().toISOString(),
    attempt_id: attemptId,
    series_id: seriesId,
    adopted_completed_games: adoptedCompletedGames,
    context_heads: { start: startHeads, end: endHeads },
    ...extra,
  };
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
    if (row.action === 'abandoned') {
      add('abandoned_decisions');
      continue;
    }
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
    fs.writeFileSync(
      path.join(seriesDir, 'series.json'),
      `${JSON.stringify({
        schema_version: 2,
        series_id: seriesId,
        started: new Date().toISOString(),
        ...identity,
        identity,
      })}\n`,
      { encoding: 'utf8', flag: 'wx' },
    );
  }
  const attemptId = randomUUID();
  const startHeads = contextLedgerHeads(seriesDir);
  const priorIncomplete = incompleteAttempts(seriesDir, seriesId);
  const decisionProjection = {
    decision_projection: Object.fromEntries(
      (['p1', 'p2'] as const).map((pid) => {
        const projection = adopted?.decisionProjection[pid] ?? {
          decisionFileHead: emptyDecisionFileHead(),
          activeRowIndexes: [],
          replayRowIndexes: [],
          abandonedRowIndexes: [],
          abandonedRowsSha256: createHash('sha256').update('').digest('hex'),
        };
        return [
          pid,
          {
            decision_file_head: projection.decisionFileHead,
            active_row_indexes: projection.activeRowIndexes,
            replay_row_indexes: projection.replayRowIndexes,
            abandoned_row_indexes: projection.abandonedRowIndexes,
            abandoned_row_count: projection.abandonedRowIndexes.length,
            abandoned_rows_sha256: projection.abandonedRowsSha256,
          },
        ];
      }),
    ),
  };
  appendAttemptRecord(
    seriesDir,
    attemptRecord(
      'attempt_started',
      attemptId,
      seriesId,
      adoptedCompletedGames,
      startHeads,
      startHeads,
      decisionProjection,
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
          { superseded_by: attemptId, ...decisionProjection },
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
    const decisionRows: Record<Pid, JsonObject[]> = {
      p1: [...(adopted?.decisions.p1 ?? [])],
      p2: [...(adopted?.decisions.p2 ?? [])],
    };
    const decisionSink = (pid: Pid): DecisionLog => {
      const file = path.join(seriesDir, `${pid}-decisions.jsonl`);
      let needsSeparator = false;
      try {
        const existing = fs.readFileSync(file);
        needsSeparator = existing.length > 0 && existing.at(-1) !== 0x0a;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      return (row) => {
        const recordedRow = { ...row, attempt_id: attemptId, branch_id: attemptId };
        fs.appendFileSync(file, `${needsSeparator ? '\n' : ''}${JSON.stringify(recordedRow)}\n`, 'utf8');
        needsSeparator = false;
        decisionRows[pid].push(recordedRow);
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
      ...(context.signal === undefined ? {} : { signal: context.signal }),
      ...(context.onGameUpdate === undefined ? {} : { onGameUpdate: context.onGameUpdate }),
      ...(context.onGameEnd === undefined ? {} : { onGameEnd: context.onGameEnd }),
    });
    writeTurnsFile(seriesDir, games, decisionRows);
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

function writeTurnsFile(seriesDir: string, games: JsonObject[], rows: Record<Pid, JsonObject[]>): void {
  if (!rows.p1.length && !rows.p2.length) return;
  const out: string[] = [];
  const decisionsByTurn: Record<Pid, Map<string, JsonObject[]>> = { p1: new Map(), p2: new Map() };
  for (const pid of ['p1', 'p2'] as const) {
    for (const row of rows[pid]) {
      if (row.kind !== 'decision') continue;
      const key = `${Number(row.game_number)}:${Number(row.turn)}`;
      const decisions = decisionsByTurn[pid].get(key);
      if (decisions) decisions.push(row);
      else decisionsByTurn[pid].set(key, [row]);
    }
  }
  for (const game of games) {
    const number = Number(game.number);
    let logLines: string[] = [];
    try {
      logLines = fs.readFileSync(path.join(seriesDir, `game-${number}.log`), 'utf8').split('\n');
    } catch {
      continue;
    }
    const chunks = new Map<number, string[]>();
    let turn = 0;
    for (const line of logLines) {
      if (line.startsWith('|turn|')) turn = Number(line.slice(6)) || turn;
      const chunk = chunks.get(turn) ?? [];
      chunk.push(line);
      chunks.set(turn, chunk);
    }
    for (const [turnNumber, chunk] of chunks) {
      out.push(
        JSON.stringify({
          game: number,
          turn: turnNumber,
          decisions: {
            p1: decisionsByTurn.p1.get(`${number}:${turnNumber}`) ?? [],
            p2: decisionsByTurn.p2.get(`${number}:${turnNumber}`) ?? [],
          },
          lines: chunk,
        }),
      );
    }
  }
  fs.writeFileSync(path.join(seriesDir, 'turns.jsonl'), out.length ? `${out.join('\n')}\n` : '', 'utf8');
}
