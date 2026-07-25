import fs from 'node:fs';
import path from 'node:path';

import type { ImportRequest, ImportResponse } from './gui/api.js';
import { appendRow, loadRows, type SeriesRecord } from './records.js';
import { createPool, listPools } from './teams.js';
import type { ExperimentMode, JsonObject, Pid } from './types.js';
import { isRecord } from './value.js';

export class ImportError extends Error {}

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;
const MODES: Record<ExperimentMode, true> = { rotation: true, exhibition: true, tournament: true, draft: true };
const SEATS: Pid[] = ['p1', 'p2'];
const MAX_LOG_BYTES = 1_000_000;

export interface ImportOptions {
  recordsPath: string;
  runsDir: string;
  teamsDir: string;
}

export interface RowOrigin extends JsonObject {
  source: 'import';
  at: string;
}

export function isImported(row: SeriesRecord): boolean {
  return isRecord(row.origin) && row.origin.source === 'import';
}

export function seriesKey(row: SeriesRecord): string {
  return `${String(row.run_id ?? '')}/${String(row.series_id ?? '')}`;
}

function requireSegment(value: unknown, field: string): string {
  const text = typeof value === 'string' ? value : '';
  if (!SAFE_SEGMENT.test(text)) throw new ImportError(`row.${field} must be a path-safe identifier`);
  return text;
}

function validateRow(candidate: unknown): SeriesRecord {
  if (!isRecord(candidate)) throw new ImportError('row must be a JSON object');
  const row = candidate as SeriesRecord;
  const players = row.players;
  if (!isRecord(players) || typeof players.p1 !== 'string' || typeof players.p2 !== 'string' || !players.p1) {
    throw new ImportError('row.players must name both seats');
  }
  requireSegment(row.run_id, 'run_id');
  requireSegment(row.series_id, 'series_id');
  if (typeof row.timestamp !== 'string' || !row.timestamp) throw new ImportError('row.timestamp is required');
  if (row.mode !== undefined && !MODES[row.mode]) throw new ImportError(`unknown mode ${JSON.stringify(row.mode)}`);
  if (row.pool !== undefined && typeof row.pool !== 'string') throw new ImportError('row.pool must be a string');
  return row;
}

function validateLog(text: unknown, pid: Pid): string {
  if (typeof text !== 'string') throw new ImportError(`logs.${pid} must be JSONL text`);
  if (Buffer.byteLength(text) > MAX_LOG_BYTES) throw new ImportError(`logs.${pid} is larger than 1 MB`);
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      JSON.parse(line);
    } catch {
      throw new ImportError(`logs.${pid} contains a line that is not JSON`);
    }
  }
  return text.endsWith('\n') ? text : `${text}\n`;
}

function ensurePool(bundle: ImportRequest, options: ImportOptions): 'created' | 'present' | null {
  const pool = bundle.pool;
  if (!pool) return null;
  if (listPools(options.teamsDir).some((entry) => entry.name === pool.name)) return 'present';
  const teams = Array.isArray(pool.teams) ? pool.teams : [];
  try {
    createPool(String(pool.name), String(pool.format), teams, options.teamsDir);
  } catch (error) {
    throw new ImportError(error instanceof Error ? error.message : String(error));
  }
  return 'created';
}

export function importSeries(bundle: ImportRequest, options: ImportOptions): ImportResponse {
  const row = validateRow(bundle.row);
  const runId = String(row.run_id);
  const seriesId = String(row.series_id);
  const logs: Array<{ pid: Pid; text: string }> = [];
  for (const pid of SEATS) {
    const text = bundle.logs?.[pid];
    if (text !== undefined) logs.push({ pid, text: validateLog(text, pid) });
  }
  if (bundle.runConfig !== undefined && !isRecord(bundle.runConfig)) {
    throw new ImportError('runConfig must be a JSON object');
  }
  const known = new Set(loadRows(options.recordsPath).map(seriesKey));
  const pool = ensurePool(bundle, options);
  if (known.has(seriesKey(row))) {
    return { imported: false, duplicate: true, runId, seriesId, logs: [], pool };
  }
  const runDir = path.join(options.runsDir, runId);
  const seriesDir = path.join(runDir, 'series', seriesId);
  fs.mkdirSync(seriesDir, { recursive: true });
  for (const log of logs) fs.writeFileSync(path.join(seriesDir, `${log.pid}-decisions.jsonl`), log.text, 'utf8');
  const configPath = path.join(runDir, 'config.json');
  if (bundle.runConfig && !fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, `${JSON.stringify(bundle.runConfig, null, 2)}\n`, 'utf8');
  }
  const origin: RowOrigin = { source: 'import', at: new Date().toISOString() };
  appendRow(options.recordsPath, { ...row, origin } as JsonObject);
  return { imported: true, runId, seriesId, logs: logs.map((log) => log.pid), pool };
}
