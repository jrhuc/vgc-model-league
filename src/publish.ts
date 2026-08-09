import fs from 'node:fs';
import path from 'node:path';

import type { AppState, ImportRequest, ImportResponse } from './gui/api.js';
import { isImported } from './import.js';
import { loadSeriesRecords, type SeriesRecord, TEST_POOL } from './records.js';
import { exportTeam, loadPool } from './teams.js';
import type { Pid } from './types.js';

const SEATS: Pid[] = ['p1', 'p2'];
const REQUEST_TIMEOUT_MS = 120_000;

export interface PublishOptions {
  origin: string;
  token: string;
  recordsPath: string;
  runsDir: string;
  teamsDir: string;
  runs?: string[];
  pool?: string;
  includeTest?: boolean;
  dryRun?: boolean;
  log?: (line: string) => void;
}

export interface PublishSummary {
  published: number;
  duplicates: number;
  poolsCreated: string[];
}

function selectable(rows: SeriesRecord[], options: PublishOptions): SeriesRecord[] {
  const local = rows.filter((row) => !isImported(row));
  if (options.runs !== undefined) {
    const wanted = new Set(options.runs);
    const missing = options.runs.filter((id) => !local.some((row) => String(row.run_id ?? '') === id));
    if (missing.length > 0) throw new Error(`no local series recorded for ${missing.join(', ')}`);
    return local.filter((row) => wanted.has(String(row.run_id ?? '')));
  }
  if (options.pool !== undefined) return local.filter((row) => row.pool === options.pool);
  return local.filter((row) => options.includeTest === true || row.pool !== TEST_POOL);
}

function readLog(runsDir: string, row: SeriesRecord, pid: Pid): string | undefined {
  const file = path.join(
    runsDir,
    String(row.run_id ?? ''),
    'series',
    String(row.series_id ?? ''),
    `${pid}-decisions.jsonl`,
  );
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

function readGameLogs(runsDir: string, row: SeriesRecord): Record<string, string> | undefined {
  const dir = path.join(runsDir, String(row.run_id ?? ''), 'series', String(row.series_id ?? ''));
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return undefined;
  }
  const games: Record<string, string> = {};
  for (const name of names) {
    if (!/^game-\d+\.log$/.test(name)) continue;
    try {
      games[name] = fs.readFileSync(path.join(dir, name), 'utf8');
    } catch {}
  }
  return Object.keys(games).length > 0 ? games : undefined;
}

function readRunConfig(runsDir: string, runId: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(runsDir, runId, 'config.json'), 'utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function readLeagueAssets(runsDir: string, runId: string): ImportRequest['league'] {
  const runDir = path.join(runsDir, runId);
  const read = (file: string): string | undefined => {
    try {
      return fs.readFileSync(path.join(runDir, file), 'utf8');
    } catch {
      return undefined;
    }
  };
  const league: NonNullable<ImportRequest['league']> = {};
  const rosters = read('rosters.json');
  if (rosters !== undefined) {
    const parsed: unknown = JSON.parse(rosters);
    if (Array.isArray(parsed)) league.rosters = parsed;
  }
  const draft = read(path.join('draft', 'draft.jsonl'));
  if (draft !== undefined) league.draft = draft;
  const teambuild = read(path.join('teambuild', 'teambuild.jsonl'));
  if (teambuild !== undefined) league.teambuild = teambuild;
  const season = read('season.jsonl');
  if (season !== undefined) league.season = season;
  const window = read('window.json');
  if (window !== undefined) {
    const parsed: unknown = JSON.parse(window);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      league.window = parsed as Record<string, unknown>;
    }
  }
  return Object.keys(league).length > 0 ? league : undefined;
}

async function exportPool(name: string, teamsDir: string): Promise<NonNullable<ImportRequest['pool']>> {
  const pool = loadPool(name, teamsDir);
  return {
    name: pool.id,
    format: pool.format,
    ...pool.metadata,
    teams: pool.teams.map((team) => {
      return {
        id: team.id,
        paste: exportTeam(team.packed, pool.format),
        ...(team.seed === undefined ? {} : { seed: team.seed }),
        ...(team.source ? { source: team.source } : {}),
      };
    }),
  };
}

async function get<T>(origin: string, route: string): Promise<T> {
  const response = await fetch(new URL(route, origin), { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${route} answered ${response.status}`);
  return (await response.json()) as T;
}

async function post(origin: string, token: string, bundle: ImportRequest): Promise<ImportResponse> {
  const response = await fetch(new URL('/api/import', origin), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(bundle),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`import rejected with ${response.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text) as ImportResponse;
}

export async function publishRecords(options: PublishOptions): Promise<PublishSummary> {
  const log = options.log ?? (() => {});
  const rows = selectable(loadSeriesRecords(options.recordsPath), options);
  if (rows.length === 0) throw new Error('no local series match the selection');
  const remote = await get<AppState>(options.origin, '/api/state');
  const remotePools = new Set(remote.pools.map((entry) => entry.name));
  const summary: PublishSummary = { published: 0, duplicates: 0, poolsCreated: [] };
  const sentConfigs = new Set<string>();
  let warnedGames = false;
  for (const row of rows) {
    const runId = String(row.run_id ?? '');
    const label = `${row.players.p1} vs ${row.players.p2} (${String(row.mode ?? 'rotation')}, ${runId.slice(0, 15)})`;
    const bundle: ImportRequest = { row: row as Record<string, unknown> };
    const logs: Partial<Record<Pid, string>> = {};
    for (const pid of SEATS) {
      const text = readLog(options.runsDir, row, pid);
      if (text !== undefined) logs[pid] = text;
    }
    if (Object.keys(logs).length > 0) bundle.logs = logs;
    const games = readGameLogs(options.runsDir, row);
    if (games) bundle.games = games;
    if (!sentConfigs.has(runId)) {
      const config = readRunConfig(options.runsDir, runId);
      if (config) bundle.runConfig = config;
      const league = readLeagueAssets(options.runsDir, runId);
      if (league) bundle.league = league;
      sentConfigs.add(runId);
    }
    const pool = typeof row.pool === 'string' ? row.pool : '';
    if (pool && !remotePools.has(pool)) bundle.pool = await exportPool(pool, options.teamsDir);
    if (options.dryRun) {
      const extras = [bundle.pool ? `pool ${pool}` : '', bundle.league ? 'league assets' : ''].filter(Boolean);
      log(`would publish ${label}${extras.length > 0 ? ` with ${extras.join(' and ')}` : ''}`);
      if (bundle.pool) remotePools.add(pool);
      continue;
    }
    const result = await post(options.origin, options.token, bundle);
    if (result.pool === 'created') {
      remotePools.add(pool);
      summary.poolsCreated.push(pool);
    }
    if (result.imported) summary.published += 1;
    else summary.duplicates += 1;
    log(
      `${result.imported ? 'published' : 'already there'}: ${label}${
        result.games?.length ? ` (+${result.games.length} game logs)` : ''
      }`,
    );
    if (bundle.league) {
      if (!Array.isArray(result.league))
        log(`WARNING: server ignored league assets for ${runId} — deploy a newer server and re-publish`);
      else if (result.league.length > 0) log(`league assets stored: ${result.league.join(', ')}`);
    }
    if (bundle.games && result.games === undefined && !warnedGames) {
      log('WARNING: server ignored game logs — deploy a newer server and re-publish');
      warnedGames = true;
    }
  }
  if (options.dryRun) log(`${rows.length} series selected; nothing sent`);
  return summary;
}
