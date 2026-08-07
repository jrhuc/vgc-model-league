import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentContextEvent, AgentContextKind } from './agent-context.js';
import type { DecisionLog, GameEnd, GameStart } from './battle-agent.js';
import { RandomEngine } from './battle-agent.js';
import { LLMEngine } from './llm-engine.js';
import { REPO_ROOT } from './paths.js';
import type { ModelReasoningConfig, ReasoningLevel } from './providers.js';
import { reasoningForModel } from './providers.js';
import { seededRng } from './random.js';
import type { RecoveryGate } from './recovery.js';
import { ShowdownReference } from './reference.js';
import { loadShowdown } from './showdown.js';
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

export interface GameLuck {
  misses: number;
  crits_taken: number;
  flinched_turns: number;
  full_paralysis: number;
}

export function gameLuck(log: string[]): Record<Pid, GameLuck> {
  const luck: Record<Pid, GameLuck> = {
    p1: { misses: 0, crits_taken: 0, flinched_turns: 0, full_paralysis: 0 },
    p2: { misses: 0, crits_taken: 0, flinched_turns: 0, full_paralysis: 0 },
  };
  for (const line of log) {
    if (!line.startsWith('|')) continue;
    const [, kind = '', ...args] = line.split('|');
    const pid = args[0]?.startsWith('p1') ? 'p1' : args[0]?.startsWith('p2') ? 'p2' : undefined;
    if (!pid) continue;
    if (kind === '-miss') luck[pid].misses += 1;
    else if (kind === '-crit') luck[pid].crits_taken += 1;
    else if (kind === 'cant' && args[1] === 'flinch') luck[pid].flinched_turns += 1;
    else if (kind === 'cant' && args[1] === 'par') luck[pid].full_paralysis += 1;
  }
  return luck;
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
      luck: gameLuck(outcome.log),
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

interface AdoptedSeries {
  seriesId: string;
  seriesDir: string;
  started: string | undefined;
  games: JsonObject[];
  decisions: Record<Pid, JsonObject[]>;
  notebooks: Partial<Record<Pid, string>>;
  replay: Record<Pid, JsonObject[]>;
}

function adoptSeriesDir(context: RecordedSeriesContext): AdoptedSeries | undefined {
  const root = path.join(context.runDir, 'series');
  let entries: string[];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return undefined;
  }
  let best: AdoptedSeries | undefined;
  for (const seriesId of entries) {
    const seriesDir = path.join(root, seriesId);
    let meta: JsonObject;
    try {
      meta = JSON.parse(fs.readFileSync(path.join(seriesDir, 'series.json'), 'utf8')) as JsonObject;
    } catch {
      continue;
    }
    if (meta.series_index !== context.seriesIndex) continue;
    const candidate = reconstructAdoptedSeries(
      context,
      seriesId,
      seriesDir,
      typeof meta.started === 'string' ? meta.started : undefined,
    );
    if (!best || candidate.games.length > best.games.length) best = candidate;
  }
  if (best) pruneDecisionFiles(best);
  return best;
}

/** A game log is trusted as finished only when it carries a win or tie line. The interrupted game's
 * own decision rows become a replay queue — the deterministic seed re-simulates the battle and each
 * side re-answers from its recording — while anything beyond them is replayed fresh. */
function reconstructAdoptedSeries(
  context: RecordedSeriesContext,
  seriesId: string,
  seriesDir: string,
  started: string | undefined,
): AdoptedSeries {
  const games: JsonObject[] = [];
  const score: Record<Pid, number> = { p1: 0, p2: 0 };
  for (let number = 1; score.p1 < 2 && score.p2 < 2; number += 1) {
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
      winner: winnerSide ? context.players[winnerSide] : null,
      winner_side: winnerSide ?? null,
      turns,
      seed: context.gameSeeds[number - 1] ?? null,
      errors: { p1: [], p2: [] },
      model_choice_fallbacks: { p1: 0, p2: 0 },
      simulator_substitutions: { p1: 0, p2: 0 },
      timer_autodefaults: { p1: 0, p2: 0 },
      luck: gameLuck(lines),
      log: relative(logPath),
      resumed: true,
    });
  }
  const decisions: Record<Pid, JsonObject[]> = { p1: [], p2: [] };
  const replay: Record<Pid, JsonObject[]> = { p1: [], p2: [] };
  const notebooks: Partial<Record<Pid, string>> = {};
  for (const pid of ['p1', 'p2'] as const) {
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(seriesDir, `${pid}-decisions.jsonl`), 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let row: JsonObject;
      try {
        row = JSON.parse(line) as JsonObject;
      } catch {
        continue;
      }
      if (Number(row.game_number) > games.length) {
        if (Number(row.game_number) === games.length + 1 && row.kind === 'decision') replay[pid].push(row);
        continue;
      }
      decisions[pid].push(row);
      if (row.kind === 'decision' && typeof row.notebook === 'string' && row.notebook.trim()) {
        notebooks[pid] = row.notebook;
      }
    }
  }
  /** The interrupted game replays from its recording only when the recording is complete: a
   * random seat's RNG cursor is not restored across attempts, and timer autodefaults answer
   * requests without logging a decision row, so those games start fresh instead. */
  const replayable =
    context.players.p1 !== 'random' &&
    context.players.p2 !== 'random' &&
    (['p1', 'p2'] as const).every((pid) => replay[pid].every((row) => !row.timer));
  for (const pid of ['p1', 'p2'] as const) {
    if (replayable) decisions[pid].push(...replay[pid]);
    else replay[pid] = [];
  }
  return { seriesId, seriesDir, started, games, decisions, notebooks, replay };
}

function pruneDecisionFiles(adopted: AdoptedSeries): void {
  for (const pid of ['p1', 'p2'] as const) {
    const file = path.join(adopted.seriesDir, `${pid}-decisions.jsonl`);
    const rows = adopted.decisions[pid];
    if (!rows.length) {
      fs.rmSync(file, { force: true });
      continue;
    }
    fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  }
}

function loadAgentContext(seriesDir: string, pid: Pid): AgentContextEvent[] {
  const file = path.join(seriesDir, `${pid}-context.jsonl`);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line, index) => {
      let row: JsonObject;
      try {
        row = JSON.parse(line) as JsonObject;
      } catch (error) {
        throw new Error(`invalid ${pid} context row ${index + 1}`, { cause: error });
      }
      const kind = row.context_kind;
      if (
        row.kind !== 'agent_context' ||
        typeof row.context_id !== 'string' ||
        !Number.isInteger(row.sequence) ||
        !['episode', 'observation', 'decision', 'reflection'].includes(String(kind)) ||
        !row.payload ||
        typeof row.payload !== 'object' ||
        Array.isArray(row.payload)
      )
        throw new Error(`invalid ${pid} context row ${index + 1}`);
      return {
        id: row.context_id,
        sequence: Number(row.sequence),
        kind: kind as AgentContextKind,
        payload: row.payload as JsonObject,
      };
    });
}

export async function playRecordedSeries(context: RecordedSeriesContext): Promise<RecordedSeries> {
  context.signal?.throwIfAborted();
  const timerScale = context.timerScale ?? DEFAULT_TIMER_SCALE;
  const adopted = context.seriesIndex === undefined ? undefined : adoptSeriesDir(context);
  const seriesId = adopted?.seriesId ?? randomUUID().replaceAll('-', '').slice(0, 12);
  const seriesDir = adopted?.seriesDir ?? path.join(context.runDir, 'series', seriesId);
  fs.mkdirSync(seriesDir, { recursive: true });
  fs.writeFileSync(
    path.join(seriesDir, 'series.json'),
    `${JSON.stringify({
      players: context.players,
      packed_teams: { p1: context.teams.p1.packed, p2: context.teams.p2.packed },
      started: adopted?.started ?? new Date().toISOString(),
      ...(context.seriesIndex === undefined ? {} : { series_index: context.seriesIndex }),
    })}\n`,
    'utf8',
  );
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
    return (row) => {
      fs.appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
      decisionRows[pid].push(row);
      context.onDecision?.(pid, row);
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
        initialContext: adopted ? loadAgentContext(seriesDir, pid) : [],
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
    (['p1', 'p2'] as const).map((pid) => [pid, engines[pid].decisionStats()]),
  ) as JsonObject;
  return {
    coachNotes: Object.fromEntries((['p1', 'p2'] as const).map((pid) => [pid, engines[pid].coachingNote()])) as Record<
      Pid,
      string
    >,
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
