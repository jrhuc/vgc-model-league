import fs from 'node:fs';
import path from 'node:path';

import { buildSeriesGame, isRunLive, scanUnfinishedSeries, viewTeamSheet } from './archive.js';
import type {
  ArchivedMatchView,
  BracketEntrantView,
  EvidenceResponse,
  LatencyPoint,
  LeagueGameResponse,
  ModelEvidence,
  SeriesLuckEntry,
  TournamentArchiveView,
  TournamentEventView,
  TournamentLiveSeriesView,
  TournamentSummary,
  TournamentsResponse,
} from './gui/api.js';
import { SAFE_SEGMENT } from './path-safety.js';
import { modelKey, type SeriesRecord, scopeRows, TEST_POOL } from './records.js';
import { loadPool } from './teams.js';
import { buildBracket } from './tournament.js';
import type { Pid } from './types.js';

const MAX_POINTS_PER_MODEL = 600;

const LUCK_FIELDS = ['misses', 'crits_taken', 'flinched_turns', 'full_paralysis'] as const;

interface StatBucket {
  providers: Set<string>;
  series: number;
  decisions: number;
  reflections: number;
  reflectionFallbacks: number;
  fallbacks: number;
  parseFailures: number;
  providerRetries: number;
  moveSelections: number;
  switchSelections: number;
  protectSelections: number;
  toolLookups: number;
  points: LatencyPoint[];
}

function bucket(): StatBucket {
  return {
    providers: new Set(),
    series: 0,
    decisions: 0,
    reflections: 0,
    reflectionFallbacks: 0,
    fallbacks: 0,
    parseFailures: 0,
    providerRetries: 0,
    moveSelections: 0,
    switchSelections: 0,
    protectSelections: 0,
    toolLookups: 0,
    points: [],
  };
}

export function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function decisionLogPath(runsDir: string, runId: string, seriesId: string, pid: Pid): string | null {
  if (!SAFE_SEGMENT.test(runId) || !SAFE_SEGMENT.test(seriesId)) return null;
  return path.join(runsDir, runId, 'series', seriesId, `${pid}-decisions.jsonl`);
}

export interface DecisionLogRow {
  kind: string;
  automatic: boolean;
  game: number;
  turn: number;
  phase: string;
  latencyMs: number | null;
  totalTokens: number | null;
  reasoningTokens: number | null;
}

const logCache = new Map<string, { mtimeMs: number; size: number; rows: DecisionLogRow[] }>();

/** Cached by mtime and size; decision logs of finished runs never change. */
export function readDecisionLog(file: string): DecisionLogRow[] {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    logCache.delete(file);
    return [];
  }
  const cached = logCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.rows;
  const rows: DecisionLogRow[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const numeric = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
    rows.push({
      kind: typeof entry.kind === 'string' ? entry.kind : '',
      automatic: entry.automatic === true,
      game: count(entry.game_number),
      turn: count(entry.turn),
      phase: typeof entry.phase === 'string' ? entry.phase : 'turn',
      latencyMs: numeric(entry.latency_ms),
      totalTokens: numeric(entry.total_tokens),
      reasoningTokens: numeric(entry.reasoning_tokens),
    });
  }
  logCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, rows });
  return rows;
}

function readLatencyPoints(file: string, seriesId: string): LatencyPoint[] {
  const points: LatencyPoint[] = [];
  for (const entry of readDecisionLog(file)) {
    if (entry.kind !== 'decision' || entry.automatic) continue;
    if (entry.latencyMs === null || entry.latencyMs <= 0) continue;
    const tokens = entry.totalTokens !== null && entry.totalTokens > 0 ? entry.totalTokens : undefined;
    points.push({
      ms: entry.latencyMs,
      ...(tokens === undefined ? {} : { tokens }),
      seriesId,
      game: entry.game,
      turn: entry.turn,
      phase: entry.phase,
    });
  }
  return points;
}

export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const position = (sorted.length - 1) * q;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return sorted[low]! + (sorted[high]! - sorted[low]!) * (position - low);
}

function adverseLuck(row: SeriesRecord, pid: Pid): number {
  const games = Array.isArray(row.games) ? row.games : [];
  let total = 0;
  for (const game of games) {
    const luck = (game as Record<string, unknown>).luck as Record<string, Record<string, unknown>> | undefined;
    for (const field of LUCK_FIELDS) total += count(luck?.[pid]?.[field]);
  }
  return total;
}

function luckEntry(row: SeriesRecord): SeriesLuckEntry {
  const games = Array.isArray(row.games) ? row.games : [];
  const score = row.score as Record<Pid, number> | undefined;
  const p1 = modelKey(row.players.p1);
  const p2 = modelKey(row.players.p2);
  const winner = row.winner === row.players.p1 ? p1 : row.winner === row.players.p2 ? p2 : null;
  const luck = { p1: adverseLuck(row, 'p1'), p2: adverseLuck(row, 'p2') };
  const winnerSide = row.winner === row.players.p1 ? 'p1' : row.winner === row.players.p2 ? 'p2' : null;
  return {
    seriesId: String(row.series_id ?? ''),
    runId: String(row.run_id ?? ''),
    timestamp: String(row.timestamp ?? ''),
    p1,
    p2,
    winner,
    score: [count(score?.p1), count(score?.p2)],
    games: games.length,
    turns: count(row.turns),
    luck,
    winnerLuckDelta: winnerSide === null ? null : luck[winnerSide] - luck[winnerSide === 'p1' ? 'p2' : 'p1'],
  };
}

function evenSample<T>(items: T[], cap: number): T[] {
  if (items.length <= cap) return items;
  const sampled: T[] = [];
  for (let index = 0; index < cap; index += 1) {
    sampled.push(items[Math.floor((index * items.length) / cap)]!);
  }
  return sampled;
}

interface TournamentBucket {
  entered: number;
  titles: number;
  runnerUp: number;
  semis: number;
  earlier: number;
}

function summarizeTournaments(rows: SeriesRecord[]): TournamentSummary {
  const runs = new Map<string, SeriesRecord[]>();
  for (const row of rows) {
    if (!row.players?.p1 || !row.players?.p2) continue;
    const runId = String(row.run_id ?? '');
    const list = runs.get(runId) ?? [];
    list.push(row);
    runs.set(runId, list);
  }
  const buckets = new Map<string, TournamentBucket>();
  const bucketFor = (spec: string) => {
    const entry = buckets.get(spec) ?? {
      entered: 0,
      titles: 0,
      runnerUp: 0,
      semis: 0,
      earlier: 0,
    };
    buckets.set(spec, entry);
    return entry;
  };
  let matches = 0;
  for (const runRows of runs.values()) {
    const maxRound = Math.max(...runRows.map((row) => count(row.round)));
    const finalRows = runRows.filter((row) => count(row.round) === maxRound);
    const champion = finalRows.length === 1 ? modelKey(String(finalRows[0]!.advanced ?? '')) : null;
    const lastRound = new Map<string, number>();
    for (const row of runRows) {
      matches += 1;
      for (const pid of ['p1', 'p2'] as const) {
        const spec = modelKey(row.players[pid]);
        lastRound.set(spec, Math.max(lastRound.get(spec) ?? 0, count(row.round)));
      }
    }
    for (const [spec, round] of lastRound) {
      const entry = bucketFor(spec);
      entry.entered += 1;
      if (spec === champion) entry.titles += 1;
      else if (round === maxRound) entry.runnerUp += 1;
      else if (round === maxRound - 1) entry.semis += 1;
      else entry.earlier += 1;
    }
  }
  return {
    tournaments: runs.size,
    matches,
    records: [...buckets.entries()]
      .map(([spec, entry]) => ({ spec, ...entry }))
      .sort((a, b) => a.spec.localeCompare(b.spec)),
  };
}

export function buildEvidence(allRows: SeriesRecord[], runsDir: string, pool: string | null): EvidenceResponse {
  const rated = scopeRows(allRows, pool ?? undefined)
    .filter((row) => row.players?.p1 && row.players?.p2)
    .sort((a, b) => String(a.timestamp ?? '').localeCompare(String(b.timestamp ?? '')));
  const buckets = new Map<string, StatBucket>();
  for (const row of rated) {
    const stats = row.decision_stats as Record<Pid, Record<string, unknown>> | undefined;
    for (const pid of ['p1', 'p2'] as const) {
      const spec = row.players[pid];
      const sideStats = stats?.[pid];
      if (!sideStats || count(sideStats.decisions) === 0) continue;
      const key = modelKey(spec);
      const entry = buckets.get(key) ?? bucket();
      buckets.set(key, entry);
      entry.providers.add(spec);
      entry.series += 1;
      entry.decisions += count(sideStats.decisions);
      entry.reflections += count(sideStats.reflections);
      entry.reflectionFallbacks += count(sideStats.reflection_fallbacks);
      entry.fallbacks += count(sideStats.fallbacks);
      entry.parseFailures += count(sideStats.parse_failures);
      entry.providerRetries += count(sideStats.provider_retries);
      entry.moveSelections += count(sideStats.move_selections);
      entry.switchSelections += count(sideStats.switch_selections);
      entry.protectSelections += count(sideStats.protect_selections);
      entry.toolLookups += count(sideStats.tool_lookups);
      const file = decisionLogPath(runsDir, String(row.run_id ?? ''), String(row.series_id ?? ''), pid);
      if (file) entry.points.push(...readLatencyPoints(file, String(row.series_id ?? '')));
    }
  }
  const models: ModelEvidence[] = [...buckets.entries()]
    .map(([spec, entry]) => {
      const sorted = entry.points.map((point) => point.ms).sort((a, b) => a - b);
      const tokenValues = entry.points
        .map((point) => point.tokens)
        .filter((tokens): tokens is number => tokens !== undefined)
        .sort((a, b) => a - b);
      const selections = entry.moveSelections + entry.switchSelections;
      const summary = (values: number[]) =>
        values.length === 0
          ? null
          : {
              median: quantile(values, 0.5),
              p25: quantile(values, 0.25),
              p75: quantile(values, 0.75),
              max: values[values.length - 1]!,
            };
      return {
        spec,
        providers: [...entry.providers].sort(),
        series: entry.series,
        decisions: entry.decisions,
        reflections: entry.reflections,
        latency: summary(sorted),
        tokens: summary(tokenValues),
        points: evenSample(entry.points, MAX_POINTS_PER_MODEL),
        rates: {
          fallback: entry.decisions ? entry.fallbacks / entry.decisions : 0,
          parseFailure: entry.decisions ? entry.parseFailures / entry.decisions : 0,
          providerRetry: entry.decisions ? entry.providerRetries / entry.decisions : 0,
          switch: selections ? entry.switchSelections / selections : 0,
          protect: selections ? entry.protectSelections / selections : 0,
          toolLookups: entry.decisions ? entry.toolLookups / entry.decisions : 0,
          reflectionFallback: entry.reflections ? entry.reflectionFallbacks / entry.reflections : null,
        },
      };
    })
    .sort((a, b) => a.spec.localeCompare(b.spec));
  return {
    pool,
    count: rated.length,
    decisions: models.reduce((total, model) => total + model.decisions, 0),
    models,
    series: rated.map(luckEntry),
  };
}

function liveTournamentRuns(runsDir: string): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(runsDir);
  } catch {
    return [];
  }
  return entries.filter(
    (runId) =>
      SAFE_SEGMENT.test(runId) && runConfig(runsDir, runId)?.mode === 'tournament' && isRunLive(runsDir, runId),
  );
}

function runConfig(runsDir: string, runId: string): Record<string, unknown> | null {
  if (!SAFE_SEGMENT.test(runId)) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(runsDir, runId, 'config.json'), 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function runStartedAt(runsDir: string, runId: string): string {
  if (!SAFE_SEGMENT.test(runId)) return '';
  try {
    const status = JSON.parse(fs.readFileSync(path.join(runsDir, runId, 'status.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    return typeof status.start_time === 'string' ? status.start_time : '';
  } catch {
    return '';
  }
}

function configEntrants(runsDir: string, runId: string): BracketEntrantView[] | null {
  const config = runConfig(runsDir, runId);
  if (!config || !Array.isArray(config.entrants)) return null;
  const entrants = (config.entrants as Array<Record<string, unknown>>).map((entry) => ({
    model: String(entry.model ?? ''),
    team: String(entry.team ?? ''),
    seed: typeof entry.seed === 'number' ? entry.seed : null,
    placement: typeof entry.placement === 'number' ? entry.placement : null,
  }));
  return entrants.every((entry: BracketEntrantView) => entry.model) ? entrants : null;
}

function poolProvenance(
  poolId: string | null,
  teamsDir?: string,
): {
  event: TournamentEventView | null;
  teams: Map<string, BracketEntrantView>;
} {
  const teams = new Map<string, BracketEntrantView>();
  if (!poolId) return { event: null, teams };
  try {
    const pool = loadPool(poolId, teamsDir);
    for (const team of pool.teams) {
      teams.set(team.id, {
        model: '',
        team: team.id,
        seed: team.seed ?? null,
        placement: team.provenance?.placement ?? null,
        player: team.provenance?.player ?? '',
        paste: team.provenance?.paste ?? '',
        teamSheet: viewTeamSheet(team.packed),
      });
    }
    const event = pool.event;
    return {
      event: event
        ? {
            name: event.name,
            game: event.game,
            regulation: event.regulation,
            location: event.location,
            dates: event.dates,
            players: event.players,
            structure: event.structure,
            url: event.url,
            reconstructedSpreads: event.reconstructedSpreads,
          }
        : null,
      teams,
    };
  } catch {
    return { event: null, teams };
  }
}

function rowEntrants(rows: SeriesRecord[]): BracketEntrantView[] | null {
  const size = rows.map((row) => count(row.entrant_count)).find((value) => value >= 2);
  if (!size) return null;
  const bySeed = new Map<number, BracketEntrantView>();
  for (const row of rows) {
    const seeds = row.seeds as Record<Pid, unknown> | undefined;
    for (const pid of ['p1', 'p2'] as const) {
      const seed = seeds?.[pid];
      if (typeof seed !== 'number' || seed < 0 || seed >= size) return null;
      bySeed.set(seed, {
        model: row.players[pid],
        team: String((row.teams as Record<Pid, unknown> | undefined)?.[pid] ?? ''),
      });
    }
  }
  if (bySeed.size !== size) return null;
  return Array.from({ length: size }, (_, seed) => bySeed.get(seed)!);
}

function entrantForModel(entrants: BracketEntrantView[], spec: string): number | null {
  const exact = entrants.findIndex((entrant) => entrant.model === spec);
  if (exact >= 0) return exact;
  const matches = entrants
    .map((entrant, index) => (modelKey(entrant.model) === modelKey(spec) ? index : -1))
    .filter((index) => index >= 0);
  return matches.length === 1 ? matches[0]! : null;
}

function liveTournamentSeriesIndex(
  entrants: BracketEntrantView[],
  rounds: ArchivedMatchView[][],
  entry: { seriesIndex: number | null; players?: Record<Pid, string> | null },
): number | null {
  if (entry.seriesIndex !== null) return entry.seriesIndex;
  if (!entry.players) return null;
  const first = entrantForModel(entrants, entry.players.p1);
  const second = entrantForModel(entrants, entry.players.p2);
  if (first === null || second === null) return null;
  const pair = new Set([first, second]);
  for (const round of rounds) {
    for (const match of round) {
      if (match.seriesIndex === null || match.slots[0] === null || match.slots[1] === null) continue;
      if (pair.has(match.slots[0]) && pair.has(match.slots[1])) return match.seriesIndex;
    }
  }
  return null;
}

function archiveTournament(
  runId: string,
  rows: SeriesRecord[],
  runsDir: string,
  teamsDir?: string,
): TournamentArchiveView | null {
  const entrants = rowEntrants(rows) ?? configEntrants(runsDir, runId);
  if (!entrants || entrants.length < 2) return null;
  const bySeries = new Map<number, SeriesRecord>();
  for (const row of rows) bySeries.set(count(row.series_index), row);
  const rounds: ArchivedMatchView[][] = [];
  const winners = new Map<number, number | null>();
  for (const [roundIndex, round] of buildBracket(entrants.length).entries()) {
    const views: ArchivedMatchView[] = [];
    for (const [matchIndex, match] of round.entries()) {
      const slots: [number | null, number | null] =
        roundIndex === 0
          ? [...match.slots]
          : [winners.get(matchIndex * 2) ?? null, winners.get(matchIndex * 2 + 1) ?? null];
      let winner = match.seriesIndex === null ? (slots[0] ?? slots[1]) : null;
      let score: [number, number] | null = null;
      let turns: number | null = null;
      const row = match.seriesIndex === null ? undefined : bySeries.get(match.seriesIndex);
      if (row) {
        const sideScore = row.score as Record<Pid, number> | undefined;
        score = [count(sideScore?.p1), count(sideScore?.p2)];
        turns = count(row.turns);
        if (row.winner_side === 'p1') winner = slots[0];
        else if (row.winner_side === 'p2') winner = slots[1];
      }
      views.push({ seriesIndex: match.seriesIndex, slots, winner, score, turns });
    }
    for (const [matchIndex, view] of views.entries()) winners.set(matchIndex, view.winner);
    rounds.push(views);
  }
  const champion = rounds[rounds.length - 1]![0]!.winner;
  const timestamps = rows.map((row) => String(row.timestamp ?? '')).filter(Boolean);
  const config = runConfig(runsDir, runId);
  const poolField = rows.find((row) => typeof row.pool === 'string')?.pool ?? config?.pool;
  const pool = typeof poolField === 'string' ? poolField : null;
  const { event, teams } = poolProvenance(pool, teamsDir);
  const detailed = entrants.map((entrant) => ({
    ...entrant,
    ...(teams.get(entrant.team) ?? {}),
    model: entrant.model,
  }));
  const live = isRunLive(runsDir, runId);
  const slotsOf = new Map<number, [number | null, number | null]>();
  for (const [roundIndex, round] of rounds.entries()) {
    for (const [matchIndex, view] of round.entries()) {
      const source = buildBracket(entrants.length)[roundIndex]![matchIndex]!;
      if (source.seriesIndex !== null) slotsOf.set(source.seriesIndex, view.slots);
    }
  }
  const roundOf = new Map<number, number>();
  for (const [roundIndex, round] of buildBracket(entrants.length).entries()) {
    for (const match of round) if (match.seriesIndex !== null) roundOf.set(match.seriesIndex, roundIndex);
  }
  const liveSeries: TournamentLiveSeriesView[] = live
    ? scanUnfinishedSeries(runsDir, runId, rows)
        .filter((entry) => entry.decisions > 0 || entry.players)
        .map((entry) => {
          const seriesIndex = liveTournamentSeriesIndex(detailed, rounds, entry);
          return {
            seriesId: entry.seriesId,
            seriesIndex,
            round: seriesIndex === null ? null : (roundOf.get(seriesIndex) ?? null),
            slots: seriesIndex === null ? [null, null] : (slotsOf.get(seriesIndex) ?? [null, null]),
            game: entry.game,
            turn: entry.turn,
            decisions: entry.decisions,
          };
        })
    : [];
  const provenance = config?.provenance;
  return {
    runId,
    when: timestamps.sort()[0] ?? runStartedAt(runsDir, runId),
    pool,
    entrants: detailed,
    rounds,
    champion,
    complete: champion !== null,
    live,
    liveSeries,
    event,
    provenance: provenance === 'disclosed' || provenance === 'blind' ? provenance : null,
  };
}

export function buildTournamentGame(
  allRows: SeriesRecord[],
  runsDir: string,
  runId: string,
  seriesIndex: number,
  game: number,
  teamsDir?: string,
): LeagueGameResponse | null {
  if (!SAFE_SEGMENT.test(runId)) return null;
  const rows = allRows.filter((row) => row.mode === 'tournament' && String(row.run_id ?? '') === runId);
  const archive = archiveTournament(runId, rows, runsDir, teamsDir);
  if (!archive) return null;
  const bracket = buildBracket(archive.entrants.length);
  let slots: [number | null, number | null] | null = null;
  let roundIndex = 0;
  for (const [index, round] of bracket.entries()) {
    for (const [matchIndex, match] of round.entries()) {
      if (match.seriesIndex !== seriesIndex) continue;
      slots = archive.rounds[index]![matchIndex]!.slots;
      roundIndex = index;
    }
  }
  if (!slots || slots[0] === null || slots[1] === null) return null;
  const row = rows.find((entry) => count(entry.series_index) === seriesIndex);
  const seriesId =
    row !== undefined
      ? String(row.series_id ?? '')
      : (scanUnfinishedSeries(runsDir, runId, rows).find(
          (entry) => liveTournamentSeriesIndex(archive.entrants, archive.rounds, entry) === seriesIndex,
        )?.seriesId ?? '');
  if (!seriesId) return null;
  return buildSeriesGame(
    runsDir,
    runId,
    seriesIndex,
    game,
    {
      seriesId,
      sides: [slots[0], slots[1]],
      stage: 'playoff',
      round: roundIndex + 1,
      models: archive.entrants.map((entrant) => entrant.model),
      labels: archive.entrants.map((entrant) => entrant.team || entrant.model),
    },
    row,
  );
}

export function buildTournaments(
  allRows: SeriesRecord[],
  runsDir: string,
  pool: string | null,
  teamsDir?: string,
): TournamentsResponse {
  const tournamentRows = allRows.filter(
    (row) =>
      row.mode === 'tournament' &&
      typeof row.players?.p1 === 'string' &&
      typeof row.players?.p2 === 'string' &&
      (pool === null ? row.pool !== TEST_POOL : row.pool === pool),
  );
  const pools = [
    ...new Set(
      allRows
        .filter((row) => row.mode === 'tournament')
        .map((row) => (typeof row.pool === 'string' ? row.pool : ''))
        .filter(Boolean),
    ),
  ].sort();
  const runs = new Map<string, SeriesRecord[]>();
  for (const row of tournamentRows) {
    const runId = String(row.run_id ?? '');
    if (!runId) continue;
    const list = runs.get(runId) ?? [];
    list.push(row);
    runs.set(runId, list);
  }
  for (const runId of liveTournamentRuns(runsDir)) if (!runs.has(runId)) runs.set(runId, []);
  const tournaments = [...runs.entries()]
    .map(([runId, rows]) => archiveTournament(runId, rows, runsDir, teamsDir))
    .filter((archive): archive is TournamentArchiveView => archive !== null)
    .sort((a, b) => b.when.localeCompare(a.when));
  return { pool, pools, summary: summarizeTournaments(tournamentRows), tournaments };
}
