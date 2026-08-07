import { seededRng } from '../random.js';
import type { JsonObject } from '../types.js';
import { type Interval, SPREAD_FLOOR } from './summary.js';

export interface PairedDecision {
  game: string;
  position: number;
  model: string;
  opponent: string;
  phase: string | null;
  exAnte: number;
  spread: number;
  discriminating: boolean;
}

export type PairedMetric = 'regret' | 'share';

export interface FacedPosition {
  game: string;
  left: string;
  right: string;
  difference: number;
}

export interface PairedScore {
  model: string;
  positions: number;
  games: number;
  opponents: number;
  effect: Interval;
}

export interface PairedComparison {
  left: string;
  right: string;
  positions: number;
  direct: boolean;
  difference: Interval;
}

export interface PairedFit {
  scores: PairedScore[];
  comparisons: PairedComparison[];
  positions: number;
  isolated: string[];
}

export interface PairedOptions {
  phases?: readonly string[];
  resamples?: number;
  seed?: string;
  minPositions?: number;
  minGames?: number;
  minOpponents?: number;
  metric?: PairedMetric;
}

export function readPaired(rows: JsonObject[]): PairedDecision[] {
  const paired: PairedDecision[] = [];
  for (const row of rows) {
    const exAnte = row.ex_ante as JsonObject | undefined;
    const exPost = row.ex_post as JsonObject | undefined;
    if (!exAnte || !exPost) continue;
    paired.push({
      game: `${row.run_id ?? ''}:${row.series_id ?? ''}:${row.game_number ?? ''}`,
      position: Number(row.position_index ?? 0),
      model: String(row.model ?? ''),
      opponent: String(row.opponent ?? ''),
      phase: typeof row.phase === 'string' ? row.phase : null,
      exAnte: Number(exAnte.regret),
      spread: Number(exAnte.spread ?? 0),
      discriminating: Boolean(exAnte.discriminating) && Boolean(exPost.discriminating),
    });
  }
  return paired;
}

export function facedPositions(
  paired: PairedDecision[],
  phases?: readonly string[],
  metric: PairedMetric = 'share',
): FacedPosition[] {
  const take = (row: PairedDecision) => (metric === 'share' ? Math.min(1, row.exAnte / row.spread) : row.exAnte);
  const sides = new Map<string, PairedDecision[]>();
  for (const row of paired) {
    if (!row.discriminating) continue;
    if (metric === 'share' && row.spread < SPREAD_FLOOR) continue;
    if (phases && (row.phase === null || !phases.includes(row.phase))) continue;
    const key = `${row.game}#${row.position}`;
    sides.set(key, [...(sides.get(key) ?? []), row]);
  }
  const faced: FacedPosition[] = [];
  for (const both of sides.values()) {
    if (both.length !== 2) continue;
    const [left, right] = both as [PairedDecision, PairedDecision];
    if (left.model === right.model) continue;
    faced.push({ game: left.game, left: left.model, right: right.model, difference: take(left) - take(right) });
  }
  return faced;
}

function solve(matrix: number[][], vector: number[]): number[] {
  const size = vector.length;
  const rows = matrix.map((row, index) => [...row, vector[index] as number]);
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs((rows[row] as number[])[column] as number) > Math.abs((rows[pivot] as number[])[column] as number)) {
        pivot = row;
      }
    }
    [rows[column], rows[pivot]] = [rows[pivot] as number[], rows[column] as number[]];
    const head = rows[column] as number[];
    const lead = head[column] as number;
    if (!lead) continue;
    for (let row = column + 1; row < size; row += 1) {
      const target = rows[row] as number[];
      const factor = (target[column] as number) / lead;
      if (!factor) continue;
      for (let cell = column; cell <= size; cell += 1) {
        target[cell] = (target[cell] as number) - factor * (head[cell] as number);
      }
    }
  }
  const solution = new Array<number>(size).fill(0);
  for (let row = size - 1; row >= 0; row -= 1) {
    const line = rows[row] as number[];
    let total = line[size] as number;
    for (let column = row + 1; column < size; column += 1)
      total -= (line[column] as number) * (solution[column] as number);
    const lead = line[row] as number;
    solution[row] = lead ? total / lead : 0;
  }
  return solution;
}

function fitEffects(faced: FacedPosition[], models: string[]): number[] {
  const size = models.length;
  const index = new Map(models.map((model, position) => [model, position]));
  const matrix = Array.from({ length: size }, () => new Array<number>(size).fill(1 / size));
  const vector = new Array<number>(size).fill(0);
  for (let position = 0; position < size; position += 1) {
    (matrix[position] as number[])[position] = 1 / size + 1e-9;
  }
  for (const pair of faced) {
    const left = index.get(pair.left);
    const right = index.get(pair.right);
    if (left === undefined || right === undefined) continue;
    (matrix[left] as number[])[left] = ((matrix[left] as number[])[left] as number) + 1;
    (matrix[right] as number[])[right] = ((matrix[right] as number[])[right] as number) + 1;
    (matrix[left] as number[])[right] = ((matrix[left] as number[])[right] as number) - 1;
    (matrix[right] as number[])[left] = ((matrix[right] as number[])[left] as number) - 1;
    vector[left] = (vector[left] as number) + pair.difference;
    vector[right] = (vector[right] as number) - pair.difference;
  }
  return solve(matrix, vector);
}

function quantiles(draws: number[], centre: number): Interval {
  if (!draws.length) return { mean: centre, low: centre, high: centre };
  const sorted = [...draws].sort((a, b) => a - b);
  return {
    mean: centre,
    low: sorted[Math.floor(0.025 * sorted.length)] as number,
    high: sorted[Math.min(sorted.length - 1, Math.floor(0.975 * sorted.length))] as number,
  };
}

export function fitPaired(paired: PairedDecision[], options: PairedOptions = {}): PairedFit {
  const resamples = options.resamples ?? 1_000;
  const minPositions = options.minPositions ?? 20;
  const minGames = options.minGames ?? 4;
  const minOpponents = options.minOpponents ?? 2;
  const faced = facedPositions(paired, options.phases, options.metric ?? 'share');

  const seen = new Map<string, { positions: number; games: Set<string>; opponents: Set<string> }>();
  const note = (model: string, against: string, game: string) => {
    const entry = seen.get(model) ?? { positions: 0, games: new Set<string>(), opponents: new Set<string>() };
    entry.positions += 1;
    entry.games.add(game);
    entry.opponents.add(against);
    seen.set(model, entry);
  };
  for (const pair of faced) {
    note(pair.left, pair.right, pair.game);
    note(pair.right, pair.left, pair.game);
  }

  const models = [...seen.entries()]
    .filter(
      ([, entry]) =>
        entry.positions >= minPositions && entry.games.size >= minGames && entry.opponents.size >= minOpponents,
    )
    .map(([model]) => model)
    .sort();
  const kept = new Set(models);
  const isolated = [...seen.keys()].filter((model) => !kept.has(model)).sort();
  const usable = faced.filter((pair) => kept.has(pair.left) && kept.has(pair.right));
  if (!models.length) return { scores: [], comparisons: [], positions: 0, isolated };

  const effects = fitEffects(usable, models);
  const byGame = new Map<string, FacedPosition[]>();
  for (const pair of usable) byGame.set(pair.game, [...(byGame.get(pair.game) ?? []), pair]);
  const clusters = [...byGame.values()];

  const random = seededRng(options.seed ?? 'paired');
  const draws: number[][] = [];
  for (let round = 0; round < resamples; round += 1) {
    const sample: FacedPosition[] = [];
    for (let pick = 0; pick < clusters.length; pick += 1) {
      sample.push(...(clusters[Math.floor(random() * clusters.length)] as FacedPosition[]));
    }
    draws.push(fitEffects(sample, models));
  }

  const scores: PairedScore[] = models.map((model, position) => ({
    model,
    positions: seen.get(model)?.positions ?? 0,
    games: seen.get(model)?.games.size ?? 0,
    opponents: seen.get(model)?.opponents.size ?? 0,
    effect: quantiles(
      draws.map((draw) => draw[position] as number),
      effects[position] as number,
    ),
  }));

  const met = new Map<string, number>();
  for (const pair of usable) {
    const key = pair.left < pair.right ? `${pair.left}|${pair.right}` : `${pair.right}|${pair.left}`;
    met.set(key, (met.get(key) ?? 0) + 1);
  }
  const comparisons: PairedComparison[] = [];
  for (let left = 0; left < models.length; left += 1) {
    for (let right = left + 1; right < models.length; right += 1) {
      const a = models[left] as string;
      const b = models[right] as string;
      const shared = met.get(a < b ? `${a}|${b}` : `${b}|${a}`) ?? 0;
      comparisons.push({
        left: a,
        right: b,
        positions: shared,
        direct: shared > 0,
        difference: quantiles(
          draws.map((draw) => (draw[left] as number) - (draw[right] as number)),
          (effects[left] as number) - (effects[right] as number),
        ),
      });
    }
  }

  return {
    scores: scores.sort((a, b) => a.effect.mean - b.effect.mean || a.model.localeCompare(b.model)),
    comparisons: comparisons.filter((entry) => entry.difference.low > 0 || entry.difference.high < 0),
    positions: usable.length,
    isolated,
  };
}
