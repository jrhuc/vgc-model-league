import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { validatePublicPositionTask } from '../eval/panel-artifact.js';
import {
  frozenUpstreamProjectionV2,
  type PilotPositionManifestV2View,
  type PositionArtifactBindingV2,
  pilotManifestUpstreamProjectionV2,
  validateFrozenManifestV2,
  validatePilotManifestV2,
} from '../eval/position-artifact-manifest.js';
import { canonicalJson, canonicalJsonl } from '../eval/serialization.js';
import type { JsonObject } from '../types.js';
import type {
  ResearchArtifactView,
  ResearchCountsView,
  ResearchProtocolsView,
  ResearchProvenanceView,
  ResearchResponse,
  ResearchTaskView,
} from './api.js';

const LIMITS = {
  taskPreviews: 24,
  promptCharacters: 16_000,
  actionsPerTask: 4_096,
  actionLabelCharacters: 4_096,
  artifactRows: 10_000,
  manifestBytes: 1_048_576,
  taskBytes: 16_777_216,
} as const;

interface InputSnapshot {
  bytes: Buffer;
  text: string;
}

interface CapturedDirectory {
  path: string;
  realpath: string;
  dev: number;
  ino: number;
  label: string;
}

interface ValidatedPilotLineage extends PilotPositionManifestV2View {
  manifestSha256: string;
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function childPath(root: string, ...parts: string[]): string {
  const candidate = path.resolve(root, ...parts);
  if (!isContained(path.resolve(root), candidate)) throw new Error('research artifact path escapes its public root');
  return candidate;
}

function directoryState(directory: string, label: string): 'missing' | 'directory' {
  let status: fs.Stats;
  try {
    status = fs.lstatSync(directory);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return 'missing';
    throw new Error(`${label} cannot be inspected`);
  }
  if (status.isSymbolicLink() || !status.isDirectory()) throw new Error(`${label} must be a real directory`);
  return 'directory';
}

function captureDirectory(directory: string, label: string, parentRealpath?: string): CapturedDirectory {
  const status = fs.lstatSync(directory);
  if (status.isSymbolicLink() || !status.isDirectory()) throw new Error(`${label} must be a real directory`);
  const realpath = fs.realpathSync.native(directory);
  if (parentRealpath && !isContained(parentRealpath, realpath)) throw new Error(`${label} escapes its parent root`);
  return { path: directory, realpath, dev: status.dev, ino: status.ino, label };
}

function verifyDirectory(directory: CapturedDirectory, parentRealpath?: string): void {
  const status = fs.lstatSync(directory.path);
  if (
    status.isSymbolicLink() ||
    !status.isDirectory() ||
    status.dev !== directory.dev ||
    status.ino !== directory.ino ||
    fs.realpathSync.native(directory.path) !== directory.realpath ||
    (parentRealpath !== undefined && !isContained(parentRealpath, directory.realpath))
  )
    throw new Error(`${directory.label} changed or became unsafe`);
}

function candidateExists(file: string, label: string): boolean {
  try {
    fs.lstatSync(file);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw new Error(`${label} cannot be inspected`);
  }
}

function readRegularFile(rootRealpath: string, file: string, maximumBytes: number, label: string): InputSnapshot {
  let before: fs.Stats;
  try {
    before = fs.lstatSync(file);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') throw new Error(`${label} is missing`);
    throw new Error(`${label} cannot be inspected`);
  }
  if (before.isSymbolicLink() || !before.isFile()) throw new Error(`${label} must be a regular non-symbolic-link file`);
  if (before.size > maximumBytes) throw new Error(`${label} exceeds its byte limit`);
  let fileRealpath: string;
  try {
    fileRealpath = fs.realpathSync.native(file);
  } catch {
    throw new Error(`${label} cannot be resolved`);
  }
  if (!isContained(rootRealpath, fileRealpath)) throw new Error(`${label} escapes the public research root`);

  let descriptor: number;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch {
    throw new Error(`${label} cannot be opened safely`);
  }
  let opened: fs.Stats;
  let after: fs.Stats;
  let bytes: Buffer;
  try {
    opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.size > maximumBytes) throw new Error(`${label} is not a bounded regular file`);
    if (before.dev !== opened.dev || before.ino !== opened.ino) throw new Error(`${label} changed while opening`);
    bytes = fs.readFileSync(descriptor);
    after = fs.fstatSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  if (
    bytes.length !== after.size ||
    opened.dev !== after.dev ||
    opened.ino !== after.ino ||
    opened.size !== after.size ||
    opened.mtimeMs !== after.mtimeMs ||
    opened.ctimeMs !== after.ctimeMs
  )
    throw new Error(`${label} changed while reading`);
  let current: fs.Stats;
  try {
    current = fs.lstatSync(file);
  } catch {
    throw new Error(`${label} changed after reading`);
  }
  if (
    current.isSymbolicLink() ||
    current.dev !== after.dev ||
    current.ino !== after.ino ||
    current.size !== after.size ||
    current.mtimeMs !== after.mtimeMs ||
    current.ctimeMs !== after.ctimeMs
  )
    throw new Error(`${label} changed after reading`);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error(`${label} is not valid UTF-8`);
  return { bytes, text };
}

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as JsonObject;
}

function nonemptyString(value: unknown, label: string, maximum = 4_096): string {
  if (typeof value !== 'string' || !value || value.length > maximum)
    throw new Error(`${label} must be a bounded string`);
  return value;
}

function canonicalObject(snapshot: InputSnapshot, label: string): JsonObject {
  let value: unknown;
  try {
    value = JSON.parse(snapshot.text);
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
  const result = object(value, label);
  if (snapshot.text !== `${canonicalJson(result)}\n`) throw new Error(`${label} is not canonical JSON`);
  return result;
}

function canonicalRows(snapshot: InputSnapshot, label: string): JsonObject[] {
  if (!snapshot.text.endsWith('\n') && snapshot.text.length) throw new Error(`${label} has no final newline`);
  const lines = snapshot.text ? snapshot.text.slice(0, -1).split('\n') : [];
  if (lines.length > LIMITS.artifactRows) throw new Error(`${label} exceeds its row limit`);
  const rows = lines.map((line, index) => {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`${label} row ${index + 1} is not valid JSON`);
    }
    return object(value, `${label} row ${index + 1}`);
  });
  if (snapshot.text !== canonicalJsonl(rows)) throw new Error(`${label} is not canonical JSONL`);
  return rows;
}

function digest(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function validatePublicTasks(
  snapshot: InputSnapshot,
  label: string,
  binding: PositionArtifactBindingV2,
  split: 'pilot' | 'train' | 'eval',
  orderedTaskIds: readonly string[],
): JsonObject[] {
  if (digest(snapshot.bytes) !== binding.sha256) throw new Error(`${label} does not match its manifest digest`);
  const rows = canonicalRows(snapshot, label);
  if (rows.length !== binding.rows || rows.length !== orderedTaskIds.length)
    throw new Error(`${label} does not match its manifest row count`);
  const taskIds: string[] = [];
  for (const [index, row] of rows.entries()) {
    validatePublicPositionTask(row, index);
    if (row.split !== split) throw new Error(`${label} row ${index + 1} has the wrong split`);
    const taskId = nonemptyString(row.task_id, `${label} row ${index + 1} task id`);
    nonemptyString(row.format, `${label} row ${index + 1} format`, 256);
    const prompt = nonemptyString(row.prompt, `${label} row ${index + 1} prompt`, LIMITS.taskBytes);
    if (Buffer.byteLength(prompt, 'utf8') > LIMITS.taskBytes) throw new Error(`${label} has an oversized prompt`);
    const actions = row.actions as JsonObject[];
    if (actions.length > LIMITS.actionsPerTask) throw new Error(`${label} has too many actions in one task`);
    for (const action of actions) {
      nonemptyString(action.label, `${label} action label`, LIMITS.actionLabelCharacters);
      nonemptyString(action.canonical_action, `${label} canonical action`, LIMITS.actionLabelCharacters);
    }
    taskIds.push(taskId);
  }
  if (new Set(taskIds).size !== taskIds.length || canonicalJson(taskIds) !== canonicalJson(orderedTaskIds))
    throw new Error(`${label} row order does not match its manifest`);
  return rows;
}

/** Preview selection preserves canonical order inside each split/phase bucket, then cycles buckets in
 * train, eval, pilot and team-preview, forced-switch, turn order. This gives every available frozen
 * split/phase bucket one item before a bucket receives its next item. */
function taskPreviews(rows: readonly JsonObject[]): ResearchTaskView[] {
  const splitOrder = ['train', 'eval', 'pilot'] as const;
  const phaseOrder = ['team_preview', 'forced_switch', 'turn'] as const;
  const buckets = new Map<string, JsonObject[]>();
  for (const row of rows) {
    const key = `${String(row.split)}\0${String(row.phase)}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(row);
    else buckets.set(key, [row]);
  }
  const orderedBuckets = splitOrder.flatMap((split) =>
    phaseOrder
      .map((phase) => buckets.get(`${split}\0${phase}`))
      .filter((bucket): bucket is JsonObject[] => bucket !== undefined),
  );
  const cursors = orderedBuckets.map(() => 0);
  const selected: JsonObject[] = [];
  while (selected.length < LIMITS.taskPreviews) {
    let added = false;
    for (const [bucketIndex, bucket] of orderedBuckets.entries()) {
      const cursor = cursors[bucketIndex] as number;
      const row = bucket[cursor];
      if (!row) continue;
      selected.push(row);
      cursors[bucketIndex] = cursor + 1;
      added = true;
      if (selected.length >= LIMITS.taskPreviews) break;
    }
    if (!added) break;
  }
  return selected.map((row) => {
    const prompt = row.prompt as string;
    const actions = row.actions as JsonObject[];
    return {
      taskId: row.task_id as string,
      format: row.format as string,
      split: row.split as ResearchTaskView['split'],
      phase: row.phase as ResearchTaskView['phase'],
      turn: row.turn as number,
      prompt: prompt.slice(0, LIMITS.promptCharacters),
      promptTruncated: prompt.length > LIMITS.promptCharacters,
      actionCount: actions.length,
      actions: actions.map((action) => ({
        number: action.number as number,
        canonicalAction: action.canonical_action as string,
        label: action.label as string,
      })),
    };
  });
}

function publicValidationError(kind: 'pilot' | 'frozen', error: unknown): string {
  const detail = error instanceof Error ? error.message : '';
  if (/byte limit|row limit|too many|oversized|bounded/u.test(detail))
    return `${kind} public artifact exceeds a safety limit`;
  if (/symbolic-link|escapes|changed|opened safely|real directory/u.test(detail))
    return `${kind} public artifact path or file identity is unsafe`;
  if (/canonical|valid JSON|UTF-8|schema version|unsupported/u.test(detail))
    return `${kind} public artifact is malformed, noncanonical, or unsupported`;
  return `${kind} public artifact failed integrity validation`;
}

function invalidArtifact(kind: 'pilot' | 'frozen', error: unknown): ResearchArtifactView {
  return {
    kind,
    schemaVersion: null,
    releaseReady: null,
    status: 'invalid',
    validation: { status: 'invalid', scope: 'public-artifacts-only', errors: [publicValidationError(kind, error)] },
    protocols: null,
    provenance: null,
    releaseGates: [],
    counts: null,
    splitBalance: null,
    taskPreviewAvailability: 'unavailable',
    taskPreviewReason: 'artifact-validation-failed',
    taskTotal: 0,
    taskPreviewCount: 0,
    tasks: [],
  };
}

interface PilotArtifactResult {
  artifact: ResearchArtifactView;
  lineage: ValidatedPilotLineage | null;
}

function pilotArtifact(
  publicRoot: string,
  publicDirectory: CapturedDirectory,
  allowCandidateTasks: boolean,
): PilotArtifactResult {
  const manifestFile = childPath(publicRoot, 'manifest.pilot.json');
  const taskFile = childPath(publicRoot, 'tasks.pilot.jsonl');
  try {
    verifyDirectory(publicDirectory);
    const manifestSnapshot = readRegularFile(
      publicDirectory.realpath,
      manifestFile,
      LIMITS.manifestBytes,
      'pilot manifest',
    );
    const validated = validatePilotManifestV2(canonicalObject(manifestSnapshot, 'pilot manifest'));
    if (validated.outputs.tasks.file !== 'tasks.pilot.jsonl')
      throw new Error('pilot manifest must bind the canonical public task filename');
    if (validated.orderedTaskIds.length > LIMITS.artifactRows) throw new Error('pilot manifest exceeds its row limit');
    for (const value of Object.values(validated.runtime)) nonemptyString(value, 'pilot manifest runtime value', 256);
    const taskSnapshot = readRegularFile(publicDirectory.realpath, taskFile, LIMITS.taskBytes, 'pilot public tasks');
    const rows = validatePublicTasks(
      taskSnapshot,
      'pilot public tasks',
      validated.outputs.tasks,
      'pilot',
      validated.orderedTaskIds,
    );
    const manifestSha256 = digest(manifestSnapshot.bytes);
    const protocols: ResearchProtocolsView = {
      schemaVersion: 2,
      action: validated.actionProtocol,
      task: validated.taskProtocol,
      counterfactual: validated.counterfactualProtocol,
      exhaustivePanels: validated.exhaustivePanelsProtocol,
      canonicalJson: validated.canonicalJsonProtocol,
      nearDuplicates: null,
      eligibilityMetricsVersion: validated.eligibilityMetricsVersion,
    };
    const provenance: ResearchProvenanceView = {
      sourceSetId: validated.sourceSetId,
      calibrationSourceSetId: null,
      manifestSha256,
      upstreamPilotManifestSha256: null,
      upstreamCalibrationManifestSha256: null,
      evaluatorDigest: validated.evaluatorDigest,
      splitterDigest: null,
      showdownCommit: validated.showdownCommit,
      seedNamespace: validated.seedNamespace,
      policyId: null,
      runtime: validated.runtime,
    };
    const counts: ResearchCountsView = {
      input: rows.length,
      eligible: null,
      excluded: null,
      train: null,
      eval: null,
      sourceGroups: null,
      duplicateClusters: null,
      nearDuplicatePairs: null,
    };
    const tasks = allowCandidateTasks ? taskPreviews(rows) : [];
    verifyDirectory(publicDirectory);
    return {
      artifact: {
        kind: 'pilot',
        schemaVersion: 2,
        releaseReady: false,
        status: 'pilot',
        validation: { status: 'valid', scope: 'public-artifacts-only', errors: [] },
        protocols,
        provenance,
        releaseGates: [],
        counts,
        splitBalance: null,
        taskPreviewAvailability: allowCandidateTasks ? 'available' : 'withheld',
        taskPreviewReason: allowCandidateTasks ? null : 'candidate-artifact-not-released-for-hosted-viewers',
        taskTotal: rows.length,
        taskPreviewCount: tasks.length,
        tasks,
      },
      lineage: { ...validated, manifestSha256 },
    };
  } catch (error) {
    return { artifact: invalidArtifact('pilot', error), lineage: null };
  }
}

function frozenArtifact(
  publicRoot: string,
  publicDirectory: CapturedDirectory,
  allowCandidateTasks: boolean,
  pilotLineage: ValidatedPilotLineage | null,
): ResearchArtifactView {
  const frozenRoot = childPath(publicRoot, 'frozen');
  const manifestFile = childPath(frozenRoot, 'manifest.json');
  const trainFile = childPath(frozenRoot, 'tasks.train.jsonl');
  const evalFile = childPath(frozenRoot, 'tasks.eval.jsonl');
  try {
    verifyDirectory(publicDirectory);
    if (!pilotLineage) throw new Error('frozen artifact has no validated sibling pilot lineage');
    if (directoryState(frozenRoot, 'frozen public artifact root') !== 'directory')
      throw new Error('frozen public artifact root is missing');
    const frozenDirectory = captureDirectory(frozenRoot, 'frozen public artifact root', publicDirectory.realpath);
    const manifestSnapshot = readRegularFile(
      frozenDirectory.realpath,
      manifestFile,
      LIMITS.manifestBytes,
      'frozen manifest',
    );
    const validated = validateFrozenManifestV2(canonicalObject(manifestSnapshot, 'frozen manifest'));
    if (
      validated.orderedTrainTaskIds.length > LIMITS.artifactRows ||
      validated.orderedEvalTaskIds.length > LIMITS.artifactRows
    )
      throw new Error('frozen manifest exceeds its row limit');
    for (const value of Object.values(validated.runtime)) nonemptyString(value, 'frozen runtime value', 256);
    const expectedPilotProjection = pilotManifestUpstreamProjectionV2(pilotLineage, pilotLineage.manifestSha256);
    if (canonicalJson(frozenUpstreamProjectionV2(validated.upstreamPilot)) !== canonicalJson(expectedPilotProjection))
      throw new Error('frozen upstream pilot projection differs from its validated sibling pilot');
    if (
      validated.inputs.tasks !== pilotLineage.outputs.tasks.sha256 ||
      validated.inputs.scores !== pilotLineage.outputs.scores.sha256 ||
      validated.inputs.sealed !== pilotLineage.outputs.sealedPanels.sha256
    )
      throw new Error('frozen inputs differ from the sibling pilot artifact bindings');
    if (validated.counts.input !== pilotLineage.outputs.tasks.rows)
      throw new Error('frozen input count differs from the sibling pilot task count');
    const trainBinding = validated.outputs.tasksTrain;
    const evalBinding = validated.outputs.tasksEval;
    const orderedTrain = validated.orderedTrainTaskIds;
    const orderedEval = validated.orderedEvalTaskIds;
    const trainRows = validatePublicTasks(
      readRegularFile(frozenDirectory.realpath, trainFile, LIMITS.taskBytes, 'frozen train public tasks'),
      'frozen train public tasks',
      trainBinding,
      'train',
      orderedTrain,
    );
    const evalRows = validatePublicTasks(
      readRegularFile(frozenDirectory.realpath, evalFile, LIMITS.taskBytes, 'frozen eval public tasks'),
      'frozen eval public tasks',
      evalBinding,
      'eval',
      orderedEval,
    );
    const rows = [...trainRows, ...evalRows];
    const protocols: ResearchProtocolsView = {
      schemaVersion: 2,
      action: validated.upstreamPilot.actionProtocol,
      task: validated.upstreamPilot.taskProtocol,
      counterfactual: validated.upstreamPilot.counterfactualProtocol,
      exhaustivePanels: validated.upstreamPilot.exhaustivePanelsProtocol,
      canonicalJson: validated.canonicalJsonProtocol,
      nearDuplicates: validated.nearDuplicateProtocol,
      eligibilityMetricsVersion: pilotLineage.eligibilityMetricsVersion,
    };
    const provenance: ResearchProvenanceView = {
      sourceSetId: validated.upstreamPilot.sourceSetId,
      calibrationSourceSetId: validated.upstreamCalibration.sourceSetId,
      manifestSha256: digest(manifestSnapshot.bytes),
      upstreamPilotManifestSha256: validated.upstreamPilot.sha256,
      upstreamCalibrationManifestSha256: validated.upstreamCalibration.sha256,
      evaluatorDigest: validated.upstreamPilot.evaluatorDigest,
      splitterDigest: validated.splitterDigest,
      showdownCommit: validated.upstreamPilot.showdownCommit,
      seedNamespace: validated.upstreamPilot.seedNamespace,
      policyId: validated.policy.policy_id,
      runtime: validated.runtime,
    };
    const exposeTasks = allowCandidateTasks;
    const tasks = exposeTasks ? taskPreviews(rows) : [];
    verifyDirectory(frozenDirectory, publicDirectory.realpath);
    verifyDirectory(publicDirectory);
    return {
      kind: 'frozen',
      schemaVersion: 2,
      releaseReady: false,
      status: validated.status,
      validation: { status: 'valid', scope: 'public-artifacts-only', errors: [] },
      protocols,
      provenance,
      releaseGates: validated.releaseGates,
      counts: validated.counts,
      splitBalance: validated.splitBalance,
      taskPreviewAvailability: exposeTasks ? 'available' : 'withheld',
      taskPreviewReason: exposeTasks ? null : 'candidate-artifact-not-released-for-hosted-viewers',
      taskTotal: rows.length,
      taskPreviewCount: tasks.length,
      tasks,
    };
  } catch (error) {
    return invalidArtifact('frozen', error);
  }
}

interface LegacyInventoryResult {
  view: ResearchResponse['legacyPositions'];
  warnings: string[];
}

function emptyLegacyInventory(): ResearchResponse['legacyPositions'] {
  return { present: false, rows: 0, manifestBound: false, displayPolicy: 'inventory-only' };
}

function countLegacyRows(recordsDirectory: CapturedDirectory, file: string): { rows: number; malformed: boolean } {
  verifyDirectory(recordsDirectory);
  const before = fs.lstatSync(file);
  if (before.isSymbolicLink() || !before.isFile()) throw new Error('legacy positions inventory is unsafe');
  if (before.size > 67_108_864) throw new Error('legacy positions inventory exceeds its byte limit');
  const fileRealpath = fs.realpathSync.native(file);
  if (!isContained(recordsDirectory.realpath, fileRealpath))
    throw new Error('legacy positions inventory escapes records');
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let opened: fs.Stats;
  let after: fs.Stats;
  let rows = 0;
  let lineBytes = 0;
  let malformed = false;
  try {
    opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.size > 67_108_864 || before.dev !== opened.dev || before.ino !== opened.ino)
      throw new Error('legacy positions inventory changed while opening');
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const buffer = Buffer.allocUnsafe(65_536);
    while (true) {
      const read = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (!read) break;
      try {
        decoder.decode(buffer.subarray(0, read), { stream: true });
      } catch {
        malformed = true;
      }
      for (let index = 0; index < read; index += 1) {
        const byte = buffer[index] as number;
        if (byte === 0x0a) {
          rows += 1;
          if (lineBytes === 0) malformed = true;
          lineBytes = 0;
          if (rows > 1_000_000) throw new Error('legacy positions inventory exceeds its row limit');
        } else {
          if (byte === 0x0d) malformed = true;
          lineBytes += 1;
        }
      }
    }
    try {
      decoder.decode();
    } catch {
      malformed = true;
    }
    if (lineBytes > 0) {
      rows += 1;
      malformed = true;
    }
    after = fs.fstatSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  if (
    opened.dev !== after.dev ||
    opened.ino !== after.ino ||
    opened.size !== after.size ||
    opened.mtimeMs !== after.mtimeMs ||
    opened.ctimeMs !== after.ctimeMs
  )
    throw new Error('legacy positions inventory changed while reading');
  const current = fs.lstatSync(file);
  if (
    current.isSymbolicLink() ||
    current.dev !== after.dev ||
    current.ino !== after.ino ||
    current.size !== after.size ||
    current.mtimeMs !== after.mtimeMs ||
    current.ctimeMs !== after.ctimeMs
  )
    throw new Error('legacy positions inventory changed after reading');
  verifyDirectory(recordsDirectory);
  return { rows, malformed };
}

function legacyInventory(recordsRoot: string, recordsDirectory: CapturedDirectory): LegacyInventoryResult {
  const file = childPath(recordsRoot, 'positions.jsonl');
  let present: boolean;
  try {
    present = candidateExists(file, 'legacy positions inventory');
  } catch {
    return {
      view: emptyLegacyInventory(),
      warnings: ['legacy positions inventory could not be inspected safely'],
    };
  }
  if (!present) return { view: emptyLegacyInventory(), warnings: [] };
  try {
    const counted = countLegacyRows(recordsDirectory, file);
    return {
      view: { present: true, rows: counted.rows, manifestBound: false, displayPolicy: 'inventory-only' },
      warnings: counted.malformed
        ? ['legacy positions inventory has malformed JSONL framing; rows remain inventory-only']
        : [],
    };
  } catch {
    return {
      view: { present: true, rows: 0, manifestBound: false, displayPolicy: 'inventory-only' },
      warnings: ['legacy positions inventory could not be counted within safety limits'],
    };
  }
}

function programStage(artifacts: readonly ResearchArtifactView[]): ResearchResponse['program']['positions']['stage'] {
  if (artifacts.some((artifact) => artifact.validation.status === 'invalid')) return 'invalid';
  const frozen = artifacts.find((artifact) => artifact.kind === 'frozen');
  if (frozen?.validation.status === 'valid') return 'candidate';
  if (artifacts.some((artifact) => artifact.kind === 'pilot' && artifact.validation.status === 'valid')) return 'pilot';
  return 'not-generated';
}

function responseBody(
  status: ResearchResponse['status'],
  artifacts: ResearchArtifactView[],
  legacy: ResearchResponse['legacyPositions'],
  errors: string[],
  warnings: string[],
): ResearchResponse {
  return {
    schemaVersion: 1,
    status,
    program: {
      positions: { target: 'vgc-positions-v1', stage: errors.length ? 'invalid' : programStage(artifacts) },
      draftCircuit: { target: 'vgc-draft-circuit-v1', stage: 'design' },
    },
    legacyPositions: legacy,
    artifacts,
    errors,
    warnings,
    limits: { ...LIMITS },
  };
}

export interface ResearchIndexOptions {
  allowCandidateTasks?: boolean;
}

interface CachedResearchResponse {
  fingerprint: string;
  response: ResearchResponse;
}

const researchCache = new Map<string, CachedResearchResponse>();
const MAX_RESEARCH_CACHE_ENTRIES = 16;

function identityFingerprint(file: string): { token: string; realDirectory: boolean } {
  try {
    const status = fs.lstatSync(file, { bigint: true });
    return {
      token: [
        status.dev,
        status.ino,
        status.mode,
        status.size,
        status.mtimeNs,
        status.ctimeNs,
        status.isSymbolicLink() ? 1 : 0,
        status.isDirectory() ? 1 : 0,
        status.isFile() ? 1 : 0,
      ].join(':'),
      realDirectory: status.isDirectory() && !status.isSymbolicLink(),
    };
  } catch (error) {
    return { token: `error:${errorCode(error) ?? 'unknown'}`, realDirectory: false };
  }
}

function researchInputFingerprint(recordsRoot: string): string {
  const parts: string[] = [];
  const append = (label: string, file: string): boolean => {
    const identity = identityFingerprint(file);
    parts.push(`${label}:${identity.token}`);
    return identity.realDirectory;
  };
  if (!append('records', recordsRoot)) return parts.join('|');
  append('legacy', childPath(recordsRoot, 'positions.jsonl'));
  const publicRoot = childPath(recordsRoot, 'position-panels');
  if (!append('public-root', publicRoot)) return parts.join('|');
  append('pilot-manifest', childPath(publicRoot, 'manifest.pilot.json'));
  append('pilot-tasks', childPath(publicRoot, 'tasks.pilot.jsonl'));
  const frozenRoot = childPath(publicRoot, 'frozen');
  if (!append('frozen-root', frozenRoot)) return parts.join('|');
  append('frozen-manifest', childPath(frozenRoot, 'manifest.json'));
  append('frozen-train', childPath(frozenRoot, 'tasks.train.jsonl'));
  append('frozen-eval', childPath(frozenRoot, 'tasks.eval.jsonl'));
  return parts.join('|');
}

function buildResearchIndexUncached(recordsRoot: string, allowCandidateTasks: boolean): ResearchResponse {
  let recordsState: 'missing' | 'directory';
  try {
    recordsState = directoryState(recordsRoot, 'records directory');
  } catch {
    return responseBody(
      'degraded',
      [],
      emptyLegacyInventory(),
      ['records directory failed public research safety validation'],
      [],
    );
  }
  if (recordsState === 'missing') return responseBody('empty', [], emptyLegacyInventory(), [], []);
  let recordsDirectory: CapturedDirectory;
  try {
    recordsDirectory = captureDirectory(recordsRoot, 'records directory');
  } catch {
    return responseBody(
      'degraded',
      [],
      emptyLegacyInventory(),
      ['records directory failed public research safety validation'],
      [],
    );
  }
  const legacy = legacyInventory(recordsRoot, recordsDirectory);
  const publicRoot = childPath(recordsRoot, 'position-panels');
  let publicState: 'missing' | 'directory';
  try {
    publicState = directoryState(publicRoot, 'public research root');
  } catch {
    return responseBody(
      'degraded',
      [],
      legacy.view,
      ['public research root failed path safety validation'],
      legacy.warnings,
    );
  }
  if (publicState === 'missing') return responseBody('empty', [], legacy.view, [], legacy.warnings);
  let publicDirectory: CapturedDirectory;
  try {
    publicDirectory = captureDirectory(publicRoot, 'public research root', recordsDirectory.realpath);
  } catch {
    return responseBody(
      'degraded',
      [],
      legacy.view,
      ['public research root failed path safety validation'],
      legacy.warnings,
    );
  }

  const artifacts: ResearchArtifactView[] = [];
  let pilotLineage: ValidatedPilotLineage | null = null;
  try {
    const pilotManifest = childPath(publicRoot, 'manifest.pilot.json');
    const pilotTasks = childPath(publicRoot, 'tasks.pilot.jsonl');
    if (candidateExists(pilotManifest, 'pilot manifest') || candidateExists(pilotTasks, 'pilot public tasks')) {
      const pilot = pilotArtifact(publicRoot, publicDirectory, allowCandidateTasks);
      artifacts.push(pilot.artifact);
      pilotLineage = pilot.lineage;
    }
  } catch (error) {
    artifacts.push(invalidArtifact('pilot', error));
  }

  const frozenRoot = childPath(publicRoot, 'frozen');
  try {
    const frozenState = directoryState(frozenRoot, 'frozen public artifact root');
    if (frozenState === 'directory') {
      const manifest = childPath(frozenRoot, 'manifest.json');
      const train = childPath(frozenRoot, 'tasks.train.jsonl');
      const evaluation = childPath(frozenRoot, 'tasks.eval.jsonl');
      if (
        candidateExists(manifest, 'frozen manifest') ||
        candidateExists(train, 'frozen train public tasks') ||
        candidateExists(evaluation, 'frozen eval public tasks')
      )
        artifacts.push(frozenArtifact(publicRoot, publicDirectory, allowCandidateTasks, pilotLineage));
    }
  } catch (error) {
    artifacts.push(invalidArtifact('frozen', error));
  }

  try {
    verifyDirectory(publicDirectory, recordsDirectory.realpath);
    verifyDirectory(recordsDirectory);
  } catch {
    return responseBody(
      'degraded',
      [],
      legacy.view,
      ['public research roots changed during validation'],
      legacy.warnings,
    );
  }
  if (!artifacts.length) return responseBody('empty', artifacts, legacy.view, [], legacy.warnings);
  const degraded = artifacts.some((artifact) => artifact.validation.status === 'invalid');
  return responseBody(degraded ? 'degraded' : 'ready', artifacts, legacy.view, [], legacy.warnings);
}

/** Node does not expose an openat-style directory capability here. Fixed-name lstat/open/fstat checks,
 * captured directory identities, and cache fingerprints reject ordinary link and replacement races;
 * an actively hostile same-UID process renaming ancestors remains a deployment-level residual risk. */
export function buildResearchIndex(recordsDirectory: string, options: ResearchIndexOptions = {}): ResearchResponse {
  const recordsRoot = path.resolve(recordsDirectory);
  const allowCandidateTasks = options.allowCandidateTasks === true;
  const cacheKey = `${recordsRoot}\0${allowCandidateTasks ? 'candidate' : 'public'}`;
  let before = researchInputFingerprint(recordsRoot);
  const cached = researchCache.get(cacheKey);
  if (cached?.fingerprint === before) {
    const confirmed = researchInputFingerprint(recordsRoot);
    if (confirmed === before) return structuredClone(cached.response);
    before = confirmed;
  }
  const response = buildResearchIndexUncached(recordsRoot, allowCandidateTasks);
  const after = researchInputFingerprint(recordsRoot);
  if (before === after) {
    if (researchCache.size >= MAX_RESEARCH_CACHE_ENTRIES) {
      const oldest = researchCache.keys().next().value as string | undefined;
      if (oldest !== undefined) researchCache.delete(oldest);
    }
    researchCache.set(cacheKey, { fingerprint: after, response: structuredClone(response) });
  } else {
    researchCache.delete(cacheKey);
    return responseBody(
      'degraded',
      [],
      response.legacyPositions,
      ['public research inputs changed during cache validation'],
      response.warnings,
    );
  }
  return response;
}
