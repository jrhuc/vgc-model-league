import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { buildLeague, buildLeagueGame } from './archive.js';
import { describeBoardMon, loadBoard } from './draft.js';
import { buildDraftLeagueSchedule } from './draftleague.js';
import { SAFE_SEGMENT } from './path-safety.js';
import { REPO_ROOT } from './paths.js';
import {
  buildPublicSeasonBundle,
  type PublicSeasonBundle,
  type PublicSeasonGameInput,
  publicSeasonBundleJsonSchema,
} from './public/season-bundle.js';
import { loadSeriesRecords } from './records.js';
import { readTradeWindow } from './trade-window.js';

export interface ExportSeasonOptions {
  out: string;
  recordsPath: string;
  runsDir: string;
  runId: string;
  title: string;
  releasedThroughWeek: number;
  generatedAt?: string;
}

interface StoredLeagueConfig {
  seed: number;
  closedSheets: boolean;
}

function storedLeagueConfig(runsDir: string, runId: string): StoredLeagueConfig {
  const file = path.join(runsDir, runId, 'config.json');
  const value = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  if (!Number.isSafeInteger(value.seed)) throw new Error(`league ${runId} has no valid schedule seed`);
  if (typeof value.closed_sheets !== 'boolean') throw new Error(`league ${runId} has no team-sheet policy`);
  return { seed: value.seed as number, closedSheets: value.closed_sheets };
}

function harnessCommit(): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function showdownCommit(): string | null {
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'showdown.lock.json'), 'utf8')) as {
      commit?: unknown;
    };
    return typeof lock.commit === 'string' ? lock.commit : null;
  } catch {
    return null;
  }
}

export function exportSeasonBundle(options: ExportSeasonOptions): PublicSeasonBundle {
  if (!SAFE_SEGMENT.test(options.runId)) throw new Error(`invalid run id ${JSON.stringify(options.runId)}`);
  const rows = loadSeriesRecords(options.recordsPath);
  const league = buildLeague(rows, options.runsDir, options.runId);
  if (!league) throw new Error(`no draft league archive found for ${options.runId}`);
  if (!league.board) throw new Error(`league ${options.runId} has no draft board`);
  const config = storedLeagueConfig(options.runsDir, options.runId);
  const schedule = buildDraftLeagueSchedule(league.franchises.length, config.seed);
  const board = loadBoard(league.board);
  const boardView = board.mons.map((mon) => describeBoardMon(mon, undefined, board.format));
  const totalWeeks = league.weeks ?? 0;
  const games = new Map<string, PublicSeasonGameInput[]>();
  for (const series of league.series) {
    const releasedRound = series.stage === 'roundrobin' ? series.round : totalWeeks + series.round;
    if (releasedRound > options.releasedThroughWeek || series.winner === null) continue;
    games.set(
      series.seriesId,
      series.games.map((_, gameIndex) => {
        const game = buildLeagueGame(rows, options.runsDir, options.runId, series.seriesIndex, gameIndex + 1);
        if (!game) throw new Error(`released series ${series.seriesId} game ${gameIndex + 1} has no verified replay`);
        return game;
      }),
    );
  }
  const bundle = buildPublicSeasonBundle({
    league,
    plans: schedule.plans,
    board: boardView,
    games,
    tradeOrder: readTradeWindow(path.join(options.runsDir, options.runId))?.order ?? null,
    title: options.title,
    releasedThroughWeek: options.releasedThroughWeek,
    closedSheets: config.closedSheets,
    harnessCommit: harnessCommit(),
    showdownCommit: showdownCommit(),
    ...(options.generatedAt === undefined ? {} : { generatedAt: options.generatedAt }),
  });
  fs.mkdirSync(path.dirname(options.out), { recursive: true });
  fs.writeFileSync(options.out, `${JSON.stringify(bundle)}\n`, 'utf8');
  fs.writeFileSync(
    path.join(path.dirname(options.out), 'season-bundle-v2.schema.json'),
    `${JSON.stringify(publicSeasonBundleJsonSchema(), null, 2)}\n`,
    'utf8',
  );
  return bundle;
}
