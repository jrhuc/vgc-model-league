import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { SAFE_SEGMENT } from '../path-safety.js';
import { defaultPsDir, REPO_ROOT, RESULTS_PATH, RUNS_DIR } from '../paths.js';
import { showdownCommit } from '../showdown.js';
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
  psCommit: string | null;
  players: Record<Pid, string>;
  scaffold: RunScaffold;
  seed: [number, number, number, number];
  names: Record<Pid, string>;
  candidates: Record<Pid, string[]>;
  recordedLog: string[];
  decisions: Record<Pid, JsonObject[]>;
  skipped: string | null;
}

export interface CorpusOptions {
  recordsPath?: string;
  runsDir?: string;
  psDir?: string;
  modes?: readonly string[];
}

function readJson(file: string): JsonObject | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as JsonObject;
  } catch {
    return null;
  }
}

function readRows(file: string): JsonObject[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const rows: JsonObject[] = [];
  for (const [index, line] of raw.split('\n').entries()) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as JsonObject);
    } catch (error) {
      throw new Error(`malformed JSONL at ${file}:${index + 1}`, { cause: error });
    }
  }
  return rows;
}

function packedDigest(packed: string): string {
  return crypto.createHash('sha256').update(packed).digest('hex');
}

function exactTeams(seriesDir: string): Record<Pid, string> | null {
  const series = readJson(path.join(seriesDir, 'series.json'));
  const packed = series?.packed_teams as Partial<Record<Pid, unknown>> | undefined;
  if (typeof packed?.p1 !== 'string' || typeof packed.p2 !== 'string') return null;
  return { p1: packed.p1, p2: packed.p2 };
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
  const scaffolds = new Map<string, RunScaffold>();
  const records: GameRecord[] = [];
  const gameKeys = new Set<string>();

  for (const row of readRows(options.recordsPath ?? RESULTS_PATH)) {
    const mode = String(row.mode ?? 'unknown');
    if (options.modes && !options.modes.includes(mode)) continue;
    const runId = String(row.run_id ?? '');
    const seriesId = String(row.series_id ?? '');
    const players = row.players as Record<Pid, string>;
    if (!runId || !players) continue;
    if (!SAFE_SEGMENT.test(runId) || !SAFE_SEGMENT.test(seriesId)) {
      throw new Error('source record run_id and series_id must be path-safe identifiers');
    }
    if (!scaffolds.has(runId)) scaffolds.set(runId, readRunScaffold(path.join(runsDir, runId)));

    for (const game of (row.games ?? []) as JsonObject[]) {
      const gameNumber = Number(game.number);
      const gameKey = `${runId}:${seriesId}:${gameNumber}`;
      if (gameKeys.has(gameKey)) throw new Error(`duplicate source game ${gameKey}`);
      gameKeys.add(gameKey);
      const seed = game.seed as [number, number, number, number] | undefined;
      const logPath = typeof game.log === 'string' ? path.resolve(REPO_ROOT, game.log) : '';
      const expectedLogPath = path.resolve(runsDir, runId, 'series', seriesId, `game-${gameNumber}.log`);
      const base: Omit<GameRecord, 'candidates' | 'recordedLog' | 'decisions' | 'seed' | 'skipped'> = {
        runId,
        seriesId,
        gameNumber,
        mode,
        format: String(row.format ?? ''),
        psCommit: typeof row.ps_commit === 'string' ? row.ps_commit : null,
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
      if (!base.psCommit) {
        records.push(incomplete('no-showdown-revision'));
        continue;
      }
      if (logPath !== expectedLogPath) {
        records.push(incomplete('invalid-log-path'));
        continue;
      }
      let recordedLog: string[];
      try {
        recordedLog = fs.readFileSync(logPath, 'utf8').split('\n');
      } catch {
        records.push(incomplete('no-log'));
        continue;
      }
      const provenance = [game.simulator_substitutions, game.timer_autodefaults, game.model_choice_fallbacks];
      if (provenance.some((counts) => !counts || typeof counts !== 'object' || Array.isArray(counts))) {
        records.push(incomplete('unknown-action-provenance'));
        continue;
      }
      const answeredForPlayer = provenance.some((counts) =>
        Object.values(counts as Record<string, number>).some((value) => Number(value) > 0),
      );
      if (answeredForPlayer) {
        records.push(incomplete('answered-for-player'));
        continue;
      }

      const candidates: Record<Pid, string[]> = { p1: [], p2: [] };
      const storedTeams = exactTeams(path.dirname(logPath));
      const storedDigests = row.packed_team_digests as Partial<Record<Pid, unknown>> | undefined;
      if (
        !storedTeams ||
        typeof storedDigests?.p1 !== 'string' ||
        typeof storedDigests.p2 !== 'string' ||
        packedDigest(storedTeams.p1) !== storedDigests.p1 ||
        packedDigest(storedTeams.p2) !== storedDigests.p2
      ) {
        records.push(incomplete('unbound-team-provenance'));
        continue;
      }
      for (const pid of ['p1', 'p2'] as const) candidates[pid] = [storedTeams[pid]];
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

export function verifyGame(record: GameRecord, psDir?: string): VerifiedGame | null {
  if (record.skipped) return null;
  if (record.psCommit && record.psCommit !== showdownCommit(psDir ?? defaultPsDir())) return null;
  const choices = Object.fromEntries(
    (['p1', 'p2'] as const).map((pid) => [pid, record.decisions[pid].map((row) => String(row.action))]),
  ) as Record<Pid, string[]>;

  let match: VerifiedGame | null = null;
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
      if (!replay.verified) continue;
      if (match) return null;
      match = { record, source, replay };
    }
  }
  return match;
}
