import fs from 'node:fs';
import path from 'node:path';

import { scaffoldComponents, scaffoldRevision } from './llm-engine.js';
import { defaultPsDir, RESULTS_PATH } from './paths.js';
import { parseRoutingPreferences, validateModelExecution } from './providers.js';
import type { Rng } from './random.js';
import { resolveSeed, seededRng, seriesEntropy } from './random.js';
import type { SeriesRecord } from './records.js';
import { appendRow } from './records.js';
import type { ExperimentOptions } from './series.js';
import { mapLimit, playRecordedSeries } from './series.js';
import { showdownCommit } from './showdown.js';
import type { Team } from './teams.js';
import { loadPool, validatePool } from './teams.js';
import { DEFAULT_TIMER_SCALE } from './timer.js';
import type { ExperimentMode, JsonObject, Pid } from './types.js';
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
  | { type: 'game-update'; index: number; game: number; lines: string[]; publicLines: string[] }
  | { type: 'game-end'; index: number; game: number; winner: string | null; turns: number; score: Record<Pid, number> }
  | { type: 'decision'; index: number; pid: Pid; row: JsonObject }
  | { type: 'series-end'; index: number; record: SeriesRecord };

export interface RotationOptions extends ExperimentOptions {
  pool?: string;
  onEvent?: (event: RotationEvent) => void;
  onNotice?: (message: string) => void;
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
  validateModelExecution(models, options);

  fs.mkdirSync(runDir, { recursive: true });
  const recordsPath = options.recordsPath ?? RESULTS_PATH;
  const psDir = options.psDir ?? defaultPsDir();
  const pool = loadPool(options.pool ?? 'test');
  validatePool(pool, psDir);
  const seed = resolveSeed(options.seed);
  const timerScale = options.timerScale ?? DEFAULT_TIMER_SCALE;
  const scaffold = scaffoldRevision();
  const scaffoldParts = scaffoldComponents();
  const openRouterRouting = parseRoutingPreferences();
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
        scaffold,
        scaffold_components: scaffoldParts,
        ...(openRouterRouting ? { openrouter_routing: openRouterRouting } : {}),
        models,
        series_per_pair: seriesPerPair,
        seed,
        concurrency: options.concurrency ?? 2,
        reasoning: options.reasoning ?? null,
        reasoning_by_model: options.reasoningByModel ?? null,
        timer_scale: timerScale,
        pool: pool.id,
        format: pool.format,
        contributor: options.contributor ?? null,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  return mapLimit(plans, options.concurrency ?? 2, options.signal, async (plan, signal) => {
    options.onEvent?.({ type: 'series-start', index: plan.index });
    const { fields } = await playRecordedSeries({
      players: plan.players,
      teams: plan.teams,
      gameSeeds: plan.gameSeeds,
      engineSeeds: plan.engineSeeds,
      format: pool.format,
      psDir,
      runDir,
      signal,
      ...(options.reasoning === undefined ? {} : { reasoning: options.reasoning }),
      ...(options.reasoningByModel === undefined ? {} : { reasoningByModel: options.reasoningByModel }),
      timerScale,
      ...(options.apiKeys === undefined ? {} : { apiKeys: options.apiKeys }),
      ...(options.recovery === undefined ? {} : { recovery: options.recovery }),
      onGameUpdate: (game, lines, publicLines) =>
        options.onEvent?.({ type: 'game-update', index: plan.index, game, lines, publicLines }),
      onGameEnd: (game, winner, turns, score) =>
        options.onEvent?.({ type: 'game-end', index: plan.index, game, winner, turns, score }),
      onDecision: (pid, row) => options.onEvent?.({ type: 'decision', index: plan.index, pid, row }),
    });
    const row = {
      schema_version: 1,
      mode: 'rotation',
      protocol_version: ROTATION_PROTOCOL_VERSION,
      scaffold,
      series_index: plan.index,
      pool: pool.id,
      ...(options.contributor === undefined ? {} : { contributor: options.contributor }),
      run_seed: seed,
      ps_commit: showdownCommit(psDir),
      ...fields,
    } as SeriesRecord;
    appendRow(recordsPath, row);
    options.onEvent?.({ type: 'series-end', index: plan.index, record: row });
    return row;
  });
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
          ...seriesEntropy(random),
        });
      }
    }
  }
  return plans;
}
