import { seededRng } from '../random.js';
import type { JsonObject } from '../types.js';

export interface GradedDecision {
  runId: string;
  seriesId: string;
  gameNumber: number;
  model: string;
  phase: string | null;
  exPost: number;
  exAnte: number;
  spread: number;
  discriminating: boolean;
}

export interface Interval {
  mean: number;
  low: number;
  high: number;
}

export interface ModelRegret {
  model: string;
  decisions: number;
  games: number;
  exAnte: Interval;
  exPost: Interval;
  share: Interval;
  readGap: Interval;
}

export interface SummaryOptions {
  phases?: readonly string[];
  resamples?: number;
  seed?: string;
}

export function readGraded(rows: JsonObject[]): GradedDecision[] {
  const graded: GradedDecision[] = [];
  for (const row of rows) {
    const exPost = row.ex_post as JsonObject | undefined;
    const exAnte = row.ex_ante as JsonObject | undefined;
    if (!exPost || !exAnte) continue;
    graded.push({
      runId: String(row.run_id ?? ''),
      seriesId: String(row.series_id ?? ''),
      gameNumber: Number(row.game_number ?? 0),
      model: String(row.model ?? ''),
      phase: typeof row.phase === 'string' ? row.phase : null,
      exPost: Number(exPost.regret),
      exAnte: Number(exAnte.regret),
      spread: Number(exAnte.spread ?? 0),
      discriminating: Boolean(exPost.discriminating) && Boolean(exAnte.discriminating),
    });
  }
  return graded;
}

function mean(values: number[]): number {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : 0;
}

function clusteredInterval(clusters: number[][], resamples: number, seed: string): Interval {
  const flat = clusters.flat();
  if (!flat.length) return { mean: 0, low: 0, high: 0 };
  const random = seededRng(seed);
  const draws: number[] = [];
  for (let round = 0; round < resamples; round += 1) {
    const sample: number[] = [];
    for (let pick = 0; pick < clusters.length; pick += 1) {
      sample.push(...(clusters[Math.floor(random() * clusters.length)] as number[]));
    }
    draws.push(mean(sample));
  }
  draws.sort((a, b) => a - b);
  return {
    mean: mean(flat),
    low: draws[Math.floor(0.025 * draws.length)] ?? mean(flat),
    high: draws[Math.min(draws.length - 1, Math.floor(0.975 * draws.length))] ?? mean(flat),
  };
}

export function summarize(graded: GradedDecision[], options: SummaryOptions = {}): ModelRegret[] {
  const resamples = options.resamples ?? 2_000;
  const usable = graded.filter(
    (row) => row.discriminating && (!options.phases || (row.phase !== null && options.phases.includes(row.phase))),
  );
  const byModel = new Map<string, Map<string, GradedDecision[]>>();
  for (const row of usable) {
    const games = byModel.get(row.model) ?? new Map<string, GradedDecision[]>();
    const key = `${row.runId}:${row.seriesId}:${row.gameNumber}`;
    games.set(key, [...(games.get(key) ?? []), row]);
    byModel.set(row.model, games);
  }

  const summaries: ModelRegret[] = [];
  for (const [model, games] of byModel) {
    const clusters = [...games.values()];
    const pick = (take: (row: GradedDecision) => number) => clusters.map((cluster) => cluster.map(take));
    summaries.push({
      model,
      decisions: clusters.reduce((total, cluster) => total + cluster.length, 0),
      games: clusters.length,
      exAnte: clusteredInterval(
        pick((row) => row.exAnte),
        resamples,
        `${options.seed ?? ''}ante:${model}`,
      ),
      exPost: clusteredInterval(
        pick((row) => row.exPost),
        resamples,
        `${options.seed ?? ''}post:${model}`,
      ),
      share: clusteredInterval(
        pick((row) => (row.spread > 0 ? row.exAnte / row.spread : 0)),
        resamples,
        `${options.seed ?? ''}share:${model}`,
      ),
      readGap: clusteredInterval(
        pick((row) => row.exPost - row.exAnte),
        resamples,
        `${options.seed ?? ''}gap:${model}`,
      ),
    });
  }
  return summaries.sort((a, b) => a.exAnte.mean - b.exAnte.mean || a.model.localeCompare(b.model));
}

export function separated(a: ModelRegret, b: ModelRegret): boolean {
  return a.exAnte.high < b.exAnte.low || b.exAnte.high < a.exAnte.low;
}
