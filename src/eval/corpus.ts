import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { GameSource, Replay } from '../fork.js';
import { replayGame } from '../fork.js';
import { readJsonlObjects } from '../jsonl.js';
import { SAFE_SEGMENT } from '../path-safety.js';
import { defaultPsDir, REPO_ROOT, RESULTS_PATH, RUNS_DIR } from '../paths.js';
import { type ParsedSeriesRecord, parseSeriesRecord } from '../records.js';
import { canonicalJson } from '../serialization.js';
import { resolveAttemptLineage } from '../series.js';
import { showdownCommit } from '../showdown.js';
import type { JsonObject, Pid } from '../types.js';
import { isRecord } from '../value.js';
import { type RunScaffold, readRunScaffold } from './scaffold.js';

export interface GameRecord {
  runId: string;
  seriesId: string;
  gameNumber: number;
  mode: string;
  format: string;
  psCommit: string;
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
  modes?: readonly string[];
}

type CorpusInputExclusionReason =
  | 'malformed-json'
  | 'not-current-series-record'
  | 'missing-attempt-id'
  | 'unsafe-source-identifiers'
  | 'no-games';

type AdmittedCorpusInput = ParsedSeriesRecord & { attempt_id: string };

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

function admitCorpusInputs(file: string, modes: readonly string[] | undefined): AdmittedCorpusInput[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`unable to read source corpus ${file}`, { cause: error });
  }
  const inputs: AdmittedCorpusInput[] = [];
  const exclusions = new Map<CorpusInputExclusionReason, number>();
  const exclude = (reason: CorpusInputExclusionReason): void => {
    exclusions.set(reason, (exclusions.get(reason) ?? 0) + 1);
  };
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      exclude('malformed-json');
      continue;
    }
    let row: ParsedSeriesRecord;
    try {
      row = parseSeriesRecord(value, file);
    } catch {
      exclude('not-current-series-record');
      continue;
    }
    if (modes && !modes.includes(row.mode)) continue;
    if (row.attempt_id === undefined) {
      exclude('missing-attempt-id');
      continue;
    }
    if (!SAFE_SEGMENT.test(row.run_id) || !SAFE_SEGMENT.test(row.series_id)) {
      exclude('unsafe-source-identifiers');
      continue;
    }
    if (row.games.length === 0) {
      exclude('no-games');
      continue;
    }
    inputs.push(row as AdmittedCorpusInput);
  }
  if (exclusions.size > 0) {
    const summary = [...exclusions].map(([reason, count]) => `${reason}: ${count}`).join(', ');
    const excluded = [...exclusions.values()].reduce((total, count) => total + count, 0);
    throw new Error(`source corpus rejected ${excluded} selected inputs (${summary})`);
  }
  return inputs;
}

function packedDigest(packed: string): string {
  return crypto.createHash('sha256').update(packed).digest('hex');
}

function exactTeams(seriesDir: string): Record<Pid, string> | null {
  const series = readJson(path.join(seriesDir, 'series.json'));
  if (series?.schema_version !== 3 || !isRecord(series.identity)) return null;
  const packed = series.identity.packed_teams;
  if (!isRecord(packed) || typeof packed.p1 !== 'string' || typeof packed.p2 !== 'string') return null;
  return { p1: packed.p1, p2: packed.p2 };
}

function gameDecisions(
  seriesDir: string,
  seriesId: string,
  gameNumber: number,
  completingAttemptId: string,
): Record<Pid, JsonObject[]> {
  const empty: Record<Pid, JsonObject[]> = { p1: [], p2: [] };
  const attempts = readJsonlObjects(path.join(seriesDir, 'series-attempts.jsonl'));
  const completions = attempts
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.kind === 'attempt_completed' && row.attempt_id === completingAttemptId);
  if (completions.length !== 1) return empty;
  const completion = completions[0]!;
  const cutoff = completion.index + 1;
  const completedGames = completion.row.completed_games;
  const completingStart = attempts
    .slice(0, cutoff)
    .find((row) => row.kind === 'attempt_started' && row.attempt_id === completingAttemptId);
  if (
    completion.row.series_id !== seriesId ||
    !Number.isSafeInteger(completedGames) ||
    Number(completedGames) < gameNumber ||
    completingStart?.series_id !== seriesId ||
    !resolveAttemptLineage(attempts, completingAttemptId, cutoff)
  ) {
    return empty;
  }
  const marker = readJson(path.join(seriesDir, `game-${gameNumber}.complete.json`));
  if (
    marker?.kind !== 'game_complete' ||
    marker.series_id !== seriesId ||
    marker.game_number !== gameNumber ||
    typeof marker.attempt_id !== 'string'
  ) {
    return empty;
  }
  const markerStart = attempts
    .slice(0, cutoff)
    .find((row) => row.kind === 'attempt_started' && row.attempt_id === marker.attempt_id);
  const lineage = resolveAttemptLineage(attempts, marker.attempt_id, cutoff);
  if (markerStart?.series_id !== seriesId || !lineage) return empty;
  const active = new Set(lineage);
  return Object.fromEntries(
    (['p1', 'p2'] as const).map((pid) => [
      pid,
      readRows(path.join(seriesDir, `${pid}-decisions.jsonl`)).filter(
        (row) =>
          active.has(String(row.attempt_id)) &&
          row.kind === 'decision' &&
          Number(row.game_number) === gameNumber &&
          row.outcome === 'accepted' &&
          typeof row.action === 'string',
      ),
    ]),
  ) as Record<Pid, JsonObject[]>;
}

export function loadGameRecordCorpus(options: CorpusOptions = {}): GameRecord[] {
  const runsDir = options.runsDir ?? RUNS_DIR;
  const inputs = admitCorpusInputs(options.recordsPath ?? RESULTS_PATH, options.modes);
  const scaffolds = new Map<string, RunScaffold>();
  const records: GameRecord[] = [];
  const gameKeys = new Set<string>();

  for (const row of inputs) {
    const mode = row.mode;
    const runId = row.run_id;
    const seriesId = row.series_id;
    const attemptId = row.attempt_id;
    const players = row.players;
    if (!scaffolds.has(runId)) scaffolds.set(runId, readRunScaffold(path.join(runsDir, runId)));

    for (const game of row.games) {
      const gameNumber = Number(game.number);
      const gameKey = `${runId}:${seriesId}:${gameNumber}`;
      if (gameKeys.has(gameKey)) throw new Error(`duplicate source game ${gameKey}`);
      gameKeys.add(gameKey);
      const seed = game.seed as [number, number, number, number];
      const logPath = typeof game.log === 'string' ? path.resolve(REPO_ROOT, game.log) : '';
      const expectedLogPath = path.resolve(runsDir, runId, 'series', seriesId, `game-${gameNumber}.log`);
      const base: Omit<GameRecord, 'candidates' | 'recordedLog' | 'decisions' | 'seed' | 'skipped'> = {
        runId,
        seriesId,
        gameNumber,
        mode,
        format: row.format,
        psCommit: row.ps_commit,
        players,
        scaffold: scaffolds.get(runId) as RunScaffold,
        names: { p1: `p1-${players.p1}`, p2: `p2-${players.p2}` },
      };
      const incomplete = (reason: string): GameRecord => ({
        ...base,
        seed,
        candidates: { p1: [], p2: [] },
        recordedLog: [],
        decisions: { p1: [], p2: [] },
        skipped: reason,
      });

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
      const decisions = gameDecisions(path.dirname(logPath), seriesId, gameNumber, attemptId);
      if (!decisions.p1.length || !decisions.p2.length) {
        records.push(incomplete('no-decisions'));
        continue;
      }
      records.push({ ...base, seed, candidates, recordedLog, decisions, skipped: null });
    }
  }
  return records;
}

interface VerifiedGame {
  record: GameRecord;
  source: GameSource;
  replay: Replay;
}

export function gameRecordCorpusDigest(records: readonly GameRecord[]): string {
  const hash = crypto.createHash('sha256').update('vgc-game-record-corpus-v1\0', 'utf8');
  for (const record of records) {
    const serialized = canonicalJson(record);
    hash.update(`${Buffer.byteLength(serialized)}:`, 'utf8').update(serialized, 'utf8');
  }
  return hash.digest('hex');
}

export function assertGameRecordCorpusDigest(
  records: readonly GameRecord[],
  expected: string,
  label = 'source corpus',
): void {
  if (!/^[0-9a-f]{64}$/u.test(expected) || gameRecordCorpusDigest(records) !== expected) {
    throw new Error(`${label} digest does not match`);
  }
}

export function verifyGame(record: GameRecord, psDir?: string): VerifiedGame | null {
  if (record.skipped) return null;
  if (record.psCommit !== showdownCommit(psDir ?? defaultPsDir())) return null;
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
