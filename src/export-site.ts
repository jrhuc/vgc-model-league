import fs from 'node:fs';
import path from 'node:path';

import { buildLeague, buildLeagueGame, buildLeagues } from './archive.js';
import { describeBoardMon, listBoards, loadBoard } from './draft.js';
import { buildTournamentGame, buildTournaments } from './evidence.js';
import type { LeagueResponse, TournamentArchiveView } from './gui/api.js';
import { loadSelectedTrace } from './gui/selected-trace.js';
import { PROVIDER_OPTIONS } from './provider-registry.js';
import { loadSeriesRecords, type SeriesRecord, TEST_POOL } from './records.js';
import { loadShowdown } from './showdown.js';
import { listPools } from './teams.js';

export interface ExportSiteOptions {
  out: string;
  recordsPath: string;
  runsDir: string;
  teamsDir: string;
  runs?: string[];
  pool?: string;
  includeTest?: boolean;
  log?: (line: string) => void;
}

export interface ExportSiteSummary {
  leagues: number;
  tournaments: number;
  files: number;
}

function selectable(rows: SeriesRecord[], options: ExportSiteOptions): SeriesRecord[] {
  if (options.runs !== undefined) {
    const wanted = new Set(options.runs);
    const missing = options.runs.filter((id) => !rows.some((row) => String(row.run_id ?? '') === id));
    if (missing.length > 0) throw new Error(`no local series recorded for ${missing.join(', ')}`);
    return rows.filter((row) => wanted.has(String(row.run_id ?? '')));
  }
  if (options.pool !== undefined) return rows.filter((row) => row.pool === options.pool);
  return rows.filter((row) => options.includeTest === true || row.pool !== TEST_POOL);
}

function championsFormats(): Array<{ id: string; label: string }> {
  const { Dex } = loadShowdown();
  return Dex.formats
    .all()
    .filter((format) => format.id.startsWith('gen9champions') && format.id.endsWith('bo3'))
    .map((format) => ({ id: format.id, label: format.name.replace(/^\[Gen 9 Champions\] /, '') }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * The static site serves every response the read-only GUI fetches as a file, so
 * a route with query parameters becomes a nested path with the same payload.
 */
export function exportSite(options: ExportSiteOptions): ExportSiteSummary {
  const log = options.log ?? (() => {});
  const rows = selectable(loadSeriesRecords(options.recordsPath), options);
  const allowed = new Set(rows.map((row) => String(row.run_id ?? '')).filter(Boolean));
  for (const id of options.runs ?? []) allowed.add(id);
  let files = 0;
  const write = (relative: string, body: unknown): void => {
    const file = path.join(options.out, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(body)}\n`, 'utf8');
    files += 1;
  };

  fs.rmSync(options.out, { recursive: true, force: true });

  const pools = listPools(options.teamsDir);
  write('state.json', {
    pools,
    defaultFormat: pools[0]?.format ?? 'gen9championsvgc2026regmbbo3',
    formats: championsFormats(),
    boards: listBoards(),
    providers: PROVIDER_OPTIONS.map((option) => ({
      id: option.id,
      label: option.label,
      description: option.description,
      discovery: option.discovery,
      requiresKey: option.requiresKey,
    })),
    auth: { mode: 'read-only', user: null, csrfToken: null },
    run: null,
  });

  const trace = loadSelectedTrace();
  write('selected-trace.json', trace.view);
  const fullFile = path.join(options.out, 'selected-trace-full.json');
  fs.writeFileSync(fullFile, trace.fullJson, 'utf8');
  files += 1;

  for (const board of listBoards()) {
    const loaded = loadBoard(board.id);
    write(`board/${board.id}.json`, {
      id: loaded.id,
      format: loaded.format,
      budget: loaded.budget,
      picks: loaded.picks,
      mons: loaded.mons.map((mon) => describeBoardMon(mon, undefined, loaded.format)),
    });
  }

  const leagues = buildLeagues(rows, options.runsDir).leagues.filter((card) => allowed.has(card.runId) && !card.live);
  write('leagues.json', { leagues });
  for (const card of leagues) {
    const league = buildLeague(rows, options.runsDir, card.runId) as LeagueResponse | null;
    if (!league) continue;
    write(`league/${card.runId}.json`, league);
    for (const series of league.series) {
      for (const [gameIndex] of series.games.entries()) {
        const game = gameIndex + 1;
        const view = buildLeagueGame(rows, options.runsDir, card.runId, series.seriesIndex, game);
        if (view) write(`league/${card.runId}/game-${series.seriesIndex}-${game}.json`, view);
      }
    }
    log(`league ${card.runId}: ${league.series.length} series`);
  }

  const tournamentsView = buildTournaments(rows, options.runsDir, null, options.teamsDir);
  const tournaments = tournamentsView.tournaments.filter(
    (archive: TournamentArchiveView) => allowed.has(archive.runId) && !archive.live,
  );
  const matches = tournaments.reduce(
    (total: number, archive: TournamentArchiveView) =>
      total + archive.rounds.flat().filter((match) => match.seriesIndex !== null && match.score !== null).length,
    0,
  );
  write('tournaments.json', {
    ...tournamentsView,
    tournaments,
    summary: {
      tournaments: tournaments.filter((archive) => archive.rounds.flat().some((match) => match.score)).length,
      matches,
    },
  });
  for (const archive of tournaments) {
    let games = 0;
    for (const match of archive.rounds.flat()) {
      if (match.seriesIndex === null) continue;
      for (const game of [1, 2, 3]) {
        const view = buildTournamentGame(
          rows,
          options.runsDir,
          archive.runId,
          match.seriesIndex,
          game,
          options.teamsDir,
        );
        if (!view) continue;
        write(`tournament/${archive.runId}/game-${match.seriesIndex}-${game}.json`, view);
        games += 1;
      }
    }
    log(`tournament ${archive.runId}: ${games} games`);
  }

  write('manifest.json', {
    generated_at: new Date().toISOString(),
    leagues: leagues.map((card) => card.runId),
    tournaments: tournaments.map((archive) => archive.runId),
    files,
  });
  return { leagues: leagues.length, tournaments: tournaments.length, files };
}
