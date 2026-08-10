#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertGameRecordCorpusDigest, type GameRecord, loadGameRecordCorpus, verifyGame } from '../src/eval/corpus.js';
import {
  type CounterfactualOptions,
  EXHAUSTIVE_PANEL_PROTOCOL,
  evaluateActionTable,
  exhaustiveCounterfactualProtocol,
  validateCounterfactualOptions,
} from '../src/eval/counterfactual.js';
import { POSITION_ELIGIBILITY_METRICS_VERSION, positionEligibilityMetrics } from '../src/eval/eligibility.js';
import { ACTION_PROTOCOL, openPosition, positionDigest } from '../src/eval/fork.js';
import {
  exactPublicPositionFingerprint,
  POSITION_PANEL_ARTIFACT_SCHEMA_VERSION,
  validatePositionPanelArtifacts,
} from '../src/eval/panel-artifact.js';
import {
  CANDIDATE_POSITION_MANIFEST_SCHEMA_VERSION,
  CANDIDATE_POSITION_SELECTION_RULES,
  validateCandidateManifest,
} from '../src/eval/position-artifact-manifest.js';
import {
  anonymiseLog,
  anonymiseRequest,
  gameOf,
  readCandidates,
  type SelectionOptions,
  selectPositions,
} from '../src/eval/positions.js';
import {
  CANONICAL_JSON_PROTOCOL,
  canonicalJson,
  canonicalJsonDigest,
  canonicalJsonl,
} from '../src/eval/serialization.js';
import { POSITION_TASK_PROTOCOL, renderPositionTask, validateTaskScoreJoin } from '../src/eval/task.js';
import { DATA_DIR, defaultPsDir } from '../src/paths.js';
import { showdownCommit } from '../src/showdown.js';
import type { JsonObject, Pid } from '../src/types.js';

interface Settings extends CounterfactualOptions, Omit<SelectionOptions, 'seed'> {
  graded: string;
  selectionSeed?: string;
  recordsPath?: string;
  runsDir?: string;
  out: string;
  privateOut: string;
}

const PUBLIC_DIRECTORY_MODE = 0o755;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PUBLIC_FILE_MODE = 0o644;
const PRIVATE_FILE_MODE = 0o600;

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
}

function pathsOverlap(left: string, right: string): boolean {
  const relative = path.relative(left, right);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function assertDisjointPaths(publicRoot: string, privateRoot: string, resolution: string): void {
  if (pathsOverlap(publicRoot, privateRoot) || pathsOverlap(privateRoot, publicRoot)) {
    throw new Error(`public and private output roots must not overlap ${resolution}`);
  }
}

function outputDirectory(directory: string, mode: number): string {
  const requested = path.resolve(directory);
  fs.mkdirSync(requested, { recursive: true, mode });
  const status = fs.lstatSync(requested);
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw new Error(`output root must be a non-symlink directory: ${requested}`);
  }
  fs.chmodSync(requested, mode);
  return fs.realpathSync.native(requested);
}

function prepareOutputDirectories(
  publicDirectory: string,
  privateDirectory: string,
): {
  publicDirectory: string;
  privateDirectory: string;
} {
  assertDisjointPaths(publicDirectory, privateDirectory, 'lexically');
  const publicRoot = outputDirectory(publicDirectory, PUBLIC_DIRECTORY_MODE);
  const privateRoot = outputDirectory(privateDirectory, PRIVATE_DIRECTORY_MODE);
  assertDisjointPaths(publicRoot, privateRoot, 'after realpath resolution');
  return { publicDirectory: publicRoot, privateDirectory: privateRoot };
}

function parse(argv: string[]): Settings {
  const out = path.join(DATA_DIR, 'records', 'position-panels');
  const settings: Settings = {
    graded: path.join(DATA_DIR, 'records', 'positions.jsonl'),
    out,
    privateOut: path.join(DATA_DIR, 'records', 'private', 'position-panels'),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--graded' && value) settings.graded = path.resolve(value);
    else if (flag === '--records' && value) settings.recordsPath = path.resolve(value);
    else if (flag === '--runs-dir' && value) settings.runsDir = path.resolve(value);
    else if (flag === '--size' && value) settings.size = Number(value);
    else if (flag === '--selection-seed' && value) settings.selectionSeed = value;
    else if (flag === '--per-game' && value) settings.perGame = Number(value);
    else if (flag === '--formats' && value) settings.formats = value.split(',');
    else if (flag === '--out' && value) settings.out = path.resolve(value);
    else if (flag === '--private-out' && value) settings.privateOut = path.resolve(value);
    else if (flag === '--horizon' && value)
      settings.horizon = value === 'end' ? Number.POSITIVE_INFINITY : Number(value);
    else if (flag === '--luck' && value) settings.luckSamples = Number(value);
    else if (flag === '--opponents' && value) settings.opponentSamples = Number(value);
    else if (flag === '--seed' && value) settings.seed = value;
    else if (flag === '--ps-dir' && value) settings.psDir = path.resolve(value);
    else throw new Error(`unknown option or missing value: ${flag}`);
    index += 1;
  }
  for (const [name, value] of [
    ['size', settings.size],
    ['per-game', settings.perGame],
  ] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
      throw new Error(`--${name} must be a positive integer`);
    }
  }
  if (settings.formats?.some((format) => !format.trim())) throw new Error('--formats cannot contain an empty format');
  validateCounterfactualOptions(settings);
  assertDisjointPaths(settings.out, settings.privateOut, 'lexically');
  return settings;
}

function digest(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function fileDigest(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function contentDigest(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function digestParts(parts: Iterable<string>): string {
  const hash = crypto.createHash('sha256');
  for (const part of parts) hash.update(`${Buffer.byteLength(part)}:`, 'utf8').update(part, 'utf8');
  return hash.digest('hex');
}

function runtimeFiles(tool: string): string[] {
  const sourceRoot = path.resolve(path.dirname(tool), '../src');
  const visit = (directory: string): string[] =>
    fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const file = path.join(directory, entry.name);
      return entry.isDirectory() ? visit(file) : entry.isFile() && file.endsWith('.js') ? [file] : [];
    });
  return [
    tool,
    ...visit(sourceRoot),
    path.resolve(path.dirname(tool), '../../package.json'),
    path.resolve(path.dirname(tool), '../../pnpm-lock.yaml'),
  ].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
}

function evaluatorDigest(): string {
  const tool = fileURLToPath(import.meta.url);
  const root = path.resolve(path.dirname(tool), '..');
  return digestParts(
    runtimeFiles(tool).map(
      (file) => `${path.relative(root, file)}
${fs.readFileSync(file, 'utf8')}`,
    ),
  );
}

function readObject(file: string): JsonObject {
  const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${file} must hold one JSON object`);
  return value as JsonObject;
}

function readJsonl(file: string): JsonObject[] {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as JsonObject);
}

function rowGame(row: JsonObject): string {
  return `${row.run_id}:${row.series_id}:${row.game_number}`;
}

function completedPositionScores(rows: JsonObject[], manifest: JsonObject): JsonObject[] {
  const expectedGames = Number(manifest.source_games);
  if (!Number.isInteger(expectedGames) || expectedGames < 0) {
    throw new Error('graded manifest has no valid source_games');
  }
  const markers = new Map<string, JsonObject>();
  const scores = new Map<string, JsonObject>();
  const perGame = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.kind === 'game_complete' && row.complete === true) {
      const game = rowGame(row);
      if (markers.has(game)) throw new Error(`graded input has duplicate completion marker for ${game}`);
      markers.set(game, row);
      continue;
    }
    if (row.kind !== 'position_score') continue;
    if (JSON.stringify(row.counterfactual) !== JSON.stringify(manifest.counterfactual)) {
      throw new Error(`position score ${rowGame(row)} mixes a different counterfactual protocol`);
    }
    const game = rowGame(row);
    const key = `${game}#${row.position_index}#${row.pid}`;
    const prior = scores.get(key);
    if (prior && JSON.stringify(prior) !== JSON.stringify(row)) throw new Error(`conflicting duplicate score ${key}`);
    scores.set(key, row);
    const keys = perGame.get(game) ?? new Set<string>();
    keys.add(key);
    perGame.set(game, keys);
  }
  if (markers.size !== expectedGames) {
    throw new Error(`graded input is incomplete: ${markers.size} of ${expectedGames} source games are complete`);
  }
  for (const [game, keys] of perGame) {
    const marker = markers.get(game);
    if (!marker) throw new Error(`graded input has scores for incomplete game ${game}`);
    if (Number(marker.decisions) !== keys.size) {
      throw new Error(`completion marker for ${game} reports ${marker.decisions} scores but ${keys.size} are present`);
    }
  }
  return [...scores.values()];
}

function gameKey(record: GameRecord): string {
  return `${record.runId}:${record.seriesId}:${record.gameNumber}`;
}

function reopenedGradedCorpus(settings: Settings, manifest: JsonObject): GameRecord[] {
  const scope = manifest.scope;
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) {
    throw new Error('graded manifest has no valid scope');
  }
  const scopeObject = scope as JsonObject;
  const expectedScopeKeys = ['limit', 'modes', 'records_path', 'runs_dir'];
  if (
    JSON.stringify(Object.keys(scopeObject).sort()) !== JSON.stringify(expectedScopeKeys) ||
    (scopeObject.modes !== null &&
      (!Array.isArray(scopeObject.modes) || scopeObject.modes.some((mode) => typeof mode !== 'string' || !mode))) ||
    (scopeObject.limit !== null && (!Number.isSafeInteger(scopeObject.limit) || Number(scopeObject.limit) < 1)) ||
    (scopeObject.records_path !== null &&
      (typeof scopeObject.records_path !== 'string' || !scopeObject.records_path)) ||
    (scopeObject.runs_dir !== null && (typeof scopeObject.runs_dir !== 'string' || !scopeObject.runs_dir))
  ) {
    throw new Error('graded manifest scope is malformed');
  }
  const sourceRecords = loadGameRecordCorpus({
    ...(scopeObject.modes === null ? {} : { modes: scopeObject.modes as string[] }),
    ...(settings.recordsPath
      ? { recordsPath: settings.recordsPath }
      : scopeObject.records_path === null
        ? {}
        : { recordsPath: String(scopeObject.records_path) }),
    ...(settings.runsDir
      ? { runsDir: settings.runsDir }
      : scopeObject.runs_dir === null
        ? {}
        : { runsDir: String(scopeObject.runs_dir) }),
  });
  const records = sourceRecords.slice(
    0,
    scopeObject.limit === null ? Number.POSITIVE_INFINITY : Number(scopeObject.limit),
  );
  const expectedGames = manifest.source_games;
  const expectedDigest = manifest.source_digest;
  if (
    !Number.isSafeInteger(expectedGames) ||
    Number(expectedGames) < 0 ||
    typeof expectedDigest !== 'string' ||
    records.length !== expectedGames
  ) {
    throw new Error('reopened source corpus does not match the graded manifest');
  }
  assertGameRecordCorpusDigest(records, expectedDigest, 'reopened source corpus and graded manifest');
  return records;
}

function publishImmutable(directory: string, name: string, content: string, mode: number): void {
  if (path.basename(name) !== name) throw new Error(`candidate artifact name must be a basename: ${name}`);
  const file = path.join(directory, name);
  const expected = Buffer.from(content, 'utf8');
  if (fs.existsSync(file)) {
    const status = fs.lstatSync(file);
    if (status.isSymbolicLink() || !status.isFile() || status.nlink !== 1 || !fs.readFileSync(file).equals(expected)) {
      throw new Error(`refusing to replace non-identical candidate artifact: ${file}`);
    }
    return;
  }
  const temporary = path.join(directory, `.${name}.${process.pid}.${crypto.randomBytes(12).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(temporary, expected, { flag: 'wx', mode });
    fs.chmodSync(temporary, mode);
    fs.linkSync(temporary, file);
  } catch (error) {
    if (errorCode(error) !== 'EEXIST' || !fs.existsSync(file) || !fs.readFileSync(file).equals(expected)) throw error;
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

async function main(): Promise<void> {
  const settings = parse(process.argv.slice(2));
  const gradedManifestPath = `${settings.graded}.manifest.json`;
  const gradedManifest = readObject(gradedManifestPath);
  if (gradedManifest.schema_version !== 1) throw new Error('graded manifest is not the current schema');
  if (gradedManifest.showdown_commit !== showdownCommit(settings.psDir ?? defaultPsDir())) {
    throw new Error('graded manifest does not match the current Pokémon Showdown checkout');
  }
  const sourceRecords = reopenedGradedCorpus(settings, gradedManifest);
  const gradedDigest = fileDigest(settings.graded);
  const gradedManifestDigest = fileDigest(gradedManifestPath);
  const scoreRows = completedPositionScores(readJsonl(settings.graded), gradedManifest);
  const selection = selectPositions(readCandidates(scoreRows), {
    ...(settings.size === undefined ? {} : { size: settings.size }),
    ...(settings.perGame === undefined ? {} : { perGame: settings.perGame }),
    ...(settings.formats === undefined ? {} : { formats: settings.formats }),
    seed: settings.selectionSeed ?? 'position-set',
  });
  const requested = settings.size ?? 500;
  if (selection.positions.length !== requested) {
    throw new Error(
      `requested ${requested} positions but only ${selection.positions.length} satisfy the filters and per-game cap`,
    );
  }
  process.stdout.write(
    `selected ${selection.positions.length} positions from ${selection.games} games across ${selection.strata.length} strata
`,
  );
  for (const stratum of selection.strata) {
    process.stdout.write(`  ${stratum.key.padEnd(34)} ${String(stratum.taken).padStart(4)} of ${stratum.available}
`);
  }

  const records = new Map(sourceRecords.map((record) => [gameKey(record), record]));
  const reopened = new Map<string, NonNullable<ReturnType<typeof verifyGame>>>();
  const selectionConfig = {
    count: requested,
    seed: settings.selectionSeed ?? 'position-set',
    per_game: settings.perGame ?? 3,
    formats: settings.formats ?? null,
    rules: CANDIDATE_POSITION_SELECTION_RULES,
  };

  const taskRows: JsonObject[] = [];
  const privateRows: JsonObject[] = [];
  const sealedRows: JsonObject[] = [];
  for (const [index, candidate] of selection.positions.entries()) {
    const game = gameOf(candidate);
    const record = records.get(game);
    if (!record) throw new Error(`selected source game ${game} is missing`);
    let verified = reopened.get(game);
    if (!verified) {
      verified = verifyGame(record, settings.psDir) ?? undefined;
      if (!verified) throw new Error(`selected source game ${game} no longer replays uniquely`);
      reopened.set(game, verified);
    }
    const position = verified.replay.positions[candidate.positionIndex];
    if (!position) throw new Error(`selected source position ${game}#${candidate.positionIndex} is missing`);
    const request = position.requests[candidate.pid];
    if (!request)
      throw new Error(`selected source decision ${game}#${candidate.positionIndex}#${candidate.pid} is missing`);
    const liveDigest = positionDigest(position, candidate.pid);
    if (liveDigest !== candidate.positionDigest) {
      throw new Error(
        `selected source decision ${game}#${candidate.positionIndex}#${candidate.pid} changed after grading`,
      );
    }
    const sourceId = digest([game, candidate.positionIndex, candidate.pid, liveDigest]);
    const authoritative = openPosition(position, settings.psDir);
    const publicRequest = anonymiseRequest(request, record.names);
    const seen = anonymiseLog(verified.replay.pov[candidate.pid].slice(0, position.seen[candidate.pid]), record.names);
    const seed = `${String(settings.seed ?? 'position-panels')}:${sourceId}`;
    const table = evaluateActionTable(position, candidate.pid, { ...settings, seed });
    if (!table) throw new Error(`position ${sourceId} did not produce three complete exhaustive panels`);
    const rendered = renderPositionTask({
      id: sourceId,
      format: candidate.format,
      pid: candidate.pid,
      battle: authoritative,
      request: publicRequest,
      seen,
      ...(settings.psDir ? { psDir: settings.psDir } : {}),
    });
    const measuredByAction = new Map(table.measurement.actions.map((entry) => [entry.action, entry]));
    const renderedCommands = rendered.actions.map((entry) => entry.canonicalAction);
    const measuredCommands = table.measurement.actions.map((entry) => entry.action);
    if (
      rendered.actions.length !== table.legal ||
      JSON.stringify(renderedCommands) !== JSON.stringify(measuredCommands)
    ) {
      throw new Error(`position ${sourceId} prompt and graded action maps are not exactly equal`);
    }
    const taskId = canonicalJsonDigest([sourceId, POSITION_TASK_PROTOCOL, rendered.prompt, rendered.actions]);
    const scoredActions = rendered.actions.map((entry) => {
      const measured = measuredByAction.get(entry.canonicalAction);
      if (!measured) throw new Error(`position ${sourceId} is missing ${entry.canonicalAction}`);
      return {
        number: entry.number,
        canonicalAction: entry.canonicalAction,
        meanValue: measured.value,
        standardError: measured.standardError,
        samples: measured.samples,
        normalizedReward: measured.reward,
      };
    });
    validateTaskScoreJoin(rendered.actions, scoredActions);
    const structuralReasons = [
      ...(table.stability.some((panel) => panel.span <= 0) ? ['zero_qualification_span'] : []),
    ];
    const diagnosticFlags = [
      ...(table.heldOutSpan.normalApproxLower95 !== null && table.heldOutSpan.normalApproxLower95 <= 0
        ? ['normal_approx_span_crosses_zero']
        : []),
      ...(!table.rankingStable ? ['best_anchor_unstable'] : []),
      ...(!table.anchorAgreement ? ['extrema_sets_unstable'] : []),
      ...(table.valueSpan <= 0 ? ['measurement_zero_span'] : []),
    ];
    const eligibilityMetrics = positionEligibilityMetrics(table);
    taskRows.push({
      schema_version: POSITION_PANEL_ARTIFACT_SCHEMA_VERSION,
      task_id: taskId,
      format: rendered.format,
      phase: rendered.phase,
      turn: rendered.turn,
      prompt: rendered.prompt,
      response_schema: {
        type: 'object',
        required: ['choice'],
        properties: { choice: { type: 'integer', minimum: 0, maximum: rendered.actions.length - 1 } },
        additionalProperties: false,
      },
      actions: rendered.actions.map((entry) => ({
        number: entry.number,
        canonical_action: entry.canonicalAction,
        label: entry.label,
      })),
    });
    privateRows.push({
      schema_version: POSITION_PANEL_ARTIFACT_SCHEMA_VERSION,
      task_id: taskId,
      structural_pass: structuralReasons.length === 0,
      structural_reasons: structuralReasons,
      measurement_ready: table.valueSpan > 0,
      diagnostic_flags: diagnosticFlags,
      eligibility_metrics: eligibilityMetrics,
      measurement_panel: {
        id: table.measurement.id,
        n: table.measurement.draws.length,
        matrix_digest: table.measurement.matrixDigest,
      },
      min_value: Math.min(...table.measurement.actions.map((entry) => entry.value)),
      max_value: Math.max(...table.measurement.actions.map((entry) => entry.value)),
      span: table.valueSpan,
      actions: scoredActions.map((entry) => ({
        number: entry.number,
        canonical_action: entry.canonicalAction,
        mean_value: entry.meanValue,
        standard_error: entry.standardError,
        n: entry.samples,
        normalized_reward: entry.normalizedReward,
      })),
      stability: {
        matrix_digests: table.stability.map((panel) => panel.matrixDigest),
        spans: table.stability.map((panel) => panel.span),
        best_anchor_agreement: table.rankingStable,
        extrema_set_agreement: table.anchorAgreement,
        max_normalized_reward_drift: table.maxNormalizedRewardDrift,
        held_out_span: table.heldOutSpan,
      },
    });
    const source = {
      run_id: candidate.runId,
      series_id: candidate.seriesId,
      game_number: candidate.gameNumber,
      position_index: candidate.positionIndex,
      pid: candidate.pid,
      scaffold: candidate.scaffold,
      played_by: record.players[candidate.pid],
      played: candidate.played,
    };
    const opponentPid: Pid = candidate.pid === 'p1' ? 'p2' : 'p1';
    const opponentRequest = position.pending.includes(opponentPid) ? (position.requests[opponentPid] ?? null) : null;
    sealedRows.push({
      schema_version: POSITION_PANEL_ARTIFACT_SCHEMA_VERSION,
      task_id: taskId,
      source_id: sourceId,
      exact_public_fingerprint: exactPublicPositionFingerprint(taskRows.at(-1) as JsonObject),
      source,
      snapshot: position.snapshot,
      opponent_request: opponentRequest,
      panel_seed: seed,
      table: { ...table, horizon: Number.isFinite(table.horizon) ? table.horizon : 'end' },
    });
    process.stdout.write(`exported ${index + 1}/${selection.positions.length} ${taskId}
`);
  }

  validatePositionPanelArtifacts(taskRows, privateRows, sealedRows, settings.psDir);
  if (fileDigest(settings.graded) !== gradedDigest || fileDigest(gradedManifestPath) !== gradedManifestDigest) {
    throw new Error('graded cache or manifest changed while candidate panels were generated');
  }
  reopenedGradedCorpus(settings, gradedManifest);
  const taskName = 'tasks.jsonl';
  const scoreName = 'scores.jsonl';
  const sealedName = 'sealed-panels.jsonl';
  const taskContent = canonicalJsonl(taskRows);
  const scoreContent = canonicalJsonl(privateRows);
  const sealedContent = canonicalJsonl(sealedRows);
  const manifest = {
    schema_version: CANDIDATE_POSITION_MANIFEST_SCHEMA_VERSION,
    evaluator_digest: evaluatorDigest(),
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    showdown_commit: showdownCommit(settings.psDir ?? defaultPsDir()),
    seed_namespace: String(settings.seed ?? 'position-panels'),
    action_protocol: ACTION_PROTOCOL,
    task_protocol: POSITION_TASK_PROTOCOL,
    canonical_json: CANONICAL_JSON_PROTOCOL,
    counterfactual: exhaustiveCounterfactualProtocol(settings),
    exhaustive_panels: EXHAUSTIVE_PANEL_PROTOCOL,
    eligibility_metrics_version: POSITION_ELIGIBILITY_METRICS_VERSION,
    inputs: { graded: gradedDigest, graded_manifest: gradedManifestDigest },
    selection: selectionConfig,
    outputs: {
      tasks: { file: taskName, sha256: contentDigest(taskContent), rows: taskRows.length },
      scores: { sha256: contentDigest(scoreContent), rows: privateRows.length },
      sealed_panels: { sha256: contentDigest(sealedContent), rows: sealedRows.length },
    },
    ordered_task_ids: taskRows.map((row) => row.task_id),
  };
  validateCandidateManifest(manifest, 'constructed candidate manifest');
  const manifestContent = `${canonicalJson(manifest)}\n`;
  const outputs = prepareOutputDirectories(settings.out, settings.privateOut);
  publishImmutable(outputs.publicDirectory, taskName, taskContent, PUBLIC_FILE_MODE);
  publishImmutable(outputs.privateDirectory, scoreName, scoreContent, PRIVATE_FILE_MODE);
  publishImmutable(outputs.privateDirectory, sealedName, sealedContent, PRIVATE_FILE_MODE);
  publishImmutable(outputs.publicDirectory, 'manifest.json', manifestContent, PUBLIC_FILE_MODE);
}

await main();
