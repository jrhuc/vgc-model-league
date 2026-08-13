import fs from 'node:fs';
import path from 'node:path';
import type {
  ArchivedMatchView,
  BracketEntrantView,
  LeagueGameResponse,
  TournamentArchiveView,
  TournamentEventView,
  TournamentLiveSeriesView,
  TournamentSummary,
  TournamentsResponse,
} from './gui/api.js';
import { SAFE_SEGMENT } from './path-safety.js';
import { type SeriesRecord, TEST_POOL } from './records.js';
import { buildSeriesGame, count, isRunLive, scanUnfinishedSeries, viewTeamSheet } from './run-artifacts.js';
import { loadPool } from './teams.js';
import { buildBracket } from './tournament.js';
import type { Pid } from './types.js';

function summarizeTournaments(tournaments: Array<{ rounds: ArchivedMatchView[][] }>): TournamentSummary {
  const counts = tournaments.map(
    (archive) => archive.rounds.flat().filter((match) => match.seriesIndex !== null && match.score !== null).length,
  );
  return { tournaments: counts.filter((matches) => matches > 0).length, matches: counts.reduce((a, b) => a + b, 0) };
}

function liveTournamentRuns(runsDir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(runsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const runId = entry.name;
    if (!entry.isDirectory() || entry.isSymbolicLink() || !SAFE_SEGMENT.test(runId)) return [];
    return runConfig(runsDir, runId)?.mode === 'tournament' && isRunLive(runsDir, runId) ? [runId] : [];
  });
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

function configEntrants(config: Record<string, unknown> | null): BracketEntrantView[] | null {
  if (!config || !Array.isArray(config.entrants)) return null;
  const entrants = (config.entrants as Array<Record<string, unknown>>).map((entry) => ({
    model: String(entry.model ?? ''),
    team: String(entry.team ?? ''),
    seed: typeof entry.seed === 'number' ? entry.seed : null,
    placement: typeof entry.placement === 'number' ? entry.placement : null,
  }));
  return entrants.every((entry: BracketEntrantView) => entry.model && entry.team) ? entrants : null;
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

interface TournamentEntrantFact {
  model: string;
  team: string;
  seed?: number | null;
  placement?: number | null;
}

interface TournamentSeriesLocation {
  round: number;
  slots: [number | null, number | null];
}

interface TournamentFold {
  entrants: TournamentEntrantFact[];
  rounds: ArchivedMatchView[][];
  champion: number | null;
  rowsBySeries: Map<number, SeriesRecord>;
  locations: Map<number, TournamentSeriesLocation>;
}

interface TournamentProjection<View> {
  view: View;
  fold: TournamentFold;
}

/** Rebuilds a tournament solely from selected structural facts and rejects facts that cannot all be true. */
function foldTournament(
  rows: SeriesRecord[],
  configured: readonly TournamentEntrantFact[] | null,
): TournamentFold | null {
  let size = configured?.length ?? null;
  if (size !== null && size < 2) return null;
  for (const row of rows) {
    const entrantCount = row.entrant_count;
    if (!Number.isSafeInteger(entrantCount) || Number(entrantCount) < 2) return null;
    if (size === null) size = Number(entrantCount);
    else if (entrantCount !== size) return null;
  }
  if (size === null) return null;

  const identities: Array<{ model: string; team: string } | null> = configured
    ? configured.map(({ model, team }) => (model && team ? { model, team } : null))
    : Array.from({ length: size }, () => null);
  if (configured && identities.some((identity) => identity === null)) return null;
  const rowsBySeries = new Map<number, SeriesRecord>();
  for (const row of rows) {
    const seriesIndex = row.series_index;
    if (!Number.isSafeInteger(seriesIndex) || Number(seriesIndex) < 0 || rowsBySeries.has(Number(seriesIndex))) {
      return null;
    }
    rowsBySeries.set(Number(seriesIndex), row);
    const seeds = row.seeds as Record<Pid, unknown> | undefined;
    const teams = row.teams as Record<Pid, unknown> | undefined;
    for (const pid of ['p1', 'p2'] as const) {
      const seed = seeds?.[pid];
      const model = row.players?.[pid];
      const team = teams?.[pid];
      if (
        !Number.isSafeInteger(seed) ||
        Number(seed) < 0 ||
        Number(seed) >= size ||
        typeof model !== 'string' ||
        !model ||
        typeof team !== 'string' ||
        !team
      ) {
        return null;
      }
      const entrant = { model, team };
      const previous = identities[Number(seed)];
      if (previous && (previous.model !== entrant.model || previous.team !== entrant.team)) return null;
      identities[Number(seed)] = entrant;
    }
    if (seeds?.p1 === seeds?.p2) return null;
  }
  if (identities.some((identity) => identity === null)) return null;
  const resolvedIdentities = identities as Array<{ model: string; team: string }>;
  if (new Set(resolvedIdentities.map((identity) => identity.model)).size !== size) return null;

  const entrants = configured
    ? configured.map((entrant) => ({ ...entrant }))
    : resolvedIdentities.map((identity) => ({ ...identity }));
  const bracket = buildBracket(size);
  const expectedSeries = new Set(
    bracket.flatMap((round) => round.flatMap((match) => (match.seriesIndex === null ? [] : [match.seriesIndex]))),
  );
  if ([...rowsBySeries.keys()].some((seriesIndex) => !expectedSeries.has(seriesIndex))) return null;

  const rounds: ArchivedMatchView[][] = [];
  const winners = new Map<number, number | null>();
  const locations = new Map<number, TournamentSeriesLocation>();
  for (const [roundIndex, round] of bracket.entries()) {
    const views: ArchivedMatchView[] = [];
    for (const [matchIndex, match] of round.entries()) {
      const slots: [number | null, number | null] =
        roundIndex === 0
          ? [...match.slots]
          : [winners.get(matchIndex * 2) ?? null, winners.get(matchIndex * 2 + 1) ?? null];
      let winner = match.seriesIndex === null ? (slots[0] ?? slots[1]) : null;
      let score: [number, number] | null = null;
      let turns: number | null = null;
      if (match.seriesIndex !== null) {
        locations.set(match.seriesIndex, { round: roundIndex, slots });
        const row = rowsBySeries.get(match.seriesIndex);
        if (row) {
          const seeds = row.seeds as Record<Pid, unknown> | undefined;
          const sideScore = row.score as Record<Pid, unknown> | undefined;
          const firstScore = sideScore?.p1;
          const secondScore = sideScore?.p2;
          if (
            slots[0] === null ||
            slots[1] === null ||
            seeds?.p1 !== slots[0] ||
            seeds.p2 !== slots[1] ||
            (row.round !== undefined && row.round !== roundIndex + 1) ||
            (row.winner_side !== 'p1' && row.winner_side !== 'p2') ||
            !Number.isSafeInteger(firstScore) ||
            Number(firstScore) < 0 ||
            !Number.isSafeInteger(secondScore) ||
            Number(secondScore) < 0
          ) {
            return null;
          }
          const winnerPid = row.winner_side;
          if (
            (winnerPid === 'p1' && Number(firstScore) <= Number(secondScore)) ||
            (winnerPid === 'p2' && Number(secondScore) <= Number(firstScore))
          ) {
            return null;
          }
          const winnerModel = row.players[winnerPid];
          if (
            (typeof row.winner === 'string' && row.winner !== winnerModel) ||
            (typeof row.advanced === 'string' && row.advanced !== winnerModel)
          ) {
            return null;
          }
          score = [Number(firstScore), Number(secondScore)];
          turns = count(row.turns);
          winner = slots[winnerPid === 'p1' ? 0 : 1];
        }
      }
      views.push({ seriesIndex: match.seriesIndex, slots, winner, score, turns });
    }
    for (const [matchIndex, view] of views.entries()) winners.set(matchIndex, view.winner);
    rounds.push(views);
  }
  return {
    entrants,
    rounds,
    champion: rounds[rounds.length - 1]?.[0]?.winner ?? null,
    rowsBySeries,
    locations,
  };
}

function tournamentSeriesLocation(fold: TournamentFold, seriesIndex: unknown): TournamentSeriesLocation | null {
  return Number.isSafeInteger(seriesIndex) ? (fold.locations.get(Number(seriesIndex)) ?? null) : null;
}

function locateTournamentStarts<T>(
  fold: TournamentFold,
  starts: Array<{ value: T; seriesIndex: unknown }>,
): Array<{ value: T; seriesIndex: number; location: TournamentSeriesLocation }> | null {
  const seen = new Set<number>();
  const located: Array<{ value: T; seriesIndex: number; location: TournamentSeriesLocation }> = [];
  for (const start of starts) {
    if (!Number.isSafeInteger(start.seriesIndex)) continue;
    const seriesIndex = Number(start.seriesIndex);
    if (fold.rowsBySeries.has(seriesIndex)) continue;
    const location = tournamentSeriesLocation(fold, seriesIndex);
    if (!location || location.slots[0] === null || location.slots[1] === null || seen.has(seriesIndex)) return null;
    seen.add(seriesIndex);
    located.push({ value: start.value, seriesIndex, location });
  }
  return located;
}

function archiveTournament(
  runId: string,
  rows: SeriesRecord[],
  runsDir: string,
  teamsDir?: string,
): TournamentProjection<TournamentArchiveView> | null {
  const config = runConfig(runsDir, runId);
  const fold = foldTournament(rows, configEntrants(config));
  if (!fold) return null;
  const poolField = rows.find((row) => typeof row.pool === 'string')?.pool ?? config?.pool;
  const pool = typeof poolField === 'string' ? poolField : null;
  const { event, teams } = poolProvenance(pool, teamsDir);
  const detailed = fold.entrants.map((entrant) => ({
    ...entrant,
    ...(teams.get(entrant.team) ?? {}),
    model: entrant.model,
  }));
  const live = isRunLive(runsDir, runId);
  const unfinished = live
    ? scanUnfinishedSeries(runsDir, runId, rows).filter((entry) => entry.decisions > 0 || entry.players)
    : [];
  const located = locateTournamentStarts(
    fold,
    unfinished.map((entry) => ({ value: entry, seriesIndex: entry.seriesIndex })),
  );
  if (!located) return null;
  const liveSeries: TournamentLiveSeriesView[] = located.map(({ value: entry, seriesIndex, location }) => ({
    seriesId: entry.seriesId,
    seriesIndex,
    round: location.round,
    slots: location.slots,
    game: entry.game,
    turn: entry.turn,
    decisions: entry.decisions,
  }));
  const timestamps = rows.map((row) => String(row.timestamp ?? '')).filter(Boolean);
  const provenance = config?.provenance;
  return {
    fold,
    view: {
      runId,
      when: timestamps.sort()[0] ?? runStartedAt(runsDir, runId),
      pool,
      entrants: detailed,
      rounds: fold.rounds,
      champion: fold.champion,
      complete: fold.champion !== null,
      live,
      liveSeries,
      event,
      provenance: provenance === 'disclosed' || provenance === 'blind' ? provenance : null,
    },
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
  const projection = archiveTournament(runId, rows, runsDir, teamsDir);
  if (!projection) return null;
  const location = tournamentSeriesLocation(projection.fold, seriesIndex);
  if (!location || location.slots[0] === null || location.slots[1] === null) return null;
  const row = projection.fold.rowsBySeries.get(seriesIndex);
  const seriesId =
    row === undefined
      ? (projection.view.liveSeries.find((entry) => entry.seriesIndex === seriesIndex)?.seriesId ?? '')
      : String(row.series_id ?? '');
  if (!seriesId) return null;
  return buildSeriesGame(
    runsDir,
    runId,
    seriesIndex,
    game,
    {
      seriesId,
      sides: [location.slots[0], location.slots[1]],
      stage: 'playoff',
      round: location.round + 1,
      models: projection.view.entrants.map((entrant) => entrant.model),
      labels: projection.view.entrants.map((entrant) => entrant.team || entrant.model),
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
    .flatMap(([runId, rows]) => {
      const archive = archiveTournament(runId, rows, runsDir, teamsDir);
      return archive ? [archive.view] : [];
    })
    .sort((a, b) => b.when.localeCompare(a.when));
  return { pool, pools, summary: summarizeTournaments(tournaments), tournaments };
}
