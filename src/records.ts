import fs from 'node:fs';
import path from 'node:path';

import type { ExperimentMode, JsonObject, Pid, TimerScale } from './types.js';

export interface SeriesRecord extends JsonObject {
  mode?: ExperimentMode;
  protocol_version?: number;
  scaffold?: string;
  draft_scaffold?: string;
  teambuild_scaffold?: string;
  window_scaffold?: string;
  season_scaffold?: string;
  run_id?: string;
  series_index?: number;
  pool?: string;
  timer_scale?: TimerScale;
  trade_window?: { after_week: number; trades_allowed?: number } | null;
  contributor?: { provider: 'github'; subject: string; login: string };
  players: Record<Pid, string>;
  winner?: string | null;
}

/** Normalizes provider-qualified specs when joining one model across archived evidence. */
export function modelKey(spec: string): string {
  const model = spec.slice(spec.indexOf(':') + 1);
  return model
    .slice(model.lastIndexOf('/') + 1)
    .toLowerCase()
    .replace(/:(?:nitro|floor|free)$/, '');
}

export const TEST_POOL = 'test';

export function scopeRows(rows: SeriesRecord[], pool?: string): SeriesRecord[] {
  return pool === undefined ? rows.filter((row) => row.pool !== TEST_POOL) : rows.filter((row) => row.pool === pool);
}

export function appendRow(file: string, row: JsonObject): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
}

const rowCache = new Map<string, { mtimeMs: number; size: number; rows: SeriesRecord[] }>();

/** Cached by mtime and size; callers must treat the returned rows as immutable. */
export function loadRows(file: string): SeriesRecord[] {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    rowCache.delete(file);
    return [];
  }
  const cached = rowCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.rows;
  const rows = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as SeriesRecord);
  rowCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, rows });
  return rows;
}
