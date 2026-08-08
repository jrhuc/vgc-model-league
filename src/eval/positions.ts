import { seededRng, shuffle } from '../random.js';
import type { BattleRequest, JsonObject, Pid } from '../types.js';

export const MIN_MEASURED_CONTRAST = 0.05;
export const POSITION_SET_SCHEMA_VERSION = 4;

export interface CandidatePosition {
  runId: string;
  seriesId: string;
  gameNumber: number;
  positionIndex: number;
  positionDigest: string;
  pid: Pid;
  format: string;
  scaffold: string;
  phase: string;
  turn: number;
  legal: number;
  value: number;
  contrast: number;
  played: string;
  discriminating: boolean;
}

export interface SelectionOptions {
  size?: number;
  seed?: string;
  perGame?: number;
  formats?: readonly string[];
}

export interface Stratum {
  key: string;
  phase: string;
  pace: string;
  standing: string;
  available: number;
  taken: number;
}

export interface Selection {
  positions: CandidatePosition[];
  strata: Stratum[];
  games: number;
  rejected: number;
}

export function readCandidates(rows: JsonObject[]): CandidatePosition[] {
  const candidates: CandidatePosition[] = [];
  for (const row of rows) {
    const vsSampledOpponent = row.vs_sampled_opponent as JsonObject | undefined;
    const pid = row.pid;
    if (
      !vsSampledOpponent ||
      (pid !== 'p1' && pid !== 'p2') ||
      typeof row.state_value !== 'number' ||
      typeof row.position_digest !== 'string' ||
      !row.position_digest
    ) {
      continue;
    }
    candidates.push({
      runId: String(row.run_id ?? ''),
      seriesId: String(row.series_id ?? ''),
      gameNumber: Number(row.game_number ?? 0),
      positionIndex: Number(row.position_index ?? 0),
      positionDigest: String(row.position_digest ?? ''),
      pid,
      format: String(row.format ?? ''),
      scaffold: String(row.scaffold ?? ''),
      phase: typeof row.phase === 'string' ? row.phase : 'turn',
      turn: Number(row.turn ?? 0),
      legal: Number(row.legal_actions ?? 0),
      value: row.state_value,
      contrast: Number(vsSampledOpponent.measuredContrast ?? 0),
      played: String(row.chosen ?? ''),
      discriminating: Boolean(vsSampledOpponent.discriminating),
    });
  }
  return candidates;
}

export const ANONYMOUS: Record<Pid, string> = { p1: 'Player 1', p2: 'Player 2' };

/** A recorded log names both seats by model spec, so replaying a position to a model would tell it
 * who played the position and who it faced. Reputation is not information a seat earns in play. */
export function anonymiseLog(lines: string[], names: Record<Pid, string>): string[] {
  const replacements = (['p1', 'p2'] as const)
    .map((pid) => ({ from: names[pid], to: ANONYMOUS[pid] }))
    .filter((entry) => entry.from)
    .sort((a, b) => b.from.length - a.from.length);
  return lines.map((line) => {
    let next = line;
    for (const { from, to } of replacements) next = next.split(from).join(to);
    return next;
  });
}

export function anonymiseRequest(request: BattleRequest, names: Record<Pid, string>): BattleRequest {
  const replacements = (['p1', 'p2'] as const)
    .map((pid) => ({ from: names[pid], to: ANONYMOUS[pid] }))
    .filter((entry) => entry.from)
    .sort((a, b) => b.from.length - a.from.length);
  const scrub = (value: unknown): unknown => {
    if (typeof value === 'string') {
      let next = value;
      for (const { from, to } of replacements) next = next.split(from).join(to);
      return next;
    }
    if (Array.isArray(value)) return value.map(scrub);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, scrub(entry)]));
  };
  return scrub(request) as BattleRequest;
}

export function gameOf(position: CandidatePosition): string {
  return `${position.runId}:${position.seriesId}:${position.gameNumber}`;
}

export function keyOf(position: CandidatePosition): string {
  return `${gameOf(position)}#${position.positionIndex}#${position.pid}`;
}

function pace(position: CandidatePosition): string {
  if (position.phase === 'team_preview') return 'preview';
  if (position.turn <= 3) return 'early';
  if (position.turn <= 8) return 'middle';
  return 'late';
}

function standing(position: CandidatePosition): string {
  if (position.value <= -0.35) return 'far-behind';
  if (position.value < -0.1) return 'behind';
  if (position.value <= 0.1) return 'level';
  if (position.value < 0.35) return 'ahead';
  return 'far-ahead';
}

export function stratumOf(position: CandidatePosition): string {
  return `${position.phase}/${pace(position)}/${standing(position)}`;
}

interface PoolState {
  key: string;
  pool: CandidatePosition[];
  cursor: number;
  taken: number;
  weight: number;
}

export function selectPositions(candidates: CandidatePosition[], options: SelectionOptions = {}): Selection {
  const size = options.size ?? 500;
  const perGame = options.perGame ?? 3;
  const random = seededRng(options.seed ?? 'position-set');

  const unique = new Map<string, CandidatePosition>();
  for (const position of candidates) if (!unique.has(keyOf(position))) unique.set(keyOf(position), position);
  const usable = [...unique.values()].filter(
    (position) =>
      position.discriminating &&
      position.contrast >= MIN_MEASURED_CONTRAST &&
      position.legal > 1 &&
      (!options.formats || options.formats.includes(position.format)),
  );
  const rejected = candidates.length - usable.length;

  const grouped = new Map<string, CandidatePosition[]>();
  for (const position of usable) {
    const key = stratumOf(position);
    grouped.set(key, [...(grouped.get(key) ?? []), position]);
  }
  const pools: PoolState[] = [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, pool]) => ({
      key,
      pool: shuffle(
        [...pool].sort((a, b) => keyOf(a).localeCompare(keyOf(b))),
        random,
      ),
      cursor: 0,
      taken: 0,
      weight: Math.sqrt(pool.length),
    }));

  const chosen: CandidatePosition[] = [];
  const perGameTaken = new Map<string, number>();
  while (chosen.length < size) {
    const available = pools.filter((state) => {
      while (state.cursor < state.pool.length) {
        const next = state.pool[state.cursor] as CandidatePosition;
        if ((perGameTaken.get(gameOf(next)) ?? 0) < perGame) return true;
        state.cursor += 1;
      }
      return false;
    });
    if (!available.length) break;
    available.sort((a, b) => (a.taken + 1) / a.weight - (b.taken + 1) / b.weight || a.key.localeCompare(b.key));
    const state = available[0] as PoolState;
    const position = state.pool[state.cursor] as CandidatePosition;
    state.cursor += 1;
    state.taken += 1;
    const game = gameOf(position);
    perGameTaken.set(game, (perGameTaken.get(game) ?? 0) + 1);
    chosen.push(position);
  }

  const strata: Stratum[] = pools.map((state) => {
    const [phase, paceName, standingName] = state.key.split('/') as [string, string, string];
    return {
      key: state.key,
      phase,
      pace: paceName,
      standing: standingName,
      available: state.pool.length,
      taken: state.taken,
    };
  });
  return { positions: chosen, strata, games: perGameTaken.size, rejected };
}
