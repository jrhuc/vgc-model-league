#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { clusterNearDuplicatePositions, NEAR_DUPLICATE_PROTOCOL } from '../src/eval/duplicates.js';
import { assessPositionEligibility, type PositionEligibilityMetrics } from '../src/eval/eligibility.js';
import { validatePositionPanelArtifacts } from '../src/eval/panel-artifact.js';
import {
  FROZEN_CALIBRATION_CANDIDATE_SEPARATION,
  FROZEN_POSITION_EXCLUSION_PROTOCOL,
  FROZEN_POSITION_MANIFEST_STATUS,
  FROZEN_POSITION_RELEASE_GATES,
  type PositionSplitFreezePolicyV2,
  pilotManifestUpstreamProjectionV2,
  validateFrozenManifestV2,
  validatePilotManifestV2,
  validatePositionSplitFreezePolicyV2,
} from '../src/eval/position-artifact-manifest.js';
import { captureRuntimeProducerAuthority, type RuntimeProducerAuthoritySnapshot } from '../src/eval/producer.js';
import {
  CANONICAL_JSON_PROTOCOL,
  canonicalJson,
  canonicalJsonDigest,
  canonicalJsonl,
} from '../src/eval/serialization.js';
import { assignStratifiedPositionSplits, positionSplitDigest, splitBalance } from '../src/eval/splits.js';
import { defaultPsDir, PINNED_PS_DIR, REPO_ROOT } from '../src/paths.js';
import type { JsonObject } from '../src/types.js';

interface Settings {
  tasks: string;
  scores: string;
  sealed: string;
  manifest: string;
  calibrationManifest: string;
  policy: string;
  out: string;
  privateOut: string;
}

function parse(argv: string[]): Settings {
  const settings: Settings = {
    tasks: path.resolve('records/position-panels/tasks.pilot.jsonl'),
    scores: path.resolve('records/private/position-panels/scores.pilot.jsonl'),
    sealed: path.resolve('records/private/position-panels/sealed-panels.pilot.jsonl'),
    manifest: path.resolve('records/position-panels/manifest.pilot.json'),
    calibrationManifest: '',
    policy: '',
    out: path.resolve('records/position-panels/frozen'),
    privateOut: path.resolve('records/private/position-panels/frozen'),
  };
  const targets: Record<
    string,
    keyof Pick<
      Settings,
      'tasks' | 'scores' | 'sealed' | 'manifest' | 'calibrationManifest' | 'policy' | 'out' | 'privateOut'
    >
  > = {
    '--tasks': 'tasks',
    '--scores': 'scores',
    '--sealed': 'sealed',
    '--manifest': 'manifest',
    '--calibration-manifest': 'calibrationManifest',
    '--policy': 'policy',
    '--out': 'out',
    '--private-out': 'privateOut',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] as string;
    const target = targets[flag];
    if (!target) throw new Error(`unknown flag ${flag}`);
    const value = argv[++index];
    if (!value) throw new Error(`${flag} requires a path`);
    settings[target] = path.resolve(value);
  }
  if (!settings.policy) throw new Error('--policy <frozen-policy.json> is required');
  if (!settings.calibrationManifest)
    throw new Error('--calibration-manifest <calibration-pilot-manifest.json> is required');
  if (overlappingPaths(settings.out, settings.privateOut))
    throw new Error('public and private output roots must not overlap');
  return settings;
}

interface InputSnapshot {
  bytes: Buffer;
  text: string;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

interface ImmutableArtifact {
  file: string;
  content: Buffer;
}

interface PreparedOutputRoot {
  path: string;
  realpath: string;
  device: number;
  inode: number;
  directoryMode: number;
  fileMode: number;
}

const inputSnapshots = new Map<string, InputSnapshot>();

function readInput(file: string): InputSnapshot {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY);
  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile()) throw new Error(`${file} must be a regular file`);
    const identity = `${before.dev}:${before.ino}`;
    const cached = inputSnapshots.get(identity);
    if (cached) {
      if (before.size !== cached.size || before.mtimeMs !== cached.mtimeMs || before.ctimeMs !== cached.ctimeMs)
        throw new Error(`${file} changed between aliased input paths`);
      return cached;
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      bytes.length !== after.size
    )
      throw new Error(`${file} changed while it was being read`);
    const text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error(`${file} is not valid UTF-8`);
    const snapshot = {
      bytes,
      text,
      size: after.size,
      mtimeMs: after.mtimeMs,
      ctimeMs: after.ctimeMs,
    };
    inputSnapshots.set(identity, snapshot);
    return snapshot;
  } finally {
    fs.closeSync(descriptor);
  }
}

function contentDigest(content: Buffer | string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

interface PhysicalDirectory {
  requestedPath: string;
  realpath: string;
  stat: fs.BigIntStats;
}

interface ReviewedRuntimeBinding {
  repository: PhysicalDirectory;
  bundledShowdown: PhysicalDirectory;
  actualShowdown: PhysicalDirectory;
  showdownRuntimeDigest: string;
}

function physicalDirectory(directory: string, label: string): PhysicalDirectory {
  const requestedPath = path.resolve(directory);
  const realpath = fs.realpathSync.native(requestedPath);
  const stat = fs.lstatSync(realpath, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} must resolve to a physical directory: ${directory}`);
  }
  return { requestedPath, realpath, stat };
}

function sameDirectoryIdentity(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.nlink === right.nlink && left.mode === right.mode;
}

function captureReviewedRuntimeBinding(authority: RuntimeProducerAuthoritySnapshot): ReviewedRuntimeBinding {
  const repository = physicalDirectory(REPO_ROOT, 'bundled repository root');
  const bundledShowdown = physicalDirectory(PINNED_PS_DIR, 'bundled reviewed Pokémon Showdown runtime');
  const actualShowdown = physicalDirectory(defaultPsDir(), 'VGC_LEAGUE_PS runtime');
  if (authority.rootRealpath !== repository.realpath) {
    throw new Error('producer authority root is not the exact physical bundled repository root');
  }
  if (authority.showdownRealpath !== bundledShowdown.realpath) {
    throw new Error('producer Showdown authority is not the exact physical bundled reviewed runtime');
  }
  if (actualShowdown.realpath !== bundledShowdown.realpath) {
    throw new Error('VGC_LEAGUE_PS must resolve to the exact physical bundled reviewed Pokémon Showdown runtime');
  }
  return {
    repository,
    bundledShowdown,
    actualShowdown,
    showdownRuntimeDigest: authority.showdownRuntimeDigest,
  };
}

function assertPhysicalDirectoryUnchanged(captured: PhysicalDirectory, label: string): void {
  const current = physicalDirectory(captured.requestedPath, label);
  if (current.realpath !== captured.realpath || !sameDirectoryIdentity(captured.stat, current.stat)) {
    throw new Error(`${label} physical identity changed during position-split derivation`);
  }
}

function assertReviewedRuntimeBinding(
  authority: RuntimeProducerAuthoritySnapshot,
  binding: ReviewedRuntimeBinding,
): void {
  authority.assertUnchanged();
  assertPhysicalDirectoryUnchanged(binding.repository, 'bundled repository root');
  assertPhysicalDirectoryUnchanged(binding.bundledShowdown, 'bundled reviewed Pokémon Showdown runtime');
  assertPhysicalDirectoryUnchanged(binding.actualShowdown, 'VGC_LEAGUE_PS runtime');
  const currentActual = physicalDirectory(defaultPsDir(), 'VGC_LEAGUE_PS runtime');
  if (
    currentActual.realpath !== binding.bundledShowdown.realpath ||
    authority.rootRealpath !== binding.repository.realpath ||
    authority.showdownRealpath !== binding.bundledShowdown.realpath ||
    authority.showdownRuntimeDigest !== binding.showdownRuntimeDigest
  ) {
    throw new Error('reviewed runtime path or digest binding changed during position-split derivation');
  }
}

function readCanonicalObject(input: InputSnapshot, file: string): JsonObject {
  const value: unknown = JSON.parse(input.text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${file} must contain one object`);
  if (input.text !== `${canonicalJson(value)}\n`)
    throw new Error(`${file} is not canonical JSON with one final newline`);
  return value as JsonObject;
}

function rows(input: InputSnapshot, file: string): JsonObject[] {
  const values = input.text
    .split('\n')
    .filter(Boolean)
    .map((line, index) => {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error(`${file} row ${index + 1} is invalid`);
      return value as JsonObject;
    });
  if (input.text !== canonicalJsonl(values)) throw new Error(`${file} is not canonical JSONL`);
  return values;
}

function exactKeys(value: JsonObject, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (canonicalJson(actual) !== canonicalJson(sortedExpected))
    throw new Error(`${label} has unexpected or missing keys`);
}

function nonemptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim())
    throw new Error(`${label} must be a trimmed nonempty string`);
  return value;
}

function validateFrozenPositionExclusions(values: readonly JsonObject[]): void {
  values.forEach((value, index) => {
    const label = `frozen exclusion row ${index + 1}`;
    exactKeys(value, FROZEN_POSITION_EXCLUSION_PROTOCOL.keys, label);
    if (value.schema_version !== FROZEN_POSITION_EXCLUSION_PROTOCOL.rowSchemaVersion)
      throw new Error(`${label} has an unexpected schema_version`);
    nonemptyString(value.task_id, `${label}.task_id`);
    if (!Array.isArray(value.reasons) || !value.reasons.length)
      throw new Error(`${label}.reasons must be a nonempty array`);
    value.reasons.forEach((reason, reasonIndex) => {
      nonemptyString(reason, `${label}.reasons[${reasonIndex}]`);
    });
  });
}

function policy(input: InputSnapshot, file: string): PositionSplitFreezePolicyV2 {
  return validatePositionSplitFreezePolicyV2(readCanonicalObject(input, file), 'split policy');
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function pathContainedBy(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function overlappingPaths(first: string, second: string): boolean {
  return pathContainedBy(first, second) || pathContainedBy(second, first);
}

/**
 * Existing ancestor aliases are canonicalized for platform paths such as macOS `/var`; the output root and every
 * directory created here must themselves be nonsymlinks. Public roots/files are pinned to 0755/0644 and private
 * roots/files to 0700/0600. Node has no dirfd-relative link API, so concurrent same-privilege ancestor replacement
 * remains outside this boundary.
 */
function secureOutputDirectory(directory: string, directoryMode: number, fileMode: number): PreparedOutputRoot {
  const requested = path.resolve(directory);
  let existing = requested;
  const missingComponents: string[] = [];
  let existingStat: fs.Stats;
  for (;;) {
    try {
      existingStat = fs.lstatSync(existing);
      break;
    } catch (error) {
      if (!missing(error)) throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw new Error(`output root has no existing filesystem ancestor: ${requested}`);
      missingComponents.unshift(path.basename(existing));
      existing = parent;
    }
  }
  if (!missingComponents.length && (existingStat.isSymbolicLink() || !existingStat.isDirectory()))
    throw new Error(`output root must be a non-symlink directory: ${requested}`);

  const canonicalParent = fs.realpathSync.native(existing);
  let current = canonicalParent;
  let parentStat = fs.statSync(canonicalParent);
  if (!parentStat.isDirectory())
    throw new Error(`nearest existing output parent must resolve to a directory: ${existing}`);
  for (const component of missingComponents) {
    const checkedParent = fs.lstatSync(current);
    if (
      checkedParent.isSymbolicLink() ||
      !checkedParent.isDirectory() ||
      checkedParent.dev !== parentStat.dev ||
      checkedParent.ino !== parentStat.ino
    )
      throw new Error(`physical output parent changed while creating the root: ${current}`);
    current = path.join(current, component);
    try {
      fs.mkdirSync(current, { mode: directoryMode });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const created = fs.lstatSync(current);
    if (created.isSymbolicLink()) throw new Error(`created output root component must not be a symlink: ${current}`);
    if (!created.isDirectory()) throw new Error(`created output root component must be a directory: ${current}`);
    fs.chmodSync(current, directoryMode);
    parentStat = fs.lstatSync(current);
  }

  fs.chmodSync(current, directoryMode);
  const beforeRealpath = fs.lstatSync(current);
  if (beforeRealpath.isSymbolicLink() || !beforeRealpath.isDirectory())
    throw new Error(`output root must remain a non-symlink directory: ${current}`);
  const realpath = fs.realpathSync.native(current);
  const afterRealpath = fs.lstatSync(current);
  if (
    afterRealpath.isSymbolicLink() ||
    !afterRealpath.isDirectory() ||
    afterRealpath.dev !== beforeRealpath.dev ||
    afterRealpath.ino !== beforeRealpath.ino
  )
    throw new Error(`output root changed while it was resolved: ${current}`);
  if ((afterRealpath.mode & 0o777) !== directoryMode)
    throw new Error(`output root has an unexpected mode after chmod: ${current}`);
  return {
    path: realpath,
    realpath,
    device: afterRealpath.dev,
    inode: afterRealpath.ino,
    directoryMode,
    fileMode,
  };
}
function assertOutputRoot(root: PreparedOutputRoot): void {
  const checked = secureOutputDirectory(root.path, root.directoryMode, root.fileMode);
  if (checked.realpath !== root.realpath || checked.device !== root.device || checked.inode !== root.inode)
    throw new Error(`output root changed during publication: ${root.path}`);
}

function prepareOutputRoots(publicRoot: string, privateRoot: string): [PreparedOutputRoot, PreparedOutputRoot] {
  const preparedPublic = secureOutputDirectory(publicRoot, 0o755, 0o644);
  const preparedPrivate = secureOutputDirectory(privateRoot, 0o700, 0o600);
  if (
    overlappingPaths(preparedPublic.realpath, preparedPrivate.realpath) ||
    (preparedPublic.device === preparedPrivate.device && preparedPublic.inode === preparedPrivate.inode)
  )
    throw new Error('public and private output roots must not overlap or alias through symlinks');
  return [preparedPublic, preparedPrivate];
}

function artifactRoot(file: string, roots: readonly PreparedOutputRoot[]): PreparedOutputRoot {
  const parent = path.dirname(file);
  const root = roots.find((candidate) => candidate.path === parent);
  if (!root) throw new Error(`artifact is outside its prepared output root: ${file}`);
  return root;
}

function readRegularArtifact(
  file: string,
  expectedIdentity: fs.Stats | undefined,
  expectedLinks: number,
  expectedMode: number,
): Buffer | undefined {
  let pathStat: fs.Stats;
  try {
    pathStat = fs.lstatSync(file);
  } catch (error) {
    if (missing(error) && expectedIdentity === undefined) return undefined;
    throw error;
  }
  if (pathStat.isSymbolicLink() || !pathStat.isFile())
    throw new Error(`immutable artifact must be a regular non-symlink file: ${file}`);
  if (expectedIdentity && (pathStat.dev !== expectedIdentity.dev || pathStat.ino !== expectedIdentity.ino))
    throw new Error(`immutable artifact identity changed: ${file}`);
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const beforeRead = fs.fstatSync(descriptor);
    if (
      !beforeRead.isFile() ||
      beforeRead.dev !== pathStat.dev ||
      beforeRead.ino !== pathStat.ino ||
      beforeRead.nlink !== expectedLinks ||
      (beforeRead.mode & 0o777) !== expectedMode
    )
      throw new Error(`immutable artifact changed or has an unexpected hard-link alias: ${file}`);
    const content = fs.readFileSync(descriptor);
    const afterRead = fs.fstatSync(descriptor);
    if (
      afterRead.dev !== beforeRead.dev ||
      afterRead.ino !== beforeRead.ino ||
      afterRead.size !== beforeRead.size ||
      afterRead.mtimeMs !== beforeRead.mtimeMs ||
      afterRead.ctimeMs !== beforeRead.ctimeMs ||
      content.length !== afterRead.size
    )
      throw new Error(`immutable artifact changed while it was read: ${file}`);
    const finalPathStat = fs.lstatSync(file);
    if (finalPathStat.dev !== afterRead.dev || finalPathStat.ino !== afterRead.ino)
      throw new Error(`immutable artifact path changed while it was read: ${file}`);
    return content;
  } finally {
    fs.closeSync(descriptor);
  }
}

function readExistingArtifact(file: string, expectedMode: number): Buffer | undefined {
  return readRegularArtifact(file, undefined, 1, expectedMode);
}

function syncOutputDirectory(root: PreparedOutputRoot): void {
  assertOutputRoot(root);
  const descriptor = fs.openSync(root.path, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(descriptor);
    if (stat.dev !== root.device || stat.ino !== root.inode)
      throw new Error(`output root changed before directory sync: ${root.path}`);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function stageArtifact(artifact: ImmutableArtifact, root: PreparedOutputRoot): { file: string; stat: fs.Stats } {
  assertOutputRoot(root);
  for (;;) {
    const temporary = path.join(
      root.path,
      `.${path.basename(artifact.file)}.${process.pid}.${crypto.randomUUID()}.tmp`,
    );
    let descriptor: number;
    try {
      descriptor = fs.openSync(
        temporary,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
        root.fileMode,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }
    let open = true;
    try {
      fs.fchmodSync(descriptor, root.fileMode);
      fs.writeFileSync(descriptor, artifact.content);
      fs.fsyncSync(descriptor);
      const stat = fs.fstatSync(descriptor);
      fs.closeSync(descriptor);
      open = false;
      return { file: temporary, stat };
    } catch (error) {
      if (open) {
        try {
          fs.closeSync(descriptor);
        } catch {}
      }
      try {
        fs.unlinkSync(temporary);
      } catch {}
      throw error;
    }
  }
}

function assertNoUnexpectedOutputEntries(
  artifacts: readonly ImmutableArtifact[],
  roots: readonly PreparedOutputRoot[],
): void {
  for (const root of roots) {
    assertOutputRoot(root);
    const expected = new Set(
      artifacts
        .filter((artifact) => path.dirname(artifact.file) === root.path)
        .map((artifact) => path.basename(artifact.file)),
    );
    for (const entry of fs.readdirSync(root.path)) {
      if (!expected.has(entry))
        throw new Error(`output root contains an unexpected entry: ${path.join(root.path, entry)}`);
    }
  }
}

function publishImmutableArtifacts(
  artifacts: readonly ImmutableArtifact[],
  roots: readonly PreparedOutputRoot[],
): void {
  const completionArtifact = artifacts.at(-1);
  if (!completionArtifact) throw new Error('immutable artifact set must include a completion manifest');
  assertNoUnexpectedOutputEntries(artifacts, roots);
  const existingFiles = new Set<string>();
  for (const artifact of artifacts) {
    const root = artifactRoot(artifact.file, roots);
    assertOutputRoot(root);
    const existing = readExistingArtifact(artifact.file, root.fileMode);
    if (existing) {
      if (!existing.equals(artifact.content))
        throw new Error(`refusing to overwrite immutable artifact ${artifact.file}`);
      existingFiles.add(artifact.file);
    }
  }
  if (existingFiles.size === artifacts.length) return;
  if (existingFiles.has(completionArtifact.file))
    throw new Error('completion manifest exists for an incomplete immutable artifact set');
  const missingArtifacts = artifacts.filter((artifact) => !existingFiles.has(artifact.file));

  const staged: Array<{
    artifact: ImmutableArtifact;
    root: PreparedOutputRoot;
    file: string;
    stat: fs.Stats;
  }> = [];
  const createdFinalLinks: typeof staged = [];
  let publicationError: unknown;
  try {
    for (const artifact of missingArtifacts) {
      const root = artifactRoot(artifact.file, roots);
      staged.push({ artifact, root, ...stageArtifact(artifact, root) });
    }
    for (const entry of staged) {
      assertOutputRoot(entry.root);
      const stagedContent = readRegularArtifact(entry.file, entry.stat, 1, entry.root.fileMode);
      if (!stagedContent?.equals(entry.artifact.content))
        throw new Error(`staged immutable artifact content changed before publication: ${entry.file}`);
      let published = false;
      try {
        fs.linkSync(entry.file, entry.artifact.file);
        createdFinalLinks.push(entry);
        published = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const existing = readExistingArtifact(entry.artifact.file, entry.root.fileMode);
        if (!existing?.equals(entry.artifact.content))
          throw new Error(`refusing to overwrite immutable artifact ${entry.artifact.file}`);
      }
      if (published) {
        const linked = readRegularArtifact(entry.artifact.file, entry.stat, 2, entry.root.fileMode);
        if (!linked?.equals(entry.artifact.content))
          throw new Error(`published immutable artifact does not match staged content: ${entry.artifact.file}`);
        syncOutputDirectory(entry.root);
      }
    }
  } catch (error) {
    publicationError = error;
  }

  let cleanupError: unknown;
  for (const entry of staged) {
    try {
      fs.unlinkSync(entry.file);
    } catch (error) {
      if (!missing(error) && cleanupError === undefined) cleanupError = error;
    }
  }
  for (const root of roots) {
    try {
      syncOutputDirectory(root);
    } catch (error) {
      if (cleanupError === undefined) cleanupError = error;
    }
  }
  let rollbackError: unknown;
  if (publicationError !== undefined || cleanupError !== undefined) {
    for (const entry of [...createdFinalLinks].reverse()) {
      try {
        const stat = fs.lstatSync(entry.artifact.file);
        if (stat.isSymbolicLink() || !stat.isFile() || stat.dev !== entry.stat.dev || stat.ino !== entry.stat.ino)
          throw new Error(`refusing to remove a changed publication target: ${entry.artifact.file}`);
        fs.unlinkSync(entry.artifact.file);
      } catch (error) {
        if (!missing(error) && rollbackError === undefined) rollbackError = error;
      }
    }
    for (const root of roots) {
      try {
        syncOutputDirectory(root);
      } catch (error) {
        if (rollbackError === undefined) rollbackError = error;
      }
    }
  }
  if (rollbackError !== undefined) throw rollbackError;
  if (publicationError !== undefined) throw publicationError;
  if (cleanupError !== undefined) throw cleanupError;
  for (const artifact of artifacts) {
    const root = artifactRoot(artifact.file, roots);
    const existing = readExistingArtifact(artifact.file, root.fileMode);
    if (!existing?.equals(artifact.content))
      throw new Error(`published immutable artifact set failed final verification: ${artifact.file}`);
  }
}

const settings = parse(process.argv.slice(2));
const taskInput = readInput(settings.tasks);
const scoreInput = readInput(settings.scores);
const sealedInput = readInput(settings.sealed);
const candidateManifestInput = readInput(settings.manifest);
const calibrationManifestInput = readInput(settings.calibrationManifest);
const policyInput = readInput(settings.policy);

const splitPolicy = policy(policyInput, settings.policy);
const candidateManifestDigest = contentDigest(candidateManifestInput.bytes);
const calibrationManifestDigest = contentDigest(calibrationManifestInput.bytes);
if (splitPolicy.calibration_manifest_sha256 !== calibrationManifestDigest)
  throw new Error('split policy calibration_manifest_sha256 does not match --calibration-manifest');
if (calibrationManifestDigest === candidateManifestDigest)
  throw new Error('calibration and candidate pilot manifests must be distinct');

const pilot = validatePilotManifestV2(
  readCanonicalObject(candidateManifestInput, settings.manifest),
  'candidate pilot manifest',
);
const calibration = validatePilotManifestV2(
  readCanonicalObject(calibrationManifestInput, settings.calibrationManifest),
  'calibration pilot manifest',
);
if (pilot.outputs.tasks.rows === 0 || calibration.outputs.tasks.rows === 0)
  throw new Error('split readiness requires nonempty candidate and calibration pilot manifests');
for (const [label, manifest] of [
  ['candidate pilot manifest', pilot],
  ['calibration pilot manifest', calibration],
] as const) {
  if (path.basename(manifest.outputs.tasks.file) !== manifest.outputs.tasks.file)
    throw new Error(`${label}.outputs.tasks.file must be a basename`);
}
if (calibration.sourceSetId === pilot.sourceSetId)
  throw new Error('calibration and candidate pilot manifests must have distinct source_set_id values');
if (
  calibration.inputDigests.publicSet === pilot.inputDigests.publicSet &&
  calibration.inputDigests.privateSet === pilot.inputDigests.privateSet
)
  throw new Error('calibration and candidate pilot manifests must have non-identical whole input digest tuples');
for (const [key, candidate, calibrationValue] of [
  ['counterfactual', pilot.counterfactualProtocol, calibration.counterfactualProtocol],
  ['evaluator_digest', pilot.evaluatorDigest, calibration.evaluatorDigest],
  ['runtime', pilot.runtime, calibration.runtime],
  ['showdown_commit', pilot.showdownCommit, calibration.showdownCommit],
] as const) {
  if (canonicalJson(calibrationValue) !== canonicalJson(candidate))
    throw new Error(`calibration and candidate pilot manifests must use the same ${key}`);
}
const calibrationTaskIds = new Set(calibration.orderedTaskIds);
const overlappingCalibrationIds = pilot.orderedTaskIds.filter((id) => calibrationTaskIds.has(id));
if (overlappingCalibrationIds.length)
  throw new Error('calibration and candidate pilot manifests must not contain overlapping ordered_task_ids');

const producerAuthority = captureRuntimeProducerAuthority(import.meta.url);
const reviewedRuntime = captureReviewedRuntimeBinding(producerAuthority);
assertReviewedRuntimeBinding(producerAuthority, reviewedRuntime);
const taskRows = rows(taskInput, settings.tasks);
const scoreRows = rows(scoreInput, settings.scores);
const sealedRows = rows(sealedInput, settings.sealed);
validatePositionPanelArtifacts(taskRows, scoreRows, sealedRows, reviewedRuntime.actualShowdown.realpath);
if (
  pilot.outputs.tasks.sha256 !== contentDigest(taskInput.bytes) ||
  pilot.outputs.scores.sha256 !== contentDigest(scoreInput.bytes) ||
  pilot.outputs.sealedPanels.sha256 !== contentDigest(sealedInput.bytes)
)
  throw new Error('candidate pilot manifest does not bind the supplied task, score, and sealed file hashes');
if (
  pilot.outputs.tasks.rows !== taskRows.length ||
  pilot.outputs.scores.rows !== scoreRows.length ||
  pilot.outputs.sealedPanels.rows !== sealedRows.length
)
  throw new Error('candidate pilot manifest does not bind the supplied task, score, and sealed row counts');
const taskRowIds = taskRows.map((row) => String(row.task_id));
const scoreRowIds = scoreRows.map((row) => String(row.task_id));
const sealedRowIds = sealedRows.map((row) => String(row.task_id));
for (const [label, ids] of [
  ['task', taskRowIds],
  ['score', scoreRowIds],
  ['sealed', sealedRowIds],
] as const) {
  if (canonicalJson(ids) !== canonicalJson(pilot.orderedTaskIds))
    throw new Error(`candidate pilot manifest ordered_task_ids do not match ${label} row order`);
}
const tasksById = new Map(taskRows.map((row) => [String(row.task_id), row]));
const scoresById = new Map(scoreRows.map((row) => [String(row.task_id), row]));
const sealedById = new Map(sealedRows.map((row) => [String(row.task_id), row]));
const exclusions: JsonObject[] = [];
const eligibleIds: string[] = [];
for (const task of taskRows) {
  const id = String(task.task_id);
  const score = scoresById.get(id) as JsonObject;
  const assessment = assessPositionEligibility(
    score.eligibility_metrics as unknown as PositionEligibilityMetrics,
    splitPolicy.eligibility,
  );
  const structural = (score.structural_reasons as unknown[]).map(String);
  const reasons = [...structural, ...assessment.reasons];
  if (reasons.length) exclusions.push({ schema_version: 2, task_id: id, reasons });
  else eligibleIds.push(id);
}
validateFrozenPositionExclusions(exclusions);
if (eligibleIds.length < 2) throw new Error('fewer than two positions pass the frozen eligibility policy');
const unscorable = eligibleIds.filter((id) => (scoresById.get(id) as JsonObject).measurement_ready !== true);
if (unscorable.length)
  throw new Error(
    `frozen qualification admitted ${unscorable.length} positions with unusable measurement panels; regenerate the complete candidate artifact instead of selecting them away`,
  );
const duplicate = clusterNearDuplicatePositions(
  eligibleIds.map((id) => ({ id, prompt: String((tasksById.get(id) as JsonObject).prompt) })),
  splitPolicy.near_duplicate_threshold,
);
const assignments = assignStratifiedPositionSplits(
  eligibleIds.map((id) => ({
    taskId: id,
    sourceGroup: String((sealedById.get(id) as JsonObject).source_group),
    duplicateCluster: duplicate.clusters.get(id) as string,
    stratum: String((sealedById.get(id) as JsonObject).selection_stratum),
  })),
  splitPolicy.seed,
  splitPolicy.eval_fraction,
);
const balance = splitBalance(assignments, splitPolicy.eval_fraction);
if (
  balance.evalFractionDeviation > splitPolicy.max_eval_fraction_deviation ||
  balance.maxStratumDeviation > splitPolicy.max_stratum_eval_fraction_deviation
)
  throw new Error('connected leakage components cannot satisfy the frozen split balance tolerances');
const splitById = new Map(assignments.map((entry) => [entry.taskId, entry.split]));
if (!assignments.some((entry) => entry.split === 'train') || !assignments.some((entry) => entry.split === 'eval'))
  throw new Error(
    'frozen assignment produced an empty train or eval split; review the policy seed or corpus components',
  );
const orderedIds = assignments.map((entry) => entry.taskId);
const selectedTasks = orderedIds.map((id) => ({
  ...(tasksById.get(id) as JsonObject),
  split: splitById.get(id) as string,
}));
const selectedScores = orderedIds.map((id) => ({
  ...(scoresById.get(id) as JsonObject),
  eligibility_status: 'eligible-under-frozen-policy',
}));
const selectedSealed = orderedIds.map((id) => sealedById.get(id) as JsonObject);
validatePositionPanelArtifacts(selectedTasks, selectedScores, selectedSealed, reviewedRuntime.actualShowdown.realpath);
const roots = prepareOutputRoots(settings.out, settings.privateOut);
const [publicRoot, privateRoot] = roots;
const publicFiles = {
  train: path.join(publicRoot.path, 'tasks.train.jsonl'),
  eval: path.join(publicRoot.path, 'tasks.eval.jsonl'),
  manifest: path.join(publicRoot.path, 'manifest.json'),
};
const privateFiles = {
  trainScores: path.join(privateRoot.path, 'scores.train.jsonl'),
  evalScores: path.join(privateRoot.path, 'scores.eval.jsonl'),
  trainSealed: path.join(privateRoot.path, 'sealed-panels.train.jsonl'),
  evalSealed: path.join(privateRoot.path, 'sealed-panels.eval.jsonl'),
  assignments: path.join(privateRoot.path, 'split-assignments.jsonl'),
  duplicatePairs: path.join(privateRoot.path, 'near-duplicate-pairs.jsonl'),
  exclusions: path.join(privateRoot.path, 'exclusions.jsonl'),
};
const forSplit = (values: JsonObject[], split: 'train' | 'eval') =>
  values.filter((row) => splitById.get(String(row.task_id)) === split);
const outputRows = {
  tasksTrain: forSplit(selectedTasks, 'train'),
  tasksEval: forSplit(selectedTasks, 'eval'),
  scoresTrain: forSplit(selectedScores, 'train'),
  scoresEval: forSplit(selectedScores, 'eval'),
  sealedTrain: forSplit(selectedSealed, 'train'),
  sealedEval: forSplit(selectedSealed, 'eval'),
  assignments,
  duplicatePairs: duplicate.pairs,
  exclusions,
};
const outputContent = {
  tasksTrain: Buffer.from(canonicalJsonl(outputRows.tasksTrain), 'utf8'),
  tasksEval: Buffer.from(canonicalJsonl(outputRows.tasksEval), 'utf8'),
  scoresTrain: Buffer.from(canonicalJsonl(outputRows.scoresTrain), 'utf8'),
  scoresEval: Buffer.from(canonicalJsonl(outputRows.scoresEval), 'utf8'),
  sealedTrain: Buffer.from(canonicalJsonl(outputRows.sealedTrain), 'utf8'),
  sealedEval: Buffer.from(canonicalJsonl(outputRows.sealedEval), 'utf8'),
  assignments: Buffer.from(canonicalJsonl(outputRows.assignments), 'utf8'),
  duplicatePairs: Buffer.from(canonicalJsonl(outputRows.duplicatePairs), 'utf8'),
  exclusions: Buffer.from(canonicalJsonl(outputRows.exclusions), 'utf8'),
};
const artifact = (content: Buffer, rowCount: number) => ({ sha256: contentDigest(content), rows: rowCount });
/**
 * The legacy v2 splitter_digest field records the complete producer-authority snapshot captured before panel
 * validation and rechecked immediately before publication. The retained snapshot detects mutations only after this
 * capture; it does not attest process-start state or prove that already-loaded module memory equals the captured disk
 * bytes.
 */
const manifest = {
  schema_version: 2,
  release_ready: false,
  status: FROZEN_POSITION_MANIFEST_STATUS,
  remaining_release_gates: FROZEN_POSITION_RELEASE_GATES,
  policy: splitPolicy,
  splitter_digest: producerAuthority.producerDigest,
  runtime: { node: process.version, platform: process.platform, arch: process.arch },
  upstream_pilot_manifest: pilotManifestUpstreamProjectionV2(pilot, candidateManifestDigest),
  upstream_calibration_manifest: pilotManifestUpstreamProjectionV2(calibration, calibrationManifestDigest),
  calibration_candidate_separation: FROZEN_CALIBRATION_CANDIDATE_SEPARATION,
  policy_canonical_digest: canonicalJsonDigest(splitPolicy),
  canonical_json: CANONICAL_JSON_PROTOCOL,
  near_duplicate_protocol: NEAR_DUPLICATE_PROTOCOL,
  exclusion_row_protocol: FROZEN_POSITION_EXCLUSION_PROTOCOL,
  split_digest: positionSplitDigest(assignments),
  split_balance: balance,
  inputs: {
    tasks: contentDigest(taskInput.bytes),
    scores: contentDigest(scoreInput.bytes),
    sealed: contentDigest(sealedInput.bytes),
    pilot_manifest: candidateManifestDigest,
    calibration_manifest: calibrationManifestDigest,
    policy_file: contentDigest(policyInput.bytes),
  },
  counts: {
    input: taskRows.length,
    eligible: eligibleIds.length,
    excluded: exclusions.length,
    train: assignments.filter((entry) => entry.split === 'train').length,
    eval: assignments.filter((entry) => entry.split === 'eval').length,
    source_groups: new Set(assignments.map((entry) => entry.sourceGroup)).size,
    duplicate_clusters: new Set(assignments.map((entry) => entry.duplicateCluster)).size,
    near_duplicate_pairs: duplicate.pairs.length,
  },
  outputs: {
    tasks_train: artifact(outputContent.tasksTrain, outputRows.tasksTrain.length),
    tasks_eval: artifact(outputContent.tasksEval, outputRows.tasksEval.length),
    scores_train: artifact(outputContent.scoresTrain, outputRows.scoresTrain.length),
    scores_eval: artifact(outputContent.scoresEval, outputRows.scoresEval.length),
    sealed_train: artifact(outputContent.sealedTrain, outputRows.sealedTrain.length),
    sealed_eval: artifact(outputContent.sealedEval, outputRows.sealedEval.length),
    assignments: artifact(outputContent.assignments, outputRows.assignments.length),
    near_duplicate_pairs: artifact(outputContent.duplicatePairs, outputRows.duplicatePairs.length),
    exclusions: artifact(outputContent.exclusions, outputRows.exclusions.length),
  },
  ordered_train_task_ids: assignments.filter((entry) => entry.split === 'train').map((entry) => entry.taskId),
  ordered_eval_task_ids: assignments.filter((entry) => entry.split === 'eval').map((entry) => entry.taskId),
};
validateFrozenManifestV2(manifest, 'constructed frozen manifest');
const manifestContent = Buffer.from(`${canonicalJson(manifest)}\n`, 'utf8');
assertReviewedRuntimeBinding(producerAuthority, reviewedRuntime);
publishImmutableArtifacts(
  [
    { file: publicFiles.train, content: outputContent.tasksTrain },
    { file: publicFiles.eval, content: outputContent.tasksEval },
    { file: privateFiles.trainScores, content: outputContent.scoresTrain },
    { file: privateFiles.evalScores, content: outputContent.scoresEval },
    { file: privateFiles.trainSealed, content: outputContent.sealedTrain },
    { file: privateFiles.evalSealed, content: outputContent.sealedEval },
    { file: privateFiles.assignments, content: outputContent.assignments },
    { file: privateFiles.duplicatePairs, content: outputContent.duplicatePairs },
    { file: privateFiles.exclusions, content: outputContent.exclusions },
    { file: publicFiles.manifest, content: manifestContent },
  ],
  roots,
);
