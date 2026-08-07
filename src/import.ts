import fs from 'node:fs';
import path from 'node:path';

import type { ImportRequest, ImportResponse, LeagueAssets } from './gui/api.js';
import { SAFE_SEGMENT } from './path-safety.js';
import { appendRow, loadRows, type SeriesRecord } from './records.js';
import { createPool, listPools } from './teams.js';
import type { ExperimentMode, JsonObject, Pid } from './types.js';
import { isRecord } from './value.js';

export class ImportError extends Error {}

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

function runDirectory(runsDir: string, runId: string): string {
  const root = path.resolve(runsDir);
  const target = path.resolve(root, requireSegment(runId, 'run_id'));
  if (path.dirname(target) !== root) throw new ImportError('row.run_id must stay inside the runs directory');
  return target;
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

function validateJsonl(text: unknown, field: string): string {
  if (typeof text !== 'string') throw new ImportError(`${field} must be JSONL text`);
  if (Buffer.byteLength(text) > MAX_LOG_BYTES) throw new ImportError(`${field} is larger than 1 MB`);
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      JSON.parse(line);
    } catch {
      throw new ImportError(`${field} contains a line that is not JSON`);
    }
  }
  return text.endsWith('\n') ? text : `${text}\n`;
}

const GAME_LOG_NAME = /^game-\d{1,3}\.log$/;

function writeGameLogs(games: ImportRequest['games'], seriesDir: string): string[] {
  if (games === undefined) return [];
  if (!isRecord(games)) throw new ImportError('games must map log names to text');
  const written: string[] = [];
  for (const [name, text] of Object.entries(games)) {
    if (!GAME_LOG_NAME.test(name)) throw new ImportError(`games contains unsafe name ${JSON.stringify(name)}`);
    if (typeof text !== 'string') throw new ImportError(`games.${name} must be text`);
    if (Buffer.byteLength(text) > MAX_LOG_BYTES) throw new ImportError(`games.${name} is larger than 1 MB`);
    const target = path.join(seriesDir, name);
    if (fs.existsSync(target)) continue;
    fs.mkdirSync(seriesDir, { recursive: true });
    fs.writeFileSync(target, text, 'utf8');
    written.push(name);
  }
  return written;
}

const LEAGUE_FILES: Array<{ key: keyof LeagueAssets; file: string }> = [
  { key: 'rosters', file: 'rosters.json' },
  { key: 'draft', file: 'draft/draft.jsonl' },
  { key: 'teambuild', file: 'teambuild/teambuild.jsonl' },
  { key: 'window', file: 'window.json' },
  { key: 'season', file: 'season.jsonl' },
];

function writeLeagueAssets(league: ImportRequest['league'], runDir: string): string[] {
  if (league === undefined) return [];
  if (!isRecord(league)) throw new ImportError('league must be a JSON object');
  const written: string[] = [];
  for (const { key, file } of LEAGUE_FILES) {
    const value = league[key];
    if (value === undefined) continue;
    let text: string;
    if (key === 'rosters') {
      if (!Array.isArray(value)) throw new ImportError('league.rosters must be an array');
      text = `${JSON.stringify(value, null, 2)}\n`;
      if (Buffer.byteLength(text) > MAX_LOG_BYTES) throw new ImportError('league.rosters is larger than 1 MB');
    } else if (key === 'window') {
      if (!isRecord(value)) throw new ImportError('league.window must be an object');
      text = `${JSON.stringify(value, null, 2)}\n`;
      if (Buffer.byteLength(text) > MAX_LOG_BYTES) throw new ImportError('league.window is larger than 1 MB');
    } else {
      text = validateJsonl(value, `league.${key}`);
    }
    const target = path.join(runDir, file);
    if (fs.existsSync(target)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text, 'utf8');
    written.push(file);
  }
  return written;
}

function ensurePool(bundle: ImportRequest, options: ImportOptions): 'created' | 'present' | null {
  const pool = bundle.pool;
  if (!pool) return null;
  if (listPools(options.teamsDir).some((entry) => entry.name === pool.name)) return 'present';
  const teams = Array.isArray(pool.teams) ? pool.teams : [];
  if (pool.event !== undefined && !isRecord(pool.event)) throw new ImportError('pool.event must be a JSON object');
  if (pool.spreads !== undefined && !isRecord(pool.spreads)) throw new ImportError('pool.spreads must be a JSON object');
  try {
    createPool(
      String(pool.name),
      String(pool.format),
      { teams, ...(pool.event ? { event: pool.event } : {}), ...(pool.spreads ? { spreads: pool.spreads } : {}) },
      options.teamsDir,
    );
  } catch (error) {
    throw new ImportError(error instanceof Error ? error.message : String(error));
  }
  return 'created';
}

export interface RemoveResponse {
  removed: number;
  runId: string;
}

export function removeImportedRun(runId: string, options: ImportOptions): RemoveResponse {
  const runDir = runDirectory(options.runsDir, runId);
  const rows = loadRows(options.recordsPath);
  const target = rows.filter((row) => String(row.run_id ?? '') === runId);
  if (target.length === 0) throw new ImportError(`no series held for run ${JSON.stringify(runId)}`);
  if (!target.every(isImported)) throw new ImportError('refusing to remove locally recorded results');
  const keep = rows.filter((row) => String(row.run_id ?? '') !== runId);
  const text = keep.map((row) => JSON.stringify(row)).join('\n');
  const staged = `${options.recordsPath}.tmp`;
  fs.writeFileSync(staged, text.length ? `${text}\n` : '', 'utf8');
  fs.renameSync(staged, options.recordsPath);
  fs.rmSync(runDir, { recursive: true, force: true });
  return { removed: target.length, runId };
}

export function importSeries(bundle: ImportRequest, options: ImportOptions): ImportResponse {
  const row = validateRow(bundle.row);
  const runId = String(row.run_id);
  const seriesId = String(row.series_id);
  const logs: Array<{ pid: Pid; text: string }> = [];
  for (const pid of SEATS) {
    const text = bundle.logs?.[pid];
    if (text !== undefined) logs.push({ pid, text: validateJsonl(text, `logs.${pid}`) });
  }
  if (bundle.runConfig !== undefined && !isRecord(bundle.runConfig)) {
    throw new ImportError('runConfig must be a JSON object');
  }
  const known = new Set(loadRows(options.recordsPath).map(seriesKey));
  const pool = ensurePool(bundle, options);
  const runDir = runDirectory(options.runsDir, runId);
  const league = writeLeagueAssets(bundle.league, runDir);
  const seriesDir = path.join(runDir, 'series', seriesId);
  const games = writeGameLogs(bundle.games, seriesDir);
  if (known.has(seriesKey(row))) {
    return { imported: false, duplicate: true, runId, seriesId, logs: [], games, pool, league };
  }
  fs.mkdirSync(seriesDir, { recursive: true });
  for (const log of logs) fs.writeFileSync(path.join(seriesDir, `${log.pid}-decisions.jsonl`), log.text, 'utf8');
  const configPath = path.join(runDir, 'config.json');
  if (bundle.runConfig && !fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, `${JSON.stringify(bundle.runConfig, null, 2)}\n`, 'utf8');
  }
  const origin: RowOrigin = { source: 'import', at: new Date().toISOString() };
  appendRow(options.recordsPath, { ...row, origin } as JsonObject);
  return { imported: true, runId, seriesId, logs: logs.map((log) => log.pid), games, pool, league };
}
