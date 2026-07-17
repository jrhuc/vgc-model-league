import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { GameEnd, GameStart } from './engines.js';
import { LLMEngine, RandomEngine } from './engines.js';
import { defaultPsDir, REPO_ROOT, RUNS_DIR } from './paths.js';
import type { ReasoningLevel } from './providers.js';
import { makeProvider, parseSpec, validateReasoning } from './providers.js';
import type { Rng } from './random.js';
import { seededRng } from './random.js';
import type { SeriesRecord } from './records.js';
import { appendRow } from './records.js';
import { ShowdownReference } from './reference.js';
import { showdownCommit } from './showdown.js';
import { SimBattle } from './sim.js';
import type { Team, TeamPool } from './teams.js';
import { loadPool, validatePool } from './teams.js';
import type { ExperimentMode, JsonObject, Pid, PlayerOptions } from './types.js';
export const ROTATION_PROTOCOL_VERSION = 1;

interface SeriesPlan {
  index: number;
  players: Record<Pid, string>;
  teams: Record<Pid, Team>;
  gameSeeds: Array<[number, number, number, number]>;
  engineSeeds: Record<Pid, number>;
}

export type RotationEvent =
  | {
      type: 'plans';
      mode: ExperimentMode;
      protocolVersion: number;
      plans: Array<{ index: number; players: Record<Pid, string> }>;
      pool: string;
      seed: number;
    }
  | { type: 'series-start'; index: number }
  | { type: 'game-update'; index: number; game: number; lines: string[] }
  | { type: 'game-end'; index: number; game: number; winner: string | null; turns: number; score: Record<Pid, number> }
  | { type: 'series-end'; index: number; record: SeriesRecord };

export interface RotationOptions {
  seed?: number;
  concurrency?: number;
  recordsPath?: string;
  psDir?: string;
  reasoning?: ReasoningLevel;
  apiKeys?: Readonly<Record<string, string>>;
  pool?: string;
  onEvent?: (event: RotationEvent) => void;
  onNotice?: (message: string) => void;
  signal?: AbortSignal;
}

export function makeRunDirectory(): string {
  const stamp = new Date().toISOString().replaceAll('-', '').replaceAll(':', '').replace('Z', '000Z');
  const directory = path.join(RUNS_DIR, `${stamp}-${randomUUID().slice(0, 8)}`);
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

export function makeEngine(
  pid: Pid,
  spec: string,
  seed: number,
  decisionLog: string,
  traceLog: string,
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

export async function runRotation(
  models: string[],
  seriesPerPair: number,
  runDir: string,
  options: RotationOptions = {},
): Promise<SeriesRecord[]> {
  if (models.length < 2) throw new Error('at least two models are required');
  if (seriesPerPair % 2) {
    const message = "warning: an odd --series-per-pair leaves each pair's last matchup unmirrored";
    if (options.onNotice) options.onNotice(message);
    else console.error(message);
  }
  for (const model of models) validateReasoning(parseSpec(model), options.reasoning);

  fs.mkdirSync(runDir, { recursive: true });
  const recordsPath = options.recordsPath ?? path.join(REPO_ROOT, 'records', 'results.jsonl');
  const psDir = options.psDir ?? defaultPsDir();
  const pool = loadPool(options.pool ?? 'test');
  validatePool(pool, psDir);
  const seed = options.seed ?? randomBytes(6).readUIntBE(0, 6);
  const plans = makePlans(models, seriesPerPair, pool.teams, seededRng(seed));
  options.onEvent?.({
    mode: 'rotation',
    protocolVersion: ROTATION_PROTOCOL_VERSION,
    type: 'plans',
    plans: plans.map((plan) => ({ index: plan.index, players: plan.players })),
    pool: pool.id,
    seed,
  });
  fs.writeFileSync(
    path.join(runDir, 'config.json'),
    `${JSON.stringify(
      {
        mode: 'rotation',
        protocol_version: ROTATION_PROTOCOL_VERSION,
        models,
        series_per_pair: seriesPerPair,
        seed,
        concurrency: options.concurrency ?? 2,
        reasoning: options.reasoning ?? null,
        pool: pool.id,
        format: pool.format,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  return mapLimit(plans, options.concurrency ?? 2, options.signal, async (plan) => {
    const row = await playSeries(plan, {
      runDir,
      pool,
      runSeed: seed,
      psDir,
      ...(options.reasoning === undefined ? {} : { reasoning: options.reasoning }),
      ...(options.apiKeys === undefined ? {} : { apiKeys: options.apiKeys }),
      ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    appendRow(recordsPath, row);
    options.onEvent?.({ type: 'series-end', index: plan.index, record: row });
    return row;
  });
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  signal: AbortSignal | undefined,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R | undefined>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length && !signal?.aborted) {
      const index = next++;
      try {
        results[index] = await task(items[index]!);
      } catch (error) {
        if (signal?.aborted) return;
        throw error;
      }
    }
  });
  await Promise.all(workers);
  return results.filter((result): result is R => result !== undefined);
}

export function makePlans(models: string[], seriesPerPair: number, teams: Team[], random: Rng): SeriesPlan[] {
  const plans: SeriesPlan[] = [];
  for (let first = 0; first < models.length; first += 1) {
    for (let second = first + 1; second < models.length; second += 1) {
      let matchup: [Team, Team] | undefined;
      for (let pair = 0; pair < seriesPerPair; pair += 1) {
        if (pair % 2 === 0 || !matchup) {
          const firstTeam = Math.floor(random() * teams.length);
          let secondTeam = Math.floor(random() * (teams.length - 1));
          if (secondTeam >= firstTeam) secondTeam += 1;
          matchup = [teams[firstTeam]!, teams[secondTeam]!];
        }
        const players: Record<Pid, string> =
          pair % 2 ? { p1: models[second]!, p2: models[first]! } : { p1: models[first]!, p2: models[second]! };
        plans.push({
          index: plans.length,
          players,
          teams: { p1: matchup[0], p2: matchup[1] },
          gameSeeds: Array.from(
            { length: 3 },
            () =>
              Array.from({ length: 4 }, () => 1 + Math.floor(random() * 0xffff)) as [number, number, number, number],
          ),
          engineSeeds: {
            p1: Math.floor(random() * Number.MAX_SAFE_INTEGER),
            p2: Math.floor(random() * Number.MAX_SAFE_INTEGER),
          },
        });
      }
    }
  }
  return plans;
}

async function playSeries(
  plan: SeriesPlan,
  context: {
    runDir: string;
    pool: TeamPool;
    runSeed: number;
    psDir: string;
    reasoning?: ReasoningLevel;
    apiKeys?: Readonly<Record<string, string>>;
    onEvent?: (event: RotationEvent) => void;
    signal?: AbortSignal;
  },
): Promise<SeriesRecord> {
  context.signal?.throwIfAborted();
  context.onEvent?.({ type: 'series-start', index: plan.index });
  const seriesId = randomUUID().replaceAll('-', '').slice(0, 12);
  const seriesDir = path.join(context.runDir, 'series', seriesId);
  fs.mkdirSync(seriesDir, { recursive: true });
  const names: Record<Pid, string> = { p1: `p1-${plan.players.p1}`, p2: `p2-${plan.players.p2}` };
  const reference = Object.values(plan.players).some((player) => player !== 'random')
    ? new ShowdownReference(context.pool.format, context.psDir)
    : undefined;
  const engines = Object.fromEntries(
    (['p1', 'p2'] as const).map((pid) => [
      pid,
      makeEngine(
        pid,
        plan.players[pid],
        plan.engineSeeds[pid],
        path.join(seriesDir, `${pid}-decisions.jsonl`),
        path.join(seriesDir, `${pid}-trace.jsonl`),
        context.pool.format,
        context.psDir,
        context.reasoning,
        reference,
        context.signal,
        context.apiKeys?.[plan.players[pid]],
      ),
    ]),
  ) as Record<Pid, RandomEngine | LLMEngine>;
  const score: Record<Pid, number> = { p1: 0, p2: 0 };
  const games: JsonObject[] = [];

  for (const [index, gameSeed] of plan.gameSeeds.entries()) {
    context.signal?.throwIfAborted();
    const gameNumber = index + 1;
    const gameId = `${seriesId}-${gameNumber}`;
    const start: GameStart = { gameId, gameNumber, seriesId, seriesScore: { ...score } };
    for (const engine of Object.values(engines)) engine.beginGame(start);
    const players: Record<Pid, PlayerOptions> = {
      p1: { name: names.p1, team: plan.teams.p1.packed },
      p2: { name: names.p2, team: plan.teams.p2.packed },
    };
    const outcome = await new SimBattle(context.pool.format, players, gameSeed, context.psDir).run(engines, (lines) =>
      context.onEvent?.({ type: 'game-update', index: plan.index, game: gameNumber, lines }),
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
    const logPath = path.join(seriesDir, `game-${gameNumber}.log`);
    fs.writeFileSync(logPath, `${outcome.log.join('\n')}\n`, 'utf8');
    games.push({
      number: gameNumber,
      winner: winnerSide ? plan.players[winnerSide] : null,
      winner_side: winnerSide ?? null,
      turns: outcome.turns,
      seed: gameSeed,
      errors: outcome.errors,
      fallbacks: outcome.fallbacks,
      log: relative(logPath),
    });
    context.onEvent?.({
      type: 'game-end',
      index: plan.index,
      game: gameNumber,
      winner: winnerSide ? plan.players[winnerSide] : null,
      turns: outcome.turns,
      score: { ...score },
    });
    if (Math.max(...Object.values(score)) === 2) break;
  }

  const winnerSide = score.p1 === score.p2 ? undefined : score.p1 > score.p2 ? 'p1' : 'p2';
  return {
    schema_version: 1,
    mode: 'rotation',
    protocol_version: ROTATION_PROTOCOL_VERSION,
    timestamp: new Date().toISOString(),
    run_id: path.basename(context.runDir),
    series_id: seriesId,
    series_index: plan.index,
    format: context.pool.format,
    pool: context.pool.id,
    players: plan.players,
    teams: { p1: plan.teams.p1.id, p2: plan.teams.p2.id },
    winner: winnerSide ? plan.players[winnerSide] : null,
    winner_side: winnerSide ?? null,
    score,
    turns: games.reduce((sum, game) => sum + Number(game.turns), 0),
    games,
    run_seed: context.runSeed,
    engine_seeds: plan.engineSeeds,
    reasoning: context.reasoning ?? null,
    decision_stats: Object.fromEntries((['p1', 'p2'] as const).map((pid) => [pid, engines[pid].decisionStats()])),
    ps_commit: showdownCommit(context.psDir),
  };
}

function relative(file: string): string {
  const value = path.relative(REPO_ROOT, file);
  return value.startsWith('..') ? file : value;
}
