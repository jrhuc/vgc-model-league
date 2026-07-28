import fs from 'node:fs';
import path from 'node:path';
import { count, decisionLogPath, quantile, readDecisionLog, SAFE_SEGMENT } from './evidence.js';
import type {
  LeagueCardView,
  LeagueChampionView,
  LeagueFranchiseView,
  LeagueResponse,
  LeagueRosterSlotView,
  LeagueSeriesView,
  LeaguesResponse,
  LeagueTeambuildView,
  ModelProfileResponse,
  ModeRecordView,
  QuartileView,
  TeambuildSetView,
} from './gui/api.js';
import { modelKey, type SeriesRecord, TEST_POOL } from './records.js';
import type { Pid } from './types.js';

const PIDS: Pid[] = ['p1', 'p2'];

function draftRuns(allRows: SeriesRecord[]): Map<string, SeriesRecord[]> {
  const runs = new Map<string, SeriesRecord[]>();
  for (const row of allRows) {
    if (row.mode !== 'draft' || !row.players?.p1 || !row.players?.p2) continue;
    const runId = String(row.run_id ?? '');
    if (!SAFE_SEGMENT.test(runId)) continue;
    const list = runs.get(runId) ?? [];
    list.push(row);
    runs.set(runId, list);
  }
  for (const list of runs.values()) list.sort((a, b) => count(a.series_index) - count(b.series_index));
  return runs;
}

function readRunJson(runsDir: string, runId: string, ...segments: string[]): unknown {
  try {
    return JSON.parse(fs.readFileSync(path.join(runsDir, runId, ...segments), 'utf8'));
  } catch {
    return null;
  }
}

function readRunLines(runsDir: string, runId: string, ...segments: string[]): Record<string, unknown>[] {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(runsDir, runId, ...segments), 'utf8');
  } catch {
    return [];
  }
  const rows: Record<string, unknown>[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // a torn tail line on a live run is not an error
    }
  }
  return rows;
}

interface LeagueIdentity {
  models: string[];
  teamNames: string[];
  weeks: number | null;
  board: string | null;
  format: string | null;
}

function leagueIdentity(runsDir: string, runId: string, rows: SeriesRecord[]): LeagueIdentity {
  const config = readRunJson(runsDir, runId, 'config.json') as Record<string, unknown> | null;
  const entrants = Array.isArray(config?.entrants) ? config.entrants.map(String) : null;
  const teamNames = Array.isArray(config?.team_names) ? config.team_names.map(String) : null;
  if (entrants && teamNames && entrants.length === teamNames.length && entrants.length >= 2) {
    return {
      models: entrants,
      teamNames,
      weeks: typeof config?.weeks === 'number' ? config.weeks : null,
      board: typeof config?.board === 'string' ? config.board : null,
      format: typeof config?.format === 'string' ? config.format : null,
    };
  }
  const models: string[] = [];
  const names: string[] = [];
  for (const row of rows) {
    for (const pid of PIDS) {
      const name = String((row.teams as Record<Pid, unknown> | undefined)?.[pid] ?? '').replace(/\s+wk\d+$/, '');
      if (!name || names.includes(name)) continue;
      names.push(name);
      models.push(row.players[pid]);
    }
  }
  const sample = rows[0];
  return {
    models,
    teamNames: names,
    weeks: null,
    board: typeof sample?.board === 'string' ? sample.board : null,
    format: typeof sample?.format === 'string' ? sample.format : null,
  };
}

function sideEntrant(row: SeriesRecord, pid: Pid, identity: LeagueIdentity): number {
  const label = String((row.teams as Record<Pid, unknown> | undefined)?.[pid] ?? '');
  const byTeam = identity.teamNames.findIndex((name) => label === name || label.startsWith(`${name} `));
  if (byTeam >= 0) return byTeam;
  return identity.models.indexOf(row.players[pid]);
}

interface LeagueProgress {
  phase: 'roundrobin' | 'playoffs' | 'complete';
  week: number;
  champion: LeagueChampionView | null;
  finalists: [number, number] | null;
  eliminatedRound: Map<number, number>;
}

function leagueProgress(rows: SeriesRecord[], identity: LeagueIdentity): LeagueProgress {
  const playoffRows = rows.filter((row) => row.stage === 'playoff');
  const week = Math.max(0, ...rows.filter((row) => row.stage === 'roundrobin').map((row) => count(row.round)));
  const eliminatedRound = new Map<number, number>();
  let champion: LeagueChampionView | null = null;
  let finalists: [number, number] | null = null;
  const maxRound = Math.max(0, ...playoffRows.map((row) => count(row.round)));
  for (const row of playoffRows) {
    const winnerPid = row.winner_side === 'p1' || row.winner_side === 'p2' ? (row.winner_side as Pid) : null;
    if (!winnerPid) continue;
    const loser = sideEntrant(row, winnerPid === 'p1' ? 'p2' : 'p1', identity);
    if (loser >= 0) eliminatedRound.set(loser, count(row.round));
  }
  const finals = playoffRows.filter((row) => count(row.round) === maxRound);
  if (maxRound > 0 && finals.length === 1) {
    const final = finals[0]!;
    const a = sideEntrant(final, 'p1', identity);
    const b = sideEntrant(final, 'p2', identity);
    if (a >= 0 && b >= 0) finalists = [a, b];
    const winnerPid = final.winner_side === 'p1' || final.winner_side === 'p2' ? (final.winner_side as Pid) : null;
    if (winnerPid && (maxRound >= 2 || playoffRows.length === 1)) {
      const entrant = sideEntrant(final, winnerPid, identity);
      if (entrant >= 0) {
        champion = { entrant, model: identity.models[entrant]!, team: identity.teamNames[entrant]! };
      }
    }
  }
  return {
    phase: champion ? 'complete' : playoffRows.length > 0 ? 'playoffs' : 'roundrobin',
    week,
    champion,
    finalists,
    eliminatedRound,
  };
}

export function buildLeagues(allRows: SeriesRecord[], runsDir: string): LeaguesResponse {
  const leagues: LeagueCardView[] = [];
  for (const [runId, rows] of draftRuns(allRows)) {
    const identity = leagueIdentity(runsDir, runId, rows);
    if (identity.models.length < 2) continue;
    const progress = leagueProgress(rows, identity);
    const timestamps = rows
      .map((row) => String(row.timestamp ?? ''))
      .filter(Boolean)
      .sort();
    leagues.push({
      runId,
      when: timestamps[0] ?? '',
      board: identity.board,
      format: identity.format,
      entrants: identity.models,
      teamNames: identity.teamNames,
      weeks: identity.weeks,
      seriesCount: rows.length,
      phase: progress.phase,
      week: progress.week,
      champion: progress.champion,
    });
  }
  leagues.sort((a, b) => b.when.localeCompare(a.when));
  return { leagues };
}

interface RosterEntry {
  model: string;
  teamName: string;
  spent: number;
  budgetLeft: number;
  roster: LeagueRosterSlotView[];
}

function readRosters(runsDir: string, runId: string, identity: LeagueIdentity): RosterEntry[] {
  const stored = readRunJson(runsDir, runId, 'rosters.json');
  const picks = readRunLines(runsDir, runId, 'draft', 'draft.jsonl');
  const pickByMon = new Map<string, Record<string, unknown>>();
  for (const pick of picks) pickByMon.set(`${pick.model}:${pick.mon}`, pick);
  const entries: RosterEntry[] = [];
  const source = Array.isArray(stored) ? (stored as Record<string, unknown>[]) : [];
  for (const [entrant, model] of identity.models.entries()) {
    const record = source.find((candidate) => candidate.model === model) ?? {};
    const mons = Array.isArray(record.roster) ? (record.roster as Record<string, unknown>[]) : [];
    const roster = mons.map((mon): LeagueRosterSlotView => {
      const pick = pickByMon.get(`${model}:${String(mon.id ?? '')}`);
      return {
        id: String(mon.id ?? ''),
        name: String(mon.name ?? mon.id ?? ''),
        cost: count(mon.cost),
        pick: pick ? count(pick.pick) : null,
        rationale: typeof pick?.rationale === 'string' ? pick.rationale : '',
        fallback: pick?.fallback === true,
      };
    });
    entries.push({
      model,
      teamName: identity.teamNames[entrant] ?? String(record.team_name ?? ''),
      spent: count(record.spent),
      budgetLeft: count(record.budget_left),
      roster,
    });
  }
  return entries;
}

function finishLabel(entrant: number, progress: LeagueProgress, rank: number, playoffsSeen: boolean): string {
  if (progress.champion?.entrant === entrant) return 'Champion';
  if (progress.champion && progress.finalists?.includes(entrant)) return 'Runner-up';
  const eliminated = progress.eliminatedRound.get(entrant);
  if (eliminated !== undefined && !progress.finalists?.includes(entrant)) {
    return 'Eliminated in the semifinals';
  }
  if (progress.phase === 'complete' && playoffsSeen) return `${ordinal(rank)} in the round robin`;
  return '';
}

function ordinal(rank: number): string {
  const suffix =
    rank % 10 === 1 && rank !== 11
      ? 'st'
      : rank % 10 === 2 && rank !== 12
        ? 'nd'
        : rank % 10 === 3 && rank !== 13
          ? 'rd'
          : 'th';
  return `${rank}${suffix}`;
}

export function buildLeague(allRows: SeriesRecord[], runsDir: string, runId: string): LeagueResponse | null {
  if (!SAFE_SEGMENT.test(runId)) return null;
  const rows = draftRuns(allRows).get(runId);
  if (!rows || rows.length === 0) return null;
  const identity = leagueIdentity(runsDir, runId, rows);
  if (identity.models.length < 2) return null;
  const progress = leagueProgress(rows, identity);
  const rosters = readRosters(runsDir, runId, identity);

  const table = identity.models.map(() => ({ w: 0, l: 0, gw: 0, gl: 0 }));
  const series: LeagueSeriesView[] = [];
  for (const row of rows) {
    const a = sideEntrant(row, 'p1', identity);
    const b = sideEntrant(row, 'p2', identity);
    if (a < 0 || b < 0) continue;
    const score = row.score as Record<Pid, number> | undefined;
    const winner = row.winner_side === 'p1' ? a : row.winner_side === 'p2' ? b : null;
    const games = (Array.isArray(row.games) ? (row.games as Record<string, unknown>[]) : []).map((game) => ({
      winner: game.winner_side === 'p1' ? a : game.winner_side === 'p2' ? b : null,
      turns: count(game.turns),
    }));
    if (row.stage === 'roundrobin' && winner !== null) {
      const loser = winner === a ? b : a;
      table[winner]!.w += 1;
      table[loser]!.l += 1;
      table[a]!.gw += count(score?.p1);
      table[a]!.gl += count(score?.p2);
      table[b]!.gw += count(score?.p2);
      table[b]!.gl += count(score?.p1);
    }
    series.push({
      seriesIndex: count(row.series_index),
      seriesId: String(row.series_id ?? ''),
      stage: row.stage === 'playoff' ? 'playoff' : 'roundrobin',
      round: count(row.round),
      timestamp: String(row.timestamp ?? ''),
      sides: [a, b],
      score: [count(score?.p1), count(score?.p2)],
      winner,
      turns: count(row.turns),
      games,
    });
  }

  const ranks = identity.models
    .map((_, entrant) => entrant)
    .sort((first, second) => {
      const a = table[first]!;
      const b = table[second]!;
      return b.w - a.w || b.gw - b.gl - (a.gw - a.gl) || first - second;
    });
  const rankOf = new Map(ranks.map((entrant, index) => [entrant, index + 1]));
  const playoffsSeen = rows.some((row) => row.stage === 'playoff');

  const franchises: LeagueFranchiseView[] = rosters.map((entry, entrant) => ({
    entrant,
    model: entry.model,
    teamName: entry.teamName,
    spent: entry.spent,
    budgetLeft: entry.budgetLeft,
    ...table[entrant]!,
    finish: finishLabel(entrant, progress, rankOf.get(entrant) ?? entrant + 1, playoffsSeen),
    roster: entry.roster,
  }));

  const teambuilds: LeagueTeambuildView[] = readRunLines(runsDir, runId, 'teambuild', 'teambuild.jsonl').map(
    (row): LeagueTeambuildView => ({
      seriesIndex: count(row.seriesIndex),
      entrant: count(row.entrant),
      opponent: count(row.opponent),
      brought: Array.isArray(row.brought) ? row.brought.map(String) : [],
      sets: Array.isArray(row.sets) ? (row.sets as TeambuildSetView[]) : [],
      rationale: typeof row.rationale === 'string' ? row.rationale : '',
      attempts: Math.max(1, count(row.attempts)),
    }),
  );

  let decisions = 0;
  let meteredCost = 0;
  let tokens = 0;
  let tokensSeen = false;
  let reasoning = 0;
  let reasoningSeen = false;
  for (const row of rows) {
    const stats = row.decision_stats as Record<Pid, Record<string, unknown>> | undefined;
    for (const pid of PIDS) {
      decisions += count(stats?.[pid]?.decisions);
      meteredCost += count(stats?.[pid]?.cost);
      const file = decisionLogPath(runsDir, runId, String(row.series_id ?? ''), pid);
      if (!file) continue;
      for (const entry of readDecisionLog(file)) {
        if (entry.totalTokens !== null) {
          tokens += entry.totalTokens;
          tokensSeen = true;
        }
        if (entry.reasoningTokens !== null) {
          reasoning += entry.reasoningTokens;
          reasoningSeen = true;
        }
      }
    }
  }

  const timestamps = rows
    .map((row) => String(row.timestamp ?? ''))
    .filter(Boolean)
    .sort();
  const sample = rosters.find((entry) => entry.spent + entry.budgetLeft > 0);
  return {
    runId,
    when: timestamps[0] ?? '',
    lastPlayed: timestamps[timestamps.length - 1] ?? null,
    board: identity.board,
    format: identity.format,
    budget: sample ? sample.spent + sample.budgetLeft : null,
    picksPerEntrant: rosters.find((entry) => entry.roster.length > 0)?.roster.length ?? null,
    weeks: identity.weeks,
    phase: progress.phase,
    week: progress.week,
    champion: progress.champion,
    franchises,
    series,
    teambuilds,
    spend: {
      decisions,
      tokens: tokensSeen ? tokens : null,
      reasoningTokens: reasoningSeen ? reasoning : null,
      cost: meteredCost > 0 ? Math.round(meteredCost * 1e4) / 1e4 : null,
    },
  };
}

function summary(values: number[]): QuartileView | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    median: quantile(sorted, 0.5),
    p25: quantile(sorted, 0.25),
    p75: quantile(sorted, 0.75),
    max: sorted[sorted.length - 1]!,
  };
}

export function buildModelProfile(allRows: SeriesRecord[], runsDir: string, id: string): ModelProfileResponse | null {
  const rows = allRows
    .filter(
      (row) =>
        row.pool !== TEST_POOL &&
        typeof row.players?.p1 === 'string' &&
        typeof row.players?.p2 === 'string' &&
        PIDS.some((pid) => modelKey(row.players[pid]) === id),
    )
    .sort((a, b) => String(a.timestamp ?? '').localeCompare(String(b.timestamp ?? '')));
  if (rows.length === 0) return null;

  const providers = new Set<string>();
  const stats: Record<string, number> = {};
  const latencies: number[] = [];
  const tokenPoints: number[] = [];
  let series = 0;
  let games = 0;
  let tokens = 0;
  let reasoning = 0;
  let reasoningSeen = false;
  const modes = new Map<string, { series: number; w: number; l: number; runs: Map<string, string> }>();

  for (const row of rows) {
    const mode = String(row.mode ?? 'rotation');
    const gameCount = Array.isArray(row.games)
      ? row.games.length
      : count((row.score as Record<Pid, number> | undefined)?.p1) +
        count((row.score as Record<Pid, number> | undefined)?.p2);
    for (const pid of PIDS) {
      if (modelKey(row.players[pid]) !== id) continue;
      providers.add(row.players[pid]);
      series += 1;
      games += gameCount;
      const bucket = modes.get(mode) ?? { series: 0, w: 0, l: 0, runs: new Map() };
      modes.set(mode, bucket);
      bucket.series += 1;
      const won = row.winner_side ? row.winner_side === pid : row.winner === row.players[pid];
      if (won) bucket.w += 1;
      else if (row.winner) bucket.l += 1;
      if (mode === 'draft' || mode === 'tournament') {
        const runId = String(row.run_id ?? '');
        if (runId && !bucket.runs.has(runId)) bucket.runs.set(runId, String(row.timestamp ?? ''));
      }
      const sideStats = (row.decision_stats as Record<Pid, Record<string, unknown>> | undefined)?.[pid];
      for (const [key, value] of Object.entries(sideStats ?? {})) {
        stats[key] = (stats[key] ?? 0) + count(value);
      }
      const file = decisionLogPath(runsDir, String(row.run_id ?? ''), String(row.series_id ?? ''), pid);
      if (!file) continue;
      for (const entry of readDecisionLog(file)) {
        if (entry.totalTokens !== null) tokens += entry.totalTokens;
        if (entry.reasoningTokens !== null) {
          reasoning += entry.reasoningTokens;
          reasoningSeen = true;
        }
        if (entry.kind !== 'decision' || entry.automatic) continue;
        if (entry.latencyMs !== null && entry.latencyMs > 0) latencies.push(entry.latencyMs);
        if (entry.totalTokens !== null && entry.totalTokens > 0) tokenPoints.push(entry.totalTokens);
      }
    }
  }

  const decisions = stats.decisions ?? 0;
  const selections = (stats.move_selections ?? 0) + (stats.switch_selections ?? 0);
  const previews = stats.team_previews ?? 0;
  const repeatChances = Math.max(0, previews - series);
  const per = (value: number, base: number) => (base > 0 ? value / base : 0);
  const timestamps = rows.map((row) => String(row.timestamp ?? '')).filter(Boolean);

  return {
    id,
    providers: [...providers].sort(),
    firstSeen: timestamps[0] ?? null,
    lastSeen: timestamps[timestamps.length - 1] ?? null,
    series,
    games,
    decisions,
    reflections: stats.reflections ?? 0,
    totalTokens: tokens,
    reasoningTokens: reasoningSeen ? reasoning : null,
    cost: (stats.cost ?? 0) > 0 ? Math.round(stats.cost! * 1e4) / 1e4 : null,
    latency: summary(latencies),
    tokensPerDecision: summary(tokenPoints),
    rates: {
      fallback: per(stats.fallbacks ?? 0, decisions),
      parseFailure: per(stats.parse_failures ?? 0, decisions),
      providerRetry: per(stats.provider_retries ?? 0, decisions),
      abandoned: per(stats.abandoned_decisions ?? 0, decisions),
      switch: per(stats.switch_selections ?? 0, selections),
      protect: per(stats.protect_selections ?? 0, selections),
      spread: per(stats.spread_move_selections ?? 0, stats.move_selections ?? 0),
      allyTarget: per(stats.ally_target_selections ?? 0, stats.move_selections ?? 0),
      megaPerGame: per(stats.mega_selections ?? 0, games),
      toolLookups: per(stats.tool_lookups ?? 0, decisions),
      repeatedActions: per(stats.repeated_joint_actions ?? 0, decisions),
      bringChanges: repeatChances > 0 ? (stats.bring_changes ?? 0) / repeatChances : null,
      leadChanges: repeatChances > 0 ? (stats.lead_changes ?? 0) / repeatChances : null,
      threatConversion: (stats.threat_turns ?? 0) > 0 ? (stats.threat_hits ?? 0) / stats.threat_turns! : null,
      reflectionFallback: (stats.reflections ?? 0) > 0 ? (stats.reflection_fallbacks ?? 0) / stats.reflections! : null,
    },
    modes: [...modes.entries()]
      .map(
        ([mode, bucket]): ModeRecordView => ({
          mode,
          series: bucket.series,
          w: bucket.w,
          l: bucket.l,
          runs: [...bucket.runs.entries()]
            .map(([runId, when]) => ({ runId, when }))
            .sort((a, b) => b.when.localeCompare(a.when)),
        }),
      )
      .sort((a, b) => b.series - a.series || a.mode.localeCompare(b.mode)),
  };
}
