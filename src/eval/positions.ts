import { seededRng } from '../random.js';
import type { JsonObject, Pid } from '../types.js';
import { SPREAD_FLOOR } from './summary.js';

export interface CandidatePosition {
  runId: string;
  seriesId: string;
  gameNumber: number;
  positionIndex: number;
  pid: Pid;
  format: string;
  scaffold: string;
  phase: string;
  turn: number;
  legal: number;
  value: number;
  spread: number;
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
    const exAnte = row.ex_ante as JsonObject | undefined;
    const exPost = row.ex_post as JsonObject | undefined;
    const pid = row.pid;
    if (!exAnte || !exPost || (pid !== 'p1' && pid !== 'p2')) continue;
    candidates.push({
      runId: String(row.run_id ?? ''),
      seriesId: String(row.series_id ?? ''),
      gameNumber: Number(row.game_number ?? 0),
      positionIndex: Number(row.position_index ?? 0),
      pid,
      format: String(row.format ?? ''),
      scaffold: String(row.scaffold ?? ''),
      phase: typeof row.phase === 'string' ? row.phase : 'turn',
      turn: Number(row.turn ?? 0),
      legal: Number(row.legal_actions ?? 0),
      value: Number(exAnte.chosen ?? 0),
      spread: Number(exAnte.spread ?? 0),
      played: String(row.chosen ?? ''),
      discriminating: Boolean(exAnte.discriminating) && Boolean(exPost.discriminating),
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
  const gap = Math.abs(position.value);
  if (gap < 0.1) return 'level';
  if (gap < 0.35) return 'tilted';
  return 'decided';
}

export function stratumOf(position: CandidatePosition): string {
  return `${position.phase}/${pace(position)}/${standing(position)}`;
}

export function selectPositions(candidates: CandidatePosition[], options: SelectionOptions = {}): Selection {
  const size = options.size ?? 500;
  const perGame = options.perGame ?? 3;
  const random = seededRng(options.seed ?? 'position-set');

  const usable = candidates.filter(
    (position) =>
      position.discriminating &&
      position.spread >= SPREAD_FLOOR &&
      position.legal > 1 &&
      (!options.formats || options.formats.includes(position.format)),
  );
  const rejected = candidates.length - usable.length;

  const pools = new Map<string, CandidatePosition[]>();
  for (const position of usable) {
    const key = stratumOf(position);
    pools.set(key, [...(pools.get(key) ?? []), position]);
  }

  const weights = [...pools.entries()].map(([key, pool]) => ({ key, pool, weight: Math.sqrt(pool.length) }));
  const total = weights.reduce((sum, entry) => sum + entry.weight, 0);

  const chosen: CandidatePosition[] = [];
  const perGameTaken = new Map<string, number>();
  const strata: Stratum[] = [];
  for (const { key, pool, weight } of weights.sort((a, b) => a.key.localeCompare(b.key))) {
    const target = total ? Math.max(1, Math.round((size * weight) / total)) : 0;
    const shuffled = [...pool].sort(() => random() - 0.5);
    let taken = 0;
    for (const position of shuffled) {
      if (taken >= target) break;
      const game = gameOf(position);
      if ((perGameTaken.get(game) ?? 0) >= perGame) continue;
      perGameTaken.set(game, (perGameTaken.get(game) ?? 0) + 1);
      chosen.push(position);
      taken += 1;
    }
    const [phase, paceName, standingName] = key.split('/') as [string, string, string];
    strata.push({ key, phase, pace: paceName, standing: standingName, available: pool.length, taken });
  }

  return { positions: chosen, strata, games: perGameTaken.size, rejected };
}
