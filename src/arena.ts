import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import pLimit from 'p-limit';
import seedrandom from 'seedrandom';

import type { GameEnd, GameStart } from './engines.js';
import { LLMEngine, RandomEngine } from './engines.js';
import { defaultPsDir, REPO_ROOT } from './paths.js';
import type { ReasoningLevel } from './providers.js';
import { makeProvider, parseSpec, validateReasoning } from './providers.js';
import type { SeriesRecord } from './records.js';
import { appendRow, psCommit } from './records.js';
import { ShowdownReference } from './reference.js';
import { SimBattle } from './sim.js';
import type { Team, TeamPool } from './teams.js';
import { loadPool, validatePool } from './teams.js';
import type { JsonObject, Pid, PlayerOptions } from './types.js';

interface SeriesPlan {
  index: number;
  players: Record<Pid, string>;
  teams: Record<Pid, Team>;
  gameSeeds: Array<[number, number, number, number]>;
  engineSeeds: Record<Pid, number>;
}

export interface BenchmarkOptions {
  seed?: number;
  concurrency?: number;
  recordsPath?: string;
  psDir?: string;
  reasoning?: ReasoningLevel;
  pool?: string;
}

export function makeEngine(
  pid: Pid,
  spec: string,
  seed: number,
  decisionLog: string,
  format: string,
  psDir: string,
  reasoning?: ReasoningLevel,
  reference?: ShowdownReference,
): RandomEngine | LLMEngine {
  if (spec === 'random') return new RandomEngine(pid, seed);
  return new LLMEngine(pid, spec, {
    provider: makeProvider(parseSpec(spec), { reasoning }),
    decisionLog,
    format,
    psDir,
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(reference === undefined ? {} : { reference }),
  });
}

export async function runBenchmark(
  models: string[],
  seriesPerPair: number,
  runDir: string,
  options: BenchmarkOptions = {},
): Promise<SeriesRecord[]> {
  if (models.length < 2) throw new Error('at least two models are required');
  if (seriesPerPair % 2) console.error("warning: an odd --series-per-pair leaves each pair's last matchup unmirrored");
  for (const model of models) validateReasoning(parseSpec(model), options.reasoning);

  fs.mkdirSync(runDir, { recursive: true });
  const recordsPath = options.recordsPath ?? path.join(REPO_ROOT, 'records', 'results.jsonl');
  const psDir = options.psDir ?? defaultPsDir();
  const pool = loadPool(options.pool ?? 'test');
  validatePool(pool, psDir);
  const seed = options.seed ?? randomBytes(6).readUIntBE(0, 6);
  const plans = makePlans(models, seriesPerPair, pool.teams, seedrandom(String(seed)));
  fs.writeFileSync(
    path.join(runDir, 'config.json'),
    `${JSON.stringify(
      {
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

  const limit = pLimit(options.concurrency ?? 2);
  return Promise.all(
    plans.map((plan) =>
      limit(async () => {
        const row = await playSeries(plan, {
          runDir,
          pool,
          runSeed: seed,
          psDir,
          ...(options.reasoning === undefined ? {} : { reasoning: options.reasoning }),
        });
        appendRow(recordsPath, row);
        return row;
      }),
    ),
  );
}

export function makePlans(
  models: string[],
  seriesPerPair: number,
  teams: Team[],
  random: seedrandom.PRNG,
): SeriesPlan[] {
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
  context: { runDir: string; pool: TeamPool; runSeed: number; psDir: string; reasoning?: ReasoningLevel },
): Promise<SeriesRecord> {
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
        context.pool.format,
        context.psDir,
        context.reasoning,
        reference,
      ),
    ]),
  ) as Record<Pid, RandomEngine | LLMEngine>;
  const score: Record<Pid, number> = { p1: 0, p2: 0 };
  const games: JsonObject[] = [];

  for (const [index, gameSeed] of plan.gameSeeds.entries()) {
    const gameNumber = index + 1;
    const gameId = `${seriesId}-${gameNumber}`;
    const start: GameStart = { gameId, gameNumber, seriesId, seriesScore: { ...score } };
    for (const engine of Object.values(engines)) engine.beginGame(start);
    const players: Record<Pid, PlayerOptions> = {
      p1: { name: names.p1, team: plan.teams.p1.packed },
      p2: { name: names.p2, team: plan.teams.p2.packed },
    };
    const outcome = await new SimBattle(context.pool.format, players, gameSeed, context.psDir).run(engines);
    const winnerSide = (['p1', 'p2'] as const).find((pid) => names[pid] === outcome.winner);
    if (winnerSide) score[winnerSide] += 1;
    for (const pid of ['p1', 'p2'] as const) {
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
      engines[pid].endGame(end);
    }
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
    if (Math.max(...Object.values(score)) === 2) break;
  }

  const winnerSide = score.p1 === score.p2 ? undefined : score.p1 > score.p2 ? 'p1' : 'p2';
  return {
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
    ps_commit: psCommit(context.psDir),
  };
}

function relative(file: string): string {
  const value = path.relative(REPO_ROOT, file);
  return value.startsWith('..') ? file : value;
}
