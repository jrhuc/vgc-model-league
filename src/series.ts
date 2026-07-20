import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DecisionLog, GameEnd, GameStart } from './engines.js';
import { LLMEngine, RandomEngine } from './engines.js';
import { REPO_ROOT } from './paths.js';
import type { ModelReasoningConfig, ReasoningLevel } from './providers.js';
import { makeProvider, parseSpec, reasoningForModel } from './providers.js';
import { seededRng } from './random.js';
import { ShowdownReference } from './reference.js';
import { SimBattle } from './sim.js';
import type { Team } from './teams.js';
import type { BattleOutcome, JsonObject, Pid, PlayerOptions } from './types.js';

export function makeEngine(
  pid: Pid,
  spec: string,
  seed: number,
  decisionLog: DecisionLog,
  traceLog: DecisionLog,
  format: string,
  psDir: string,
  reasoning?: ReasoningLevel,
  reference?: ShowdownReference,
  signal?: AbortSignal,
  apiKey?: string,
): RandomEngine | LLMEngine {
  if (spec === 'random') return new RandomEngine(pid, seed);
  return new LLMEngine(pid, spec, {
    provider: makeProvider(parseSpec(spec), {
      reasoning,
      ...(apiKey === undefined ? {} : { apiKey }),
    }),
    decisionLog,
    traceLog,
    format,
    psDir,
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(reference === undefined ? {} : { reference }),
    ...(signal === undefined ? {} : { signal }),
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
  timer?: boolean;
  signal?: AbortSignal;
  onGameStart?: (game: number) => void;
  onGameUpdate?: (game: number, lines: string[], publicLines: string[]) => void;
  onGameEnd?: (game: number, winner: string | null, turns: number, score: Record<Pid, number>) => void;
  requireWinner?: boolean;
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
  const games: JsonObject[] = [];
  const gameSeeds = [...context.gameSeeds];
  const tiebreakRandom = seededRng(JSON.stringify(context.gameSeeds));

  for (let index = 0; index < gameSeeds.length; index += 1) {
    const gameSeed = gameSeeds[index]!;
    context.signal?.throwIfAborted();
    const gameNumber = index + 1;
    const gameId = `${seriesId}-${gameNumber}`;
    const start: GameStart = { gameId, gameNumber, seriesId, seriesScore: { ...score } };
    for (const engine of Object.values(engines)) engine.beginGame(start);
    context.onGameStart?.(gameNumber);
    const players: Record<Pid, PlayerOptions> = {
      p1: { name: names.p1, team: context.teams.p1.packed },
      p2: { name: names.p2, team: context.teams.p2.packed },
    };
    const onUpdate = (lines: string[], publicLines: string[]) => context.onGameUpdate?.(gameNumber, lines, publicLines);
    const outcome = context.runBattle
      ? await context.runBattle(gameSeed, onUpdate)
      : await new SimBattle(context.format, players, gameSeed, context.psDir, context.timer ?? true).run(
          engines,
          onUpdate,
        );
    context.signal?.throwIfAborted();
    const winnerSide = (['p1', 'p2'] as const).find((pid) => names[pid] === outcome.winner);
    if (winnerSide) score[winnerSide] += 1;
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
            fallbacks: outcome.fallbacks[pid],
          },
          gameNumber,
          seriesScore: { ...score },
        };
        await engines[pid].endGame(end);
      }),
    );
    const logPath = path.join(context.seriesDir, `game-${gameNumber}.log`);
    fs.writeFileSync(logPath, `${outcome.log.join('\n')}\n`, 'utf8');
    games.push({
      number: gameNumber,
      winner: winnerSide ? context.players[winnerSide] : null,
      winner_side: winnerSide ?? null,
      turns: outcome.turns,
      seed: gameSeed,
      errors: outcome.errors,
      fallbacks: outcome.fallbacks,
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
}

export interface RecordedSeriesFields extends JsonObject {
  timestamp: string;
  run_id: string;
  series_id: string;
  format: string;
  players: Record<Pid, string>;
  teams: Record<Pid, string>;
  winner: string | null;
  winner_side: Pid | null;
  score: Record<Pid, number>;
  turns: number;
  games: JsonObject[];
  engine_seeds: Record<Pid, number>;
  reasoning: ReasoningLevel | null;
  reasoning_by_player?: Record<Pid, ReasoningLevel | null>;
  decision_stats: JsonObject;
}

export interface RecordedSeries {
  winnerSide: Pid | undefined;
  fields: RecordedSeriesFields;
}

export async function playRecordedSeries(context: RecordedSeriesContext): Promise<RecordedSeries> {
  context.signal?.throwIfAborted();
  const seriesId = randomUUID().replaceAll('-', '').slice(0, 12);
  const seriesDir = path.join(context.runDir, 'series', seriesId);
  fs.mkdirSync(seriesDir, { recursive: true });
  const names: Record<Pid, string> = { p1: `p1-${context.players.p1}`, p2: `p2-${context.players.p2}` };
  const reference = Object.values(context.players).some((player) => player !== 'random')
    ? new ShowdownReference(context.format, context.psDir)
    : undefined;
  const reasoning: Record<Pid, ReasoningLevel | undefined> = {
    p1: reasoningForModel(context.players.p1, context),
    p2: reasoningForModel(context.players.p2, context),
  };
  const decisionRows: Record<Pid, JsonObject[]> = { p1: [], p2: [] };
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
      makeEngine(
        pid,
        context.players[pid],
        context.engineSeeds[pid],
        decisionSink(pid),
        path.join(seriesDir, `${pid}-trace.jsonl`),
        context.format,
        context.psDir,
        reasoning[pid],
        reference,
        context.signal,
        context.apiKeys?.[context.players[pid]],
      ),
    ]),
  ) as Record<Pid, RandomEngine | LLMEngine>;
  const { score, games, winnerSide } = await playBo3({
    engines,
    names,
    players: context.players,
    teams: context.teams,
    gameSeeds: context.gameSeeds,
    seriesId,
    seriesDir,
    format: context.format,
    psDir: context.psDir,
    ...(context.requireWinner === undefined ? {} : { requireWinner: context.requireWinner }),
    ...(context.signal === undefined ? {} : { signal: context.signal }),
    ...(context.onGameUpdate === undefined ? {} : { onGameUpdate: context.onGameUpdate }),
    ...(context.onGameEnd === undefined ? {} : { onGameEnd: context.onGameEnd }),
  });
  writeTurnsFile(seriesDir, games, decisionRows);
  const stats = Object.fromEntries(
    (['p1', 'p2'] as const).map((pid) => [pid, engines[pid].decisionStats()]),
  ) as JsonObject;
  return {
    winnerSide,
    fields: {
      timestamp: new Date().toISOString(),
      run_id: path.basename(context.runDir),
      series_id: seriesId,
      format: context.format,
      players: context.players,
      teams: { p1: context.teams.p1.id, p2: context.teams.p2.id },
      winner: winnerSide ? context.players[winnerSide] : null,
      winner_side: winnerSide ?? null,
      score,
      turns: games.reduce((sum, game) => sum + Number(game.turns), 0),
      games,
      engine_seeds: context.engineSeeds,
      reasoning: context.reasoning ?? null,
      ...(context.reasoningByModel === undefined
        ? {}
        : { reasoning_by_player: { p1: reasoning.p1 ?? null, p2: reasoning.p2 ?? null } }),
      decision_stats: stats,
    },
  };
}

function relative(file: string): string {
  const value = path.relative(REPO_ROOT, file);
  return value.startsWith('..') ? file : value;
}

/** Audit convenience: one file joining each turn's protocol lines with both sides' decisions. */
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
