import fs from 'node:fs';
import path from 'node:path';
import { draftLeagueTopology } from './draftleague-topology.js';
import type {
  LeagueCardView,
  LeagueChampionView,
  LeagueDistributionView,
  LeagueFranchiseStatsView,
  LeagueFranchiseView,
  LeagueGameResponse,
  LeagueLifecycle,
  LeagueLiveSeriesView,
  LeagueRecordView,
  LeagueResponse,
  LeagueRosterSlotView,
  LeagueSeasonReviewView,
  LeagueSeriesView,
  LeaguesResponse,
  LeagueTeambuildView,
  LeagueTradeWindowView,
  LeagueUsageView,
  QuartileView,
} from './gui/api.js';
import { SAFE_SEGMENT } from './path-safety.js';
import { modelKey, type SeriesRecord } from './records.js';
import {
  buildSeriesGame,
  count,
  decisionLogPath,
  isRunLive,
  PIDS,
  quantile,
  readDecisionLog,
  readRunJson,
  readRunLines,
  type SeriesSlot,
  scanUnfinishedSeries,
  spriteIdFor,
} from './run-artifacts.js';
import { decodeArchivedTeamBuildJournalRow } from './teambuild.js';
import { readCurrentRosterArtifact, readTransactionEpochs } from './trade-window.js';
import type { Pid } from './types.js';
import { ordinal, text } from './value.js';

function draftRunDirs(runsDir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(runsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const runId = entry.name;
    if (!entry.isDirectory() || entry.isSymbolicLink() || !SAFE_SEGMENT.test(runId)) return [];
    const config = readRunJson(runsDir, runId, 'config.json') as Record<string, unknown> | null;
    return config?.mode === 'draft' ? [runId] : [];
  });
}

export function findLiveCliRun(runsDir: string): { runId: string; mode: 'draft' | 'tournament' } | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(runsDir);
  } catch {
    return null;
  }
  const live: Array<{ runId: string; mode: 'draft' | 'tournament' }> = [];
  for (const runId of entries) {
    if (!SAFE_SEGMENT.test(runId)) continue;
    const config = readRunJson(runsDir, runId, 'config.json') as Record<string, unknown> | null;
    const mode = config?.mode;
    if ((mode === 'draft' || mode === 'tournament') && isRunLive(runsDir, runId)) live.push({ runId, mode });
  }
  live.sort((a, b) => a.runId.localeCompare(b.runId));
  return live[live.length - 1] ?? null;
}

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

function speciesSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

interface GameReplay {
  fielded: [Set<string>, Set<string>];
  faints: [Map<string, number>, Map<string, number>];
}

function replaySeriesGames(runsDir: string, runId: string, seriesId: string, games: number): Map<number, GameReplay> {
  const replays = new Map<number, GameReplay>();
  if (!SAFE_SEGMENT.test(runId) || !SAFE_SEGMENT.test(seriesId)) return replays;
  for (let game = 1; game <= games; game += 1) {
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(runsDir, runId, 'series', seriesId, `game-${game}.log`), 'utf8');
    } catch {
      continue;
    }
    const fielded: [Set<string>, Set<string>] = [new Set(), new Set()];
    const faints: [Map<string, number>, Map<string, number>] = [new Map(), new Map()];
    const active = new Map<string, string>();
    for (const line of raw.split('\n')) {
      const [, kind = '', ...args] = line.split('|');
      const ident = args[0] ?? '';
      const side = ident.startsWith('p1') ? 0 : ident.startsWith('p2') ? 1 : -1;
      if (side === -1) continue;
      const slot = ident.slice(0, 3);
      if ((kind === 'switch' || kind === 'drag' || kind === 'replace' || kind === 'detailschange') && args[1]) {
        const species = speciesSlug(args[1].split(',', 1)[0]!);
        active.set(slot, species);
        fielded[side]!.add(species);
      } else if (kind === 'faint') {
        const species = active.get(slot);
        if (species) faints[side]!.set(species, (faints[side]!.get(species) ?? 0) + 1);
      }
    }
    replays.set(game, { fielded, faints });
  }
  return replays;
}

/** A drafted mon enters play under its base species until it megas, so match ids by exact slug or mega prefix. */
function speciesMatchesPick(pickId: string, species: string): boolean {
  return pickId === species || pickId.startsWith(`${species}-`);
}

function liveSeriesViews(
  runsDir: string,
  runId: string,
  rows: SeriesRecord[],
  identity: LeagueIdentity,
): LeagueLiveSeriesView[] {
  const views: LeagueLiveSeriesView[] = [];
  for (const entry of scanUnfinishedSeries(runsDir, runId, rows)) {
    let sides: [number, number] | null = null;
    if (entry.players) {
      const a = entrantForSpec(identity, entry.players.p1);
      const b = entrantForSpec(identity, entry.players.p2);
      if (a >= 0 && b >= 0) sides = [a, b];
    }
    if (entry.decisions === 0 && !sides) continue;
    const slot = entry.seriesIndex === null ? null : leagueSeriesSlot(entry.seriesIndex, identity.models.length);
    views.push({
      seriesId: entry.seriesId,
      seriesIndex: entry.seriesIndex,
      stage: slot?.stage ?? null,
      round: slot?.round ?? null,
      game: entry.game,
      turn: entry.turn,
      decisions: entry.decisions,
      sides,
    });
  }
  return views;
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

/** A seat rewired to another provider mid-run keeps its entrant: match the exact spec first,
 * then fall back to the bare model name when it identifies a single entrant. */
function entrantForSpec(identity: LeagueIdentity, spec: string): number {
  const exact = identity.models.indexOf(spec);
  if (exact >= 0) return exact;
  const matches = identity.models
    .map((model, entrant) => (modelKey(model) === modelKey(spec) ? entrant : -1))
    .filter((entrant) => entrant >= 0);
  return matches.length === 1 ? matches[0]! : -1;
}

function sideEntrant(row: SeriesRecord, pid: Pid, identity: LeagueIdentity): number {
  const label = String((row.teams as Record<Pid, unknown> | undefined)?.[pid] ?? '');
  const byTeam = identity.teamNames.findIndex((name) => label === name || label.startsWith(`${name} `));
  if (byTeam >= 0) return byTeam;
  return entrantForSpec(identity, row.players[pid]);
}

interface LeagueProgress {
  phase: 'roundrobin' | 'playoffs' | 'complete';
  week: number;
  champion: LeagueChampionView | null;
  finalists: [number, number] | null;
  eliminatedRound: Map<number, number>;
}

function leagueSeriesSlot(
  seriesIndex: number,
  entrants: number,
): { stage: 'roundrobin' | 'playoff'; round: number } | null {
  if (!Number.isSafeInteger(seriesIndex) || seriesIndex < 0 || entrants < 2) return null;
  const topology = draftLeagueTopology(entrants);
  if (seriesIndex < topology.roundRobinSeries) {
    return { stage: 'roundrobin', round: Math.floor(seriesIndex / Math.floor(entrants / 2)) + 1 };
  }
  const playoffIndex = seriesIndex - topology.roundRobinSeries;
  if (playoffIndex >= topology.playoffSeries) return null;
  return { stage: 'playoff', round: topology.playoffRounds === 1 || playoffIndex < 2 ? 1 : 2 };
}

function leagueProgress(rows: SeriesRecord[], identity: LeagueIdentity): LeagueProgress {
  const playoffRows = rows.filter((row) => row.stage === 'playoff');
  const week = Math.max(0, ...rows.filter((row) => row.stage === 'roundrobin').map((row) => count(row.round)));
  const eliminatedRound = new Map<number, number>();
  let champion: LeagueChampionView | null = null;
  let finalists: [number, number] | null = null;
  /** Mirrors the bracket in draftleague.ts: the final is the last round, so a lone finished
   * semifinal must not be mistaken for it while the other semifinal is still playing. */
  const finalRound = draftLeagueTopology(identity.models.length).playoffRounds;
  for (const row of playoffRows) {
    const winnerPid = row.winner_side === 'p1' || row.winner_side === 'p2' ? (row.winner_side as Pid) : null;
    if (!winnerPid) continue;
    const loser = sideEntrant(row, winnerPid === 'p1' ? 'p2' : 'p1', identity);
    if (loser >= 0) eliminatedRound.set(loser, count(row.round));
  }
  const finals = playoffRows.filter((row) => count(row.round) === finalRound);
  if (finals.length === 1) {
    const final = finals[0]!;
    const a = sideEntrant(final, 'p1', identity);
    const b = sideEntrant(final, 'p2', identity);
    if (a >= 0 && b >= 0) finalists = [a, b];
    const winnerPid = final.winner_side === 'p1' || final.winner_side === 'p2' ? (final.winner_side as Pid) : null;
    if (winnerPid) {
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

function preSeasonPhase(runsDir: string, runId: string): 'drafting' | 'building' | 'roundrobin' {
  try {
    if (fs.readdirSync(path.join(runsDir, runId, 'series')).length > 0) return 'roundrobin';
  } catch {}
  const builds = readRunLines(runsDir, runId, 'teambuild', 'teambuild.jsonl');
  return builds.length > 0 ? 'building' : 'drafting';
}
function leaguePhase(
  runsDir: string,
  runId: string,
  rows: SeriesRecord[],
  progress: LeagueProgress,
  liveSeries: LeagueLiveSeriesView[],
): 'drafting' | 'building' | 'roundrobin' | 'window' | 'playoffs' | 'complete' {
  if (readTransactionEpochs(path.join(runsDir, runId)).some((epoch) => epoch.inProgress)) return 'window';
  if (liveSeries.some((series) => series.stage === 'playoff')) return 'playoffs';
  if (rows.length > 0) return progress.phase;
  /** A draft-only run ends at a full board of picks, so it is complete rather than mid-draft. */
  if (completedDraftOnlyRun(runsDir, runId)) return 'complete';
  return preSeasonPhase(runsDir, runId);
}
function isDraftOnly(runsDir: string, runId: string): boolean {
  const config = readRunJson(runsDir, runId, 'config.json') as Record<string, unknown> | null;
  return config?.draft_only === true;
}

function completedDraftOnlyRun(runsDir: string, runId: string): boolean {
  if (!isDraftOnly(runsDir, runId)) return false;
  const status = readRunJson(runsDir, runId, 'status.json') as Record<string, unknown> | null;
  if (status?.state === 'done') return true;
  /** Legacy draft-only runs predate status files but persisted complete rosters into config. */
  const config = readRunJson(runsDir, runId, 'config.json') as Record<string, unknown> | null;
  return Array.isArray(config?.rosters) && config.rosters.length >= 2;
}

function leagueLifecycle(runsDir: string, runId: string, champion: LeagueChampionView | null): LeagueLifecycle {
  if (isRunLive(runsDir, runId)) return 'live';
  const status = readRunJson(runsDir, runId, 'status.json') as Record<string, unknown> | null;
  if (status?.state === 'failed' || status?.state === 'stopped') return status.state;
  if (champion || completedDraftOnlyRun(runsDir, runId)) return 'complete';
  return 'incomplete';
}

function transactionWeeks(runsDir: string, runId: string): number[] {
  const config = readRunJson(runsDir, runId, 'config.json') as Record<string, unknown> | null;
  const windows = Array.isArray(config?.transactions)
    ? config.transactions
    : typeof config?.trade_window === 'object' && config.trade_window !== null
      ? [config.trade_window]
      : [];
  return windows
    .map((window) => Number((window as Record<string, unknown>).after_week))
    .filter((afterWeek) => Number.isSafeInteger(afterWeek) && afterWeek > 0);
}

function seasonReviewViews(runsDir: string, runId: string): LeagueSeasonReviewView[] {
  return readRunLines(runsDir, runId, 'season.jsonl').map((row) => ({
    entrant: count(row.entrant),
    outcome: text(row.outcome),
    summary: text(row.summary),
    didWell: text(row.did_well),
    didPoorly: text(row.did_poorly),
    wouldChange: text(row.would_change),
    fallback: row.fallback === true,
  }));
}

function transactionViews(runsDir: string, runId: string): LeagueTradeWindowView[] {
  const epochs = readTransactionEpochs(path.join(runsDir, runId));
  return transactionWeeks(runsDir, runId).map((afterWeek) => {
    const epoch = epochs.find((candidate) => candidate.afterWeek === afterWeek);
    const artifact = epoch?.artifact;
    if (!artifact) {
      return {
        afterWeek,
        state: epoch?.inProgress ? 'in-progress' : 'scheduled',
        order: [],
        offers: [],
        decisions: [],
      };
    }
    return {
      afterWeek,
      state: 'complete',
      order: [...artifact.order],
      offers: artifact.offers.map((offer) => ({
        from: offer.from,
        to: offer.to,
        give: offer.give,
        get: offer.get,
        message: offer.message,
        accepted: offer.accepted,
        offerReasoning: offer.offerReasoning,
        responseReasoning: offer.responseReasoning,
      })),
      decisions: artifact.decisions.map((decision) => ({
        entrant: decision.entrant,
        swaps: decision.swaps.map(({ drop, add }) => ({ drop, add })),
        reasoning: decision.reasoning,
        fallback: decision.fallback,
      })),
    };
  });
}

export function buildLeagues(allRows: SeriesRecord[], runsDir: string): LeaguesResponse {
  const leagues: LeagueCardView[] = [];
  const byRun = draftRuns(allRows);
  for (const runId of draftRunDirs(runsDir)) {
    if (!byRun.has(runId) && (isRunLive(runsDir, runId) || isDraftOnly(runsDir, runId))) byRun.set(runId, []);
  }
  for (const [runId, rows] of byRun) {
    const identity = leagueIdentity(runsDir, runId, rows);
    if (identity.models.length < 2) continue;
    const progress = leagueProgress(rows, identity);
    const live = isRunLive(runsDir, runId);
    const liveSeries = live ? liveSeriesViews(runsDir, runId, rows, identity) : [];
    const timestamps = rows
      .map((row) => String(row.timestamp ?? ''))
      .filter(Boolean)
      .sort();
    const status = readRunJson(runsDir, runId, 'status.json') as Record<string, unknown> | null;
    const started = typeof status?.start_time === 'string' ? status.start_time : '';
    const phase = leaguePhase(runsDir, runId, rows, progress, liveSeries);
    leagues.push({
      runId,
      when: timestamps[0] ?? started,
      board: identity.board,
      format: identity.format,
      entrants: identity.models,
      teamNames: identity.teamNames,
      weeks: identity.weeks,
      seriesCount: rows.length,
      phase,
      week: progress.week,
      champion: progress.champion,
      transactionWeeks: transactionWeeks(runsDir, runId),
      draftOnly: isDraftOnly(runsDir, runId) && rows.length === 0,
      lifecycle: leagueLifecycle(runsDir, runId, progress.champion),
      picks: phase === 'drafting' ? readRunLines(runsDir, runId, 'draft', 'draft.jsonl').length : null,
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

function readRosters(runsDir: string, runId: string, identity: LeagueIdentity, current = true): RosterEntry[] {
  const stored = current
    ? readCurrentRosterArtifact(path.join(runsDir, runId))
    : readRunJson(runsDir, runId, 'rosters.json');
  const picks = readRunLines(runsDir, runId, 'draft', 'draft.jsonl');
  const pickByMon = new Map<string, Record<string, unknown>>();
  for (const pick of picks) pickByMon.set(`${modelKey(String(pick.model ?? ''))}:${pick.mon}`, pick);
  const windowAdds = new Map<number, Set<string>>();
  if (current) {
    for (const { artifact } of readTransactionEpochs(path.join(runsDir, runId))) {
      for (const decision of artifact?.decisions ?? []) {
        const adds = windowAdds.get(decision.entrant) ?? new Set<string>();
        for (const swap of decision.swaps) adds.add(swap.add);
        windowAdds.set(decision.entrant, adds);
      }
    }
  }
  const entries: RosterEntry[] = [];
  const source = Array.isArray(stored) ? (stored as Record<string, unknown>[]) : [];
  for (const [entrant, model] of identity.models.entries()) {
    const record = source.find((candidate) => modelKey(String(candidate.model ?? '')) === modelKey(model)) ?? {};
    const mons = Array.isArray(record.roster) ? (record.roster as Record<string, unknown>[]) : [];
    let roster = mons.map((mon): LeagueRosterSlotView => {
      const id = String(mon.id ?? '');
      const viaWindow = windowAdds.get(entrant)?.has(id) === true;
      const pick = viaWindow ? undefined : pickByMon.get(`${modelKey(model)}:${id}`);
      return {
        id,
        name: String(mon.name ?? mon.id ?? ''),
        spriteId: spriteIdFor(id),
        cost: count(mon.cost),
        pick: pick ? count(pick.pick) : null,
        rationale: typeof pick?.rationale === 'string' ? pick.rationale : '',
        fallback: pick?.fallback === true,
        acquired: viaWindow ? 'window' : 'draft',
      };
    });
    let spent = count(record.spent);
    let budgetLeft = count(record.budget_left);
    if (roster.length === 0) {
      const own = picks
        .filter((pick) => modelKey(String(pick.model ?? '')) === modelKey(model))
        .sort((a, b) => count(a.pick) - count(b.pick));
      roster = own.map(
        (pick): LeagueRosterSlotView => ({
          id: String(pick.mon ?? ''),
          name: String(pick.name ?? pick.mon ?? ''),
          spriteId: spriteIdFor(String(pick.mon ?? '')),
          cost: count(pick.cost),
          pick: count(pick.pick),
          rationale: typeof pick.rationale === 'string' ? pick.rationale : '',
          fallback: pick.fallback === true,
          acquired: 'draft',
        }),
      );
      spent = own.reduce((total, pick) => total + count(pick.cost), 0);
      const last = own[own.length - 1];
      if (last) budgetLeft = count(last.budget_left);
    }
    entries.push({
      model,
      teamName: identity.teamNames[entrant] ?? String(record.team_name ?? ''),
      spent,
      budgetLeft,
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

function recordCompletedSeries(
  recordA: LeagueRecordView,
  recordB: LeagueRecordView,
  winner: number,
  entrantA: number,
  score: Record<Pid, number> | undefined,
): void {
  if (winner === entrantA) {
    recordA.w += 1;
    recordB.l += 1;
  } else {
    recordB.w += 1;
    recordA.l += 1;
  }
  recordA.gw += count(score?.p1);
  recordA.gl += count(score?.p2);
  recordB.gw += count(score?.p2);
  recordB.gl += count(score?.p1);
}

export function buildLeague(allRows: SeriesRecord[], runsDir: string, runId: string): LeagueResponse | null {
  if (!SAFE_SEGMENT.test(runId)) return null;
  const live = isRunLive(runsDir, runId);
  const rows = draftRuns(allRows).get(runId) ?? [];
  /** A finished draft-only run has no series and is not live, and its draft is the whole point of it. */
  if (rows.length === 0 && !live && !isDraftOnly(runsDir, runId)) return null;
  const identity = leagueIdentity(runsDir, runId, rows);
  if (identity.models.length < 2) return null;
  const progress = leagueProgress(rows, identity);
  const liveSeries = live ? liveSeriesViews(runsDir, runId, rows, identity) : [];
  const rosters = readRosters(runsDir, runId, identity);
  const draftRosters = readRosters(runsDir, runId, identity, false);

  const roundRobinRecords: LeagueRecordView[] = identity.models.map(() => ({ w: 0, l: 0, gw: 0, gl: 0 }));
  const overallRecords: LeagueRecordView[] = identity.models.map(() => ({ w: 0, l: 0, gw: 0, gl: 0 }));
  const statsAgg: LeagueFranchiseStatsView[] = identity.models.map(() => ({
    decisions: 0,
    latency: null,
    reasoningTokens: null,
    cost: null,
    toolLookups: 0,
    parseFailures: 0,
    fallbacks: 0,
    moveSelections: 0,
    switchSelections: 0,
    protectSelections: 0,
    consecutiveProtects: 0,
    spreadSelections: 0,
    megaSelections: 0,
    buildAttempts: 0,
    leadChanges: 0,
    bringChanges: 0,
  }));
  const entrantCost = identity.models.map(() => ({ total: 0, seen: false }));
  const entrantReasoning = identity.models.map(() => ({ total: 0, seen: false }));
  const entrantLatencies: number[][] = identity.models.map(() => []);
  const series: LeagueSeriesView[] = [];
  for (const row of rows) {
    const a = sideEntrant(row, 'p1', identity);
    const b = sideEntrant(row, 'p2', identity);
    if (a < 0 || b < 0) continue;
    const score = row.score as Record<Pid, number> | undefined;
    const winner = row.winner_side === 'p1' ? a : row.winner_side === 'p2' ? b : null;
    const dstats = row.decision_stats as Record<Pid, Record<string, unknown>> | undefined;
    for (const [pid, entrant] of [
      ['p1', a],
      ['p2', b],
    ] as const) {
      const d = dstats?.[pid];
      const agg = statsAgg[entrant]!;
      if (d) {
        agg.decisions += count(d.decisions);
        agg.fallbacks += count(d.fallbacks);
        agg.parseFailures += count(d.parse_failures);
        agg.toolLookups += count(d.tool_lookups);
        agg.moveSelections += count(d.move_selections);
        agg.switchSelections += count(d.switch_selections);
        agg.protectSelections += count(d.protect_selections);
        agg.consecutiveProtects += count(d.consecutive_protect_selections);
        agg.spreadSelections += count(d.spread_move_selections);
        agg.megaSelections += count(d.mega_selections);
        agg.leadChanges += count(d.lead_changes);
        agg.bringChanges += count(d.bring_changes);
        if (typeof d.cost === 'number') {
          entrantCost[entrant]!.total += count(d.cost);
          entrantCost[entrant]!.seen = true;
        }
        if (typeof d.reasoning_tokens === 'number') {
          entrantReasoning[entrant]!.total += count(d.reasoning_tokens);
          entrantReasoning[entrant]!.seen = true;
        }
      }
      const file = decisionLogPath(runsDir, runId, String(row.series_id ?? ''), pid);
      if (file) {
        for (const entry of readDecisionLog(file)) {
          if (entry.kind !== 'decision' || entry.automatic) continue;
          if (entry.latencyMs !== null && entry.latencyMs > 0) entrantLatencies[entrant]!.push(entry.latencyMs);
        }
      }
    }
    const games = (Array.isArray(row.games) ? (row.games as Record<string, unknown>[]) : []).map((game) => ({
      winner: game.winner_side === 'p1' ? a : game.winner_side === 'p2' ? b : null,
      turns: count(game.turns),
    }));
    if (winner !== null) {
      recordCompletedSeries(overallRecords[a]!, overallRecords[b]!, winner, a, score);
      if (row.stage === 'roundrobin') {
        recordCompletedSeries(roundRobinRecords[a]!, roundRobinRecords[b]!, winner, a, score);
      }
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
      const a = roundRobinRecords[first]!;
      const b = roundRobinRecords[second]!;
      return b.w - a.w || b.gw - b.gl - (a.gw - a.gl) || first - second;
    });
  const rankOf = new Map(ranks.map((entrant, index) => [entrant, index + 1]));
  const playoffsSeen = rows.some((row) => row.stage === 'playoff');

  const teambuildFile = path.join(runsDir, runId, 'teambuild', 'teambuild.jsonl');
  const teambuilds: LeagueTeambuildView[] = readRunLines(runsDir, runId, 'teambuild', 'teambuild.jsonl').map(
    (row, index) => {
      const entry = decodeArchivedTeamBuildJournalRow(row, `${teambuildFile} line ${index + 1}`);
      return { ...entry.view, notebook: entry.notebook };
    },
  );
  for (const build of teambuilds) {
    const agg = statsAgg[build.entrant];
    if (agg) agg.buildAttempts += build.attempts;
  }
  for (const [entrant, agg] of statsAgg.entries()) {
    agg.latency = summary(entrantLatencies[entrant]!);
    if (entrantCost[entrant]!.seen) agg.cost = Math.round(entrantCost[entrant]!.total * 1e4) / 1e4;
    if (entrantReasoning[entrant]!.seen) agg.reasoningTokens = entrantReasoning[entrant]!.total;
  }

  const franchises: LeagueFranchiseView[] = rosters.map((entry, entrant) => ({
    entrant,
    model: entry.model,
    teamName: entry.teamName,
    spent: entry.spent,
    budgetLeft: entry.budgetLeft,
    overallRecord: overallRecords[entrant]!,
    roundRobinRecord: roundRobinRecords[entrant]!,
    finish: finishLabel(entrant, progress, rankOf.get(entrant) ?? entrant + 1, playoffsSeen),
    roster: entry.roster,
    draftRoster: draftRosters[entrant]?.roster ?? entry.roster,
    stats: statsAgg[entrant]!,
  }));

  const buildFor = new Map<string, LeagueTeambuildView>();
  for (const build of teambuilds) buildFor.set(`${build.seriesIndex}:${build.entrant}`, build);
  const usageMap = new Map<string, LeagueUsageView>();
  const usageOf = (entrant: number, id: string): LeagueUsageView => {
    const key = `${entrant}:${id}`;
    let usage = usageMap.get(key);
    if (!usage) {
      const slot =
        rosters[entrant]?.roster.find((mon) => mon.id === id) ??
        draftRosters[entrant]?.roster.find((mon) => mon.id === id);
      usage = {
        entrant,
        id,
        name: slot?.name ?? id,
        spriteId: slot?.spriteId ?? spriteIdFor(id),
        cost: slot?.cost ?? 0,
        pick: slot?.pick ?? null,
        builds: 0,
        seriesWins: 0,
        seriesLosses: 0,
        gamesFielded: 0,
        gameWins: 0,
        gameLosses: 0,
        faints: 0,
      };
      usageMap.set(key, usage);
    }
    return usage;
  };
  for (const view of series) {
    const replays = replaySeriesGames(runsDir, runId, view.seriesId, view.games.length);
    for (const [sideIndex, entrant] of view.sides.entries()) {
      const build = buildFor.get(`${view.seriesIndex}:${entrant}`);
      if (!build) continue;
      for (const id of build.brought) {
        const usage = usageOf(entrant, id);
        usage.builds += 1;
        if (view.winner === entrant) usage.seriesWins += 1;
        else if (view.winner !== null) usage.seriesLosses += 1;
      }
      for (const [game, replay] of replays) {
        const fielded = replay.fielded[sideIndex as 0 | 1]!;
        const faints = replay.faints[sideIndex as 0 | 1]!;
        const gameView = view.games[game - 1];
        for (const id of build.brought) {
          if (![...fielded].some((species) => speciesMatchesPick(id, species))) continue;
          const usage = usageOf(entrant, id);
          usage.gamesFielded += 1;
          if (gameView?.winner === entrant) usage.gameWins += 1;
          else if (gameView?.winner !== null && gameView?.winner !== undefined) usage.gameLosses += 1;
          for (const [species, fainted] of faints) {
            if (speciesMatchesPick(id, species)) usage.faints += fainted;
          }
        }
      }
    }
  }
  for (const [entrant, entry] of rosters.entries()) {
    for (const slot of entry.roster) usageOf(entrant, slot.id);
  }
  const usage = [...usageMap.values()].sort(
    (a, b) =>
      b.gamesFielded - a.gamesFielded ||
      b.gameWins - a.gameWins ||
      b.builds - a.builds ||
      b.cost - a.cost ||
      a.name.localeCompare(b.name),
  );

  const itemCounts = new Map<string, number>();
  for (const build of teambuilds) {
    for (const set of build.sets) {
      const item = typeof set.item === 'string' ? set.item.trim() : '';
      if (item) itemCounts.set(item, (itemCounts.get(item) ?? 0) + 1);
    }
  }
  const distribution: LeagueDistributionView = {
    speciesDrafted: new Set(rosters.flatMap((entry) => entry.roster.map((mon) => mon.id))).size,
    speciesBuilt: new Set(teambuilds.flatMap((build) => build.brought)).size,
    speciesFielded: new Set(usage.filter((entry) => entry.gamesFielded > 0).map((entry) => entry.id)).size,
    itemsUsed: itemCounts.size,
    topItems: [...itemCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 3)
      .map(([item, itemCount]) => ({ item, count: itemCount })),
  };

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
  const status = readRunJson(runsDir, runId, 'status.json') as Record<string, unknown> | null;
  const started = typeof status?.start_time === 'string' ? status.start_time : '';
  return {
    runId,
    when: timestamps[0] ?? started,
    lastPlayed: timestamps[timestamps.length - 1] ?? null,
    board: identity.board,
    format: identity.format,
    budget: sample ? sample.spent + sample.budgetLeft : null,
    picksPerEntrant: rosters.find((entry) => entry.roster.length > 0)?.roster.length ?? null,
    weeks: identity.weeks,
    playoffRounds: draftLeagueTopology(identity.models.length).playoffRounds,
    phase: leaguePhase(runsDir, runId, rows, progress, liveSeries),
    week: progress.week,
    champion: progress.champion,
    draftOnly: isDraftOnly(runsDir, runId) && rows.length === 0,
    lifecycle: leagueLifecycle(runsDir, runId, progress.champion),
    liveSeries,
    transactions: transactionViews(runsDir, runId),
    seasonReviews: seasonReviewViews(runsDir, runId),
    franchises,
    series,
    teambuilds,
    spend: {
      decisions,
      tokens: tokensSeen ? tokens : null,
      reasoningTokens: reasoningSeen ? reasoning : null,
      cost: meteredCost > 0 ? Math.round(meteredCost * 1e4) / 1e4 : null,
    },
    usage,
    distribution,
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

function liveSeriesByIndex(
  runsDir: string,
  runId: string,
  seriesIndex: number,
  identity: LeagueIdentity,
): { seriesId: string; sides: [number, number]; stage: 'roundrobin' | 'playoff'; round: number } | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(path.join(runsDir, runId, 'series'));
  } catch {
    return null;
  }
  for (const seriesId of entries) {
    if (!SAFE_SEGMENT.test(seriesId)) continue;
    const meta = readRunJson(runsDir, runId, 'series', seriesId, 'series.json') as Record<string, unknown> | null;
    const storedIdentity =
      meta?.schema_version === 3 && meta.identity && typeof meta.identity === 'object' && !Array.isArray(meta.identity)
        ? (meta.identity as Record<string, unknown>)
        : null;
    if (storedIdentity?.series_index !== seriesIndex) continue;
    const players = (storedIdentity.players ?? null) as Record<string, unknown> | null;
    if (typeof players?.p1 !== 'string' || typeof players.p2 !== 'string') continue;
    const a = entrantForSpec(identity, players.p1);
    const b = entrantForSpec(identity, players.p2);
    const slot = leagueSeriesSlot(seriesIndex, identity.models.length);
    if (a >= 0 && b >= 0 && slot) return { seriesId, sides: [a, b], ...slot };
  }
  return null;
}

export function buildLeagueGame(
  allRows: SeriesRecord[],
  runsDir: string,
  runId: string,
  seriesIndex: number,
  game: number,
): LeagueGameResponse | null {
  if (!SAFE_SEGMENT.test(runId)) return null;
  const rows = draftRuns(allRows).get(runId) ?? [];
  const identity = leagueIdentity(runsDir, runId, rows);
  const row = rows.find((entry) => count(entry.series_index) === seriesIndex);
  let slot: SeriesSlot;
  if (row) {
    const a = sideEntrant(row, 'p1', identity);
    const b = sideEntrant(row, 'p2', identity);
    if (a < 0 || b < 0) return null;
    slot = {
      seriesId: String(row.series_id ?? ''),
      sides: [a, b],
      stage: row.stage === 'playoff' ? 'playoff' : 'roundrobin',
      round: count(row.round),
      models: identity.models,
      labels: identity.teamNames,
    };
  } else {
    const found = liveSeriesByIndex(runsDir, runId, seriesIndex, identity);
    if (!found) return null;
    slot = { ...found, models: identity.models, labels: identity.teamNames };
  }
  return buildSeriesGame(runsDir, runId, seriesIndex, game, slot, row);
}
