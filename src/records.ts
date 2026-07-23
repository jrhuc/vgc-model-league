import fs from 'node:fs';
import path from 'node:path';

import type { ExperimentMode, JsonObject, Pid, TimerScale } from './types.js';

export interface SeriesRecord extends JsonObject {
  mode?: ExperimentMode;
  protocol_version?: number;
  scaffold?: string;
  draft_scaffold?: string;
  run_id?: string;
  series_index?: number;
  pool?: string;
  timer_scale?: TimerScale;
  contributor?: { provider: 'github'; subject: string; login: string };
  players: Record<Pid, string>;
  winner?: string | null;
}

/** Rows recorded before the timer-scale field existed all ran the standard 1x clock. */
function rowSpeed(row: SeriesRecord): TimerScale {
  return row.timer_scale === 'off' || typeof row.timer_scale === 'number' ? row.timer_scale : 1;
}

export function speedLabel(scale: TimerScale): string {
  return scale === 'off' ? 'Untimed' : `${scale}x clock`;
}

export function speedGroups(rows: SeriesRecord[]): Array<{ scale: TimerScale; rows: SeriesRecord[] }> {
  const groups = new Map<TimerScale, SeriesRecord[]>();
  for (const row of rows) {
    const scale = rowSpeed(row);
    const bucket = groups.get(scale);
    if (bucket) bucket.push(row);
    else groups.set(scale, [row]);
  }
  return [...groups.entries()]
    .map(([scale, grouped]) => ({ scale, rows: grouped }))
    .sort((a, b) => (a.scale === 'off' ? -1 : b.scale === 'off' ? 1 : a.scale - b.scale));
}

/** Ratings merge provider aliases by normalized model id. */
export function modelKey(spec: string): string {
  const model = spec.slice(spec.indexOf(':') + 1);
  return model.slice(model.lastIndexOf('/') + 1).toLowerCase();
}

export const TEST_POOL = 'test';

export function scopeRows(rows: SeriesRecord[], pool?: string): SeriesRecord[] {
  return pool === undefined
    ? rows.filter((row) => row.pool !== TEST_POOL && (row.mode ?? 'rotation') === 'rotation')
    : rows.filter((row) => row.pool === pool);
}

function playedRows(rows: SeriesRecord[]): SeriesRecord[] {
  return rows.filter(
    (row) =>
      (row.mode ?? 'rotation') === 'rotation' &&
      typeof row.players?.p1 === 'string' &&
      typeof row.players.p2 === 'string',
  );
}

export interface Standing {
  spec: string;
  series: number;
  w: number;
  l: number;
  t: number;
  winrate: number;
  elo: number;
}

export type HeadToHead = Record<string, Record<string, [number, number, number]>>;

export interface RatingGroup {
  scale: TimerScale;
  label: string;
  count: number;
  standings: Standing[];
  h2h: HeadToHead;
}

export function appendRow(file: string, row: JsonObject): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
}

export function loadRows(file: string): SeriesRecord[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as SeriesRecord);
}

function scheduled(rows: SeriesRecord[]): SeriesRecord[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const run = String(a.row.run_id ?? '').localeCompare(String(b.row.run_id ?? ''));
      if (run) return run;
      const aIndex = Number.isInteger(a.row.series_index) ? a.row.series_index! : a.index;
      const bIndex = Number.isInteger(b.row.series_index) ? b.row.series_index! : b.index;
      return aIndex - bIndex || a.index - b.index;
    })
    .map((item) => item.row);
}

function normalizedPlayers(row: SeriesRecord): { p1: string; p2: string; winner: string | null } {
  const { p1, p2 } = row.players;
  const winner = row.winner === p1 ? modelKey(p1) : row.winner === p2 ? modelKey(p2) : null;
  return { p1: modelKey(p1), p2: modelKey(p2), winner };
}

export function standings(rows: SeriesRecord[]): Standing[] {
  const ordered = scheduled(playedRows(rows)).map(normalizedPlayers);
  const specs = [...new Set(ordered.flatMap(({ p1, p2 }) => [p1, p2]))].sort();
  const ratings: Record<string, number> = Object.fromEntries(specs.map((spec) => [spec, 1000]));
  const totals: Record<string, { series: number; w: number; l: number; t: number }> = Object.fromEntries(
    specs.map((spec) => [spec, { series: 0, w: 0, l: 0, t: 0 }]),
  );
  for (const { p1, p2, winner } of ordered) {
    const score1 = winner === null ? 0.5 : Number(winner === p1);
    if (p1 !== p2) {
      const expected1 = 1 / (1 + 10 ** ((ratings[p2]! - ratings[p1]!) / 400));
      const old1 = ratings[p1]!;
      const old2 = ratings[p2]!;
      ratings[p1] = old1 + 24 * (score1 - expected1);
      ratings[p2] = old2 + 24 * (1 - score1 - (1 - expected1));
    }
    totals[p1]!.series += 1;
    totals[p2]!.series += 1;
    if (winner === null) {
      totals[p1]!.t += 1;
      totals[p2]!.t += 1;
    } else {
      totals[winner]!.w += 1;
      totals[winner === p1 ? p2 : p1]!.l += 1;
    }
  }
  return specs
    .map((spec) => {
      const total = totals[spec]!;
      return {
        spec,
        ...total,
        winrate: total.series ? (total.w + 0.5 * total.t) / total.series : 0,
        elo: ratings[spec]!,
      };
    })
    .sort((a, b) => b.elo - a.elo || a.spec.localeCompare(b.spec));
}

export function h2h(input: SeriesRecord[]): HeadToHead {
  const rows = playedRows(input).map(normalizedPlayers);
  const specs = [...new Set(rows.flatMap(({ p1, p2 }) => [p1, p2]))].sort();
  const matrix: HeadToHead = Object.fromEntries(
    specs.map((a) => [a, Object.fromEntries(specs.map((b) => [b, [0, 0, 0]]))]),
  );
  for (const { p1, p2, winner } of rows) {
    if (p1 === p2) {
      const cell = matrix[p1]![p1]!;
      if (winner === null) cell[2] += 2;
      else {
        cell[0] += 1;
        cell[1] += 1;
      }
    } else if (winner === null) {
      matrix[p1]![p2]![2] += 1;
      matrix[p2]![p1]![2] += 1;
    } else if (winner === p1) {
      matrix[p1]![p2]![0] += 1;
      matrix[p2]![p1]![1] += 1;
    } else {
      matrix[p1]![p2]![1] += 1;
      matrix[p2]![p1]![0] += 1;
    }
  }
  return matrix;
}

export function ratingGroups(rows: SeriesRecord[]): RatingGroup[] {
  return speedGroups(rows).map(({ scale, rows: grouped }) => ({
    scale,
    label: speedLabel(scale),
    count: grouped.length,
    standings: standings(grouped),
    h2h: h2h(grouped),
  }));
}
