import fs from 'node:fs';
import path from 'node:path';

import { REPO_ROOT, RESULTS_PATH, RUNS_DIR, TEAMS_DIR } from '../paths.js';
import type { JsonObject, Pid } from '../types.js';
import type { GameSource, Replay } from './fork.js';
import { replayGame } from './fork.js';
import { type RunScaffold, readRunScaffold } from './scaffold.js';

export interface GameRecord {
  runId: string;
  seriesId: string;
  gameNumber: number;
  mode: string;
  format: string;
  players: Record<Pid, string>;
  scaffold: RunScaffold;
  seed: [number, number, number, number];
  names: Record<Pid, string>;
  candidates: Record<Pid, string[]>;
  recordedLog: string[];
  decisions: Record<Pid, JsonObject[]>;
  /** Why a game never reached the replay, when it did not. Kept so a shrinking position set can be
   * explained rather than silently attributed to the games that happened to survive. */
  skipped: string | null;
}

export interface CorpusOptions {
  recordsPath?: string;
  runsDir?: string;
  teamsDir?: string;
  psDir?: string;
  modes?: readonly string[];
}

function readRows(file: string): JsonObject[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const rows: JsonObject[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as JsonObject);
    } catch {}
  }
  return rows;
}

/** Open team sheets publish everything about a set except its EVs and IVs, so a `|showteam|` line
 * identifies which of a run's built teams played this game without being able to reconstruct it. */
function sheetKey(packed: string): string {
  return packed
    .split(']')
    .map((set) => {
      const fields = set.split('|');
      fields[6] = '';
      fields[8] = '';
      return fields.slice(0, 11).join('|');
    })
    .join(']');
}

function declaredSheets(log: string[]): Partial<Record<Pid, string>> {
  const sheets: Partial<Record<Pid, string>> = {};
  for (const line of log) {
    if (!line.startsWith('|showteam|')) continue;
    const [, , pid = '', ...rest] = line.split('|');
    if (pid === 'p1' || pid === 'p2') sheets[pid] = sheetKey(rest.join('|'));
  }
  return sheets;
}

function poolTeam(teamsDir: string, pool: string, id: string): string[] {
  try {
    return [fs.readFileSync(path.join(teamsDir, pool, `${id}.team`), 'utf8').trim()];
  } catch {
    return [];
  }
}

function builtTeams(runsDir: string, runId: string, model: string): string[] {
  const rows = readRows(path.join(runsDir, runId, 'teambuild', 'teambuild.jsonl'));
  const packed = rows.filter((row) => row.model === model && typeof row.packed === 'string');
  return [...new Set(packed.map((row) => row.packed as string))];
}

function gameDecisions(seriesDir: string, gameNumber: number): Record<Pid, JsonObject[]> {
  const decisions: Record<Pid, JsonObject[]> = { p1: [], p2: [] };
  for (const pid of ['p1', 'p2'] as const) {
    decisions[pid] = readRows(path.join(seriesDir, `${pid}-decisions.jsonl`)).filter(
      (row) => row.kind === 'decision' && Number(row.game_number) === gameNumber,
    );
  }
  return decisions;
}

export function loadGameRecords(options: CorpusOptions = {}): GameRecord[] {
  const runsDir = options.runsDir ?? RUNS_DIR;
  const teamsDir = options.teamsDir ?? TEAMS_DIR;
  const scaffolds = new Map<string, RunScaffold>();
  const records: GameRecord[] = [];

  for (const row of readRows(options.recordsPath ?? RESULTS_PATH)) {
    const mode = String(row.mode ?? 'unknown');
    if (options.modes && !options.modes.includes(mode)) continue;
    const runId = String(row.run_id ?? '');
    const players = row.players as Record<Pid, string>;
    const teams = row.teams as Record<Pid, string>;
    if (!runId || !players || !teams) continue;
    if (!scaffolds.has(runId)) scaffolds.set(runId, readRunScaffold(path.join(runsDir, runId)));

    for (const game of (row.games ?? []) as JsonObject[]) {
      const gameNumber = Number(game.number);
      const seed = game.seed as [number, number, number, number] | undefined;
      const logPath = typeof game.log === 'string' ? path.resolve(REPO_ROOT, game.log) : '';
      const base: Omit<GameRecord, 'candidates' | 'recordedLog' | 'decisions' | 'seed' | 'skipped'> = {
        runId,
        seriesId: String(row.series_id ?? ''),
        gameNumber,
        mode,
        format: String(row.format ?? ''),
        players,
        scaffold: scaffolds.get(runId) as RunScaffold,
        names: { p1: `p1-${players.p1}`, p2: `p2-${players.p2}` },
      };
      const incomplete = (reason: string): GameRecord => ({
        ...base,
        seed: seed ?? [0, 0, 0, 0],
        candidates: { p1: [], p2: [] },
        recordedLog: [],
        decisions: { p1: [], p2: [] },
        skipped: reason,
      });

      if (!seed) {
        records.push(incomplete('no-seed'));
        continue;
      }
      let recordedLog: string[];
      try {
        recordedLog = fs.readFileSync(logPath, 'utf8').split('\n');
      } catch {
        records.push(incomplete('no-log'));
        continue;
      }
      /** A game the timer or the simulator answered for a player has choices that were never
       * written down, so it can be recognised as unreplayable before any work is spent on it. */
      const answeredForPlayer = [game.simulator_substitutions, game.timer_autodefaults].some((counts) =>
        Object.values((counts ?? {}) as Record<string, number>).some((value) => Number(value) > 0),
      );
      if (answeredForPlayer) {
        records.push(incomplete('answered-for-player'));
        continue;
      }

      const pool = typeof row.pool === 'string' ? row.pool : null;
      const sheets = declaredSheets(recordedLog);
      const candidates: Record<Pid, string[]> = { p1: [], p2: [] };
      for (const pid of ['p1', 'p2'] as const) {
        const all = pool ? poolTeam(teamsDir, pool, teams[pid]) : builtTeams(runsDir, runId, players[pid]);
        const sheet = sheets[pid];
        const declared = (packed: string) => sheet !== undefined && sheetKey(packed) === sheet;
        candidates[pid] = [...all].sort((a, b) => Number(declared(b)) - Number(declared(a)));
      }
      if (!candidates.p1.length || !candidates.p2.length) {
        records.push(incomplete('no-team'));
        continue;
      }
      const decisions = gameDecisions(path.dirname(logPath), gameNumber);
      if (!decisions.p1.length || !decisions.p2.length) {
        records.push(incomplete('no-decisions'));
        continue;
      }
      records.push({ ...base, seed, candidates, recordedLog, decisions, skipped: null });
    }
  }
  return records;
}

export interface VerifiedGame {
  record: GameRecord;
  source: GameSource;
  replay: Replay;
}

/** Team resolution is allowed to guess because it cannot lie: a candidate that is not the team that
 * played produces a different log, and only a line-for-line match is returned. */
export function verifyGame(record: GameRecord, psDir?: string): VerifiedGame | null {
  if (record.skipped) return null;
  const choices = Object.fromEntries(
    (['p1', 'p2'] as const).map((pid) => [pid, record.decisions[pid].map((row) => String(row.action))]),
  ) as Record<Pid, string[]>;

  for (const p1 of record.candidates.p1) {
    for (const p2 of record.candidates.p2) {
      const source: GameSource = {
        format: record.format,
        seed: record.seed,
        names: record.names,
        packed: { p1, p2 },
        choices,
        ...(psDir === undefined ? {} : { psDir }),
      };
      let replay: Replay;
      try {
        replay = replayGame(source, record.recordedLog);
      } catch {
        continue;
      }
      if (replay.verified) return { record, source, replay };
    }
  }
  return null;
}
