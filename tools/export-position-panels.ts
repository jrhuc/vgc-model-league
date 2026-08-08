#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  type CounterfactualOptions,
  counterfactualProtocol,
  EXHAUSTIVE_PANEL_PROTOCOL,
  evaluateActionTable,
} from '../src/eval/counterfactual.js';
import { POSITION_ELIGIBILITY_METRICS_VERSION, positionEligibilityMetrics } from '../src/eval/eligibility.js';
import { ACTION_PROTOCOL, openPosition, type Position, pendingSides } from '../src/eval/fork.js';
import {
  exactPublicPositionFingerprint,
  POSITION_SOURCE_GROUP_PROTOCOL,
  positionSourceGroup,
  validatePositionPanelArtifacts,
} from '../src/eval/panel-artifact.js';
import { validatePilotManifestV2 } from '../src/eval/position-artifact-manifest.js';
import { anonymiseRequest, POSITION_SET_SCHEMA_VERSION } from '../src/eval/positions.js';
import {
  CANONICAL_JSON_PROTOCOL,
  canonicalJson,
  canonicalJsonDigest,
  canonicalJsonl,
} from '../src/eval/serialization.js';
import { POSITION_TASK_PROTOCOL, renderPositionTask, validateTaskScoreJoin } from '../src/eval/task.js';
import { DATA_DIR, defaultPsDir } from '../src/paths.js';
import { showdownCommit } from '../src/showdown.js';
import type { BattleRequest, JsonObject, Pid } from '../src/types.js';

interface Settings extends CounterfactualOptions {
  set: string;
  privateSet: string;
  out: string;
  privateOut: string;
}

interface OutputRoot {
  directory: string;
  realDirectory: string;
  device: number;
  inode: number;
  directoryMode: number;
  fileMode: number;
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

function secureOutputDirectory(directory: string, directoryMode: number, fileMode: number): OutputRoot {
  const requested = path.resolve(directory);
  let existing = requested;
  const missingComponents: string[] = [];
  let existingStatus: fs.Stats;
  for (;;) {
    try {
      existingStatus = fs.lstatSync(existing);
      break;
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw new Error(`output root has no existing filesystem ancestor: ${requested}`);
      missingComponents.unshift(path.basename(existing));
      existing = parent;
    }
  }
  if (!missingComponents.length && (existingStatus.isSymbolicLink() || !existingStatus.isDirectory())) {
    throw new Error(`output root must be a non-symlink directory: ${requested}`);
  }

  const canonicalParent = fs.realpathSync.native(existing);
  let current = canonicalParent;
  let parentStatus = fs.statSync(canonicalParent);
  if (!parentStatus.isDirectory()) {
    throw new Error(`nearest existing output parent must resolve to a directory: ${existing}`);
  }
  for (const component of missingComponents) {
    const checkedParent = fs.lstatSync(current);
    if (
      checkedParent.isSymbolicLink() ||
      !checkedParent.isDirectory() ||
      checkedParent.dev !== parentStatus.dev ||
      checkedParent.ino !== parentStatus.ino
    ) {
      throw new Error(`physical output parent changed while creating the root: ${current}`);
    }
    current = path.join(current, component);
    try {
      fs.mkdirSync(current, { mode: directoryMode });
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
    }
    const created = fs.lstatSync(current);
    if (created.isSymbolicLink()) {
      throw new Error(`created output root component must not be a symlink: ${current}`);
    }
    if (!created.isDirectory()) {
      throw new Error(`created output root component must be a directory: ${current}`);
    }
    fs.chmodSync(current, directoryMode);
    parentStatus = fs.lstatSync(current);
  }

  fs.chmodSync(current, directoryMode);
  const beforeRealpath = fs.lstatSync(current);
  if (beforeRealpath.isSymbolicLink() || !beforeRealpath.isDirectory()) {
    throw new Error(`output root must remain a non-symlink directory: ${current}`);
  }
  const realDirectory = fs.realpathSync.native(current);
  const afterRealpath = fs.lstatSync(current);
  if (
    afterRealpath.isSymbolicLink() ||
    !afterRealpath.isDirectory() ||
    afterRealpath.dev !== beforeRealpath.dev ||
    afterRealpath.ino !== beforeRealpath.ino
  ) {
    throw new Error(`output root changed while it was resolved: ${current}`);
  }
  if ((afterRealpath.mode & 0o777) !== directoryMode) {
    throw new Error(`output root has an unexpected mode after chmod: ${current}`);
  }
  return {
    directory: realDirectory,
    realDirectory,
    device: afterRealpath.dev,
    inode: afterRealpath.ino,
    directoryMode,
    fileMode,
  };
}

function prepareOutputRoots(
  publicDirectory: string,
  privateDirectory: string,
): {
  publicRoot: OutputRoot;
  privateRoot: OutputRoot;
} {
  const publicRoot = secureOutputDirectory(publicDirectory, PUBLIC_DIRECTORY_MODE, PUBLIC_FILE_MODE);
  const privateRoot = secureOutputDirectory(privateDirectory, PRIVATE_DIRECTORY_MODE, PRIVATE_FILE_MODE);
  assertDisjointPaths(publicRoot.realDirectory, privateRoot.realDirectory, 'after realpath resolution');
  if (publicRoot.device === privateRoot.device && publicRoot.inode === privateRoot.inode) {
    throw new Error('public and private output roots must not be realpath aliases');
  }
  return { publicRoot, privateRoot };
}

function verifyOutputRoot(root: OutputRoot): void {
  const checked = secureOutputDirectory(root.directory, root.directoryMode, root.fileMode);
  if (checked.realDirectory !== root.realDirectory || checked.device !== root.device || checked.inode !== root.inode) {
    throw new Error(`output root changed during publication: ${root.directory}`);
  }
}

function parse(argv: string[]): Settings {
  const out = path.join(DATA_DIR, 'records', 'position-panels');
  const settings: Settings = {
    set: path.join(DATA_DIR, 'records', 'position-set.json'),
    privateSet: path.join(DATA_DIR, 'records', 'private', 'position-set.json'),
    out,
    privateOut: path.join(DATA_DIR, 'records', 'private', 'position-panels'),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--set' && value) settings.set = path.resolve(value);
    else if (flag === '--private-set' && value) settings.privateSet = path.resolve(value);
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
    ['luck', settings.luckSamples],
    ['opponents', settings.opponentSamples],
  ] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
      throw new Error(`--${name} must be a positive integer`);
    }
  }
  if (
    settings.horizon !== undefined &&
    settings.horizon !== Number.POSITIVE_INFINITY &&
    (!Number.isInteger(settings.horizon) || settings.horizon < 0)
  ) {
    throw new Error('--horizon must be a non-negative integer or end');
  }
  assertDisjointPaths(settings.out, settings.privateOut, 'lexically');
  return settings;
}

function digest(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function fileDigest(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
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
  ].sort((a, b) => Buffer.from(a).compare(Buffer.from(b)));
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

function rows(value: JsonObject, file: string): JsonObject[] {
  if (!Array.isArray(value.positions)) throw new Error(`${file} has no positions array`);
  return value.positions.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      throw new Error(`${file} has a malformed position`);
    return entry as JsonObject;
  });
}

type ExistingTargetState = 'missing' | 'identical' | 'different';

function assertRegularTarget(file: string, status: fs.Stats, expectedMode: number): void {
  if (status.isSymbolicLink() || !status.isFile()) {
    throw new Error(`pilot artifact target must be a regular file and not a symbolic link: ${file}`);
  }
  if (status.nlink !== 1 || (status.mode & 0o777) !== expectedMode) {
    throw new Error(`pilot artifact target has an unexpected mode or hard-link alias: ${file}`);
  }
}

function existingTargetState(file: string, expected: Buffer, expectedMode: number): ExistingTargetState {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let initial: fs.Stats;
    try {
      initial = fs.lstatSync(file);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return 'missing';
      throw error;
    }
    assertRegularTarget(file, initial, expectedMode);
    let descriptor: number;
    try {
      descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') continue;
      if (errorCode(error) === 'ELOOP') {
        throw new Error(`pilot artifact target must not be a symbolic link: ${file}`);
      }
      throw error;
    }
    let opened: fs.Stats;
    let finished: fs.Stats;
    let actual: Buffer;
    try {
      opened = fs.fstatSync(descriptor);
      assertRegularTarget(file, opened, expectedMode);
      actual = fs.readFileSync(descriptor);
      finished = fs.fstatSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    let current: fs.Stats;
    try {
      current = fs.lstatSync(file);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') continue;
      throw error;
    }
    assertRegularTarget(file, current, expectedMode);
    if (
      initial.dev !== opened.dev ||
      initial.ino !== opened.ino ||
      opened.dev !== current.dev ||
      opened.ino !== current.ino ||
      opened.size !== finished.size ||
      opened.mtimeMs !== finished.mtimeMs ||
      opened.ctimeMs !== finished.ctimeMs ||
      finished.size !== current.size ||
      finished.mtimeMs !== current.mtimeMs ||
      finished.ctimeMs !== current.ctimeMs
    ) {
      continue;
    }
    return actual.equals(expected) ? 'identical' : 'different';
  }
  throw new Error(`pilot artifact target changed while it was being checked: ${file}`);
}

function stageArtifact(root: OutputRoot, file: string, content: Buffer): string {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const temporary = path.join(
      root.directory,
      `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(12).toString('hex')}.tmp`,
    );
    let descriptor: number;
    try {
      descriptor = fs.openSync(
        temporary,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
        root.fileMode,
      );
    } catch (error) {
      if (errorCode(error) === 'EEXIST') continue;
      throw error;
    }
    try {
      fs.fchmodSync(descriptor, root.fileMode);
      fs.writeFileSync(descriptor, content);
      fs.fsyncSync(descriptor);
      assertRegularTarget(temporary, fs.fstatSync(descriptor), root.fileMode);
    } catch (error) {
      fs.closeSync(descriptor);
      fs.unlinkSync(temporary);
      throw error;
    }
    fs.closeSync(descriptor);
    return temporary;
  }
  throw new Error(`could not allocate a temporary pilot artifact beside ${file}`);
}

function publishImmutable(root: OutputRoot, name: string, content: string): void {
  if (path.basename(name) !== name) throw new Error(`pilot artifact name must be a basename: ${name}`);
  verifyOutputRoot(root);
  const file = path.join(root.directory, name);
  const expected = Buffer.from(content, 'utf8');
  const initial = existingTargetState(file, expected, root.fileMode);
  if (initial === 'identical') return;
  if (initial === 'different') {
    throw new Error(`refusing to replace non-identical pilot artifact: ${file}`);
  }
  const temporary = stageArtifact(root, file, expected);
  let published = false;
  let publicationFailed = false;
  let publicationError: unknown;
  try {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      verifyOutputRoot(root);
      const current = existingTargetState(file, expected, root.fileMode);
      if (current === 'identical') {
        published = true;
        break;
      }
      if (current === 'different') {
        throw new Error(`refusing to replace non-identical pilot artifact: ${file}`);
      }
      try {
        fs.linkSync(temporary, file);
        published = true;
        break;
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error;
      }
    }
    if (!published) throw new Error(`pilot artifact target changed during publication: ${file}`);
  } catch (error) {
    publicationFailed = true;
    publicationError = error;
  }
  let cleanupFailed = false;
  let cleanupError: unknown;
  try {
    fs.unlinkSync(temporary);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      cleanupFailed = true;
      cleanupError = error;
    }
  }
  if (publicationFailed) throw publicationError;
  if (cleanupFailed) throw cleanupError;
}

function taskPosition(publicRow: JsonObject, privateRow: JsonObject, psDir?: string): { position: Position; pid: Pid } {
  const source = privateRow.source as JsonObject | undefined;
  const pid = source?.pid;
  if (pid !== 'p1' && pid !== 'p2') throw new Error(`position ${String(publicRow.id)} has no private pid`);
  const foe: Pid = pid === 'p1' ? 'p2' : 'p1';
  const request = publicRow.request as BattleRequest | undefined;
  if (!request) throw new Error(`position ${String(publicRow.id)} has no public request`);
  const opponent = privateRow.opponent_request as BattleRequest | null | undefined;
  const requests = { [pid]: request } as Record<Pid, BattleRequest>;
  if (opponent) requests[foe] = opponent;
  const position: Position = {
    index: Number(source?.position_index ?? 0),
    turn: Number(publicRow.turn ?? 0),
    pending: [],
    requests,
    actual: {},
    choiceIndex: {},
    seen: { p1: 0, p2: 0 },
    snapshot: String(privateRow.snapshot ?? ''),
  };
  position.pending = pendingSides(openPosition(position, psDir));
  return { pid, position };
}

async function main(): Promise<void> {
  const settings = parse(process.argv.slice(2));
  const publicSet = readObject(settings.set);
  const privateSet = readObject(settings.privateSet);
  if (
    publicSet.schema_version !== POSITION_SET_SCHEMA_VERSION ||
    privateSet.schema_version !== POSITION_SET_SCHEMA_VERSION
  ) {
    throw new Error(`position sets must use schema version ${POSITION_SET_SCHEMA_VERSION}`);
  }
  if (typeof publicSet.id !== 'string' || publicSet.id !== privateSet.id) {
    throw new Error('public and private position sets do not share one id');
  }
  if (privateSet.public_checksum !== digest(publicSet)) throw new Error('private set does not bind the public set');
  const publicRows = rows(publicSet, settings.set);
  const privateRows = rows(privateSet, settings.privateSet);
  const privateById = new Map(privateRows.map((row) => [String(row.id), row]));
  if (privateById.size !== privateRows.length || publicRows.length !== privateRows.length) {
    throw new Error('public and private position sets are not a bijection');
  }

  const taskRows: JsonObject[] = [];
  const scoreRows: JsonObject[] = [];
  const sealedRows: JsonObject[] = [];
  for (const [index, publicRow] of publicRows.entries()) {
    const sourceId = String(publicRow.id ?? '');
    const privateRow = privateById.get(sourceId);
    if (!sourceId || !privateRow) throw new Error(`public position ${sourceId || index} has no private row`);
    const { position, pid } = taskPosition(publicRow, privateRow, settings.psDir);
    const authoritative = openPosition(position, settings.psDir);
    const authoritativeRequest = authoritative.getSide(pid).activeRequest as unknown as BattleRequest | null;
    if (!authoritativeRequest) throw new Error(`position ${sourceId} snapshot has no source request`);
    const names = { p1: authoritative.getSide('p1').name, p2: authoritative.getSide('p2').name };
    if (canonicalJson(anonymiseRequest(authoritativeRequest, names)) !== canonicalJson(position.requests[pid])) {
      throw new Error(`position ${sourceId} public request does not match its anonymized snapshot request`);
    }
    const opponentPid: Pid = pid === 'p1' ? 'p2' : 'p1';
    const authoritativeOpponent = authoritative.getSide(opponentPid).activeRequest as unknown as BattleRequest | null;
    const submittedOpponent = position.requests[opponentPid];
    if (position.pending.includes(opponentPid) !== Boolean(submittedOpponent)) {
      throw new Error(`position ${sourceId} opponent request presence does not match its snapshot decision boundary`);
    }
    if (
      submittedOpponent &&
      (!authoritativeOpponent || canonicalJson(authoritativeOpponent) !== canonicalJson(submittedOpponent))
    ) {
      throw new Error(`position ${sourceId} opponent request does not match its snapshot request`);
    }
    const seed = `${String(settings.seed ?? 'position-panels')}:${sourceId}`;
    const table = evaluateActionTable(position, pid, { ...settings, seed });
    if (!table) throw new Error(`position ${sourceId} did not produce three complete exhaustive panels`);
    const rendered = renderPositionTask({
      id: sourceId,
      format: String(publicRow.format ?? ''),
      pid,
      battle: authoritative,
      request: position.requests[pid],
      seen: Array.isArray(publicRow.seen) ? publicRow.seen.map(String) : [],
      ...(settings.psDir ? { psDir: settings.psDir } : {}),
    });
    const measuredByAction = new Map(table.measurement.actions.map((entry) => [entry.action, entry]));
    const renderedCommands = rendered.actions.map((entry) => entry.canonicalAction);
    const measuredCommands = table.measurement.actions.map((entry) => entry.action);
    const frozenPublicCommands = Array.isArray(publicRow.legal) ? publicRow.legal.map(String) : [];
    if (
      rendered.actions.length !== table.legal ||
      JSON.stringify(renderedCommands) !== JSON.stringify(measuredCommands) ||
      JSON.stringify(renderedCommands) !== JSON.stringify(frozenPublicCommands)
    ) {
      throw new Error(`position ${sourceId} frozen, prompt, and graded action maps are not exactly equal`);
    }
    const taskId = canonicalJsonDigest([
      publicSet.id,
      sourceId,
      POSITION_TASK_PROTOCOL,
      rendered.prompt,
      rendered.actions,
    ]);
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
      schema_version: 3,
      task_id: taskId,
      split: 'pilot',
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
    scoreRows.push({
      schema_version: 3,
      task_id: taskId,
      structural_pass: structuralReasons.length === 0,
      structural_reasons: structuralReasons,
      measurement_ready: table.valueSpan > 0,
      diagnostic_flags: diagnosticFlags,
      eligibility_status: 'pilot-thresholds-not-frozen',
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
    const source = privateRow.source as JsonObject;
    const sourceGroup = positionSourceGroup(source);
    const exactPublicFingerprint = exactPublicPositionFingerprint(taskRows.at(-1) as JsonObject);
    sealedRows.push({
      schema_version: 3,
      task_id: taskId,
      source_id: sourceId,
      source_group: sourceGroup,
      selection_stratum: String(privateRow.selection_stratum ?? ''),
      exact_public_fingerprint: exactPublicFingerprint,
      source: privateRow.source,
      snapshot: privateRow.snapshot,
      opponent_request: privateRow.opponent_request,
      panel_seed: seed,
      table: { ...table, horizon: Number.isFinite(table.horizon) ? table.horizon : 'end' },
    });
    process.stdout.write(`exported ${index + 1}/${publicRows.length} ${taskId}\n`);
  }
  if (privateById.size !== taskRows.length) throw new Error('private position set contains an unmatched row');

  validatePositionPanelArtifacts(taskRows, scoreRows, sealedRows, settings.psDir);
  const { publicRoot, privateRoot } = prepareOutputRoots(settings.out, settings.privateOut);
  const taskFile = path.join(publicRoot.directory, 'tasks.pilot.jsonl');
  const scoreFile = path.join(privateRoot.directory, 'scores.pilot.jsonl');
  const sealedFile = path.join(privateRoot.directory, 'sealed-panels.pilot.jsonl');
  publishImmutable(publicRoot, path.basename(taskFile), canonicalJsonl(taskRows));
  publishImmutable(privateRoot, path.basename(scoreFile), canonicalJsonl(scoreRows));
  publishImmutable(privateRoot, path.basename(sealedFile), canonicalJsonl(sealedRows));
  const manifest = {
    schema_version: 2,
    release_ready: false,
    eligibility_status: 'pilot-thresholds-not-frozen',
    eligibility_metrics_version: POSITION_ELIGIBILITY_METRICS_VERSION,
    split_status: 'pilot-only-source-groups-and-exact-fingerprints-recorded',
    source_set_id: publicSet.id,
    evaluator_digest: evaluatorDigest(),
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    showdown_commit: showdownCommit(settings.psDir ?? defaultPsDir()),
    action_protocol: ACTION_PROTOCOL,
    task_protocol: POSITION_TASK_PROTOCOL,
    canonical_json: CANONICAL_JSON_PROTOCOL,
    counterfactual: counterfactualProtocol(settings),
    exhaustive_panels: EXHAUSTIVE_PANEL_PROTOCOL,
    source_group_protocol: POSITION_SOURCE_GROUP_PROTOCOL,
    seed_namespace: String(settings.seed ?? 'position-panels'),
    inputs: {
      public_set: fileDigest(settings.set),
      private_set: fileDigest(settings.privateSet),
    },
    outputs: {
      tasks: { file: path.basename(taskFile), sha256: fileDigest(taskFile), rows: taskRows.length },
      scores: { sha256: fileDigest(scoreFile), rows: scoreRows.length },
      sealed_panels: { sha256: fileDigest(sealedFile), rows: sealedRows.length },
    },
    ordered_task_ids: taskRows.map((row) => row.task_id),
  };
  validatePilotManifestV2(manifest, 'constructed pilot manifest');
  publishImmutable(publicRoot, 'manifest.pilot.json', `${canonicalJson(manifest)}\n`);
}

await main();
