import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { LLMEngine, RandomEngine } from './engines.js';
import { scaffoldRevision } from './engines.js';
import type { BracketView } from './gui/api.js';
import { defaultPsDir, RESULTS_PATH } from './paths.js';
import type { ReasoningLevel } from './providers.js';
import { parseSpec, validateReasoning } from './providers.js';
import type { Rng } from './random.js';
import { seededRng } from './random.js';
import type { SeriesRecord } from './records.js';
import { appendRow } from './records.js';
import { ShowdownReference } from './reference.js';
import type { ContributorAttribution, RotationEvent } from './rotation.js';
import { makeEngine, mapLimit, playBo3 } from './rotation.js';
import { showdownCommit } from './showdown.js';
import type { Team } from './teams.js';
import { loadPool, validatePool, validateTeam } from './teams.js';
import type { Pid } from './types.js';

export const TOURNAMENT_PROTOCOL_VERSION = 1;

export type TournamentEvent =
  | RotationEvent
  | { type: 'bracket'; bracket: BracketView }
  | { type: 'series-players'; index: number; players: Record<Pid, string> };

export interface TournamentOptions {
  seed?: number;
  concurrency?: number;
  recordsPath?: string;
  psDir?: string;
  reasoning?: ReasoningLevel;
  apiKeys?: Readonly<Record<string, string>>;
  pool?: string;
  /** Inline teams paired to models by index; replaces the pool as the team source. */
  teams?: Team[];
  /** Showdown format for inline teams; ignored when a pool is used. */
  format?: string;
  onEvent?: (event: TournamentEvent) => void;
  onNotice?: (message: string) => void;
  signal?: AbortSignal;
  contributor?: ContributorAttribution;
}

interface Entrant {
  model: string;
  team: Team;
}

export interface BracketMatch {
  round: number;
  /** Null for byes, which play no series. */
  seriesIndex: number | null;
  slots: [number | null, number | null];
  winner: number | null;
}

/**
 * Classic single-elimination seed order: seed 0 meets the highest seed, so byes
 * (seeds beyond the entrant count) spread across distinct first-round matches.
 */
export function seedPositions(size: number): number[] {
  let order = [0];
  while (order.length < size) {
    const doubled = order.length * 2;
    order = order.flatMap((position) => [position, doubled - 1 - position]);
  }
  return order;
}

export function buildBracket(count: number): BracketMatch[][] {
  let size = 1;
  while (size < count) size *= 2;
  const order = seedPositions(size);
  let series = 0;
  const first: BracketMatch[] = [];
  for (let position = 0; position < size; position += 2) {
    const a = order[position]! < count ? order[position]! : null;
    const b = order[position + 1]! < count ? order[position + 1]! : null;
    const played = a !== null && b !== null;
    first.push({ round: 0, seriesIndex: played ? series++ : null, slots: [a, b], winner: played ? null : (a ?? b) });
  }
  const rounds = [first];
  for (let width = size / 4; width >= 1; width /= 2) {
    rounds.push(
      Array.from({ length: width }, () => ({
        round: rounds.length,
        seriesIndex: series++,
        slots: [null, null] as [number | null, number | null],
        winner: null,
      })),
    );
  }
  return rounds;
}

function shuffle<T>(items: readonly T[], random: Rng): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [result[index], result[swap]] = [result[swap]!, result[index]!];
  }
  return result;
}

export async function runTournament(
  models: string[],
  runDir: string,
  options: TournamentOptions = {},
): Promise<SeriesRecord[]> {
  if (models.length < 2) throw new Error('a tournament needs at least two models');
  for (const model of models) validateReasoning(parseSpec(model), options.reasoning);
  if (options.apiKeys) {
    for (const model of models) {
      if (model !== 'random' && options.apiKeys[model] === undefined)
        throw new Error(
          `no API key was supplied for ${model}; key-carrying runs never fall back to server environment keys`,
        );
    }
  }

  fs.mkdirSync(runDir, { recursive: true });
  const recordsPath = options.recordsPath ?? RESULTS_PATH;
  const psDir = options.psDir ?? defaultPsDir();
  const seed = options.seed ?? randomBytes(6).readUIntBE(0, 6);
  const random = seededRng(seed);
  const scaffold = scaffoldRevision();

  let format: string;
  let poolId: string | null;
  let assignedTeams: Team[];
  if (options.teams) {
    if (options.teams.length !== models.length) throw new Error('inline tournaments need one team per model');
    if (!options.format) throw new Error('inline teams need an explicit format');
    format = options.format;
    for (const team of options.teams) {
      try {
        validateTeam(team.packed, format, psDir);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`invalid team ${JSON.stringify(team.id)}: ${detail}`);
      }
    }
    poolId = null;
    assignedTeams = options.teams;
    fs.writeFileSync(path.join(runDir, 'teams.json'), `${JSON.stringify(options.teams, null, 2)}\n`, 'utf8');
  } else {
    const pool = loadPool(options.pool ?? 'test');
    validatePool(pool, psDir);
    if (pool.teams.length < models.length) {
      throw new Error(`pool ${JSON.stringify(pool.id)} has ${pool.teams.length} teams for ${models.length} entrants`);
    }
    format = pool.format;
    poolId = pool.id;
    assignedTeams = shuffle(pool.teams, random).slice(0, models.length);
  }

  const placement = shuffle(
    models.map((_, index) => index),
    random,
  );
  const entrants: Entrant[] = placement.map((index) => ({ model: models[index]!, team: assignedTeams[index]! }));
  const rounds = buildBracket(entrants.length);
  const matches = rounds.flat();
  const seriesCount = entrants.length - 1;
  const seriesSeeds = Array.from({ length: seriesCount }, () => ({
    gameSeeds: Array.from(
      { length: 3 },
      () => Array.from({ length: 4 }, () => 1 + Math.floor(random() * 0xffff)) as [number, number, number, number],
    ),
    engineSeeds: {
      p1: Math.floor(random() * Number.MAX_SAFE_INTEGER),
      p2: Math.floor(random() * Number.MAX_SAFE_INTEGER),
    } as Record<Pid, number>,
  }));

  const bracketView = (): BracketView => ({
    entrants: entrants.map((entrant) => ({ model: entrant.model, team: entrant.team.id })),
    rounds: rounds.map((round) =>
      round.map((match) => ({ seriesIndex: match.seriesIndex, slots: [...match.slots], winner: match.winner })),
    ),
    champion: rounds[rounds.length - 1]![0]!.winner,
  });

  fs.writeFileSync(
    path.join(runDir, 'config.json'),
    `${JSON.stringify(
      {
        mode: 'tournament',
        protocol_version: TOURNAMENT_PROTOCOL_VERSION,
        scaffold,
        models,
        seed,
        concurrency: options.concurrency ?? 2,
        reasoning: options.reasoning ?? null,
        pool: poolId,
        format,
        entrants: entrants.map((entrant) => ({ model: entrant.model, team: entrant.team.id })),
        contributor: options.contributor ?? null,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const playersFor = (match: BracketMatch): Record<Pid, string> => ({
    p1: match.slots[0] === null ? 'TBD' : entrants[match.slots[0]]!.model,
    p2: match.slots[1] === null ? 'TBD' : entrants[match.slots[1]]!.model,
  });
  options.onEvent?.({
    type: 'plans',
    mode: 'tournament',
    protocolVersion: TOURNAMENT_PROTOCOL_VERSION,
    plans: matches
      .filter((match) => match.seriesIndex !== null)
      .sort((a, b) => a.seriesIndex! - b.seriesIndex!)
      .map((match) => ({ index: match.seriesIndex!, players: playersFor(match) })),
    pool: poolId ?? '',
    seed,
  });

  const propagate = (match: BracketMatch): void => {
    const roundMatches = rounds[match.round]!;
    const position = roundMatches.indexOf(match);
    const next = rounds[match.round + 1]?.[position >> 1];
    if (next && match.winner !== null) next.slots[position % 2] = match.winner;
  };
  for (const match of rounds[0]!) if (match.seriesIndex === null) propagate(match);
  options.onEvent?.({ type: 'bracket', bracket: bracketView() });

  const results: SeriesRecord[] = [];
  for (const round of rounds) {
    if (options.signal?.aborted) break;
    const playable = round.filter(
      (match) => match.seriesIndex !== null && match.slots[0] !== null && match.slots[1] !== null,
    );
    const roundResults = await mapLimit(playable, options.concurrency ?? 2, options.signal, async (match, signal) => {
      const row = await playMatch(match, entrants, {
        runDir,
        format,
        poolId,
        runSeed: seed,
        scaffold,
        psDir,
        signal,
        seriesSeeds: seriesSeeds[match.seriesIndex!]!,
        ...(options.reasoning === undefined ? {} : { reasoning: options.reasoning }),
        ...(options.apiKeys === undefined ? {} : { apiKeys: options.apiKeys }),
        ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
        ...(options.onNotice === undefined ? {} : { onNotice: options.onNotice }),
        ...(options.contributor === undefined ? {} : { contributor: options.contributor }),
      });
      appendRow(recordsPath, row);
      propagate(match);
      options.onEvent?.({ type: 'series-end', index: match.seriesIndex!, record: row });
      options.onEvent?.({ type: 'bracket', bracket: bracketView() });
      return row;
    });
    results.push(...roundResults);
  }
  return results;
}

async function playMatch(
  match: BracketMatch,
  entrants: Entrant[],
  context: {
    runDir: string;
    format: string;
    poolId: string | null;
    runSeed: number;
    scaffold: string;
    psDir: string;
    seriesSeeds: { gameSeeds: Array<[number, number, number, number]>; engineSeeds: Record<Pid, number> };
    reasoning?: ReasoningLevel;
    apiKeys?: Readonly<Record<string, string>>;
    onEvent?: (event: TournamentEvent) => void;
    onNotice?: (message: string) => void;
    signal?: AbortSignal;
    contributor?: ContributorAttribution;
  },
): Promise<SeriesRecord> {
  context.signal?.throwIfAborted();
  const index = match.seriesIndex!;
  const sides: Record<Pid, Entrant> = { p1: entrants[match.slots[0]!]!, p2: entrants[match.slots[1]!]! };
  const players: Record<Pid, string> = { p1: sides.p1.model, p2: sides.p2.model };
  context.onEvent?.({ type: 'series-players', index, players });
  context.onEvent?.({ type: 'series-start', index });
  const seriesId = randomUUID().replaceAll('-', '').slice(0, 12);
  const seriesDir = path.join(context.runDir, 'series', seriesId);
  fs.mkdirSync(seriesDir, { recursive: true });
  const names: Record<Pid, string> = { p1: `p1-${players.p1}`, p2: `p2-${players.p2}` };
  const reference = Object.values(players).some((player) => player !== 'random')
    ? new ShowdownReference(context.format, context.psDir)
    : undefined;
  const engines = Object.fromEntries(
    (['p1', 'p2'] as const).map((pid) => [
      pid,
      makeEngine(
        pid,
        players[pid],
        context.seriesSeeds.engineSeeds[pid],
        path.join(seriesDir, `${pid}-decisions.jsonl`),
        path.join(seriesDir, `${pid}-trace.jsonl`),
        context.format,
        context.psDir,
        context.reasoning,
        reference,
        context.signal,
        context.apiKeys?.[players[pid]],
      ),
    ]),
  ) as Record<Pid, RandomEngine | LLMEngine>;
  const { score, games, winnerSide } = await playBo3({
    engines,
    names,
    players,
    teams: { p1: sides.p1.team, p2: sides.p2.team },
    gameSeeds: context.seriesSeeds.gameSeeds,
    seriesId,
    seriesDir,
    format: context.format,
    psDir: context.psDir,
    ...(context.signal === undefined ? {} : { signal: context.signal }),
    onGameUpdate: (game, lines, publicLines) =>
      context.onEvent?.({ type: 'game-update', index, game, lines, publicLines }),
    onGameEnd: (game, winner, turns, score) =>
      context.onEvent?.({ type: 'game-end', index, game, winner, turns, score }),
  });

  // A drawn series cannot leave the bracket unresolved: the higher seed advances,
  // while the record keeps winner null so results stay honest.
  match.winner = winnerSide ? match.slots[winnerSide === 'p1' ? 0 : 1]! : match.slots[0]!;
  if (!winnerSide) {
    context.onNotice?.(`series ${index + 1} was drawn; ${sides.p1.model} advances as the higher seed`);
  }

  return {
    schema_version: 1,
    mode: 'tournament',
    protocol_version: TOURNAMENT_PROTOCOL_VERSION,
    scaffold: context.scaffold,
    timestamp: new Date().toISOString(),
    run_id: path.basename(context.runDir),
    series_id: seriesId,
    series_index: index,
    round: match.round + 1,
    format: context.format,
    ...(context.poolId === null ? {} : { pool: context.poolId }),
    ...(context.contributor === undefined ? {} : { contributor: context.contributor }),
    players,
    teams: { p1: sides.p1.team.id, p2: sides.p2.team.id },
    winner: winnerSide ? players[winnerSide] : null,
    winner_side: winnerSide ?? null,
    advanced: entrants[match.winner]!.model,
    score,
    turns: games.reduce((sum, game) => sum + Number(game.turns), 0),
    games,
    run_seed: context.runSeed,
    engine_seeds: context.seriesSeeds.engineSeeds,
    reasoning: context.reasoning ?? null,
    decision_stats: Object.fromEntries((['p1', 'p2'] as const).map((pid) => [pid, engines[pid].decisionStats()])),
    ps_commit: showdownCommit(context.psDir),
  };
}
