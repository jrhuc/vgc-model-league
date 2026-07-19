import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { LLMEngine, RandomEngine } from './engines.js';
import type { ReasoningLevel } from './providers.js';
import { ShowdownReference } from './reference.js';
import { makeEngine, playBo3 } from './rotation.js';
import type { Team } from './teams.js';
import type { JsonObject, Pid } from './types.js';

export interface RecordedSeriesContext {
  players: Record<Pid, string>;
  teams: Record<Pid, Team>;
  gameSeeds: Array<[number, number, number, number]>;
  engineSeeds: Record<Pid, number>;
  format: string;
  psDir: string;
  runDir: string;
  reasoning?: ReasoningLevel;
  apiKeys?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
  onGameUpdate?: (game: number, lines: string[], publicLines: string[]) => void;
  onGameEnd?: (game: number, winner: string | null, turns: number, score: Record<Pid, number>) => void;
}

/** Common record fields shared by every mode; callers add mode identity on top. */
export interface RecordedSeriesFields extends JsonObject {
  timestamp: string;
  run_id: string;
  series_id: string;
  format: string;
  players: Record<Pid, string>;
  teams: Record<Pid, string>;
  winner: string | null;
  winner_side: Pid | null;
  score: Record<Pid, number>;
  turns: number;
  games: JsonObject[];
  engine_seeds: Record<Pid, number>;
  reasoning: ReasoningLevel | null;
  decision_stats: JsonObject;
}

export interface RecordedSeries {
  winnerSide: Pid | undefined;
  fields: RecordedSeriesFields;
}

export async function playRecordedSeries(context: RecordedSeriesContext): Promise<RecordedSeries> {
  context.signal?.throwIfAborted();
  const seriesId = randomUUID().replaceAll('-', '').slice(0, 12);
  const seriesDir = path.join(context.runDir, 'series', seriesId);
  fs.mkdirSync(seriesDir, { recursive: true });
  const names: Record<Pid, string> = { p1: `p1-${context.players.p1}`, p2: `p2-${context.players.p2}` };
  const reference = Object.values(context.players).some((player) => player !== 'random')
    ? new ShowdownReference(context.format, context.psDir)
    : undefined;
  const engines = Object.fromEntries(
    (['p1', 'p2'] as const).map((pid) => [
      pid,
      makeEngine(
        pid,
        context.players[pid],
        context.engineSeeds[pid],
        path.join(seriesDir, `${pid}-decisions.jsonl`),
        path.join(seriesDir, `${pid}-trace.jsonl`),
        context.format,
        context.psDir,
        context.reasoning,
        reference,
        context.signal,
        context.apiKeys?.[context.players[pid]],
      ),
    ]),
  ) as Record<Pid, RandomEngine | LLMEngine>;
  const { score, games, winnerSide } = await playBo3({
    engines,
    names,
    players: context.players,
    teams: context.teams,
    gameSeeds: context.gameSeeds,
    seriesId,
    seriesDir,
    format: context.format,
    psDir: context.psDir,
    ...(context.signal === undefined ? {} : { signal: context.signal }),
    ...(context.onGameUpdate === undefined ? {} : { onGameUpdate: context.onGameUpdate }),
    ...(context.onGameEnd === undefined ? {} : { onGameEnd: context.onGameEnd }),
  });
  const stats = Object.fromEntries(
    (['p1', 'p2'] as const).map((pid) => [pid, engines[pid].decisionStats()]),
  ) as JsonObject;
  return {
    winnerSide,
    fields: {
      timestamp: new Date().toISOString(),
      run_id: path.basename(context.runDir),
      series_id: seriesId,
      format: context.format,
      players: context.players,
      teams: { p1: context.teams.p1.id, p2: context.teams.p2.id },
      winner: winnerSide ? context.players[winnerSide] : null,
      winner_side: winnerSide ?? null,
      score,
      turns: games.reduce((sum, game) => sum + Number(game.turns), 0),
      games,
      engine_seeds: context.engineSeeds,
      reasoning: context.reasoning ?? null,
      decision_stats: stats,
    },
  };
}
