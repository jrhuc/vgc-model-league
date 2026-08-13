import fs from 'node:fs';
import path from 'node:path';

import type {
  BattleLogEntryView,
  BattleSnapshot,
  DecisionView,
  LeagueGameDecisionView,
  LeagueGameReflectionView,
  LeagueGameResponse,
  MonView,
  TeambuildSetView,
} from './gui/api.js';
import { BattleLog } from './gui/battlelog.js';
import { readJsonlObjects } from './jsonl.js';
import { SAFE_SEGMENT } from './path-safety.js';
import type { SeriesRecord } from './records.js';
import { loadShowdown } from './showdown.js';
import { BattleState, type MonState } from './state.js';
import type { Pid } from './types.js';
import { afterColon } from './value.js';

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

export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const position = (sorted.length - 1) * q;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return sorted[low]! + (sorted[high]! - sorted[low]!) * (position - low);
}

export const PIDS: Pid[] = ['p1', 'p2'];

const spriteIds = new Map<string, string>();

export function spriteIdFor(species: string): string {
  const cached = spriteIds.get(species);
  if (cached !== undefined) return cached;
  const { Dex } = loadShowdown();
  const resolved = Dex.mod('champions').species.get(species);
  const id = resolved.exists ? resolved.spriteid : '';
  spriteIds.set(species, id);
  return id;
}

export function viewTeamSheet(packed: string): TeambuildSetView[] {
  const { Teams } = loadShowdown();
  return (Teams.unpack(packed) ?? []).map((set) => {
    const evs = Object.fromEntries(
      Object.entries(set.evs ?? {}).filter((entry): entry is [string, number] => typeof entry[1] === 'number'),
    );
    const species = set.species || set.name || 'Pokémon';
    return {
      species,
      spriteId: spriteIdFor(species),
      item: set.item,
      ability: set.ability,
      nature: set.nature,
      moves: set.moves,
      evs,
      repaired: false,
      repairs: [],
    };
  });
}

function snapshotMon(battle: BattleState, pid: Pid, mon: MonState): MonView {
  const boosts = Object.entries(mon.boosts)
    .filter(([, value]) => value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([stat, value]) => `${stat} ${value > 0 ? '+' : ''}${value}`)
    .join(', ');
  const target = mon.lastMove?.target ? ` → ${afterColon(mon.lastMove.target)}` : '';
  const volatiles = [...mon.volatiles]
    .map((volatile) => (/^perish(\d)$/i.test(volatile) ? `Perish ${volatile.slice(-1)}` : volatile))
    .sort()
    .join(', ');
  return {
    species: mon.species,
    spriteId: spriteIdFor(mon.species),
    slot: battle.activeSlot(pid, mon)?.toUpperCase() ?? '',
    hp: mon.fainted ? 'fainted' : (mon.hp ?? ''),
    status: mon.fainted ? '' : (mon.status ?? ''),
    fainted: mon.fainted,
    boosts,
    volatiles,
    lastMove: mon.lastMove ? `${mon.lastMove.name}${target} · T${mon.lastMove.turn}` : '',
  };
}

export function snapshotBattle(
  battle: BattleState,
  players: Record<Pid, string> | undefined,
  log: BattleLogEntryView[],
  decisions: DecisionView[] = [],
  spend?: Record<Pid, { ms: number; tokens: number }>,
): BattleSnapshot {
  const side = (pid: Pid) => ({
    player: players?.[pid] ?? pid,
    conditions: battle.conditionLabels(pid),
    mons: battle.visibleMons(pid).map((mon) => snapshotMon(battle, pid, mon)),
  });
  const timerView = (pid: Pid) => {
    const timer = battle.timers[pid];
    if (!timer) return null;
    const drained = timer.running ? (Date.now() - timer.at) / 1000 : 0;
    const remaining = (value: number | null) => (value === null ? null : Math.max(0, Math.round(value - drained)));
    return {
      seconds: remaining(timer.seconds),
      turnSeconds: remaining(timer.turnSeconds),
      elapsedSeconds: timer.running ? Math.max(0, Math.floor(drained)) : null,
      running: timer.running,
    };
  };
  const spendView = (pid: Pid) => ({
    seconds: Math.round((spend?.[pid]?.ms ?? 0) / 1000),
    tokens: spend?.[pid]?.tokens ?? 0,
  });
  return {
    turn: battle.turn,
    weather: battle.weatherLabel(),
    fields: battle.fieldLabels(),
    sides: { p1: side('p1'), p2: side('p2') },
    timers: { p1: timerView('p1'), p2: timerView('p2') },
    spend: { p1: spendView('p1'), p2: spendView('p2') },
    log,
    decisions,
  };
}

export function isRunLive(runsDir: string, runId: string): boolean {
  const status = readRunJson(runsDir, runId, 'status.json') as Record<string, unknown> | null;
  if ((status?.state !== 'running' && status?.state !== 'paused') || typeof status.pid !== 'number') return false;
  try {
    process.kill(status.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function readRunJson(runsDir: string, runId: string, ...segments: string[]): unknown {
  try {
    return JSON.parse(fs.readFileSync(path.join(runsDir, runId, ...segments), 'utf8'));
  } catch {
    return null;
  }
}

export function readRunLines(runsDir: string, runId: string, ...segments: string[]): Record<string, unknown>[] {
  return readJsonlObjects(path.join(runsDir, runId, ...segments));
}

export interface UnfinishedSeries {
  seriesId: string;
  seriesIndex: number | null;
  game: number;
  turn: number;
  decisions: number;
  players: Record<Pid, string> | null;
}

export function scanUnfinishedSeries(runsDir: string, runId: string, rows: SeriesRecord[]): UnfinishedSeries[] {
  const seen = new Set(rows.map((row) => String(row.series_id ?? '')));
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(path.join(runsDir, runId, 'series'));
  } catch {
    return [];
  }
  const found: UnfinishedSeries[] = [];
  for (const seriesId of entries) {
    if (!SAFE_SEGMENT.test(seriesId) || seen.has(seriesId)) continue;
    let decisions = 0;
    let game = 0;
    let turn = 0;
    for (const pid of PIDS) {
      const lines = readRunLines(runsDir, runId, 'series', seriesId, `${pid}-decisions.jsonl`);
      decisions += lines.length;
      const last = lines[lines.length - 1];
      if (last) {
        game = Math.max(game, count(last.game_number));
        turn = Math.max(turn, count(last.turn));
      }
    }
    const meta = readRunJson(runsDir, runId, 'series', seriesId, 'series.json') as Record<string, unknown> | null;
    const storedIdentity =
      meta?.schema_version === 3 && meta.identity && typeof meta.identity === 'object' && !Array.isArray(meta.identity)
        ? (meta.identity as Record<string, unknown>)
        : null;
    const raw = (storedIdentity?.players ?? null) as Record<string, unknown> | null;
    const players = raw && typeof raw.p1 === 'string' && typeof raw.p2 === 'string' ? { p1: raw.p1, p2: raw.p2 } : null;
    found.push({
      seriesId,
      seriesIndex: typeof storedIdentity?.series_index === 'number' ? storedIdentity.series_index : null,
      game: Math.max(1, game),
      turn,
      decisions,
      players,
    });
  }
  return found.sort((a, b) => a.seriesId.localeCompare(b.seriesId));
}

export interface SeriesSlot {
  seriesId: string;
  sides: [number, number];
  stage: 'roundrobin' | 'playoff';
  round: number;
  models: string[];
  labels: string[];
}

export function buildSeriesGame(
  runsDir: string,
  runId: string,
  seriesIndex: number,
  game: number,
  slot: SeriesSlot,
  row: SeriesRecord | undefined,
): LeagueGameResponse | null {
  const { seriesId, sides, stage, round } = slot;
  if (!SAFE_SEGMENT.test(runId) || !SAFE_SEGMENT.test(seriesId)) return null;

  let seriesFiles: string[];
  try {
    seriesFiles = fs.readdirSync(path.join(runsDir, runId, 'series', seriesId));
  } catch {
    return null;
  }
  const gameNumbers = new Set<number>();
  for (const name of seriesFiles) {
    const match = /^game-(\d+)\.log$/.exec(name);
    if (match) gameNumbers.add(Number(match[1]));
  }

  const decisions: LeagueGameDecisionView[] = [];
  const reflections: LeagueGameReflectionView[] = [];
  for (const [side, pid] of [
    [0, 'p1'],
    [1, 'p2'],
  ] as const) {
    for (const entry of readRunLines(runsDir, runId, 'series', seriesId, `${pid}-decisions.jsonl`)) {
      const entryGame = count(entry.game_number);
      if (entryGame > 0) gameNumbers.add(entryGame);
      if (entryGame !== game) continue;
      if (entry.kind === 'game_reflection') {
        reflections.push({
          side,
          result: entry.result === 'won' ? 'won' : 'lost',
          summary: typeof entry.summary === 'string' ? entry.summary : '',
          adjustment: typeof entry.adjustment === 'string' ? entry.adjustment : '',
          notebook: typeof entry.notebook === 'string' ? entry.notebook : '',
          fallback: entry.fallback === true,
          seriesOver: entry.series_over === true,
        });
        continue;
      }
      if (entry.kind !== 'decision') continue;
      const numeric = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
      decisions.push({
        side,
        turn: count(entry.turn),
        phase: typeof entry.phase === 'string' ? entry.phase : 'turn',
        selection: Array.isArray(entry.selection) ? entry.selection.map(String) : [],
        action: typeof entry.action === 'string' ? entry.action : '',
        rationale: typeof entry.rationale === 'string' ? entry.rationale : '',
        notebook: typeof entry.notebook === 'string' ? entry.notebook : '',
        fallback: entry.fallback === true,
        automatic: entry.automatic === true,
        latencyMs: numeric(entry.latency_ms),
        totalTokens: numeric(entry.total_tokens),
        reasoningTokens: numeric(entry.reasoning_tokens),
      });
    }
  }
  if (!gameNumbers.has(game)) return null;
  decisions.sort((first, second) => first.turn - second.turn || first.side - second.side);

  let raw = '';
  try {
    raw = fs.readFileSync(path.join(runsDir, runId, 'series', seriesId, `game-${game}.log`), 'utf8');
  } catch {
    if (row) return null;
  }
  const battleLog = new BattleLog(10_000);
  battleLog.feed(raw.split('\n'));
  const live = !row && isRunLive(runsDir, runId);
  let snapshot: BattleSnapshot | null = null;
  if (live && !/^\|(?:win\||tie\b)/m.test(raw)) {
    const state = new BattleState('p1');
    state.feed(raw.split('\n'));
    const spendFor = (side: 0 | 1) => ({
      ms: decisions.reduce((total, entry) => total + (entry.side === side ? (entry.latencyMs ?? 0) : 0), 0),
      tokens: decisions.reduce((total, entry) => total + (entry.side === side ? (entry.totalTokens ?? 0) : 0), 0),
    });
    snapshot = snapshotBattle(state, { p1: slot.models[sides[0]]!, p2: slot.models[sides[1]]! }, [], [], {
      p1: spendFor(0),
      p2: spendFor(1),
    });
  }

  const gameRows = row && Array.isArray(row.games) ? (row.games as Record<string, unknown>[]) : [];
  const logWinner = (text: string): number | null => {
    const lines = text.split('\n');
    const players = new Map<string, Pid>();
    for (const line of lines) {
      const match = /^\|player\|(p[12])\|([^|]+)\|/.exec(line);
      if (match) players.set(match[2]!, match[1] as Pid);
    }
    const winLine = lines.find((line) => line.startsWith('|win|'));
    const pid = winLine === undefined ? undefined : players.get(winLine.slice(5).trim());
    return pid === undefined ? null : pid === 'p1' ? sides[0] : sides[1];
  };
  const winnerOf = (number: number): number | null => {
    const gameRow = gameRows[number - 1];
    if (gameRow?.winner_side === 'p1') return sides[0];
    if (gameRow?.winner_side === 'p2') return sides[1];
    if (row) return null;
    if (number === game) return raw ? logWinner(raw) : null;
    try {
      return logWinner(fs.readFileSync(path.join(runsDir, runId, 'series', seriesId, `game-${number}.log`), 'utf8'));
    } catch {
      return null;
    }
  };
  const games = [...gameNumbers].sort((first, second) => first - second);
  return {
    runId,
    seriesIndex,
    seriesId,
    stage,
    round,
    game,
    games,
    gameWinners: games.map(winnerOf),
    sides,
    teamNames: [slot.labels[sides[0]] ?? `Seat ${sides[0] + 1}`, slot.labels[sides[1]] ?? `Seat ${sides[1] + 1}`],
    winner: winnerOf(game),
    live,
    snapshot,
    log: battleLog.entries,
    decisions,
    reflections,
  };
}
