#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { type GameRecord, gameRecordCorpusDigest, loadGameRecordCorpus, verifyGame } from '../src/eval/corpus.js';
import {
  type CounterfactualOptions,
  counterfactualProtocol,
  EXHAUSTIVE_PANEL_PROTOCOL,
  evaluateActionTable,
  validateCounterfactualOptions,
} from '../src/eval/counterfactual.js';
import { positionEligibilityMetrics } from '../src/eval/eligibility.js';
import { ACTION_PROTOCOL, positionDigest, requestPhase } from '../src/eval/fork.js';
import { POSITION_GRADE_SCHEMA_VERSION } from '../src/eval/positions.js';
import { captureRuntimeProducerAuthority } from '../src/eval/producer.js';
import { DATA_DIR, defaultPsDir } from '../src/paths.js';
import { showdownCommit } from '../src/showdown.js';
import type { JsonObject } from '../src/types.js';

interface Settings extends CounterfactualOptions {
  modes?: string[];
  limit?: number;
  workers: number;
  out: string;
  recordsPath?: string;
  runsDir?: string;
  restart?: boolean;
}

interface Shard {
  index: number;
  of: number;
  settings: Settings;
  done: string[];
  sourceDigest: string;
}

interface GradedGame {
  game: string;
  rows: JsonObject[];
  decisions: number;
}

interface GradeManifest extends JsonObject {
  schema_version: typeof POSITION_GRADE_SCHEMA_VERSION;
  showdown_commit: string;
  evaluator_digest: string;
  source_digest: string;
  source_games: number;
  scope: JsonObject;
  action_protocol: JsonObject;
  counterfactual: JsonObject;
  exhaustive_panels: JsonObject;
  seed_namespace: string;
}

function defaultWorkers(): number {
  return Math.max(1, Math.floor(os.availableParallelism() / 3));
}

function parse(argv: string[]): Settings {
  const settings: Settings = {
    workers: defaultWorkers(),
    out: path.join(DATA_DIR, 'records', 'positions.jsonl'),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--restart') {
      settings.restart = true;
      continue;
    }
    if (flag === '--modes' && value) settings.modes = value.split(',');
    else if (flag === '--limit' && value) settings.limit = Number(value);
    else if (flag === '--workers' && value) settings.workers = Math.max(1, Number(value));
    else if (flag === '--horizon' && value)
      settings.horizon = value === 'end' ? Number.POSITIVE_INFINITY : Number(value);
    else if (flag === '--luck' && value) settings.luckSamples = Number(value);
    else if (flag === '--opponents' && value) settings.opponentSamples = Number(value);
    else if (flag === '--seed' && value) settings.seed = value;
    else if (flag === '--out' && value) settings.out = path.resolve(value);
    else if (flag === '--records' && value) settings.recordsPath = path.resolve(value);
    else if (flag === '--runs-dir' && value) settings.runsDir = path.resolve(value);
    else if (flag === '--ps-dir' && value) settings.psDir = path.resolve(value);
    else throw new Error(`unknown option or missing value: ${flag}`);
    index += 1;
  }
  for (const [name, value] of [
    ['workers', settings.workers],
    ['limit', settings.limit],
  ] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
      throw new Error(`--${name} must be a positive integer`);
    }
  }
  validateCounterfactualOptions(settings);
  return settings;
}

function gameKey(record: GameRecord): string {
  return `${record.runId}:${record.seriesId}:${record.gameNumber}`;
}

function gradedGames(file: string): Set<string> {
  const done = new Set<string>();
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return done;
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as JsonObject;
      if (row.kind === 'game_complete' && row.complete === true) {
        done.add(`${row.run_id}:${row.series_id}:${row.game_number}`);
      }
    } catch {}
  }
  return done;
}

function manifestFor(settings: Settings, records: GameRecord[], producerDigest: string): GradeManifest {
  return {
    schema_version: POSITION_GRADE_SCHEMA_VERSION,
    showdown_commit: showdownCommit(settings.psDir ?? defaultPsDir()),
    evaluator_digest: producerDigest,
    source_digest: gameRecordCorpusDigest(records),
    source_games: records.length,
    scope: {
      modes: settings.modes ?? null,
      limit: settings.limit ?? null,
      records_path: settings.recordsPath ?? null,
      runs_dir: settings.runsDir ?? null,
    },
    action_protocol: ACTION_PROTOCOL as unknown as JsonObject,
    counterfactual: counterfactualProtocol(settings) as unknown as JsonObject,
    exhaustive_panels: EXHAUSTIVE_PANEL_PROTOCOL as unknown as JsonObject,
    seed_namespace: String(settings.seed ?? 'source-game-position'),
  };
}

function prepareOutput(settings: Settings, records: GameRecord[], producerDigest: string): GradeManifest {
  const manifest = manifestFor(settings, records, producerDigest);
  const manifestPath = `${settings.out}.manifest.json`;
  if (settings.restart) {
    fs.rmSync(settings.out, { force: true });
    fs.rmSync(manifestPath, { force: true });
  }
  if (fs.existsSync(settings.out) && fs.statSync(settings.out).size > 0) {
    let existing: unknown;
    try {
      existing = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch {
      throw new Error(`refusing to resume ${settings.out} without ${manifestPath}; pass --restart`);
    }
    if (JSON.stringify(existing) !== JSON.stringify(manifest)) {
      throw new Error(`refusing to mix grading protocols in ${settings.out}; pass --restart or choose another --out`);
    }
  } else {
    fs.writeFileSync(
      manifestPath,
      `${JSON.stringify(manifest, null, 2)}
`,
      'utf8',
    );
  }
  return manifest;
}

function scopedRecords(settings: Settings): GameRecord[] {
  const records = loadGameRecordCorpus({
    ...(settings.modes ? { modes: settings.modes } : {}),
    ...(settings.recordsPath ? { recordsPath: settings.recordsPath } : {}),
    ...(settings.runsDir ? { runsDir: settings.runsDir } : {}),
  });
  return records.slice(0, settings.limit ?? Number.POSITIVE_INFINITY);
}

interface GameStats {
  attempted: number;
  graded: number;
  excluded: number;
  failed: number;
}

const EMPTY_STATS: GameStats = { attempted: 0, graded: 0, excluded: 0, failed: 0 };

function marker(record: GameRecord, status: string, stats: GameStats): JsonObject {
  return {
    kind: 'game_complete',
    run_id: record.runId,
    series_id: record.seriesId,
    game_number: record.gameNumber,
    status,
    attempted: stats.attempted,
    decisions: stats.graded,
    excluded: stats.excluded,
    failed: stats.failed,
    complete: true,
  };
}

function decisionStatus(record: GameRecord, positionIndex: number, pid: string, reason: string): JsonObject {
  return {
    kind: reason.startsWith('excluded-') ? 'position_excluded' : 'position_failure',
    run_id: record.runId,
    series_id: record.seriesId,
    game_number: record.gameNumber,
    position_index: positionIndex,
    pid,
    reason,
  };
}

function gradeShard(shard: Shard, emit: (graded: GradedGame) => void): void {
  const { settings } = shard;
  const done = new Set(shard.done);
  const records = scopedRecords(settings);
  if (gameRecordCorpusDigest(records) !== shard.sourceDigest)
    throw new Error('source corpus changed after grading started');

  for (const [index, record] of records.entries()) {
    if (index % shard.of !== shard.index) continue;
    const key = gameKey(record);
    if (done.has(key)) continue;
    if (record.skipped) {
      emit({ game: key, rows: [marker(record, `source-${record.skipped}`, EMPTY_STATS)], decisions: 0 });
      continue;
    }
    const game = verifyGame(record, settings.psDir);
    if (!game) {
      emit({ game: key, rows: [marker(record, 'replay-failed', EMPTY_STATS)], decisions: 0 });
      continue;
    }
    const rows: JsonObject[] = [];
    const stats: GameStats = { ...EMPTY_STATS };
    for (const position of game.replay.positions) {
      for (const pid of position.pending) {
        stats.attempted += 1;
        const choiceIndex = position.choiceIndex[pid];
        if (choiceIndex === undefined) {
          stats.failed += 1;
          rows.push(decisionStatus(record, position.index, pid, 'missing-choice-index'));
          continue;
        }
        const decision = record.decisions[pid][choiceIndex] ?? {};
        const ineligible =
          decision.outcome !== 'accepted'
            ? 'excluded-unaccepted'
            : decision.submission_source !== 'model'
              ? `excluded-${String(decision.submission_source ?? 'unknown-source')}`
              : decision.fallback === true
                ? 'excluded-fallback'
                : undefined;
        if (ineligible) {
          stats.excluded += 1;
          rows.push(decisionStatus(record, position.index, pid, ineligible));
          continue;
        }
        const seed = `${settings.seed ?? 'source-game-position'}:${key}:${position.index}:${pid}`;
        const table = evaluateActionTable(position, pid, { ...settings, seed });
        if (!table) {
          stats.failed += 1;
          rows.push(decisionStatus(record, position.index, pid, 'counterfactual-evaluation-failed'));
          continue;
        }
        const panels = [...table.stability, table.measurement];
        const actions = table.measurement.actions.map((entry) => entry.action);
        const complete =
          panels.length === 3 &&
          actions.length === table.legal &&
          panels.every(
            (panel) =>
              panel.actions.length === table.legal &&
              panel.draws.length > 0 &&
              panel.matrix.length === panel.draws.length &&
              panel.matrix.every((row) => row.length === table.legal) &&
              panel.actions.every(
                (entry, actionIndex) => entry.action === actions[actionIndex] && entry.samples === panel.draws.length,
              ),
          );
        if (!complete) {
          stats.failed += 1;
          rows.push(decisionStatus(record, position.index, pid, 'counterfactual-evaluation-incomplete'));
          continue;
        }
        const chosen = position.actual[pid];
        if (!chosen || !actions.includes(chosen)) {
          stats.failed += 1;
          rows.push(decisionStatus(record, position.index, pid, 'recorded-action-not-in-counterfactual-table'));
          continue;
        }
        stats.graded += 1;
        rows.push({
          kind: 'position_score',
          run_id: record.runId,
          series_id: record.seriesId,
          game_number: record.gameNumber,
          mode: record.mode,
          format: record.format,
          showdown_commit: record.psCommit,
          scaffold: record.scaffold.revision,
          scaffold_components: record.scaffold.components,
          generating_models: { p1: record.players.p1, p2: record.players.p2 },
          pid,
          position_index: position.index,
          position_digest: positionDigest(position, pid),
          choice_index: choiceIndex,
          turn: table.turn,
          phase: requestPhase(position.requests[pid]),
          legal_actions: table.legal,
          chosen,
          state_value: table.stateValue,
          counterfactual: counterfactualProtocol(settings),
          sampling_seed: seed,
          eligibility_metrics: positionEligibilityMetrics(table),
        });
      }
    }
    const status =
      stats.graded > 0
        ? stats.failed > 0
          ? 'graded-with-failures'
          : 'graded'
        : stats.failed > 0
          ? 'evaluation-failed'
          : 'no-eligible-decisions';
    rows.push(marker(record, status, stats));
    emit({ game: key, rows, decisions: stats.graded });
  }
}

async function main(): Promise<void> {
  const settings = parse(process.argv.slice(2));
  const producer = captureRuntimeProducerAuthority(import.meta.url);
  const showdownRealpath = fs.realpathSync.native(settings.psDir ?? defaultPsDir());
  if (showdownRealpath !== producer.showdownRealpath) {
    throw new Error(
      `configured Pokémon Showdown root ${showdownRealpath} does not match captured producer runtime ${producer.showdownRealpath}`,
    );
  }
  settings.psDir = producer.showdownRealpath;
  fs.mkdirSync(path.dirname(settings.out), { recursive: true });
  const records = scopedRecords(settings);
  const manifest = prepareOutput(settings, records, producer.producerDigest);
  const done = gradedGames(settings.out);
  const remaining = records.filter((record) => !done.has(gameKey(record))).length;
  const workers = Math.min(settings.workers, Math.max(1, remaining));
  process.stdout.write(`${remaining} of ${records.length} candidate games left across ${workers} workers into ${settings.out}
`);
  if (!remaining) {
    producer.assertUnchanged();
    return;
  }

  const stream = fs.createWriteStream(settings.out, { flags: 'a' });
  let rows = 0;
  let games = 0;
  const started = Date.now();
  await Promise.all(
    Array.from({ length: workers }, (_, index) => {
      const shard: Shard = { index, of: workers, settings, done: [...done], sourceDigest: manifest.source_digest };
      const worker = new Worker(fileURLToPath(import.meta.url), { workerData: shard });
      worker.on('message', (graded: GradedGame) => {
        for (const row of graded.rows)
          stream.write(`${JSON.stringify(row)}
`);
        rows += graded.decisions;
        games += 1;
        const rate = rows / Math.max(1, (Date.now() - started) / 1000);
        process.stdout.write(`  ${games}/${remaining} games · ${rows} decisions (${rate.toFixed(1)}/s)
`);
      });
      return new Promise<void>((resolve, reject) => {
        worker.on('error', reject);
        worker.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`grading worker exited ${code}`))));
      });
    }),
  );
  await new Promise<void>((resolve, reject) => {
    stream.on('error', reject);
    stream.end(resolve);
  });
  producer.assertUnchanged();
  process.stdout.write(`${rows} decisions graded in ${((Date.now() - started) / 60_000).toFixed(1)} min
`);
}

if (isMainThread) {
  await main();
} else {
  gradeShard(workerData as Shard, (graded) => parentPort?.postMessage(graded));
}
