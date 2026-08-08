import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { FROZEN_BATTLE_REFEREE_PROTOCOL_VERSION } from '../frozen-battle-referee.js';
import { FROZEN_MATCHDAY_JSONL_PROTOCOL_VERSION } from '../frozen-matchday-protocol.js';
import {
  FROZEN_MATCHDAY_REFEREE_PROTOCOL_VERSION,
  FrozenMatchdayReferee,
  type FrozenMatchdayRefereeOptions,
} from '../frozen-matchday-referee.js';
import { defaultPsDir, PINNED_PS_DIR, REPO_ROOT } from '../paths.js';
import { SHOWDOWN_LOCK } from '../showdown.js';
import type { JsonObject } from '../types.js';
import {
  captureRuntimeProducerAuthority,
  PRODUCER_DIGEST_PROTOCOL,
  type RuntimeProducerAuthoritySnapshot,
} from './producer.js';
import { CANONICAL_JSON_PROTOCOL, canonicalJson, canonicalJsonDigest, canonicalJsonl } from './serialization.js';

export const FROZEN_MATCHDAY_TASK_SOURCE_INPUT_SCHEMA_VERSION = 1 as const;
export const FROZEN_MATCHDAY_TASK_SOURCE_MANIFEST_SCHEMA_VERSION = 1 as const;
export const FROZEN_MATCHDAY_CONDITION_DIGEST_PROTOCOL = 'vgc-frozen-matchday-condition-v1' as const;
export const FROZEN_MATCHDAY_TASK_SOURCE_STATUS = 'private-frozen-task-source-not-release-approved' as const;
export const FROZEN_REFEREE_REQUEST_LINE_BYTES = 32 * 1024 * 1024;
export const FROZEN_MATCHDAY_EPISODE_ID_PLACEHOLDER = '0'.repeat(32);
export const FROZEN_MATCHDAY_TASK_SOURCE_PUBLICATION_PRECONDITION =
  'trusted-single-producer-repository-build-runtime-tree-immutable-from-process-start-through-publication' as const;
export const FROZEN_MATCHDAY_TASK_SOURCE_RUNTIME_BYTE_PORTABILITY =
  'repository-supported-posix-lf-build-required-raw-authority-bytes-not-normalized' as const;
export const FROZEN_MATCHDAY_TASK_SOURCE_LOADED_JS_MODULE_BYTE_ATTESTATION =
  'loaded-js-module-bytes-not-independently-attested' as const;
export const FROZEN_MATCHDAY_TASK_SOURCE_AUTHORITY_SNAPSHOT_SCOPE =
  'authority-snapshot-detects-mutations-only-after-capture' as const;
export const FROZEN_MATCHDAY_TASK_SOURCE_FILES = ['manifest.json', 'task-source.jsonl'] as const;

const INPUT_MODE = 0o600;
const OUTPUT_DIRECTORY_MODE = 0o700;
const OUTPUT_FILE_MODE = 0o600;
const MAX_INPUT_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 10_000;
const MAX_ID_CHARACTERS = 128;
const MAX_PROVENANCE_CHARACTERS = 4_096;
const MAX_CONSTRUCTION_PROVENANCE_BYTES = FROZEN_REFEREE_REQUEST_LINE_BYTES;
const MAX_SEAT_NAME_CHARACTERS = 256;
const MAX_CONDITION_BYTES = 256 * 1024;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

interface InputSnapshot {
  requestedPath: string;
  realpath: string;
  bytes: Buffer;
  text: string;
  stat: fs.Stats;
}

interface FrozenCondition {
  conditionId: string;
  definition: unknown;
  digest: string;
}

interface ValidatedCase {
  caseId: string;
  conditionId: string;
  conditionDigest: string;
  expectedConfigDigest: string;
  provenanceDigest: string;
  options: FrozenMatchdayRefereeOptions;
  constructionTasks: Array<{ pid: 'p1' | 'p2'; task_id: string; provenance_digest: string }>;
  showdownRevision: string;
  format: string;
}

export interface FrozenMatchdayTaskSourceFreezeResult {
  outputRoot: string;
  taskSourceSha256: string;
  manifestSha256: string;
  rows: number;
  identicalRerun: boolean;
  publicationPrecondition: typeof FROZEN_MATCHDAY_TASK_SOURCE_PUBLICATION_PRECONDITION;
  runtimeBytePortability: typeof FROZEN_MATCHDAY_TASK_SOURCE_RUNTIME_BYTE_PORTABILITY;
  loadedJsModuleByteAttestation: typeof FROZEN_MATCHDAY_TASK_SOURCE_LOADED_JS_MODULE_BYTE_ATTESTATION;
  authoritySnapshotScope: typeof FROZEN_MATCHDAY_TASK_SOURCE_AUTHORITY_SNAPSHOT_SCOPE;
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

function physicalDirectory(file: string, label: string): PhysicalDirectory {
  const requestedPath = path.resolve(file);
  const realpath = fs.realpathSync.native(requestedPath);
  const stat = fs.lstatSync(realpath, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} must resolve to a physical directory: ${file}`);
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
    throw new Error(`${label} physical identity changed during task-source derivation`);
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
    throw new Error('reviewed runtime path or digest binding changed during task-source derivation');
  }
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function sha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

function object(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as JsonObject;
}

function exactKeys(value: JsonObject, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has unexpected or missing keys`);
  }
}

function boundedString(value: unknown, maximum: number, label: string): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value !== value.trim() ||
    value.length > maximum ||
    value.includes('\u0000')
  ) {
    throw new Error(`${label} must be a bounded trimmed nonempty string`);
  }
  return value;
}

function slug(value: unknown, label: string): string {
  const result = boundedString(value, MAX_ID_CHARACTERS, label);
  if (!SLUG.test(result)) throw new Error(`${label} must be a lowercase slug`);
  return result;
}

function assertUnicodeScalarString(value: string, label: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const following = value.charCodeAt(index + 1);
      if (following < 0xdc00 || following > 0xdfff) {
        throw new Error(`${label} contains an unpaired UTF-16 surrogate`);
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new Error(`${label} contains an unpaired UTF-16 surrogate`);
    }
  }
}

function assertPythonCompactJsonValue(value: unknown, label: string): void {
  if (typeof value === 'string') {
    assertUnicodeScalarString(value, label);
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new Error(`${label} contains a number without invariant compact Python/ECMAScript JSON bytes`);
    }
    return;
  }
  if (value === null || typeof value === 'boolean') return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      assertPythonCompactJsonValue(entry, `${label}[${index}]`);
    });
    return;
  }
  const item = object(value, label);
  for (const [key, entry] of Object.entries(item)) {
    assertUnicodeScalarString(key, `${label} key`);
    assertPythonCompactJsonValue(entry, `${label}.${key}`);
  }
}

export interface FrozenMatchdayTaskSourceRowForStart {
  condition_digest: unknown;
  showdown_revision: unknown;
  options: unknown;
}

/** Builds the id-one Python-client start request bytes, including its LF transport terminator. */
export function frozenMatchdayStartRequestLine(
  row: Record<string, unknown>,
  episodeId = FROZEN_MATCHDAY_EPISODE_ID_PLACEHOLDER,
): Buffer {
  const conditionDigest = row.condition_digest;
  const showdownRevision = row.showdown_revision;
  if (typeof conditionDigest !== 'string' || !/^[0-9a-f]{64}$/u.test(conditionDigest)) {
    throw new Error('emitted condition_digest must be a lowercase SHA-256 digest');
  }
  if (typeof showdownRevision !== 'string' || !/^[0-9a-f]{40}$/u.test(showdownRevision)) {
    throw new Error('emitted showdown_revision must be a lowercase full commit SHA');
  }
  if (typeof episodeId !== 'string' || Buffer.byteLength(episodeId, 'utf8') !== 32) {
    throw new Error('start request episode placeholder must encode to exactly 32 bytes');
  }
  assertUnicodeScalarString(episodeId, 'start request episode placeholder');
  assertPythonCompactJsonValue(row.options, 'emitted options');
  const options = canonicalJson(row.options);
  const encoded = Buffer.from(
    `{"protocolVersion":${FROZEN_MATCHDAY_JSONL_PROTOCOL_VERSION},"id":1,"method":"start","params":{"episodeId":${JSON.stringify(episodeId)},"conditionDigest":${JSON.stringify(conditionDigest)},"showdownRevision":${JSON.stringify(showdownRevision)},"options":${options}}}`,
    'utf8',
  );
  if (encoded.length > FROZEN_REFEREE_REQUEST_LINE_BYTES) {
    throw new Error(
      `emitted start request line exceeds ${FROZEN_REFEREE_REQUEST_LINE_BYTES} encoded bytes (${encoded.length})`,
    );
  }
  return Buffer.concat([encoded, Buffer.from('\n')]);
}

function pathContainedBy(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function assertPrivateRegularFile(file: string, stat: fs.Stats, label: string): void {
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} must be a regular non-symlink file: ${file}`);
  if (stat.nlink !== 1 || (stat.mode & 0o7777) !== INPUT_MODE) {
    throw new Error(`${label} must have mode 0600 and no hard-link aliases: ${file}`);
  }
}

function readPrivateInput(file: string): InputSnapshot {
  const requestedPath = path.resolve(file);
  const pathStat = fs.lstatSync(requestedPath);
  assertPrivateRegularFile(requestedPath, pathStat, 'private input');
  const descriptor = fs.openSync(
    requestedPath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const before = fs.fstatSync(descriptor);
    assertPrivateRegularFile(requestedPath, before, 'private input');
    if (before.dev !== pathStat.dev || before.ino !== pathStat.ino) {
      throw new Error(`private input identity changed before it was read: ${requestedPath}`);
    }
    if (before.size > MAX_INPUT_BYTES) throw new Error(`private input exceeds ${MAX_INPUT_BYTES} bytes`);
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    const finalPathStat = fs.lstatSync(requestedPath);
    assertPrivateRegularFile(requestedPath, finalPathStat, 'private input');
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      finalPathStat.dev !== after.dev ||
      finalPathStat.ino !== after.ino ||
      finalPathStat.size !== after.size ||
      finalPathStat.mtimeMs !== after.mtimeMs ||
      finalPathStat.ctimeMs !== after.ctimeMs ||
      bytes.length !== after.size
    ) {
      throw new Error(`private input changed while it was being read: ${requestedPath}`);
    }
    const text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error(`private input is not valid UTF-8: ${requestedPath}`);
    const realpath = fs.realpathSync.native(requestedPath);
    const resolvedStat = fs.statSync(realpath);
    if (resolvedStat.dev !== after.dev || resolvedStat.ino !== after.ino) {
      throw new Error(`private input changed while its identity was resolved: ${requestedPath}`);
    }
    return { requestedPath, realpath, bytes, text, stat: after };
  } finally {
    fs.closeSync(descriptor);
  }
}

function parseCanonicalInput(input: InputSnapshot): JsonObject {
  let value: unknown;
  try {
    value = JSON.parse(input.text);
  } catch (error) {
    throw new Error(`private input must contain valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const result = object(value, 'private input');
  if (input.text !== `${canonicalJson(result)}\n`) {
    throw new Error('private input must contain one canonical JSON object with one final LF');
  }
  return result;
}

function conditionDigest(conditionId: string, definition: unknown): string {
  return canonicalJsonDigest({
    protocol: FROZEN_MATCHDAY_CONDITION_DIGEST_PROTOCOL,
    condition: { condition_id: conditionId, definition },
  });
}

function validateConditions(value: unknown): { ordered: FrozenCondition[]; byId: Map<string, FrozenCondition> } {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ENTRIES) {
    throw new Error(`conditions must contain between 1 and ${MAX_ENTRIES} entries`);
  }
  const byId = new Map<string, FrozenCondition>();
  const semanticDefinitions = new Set<string>();
  const ordered = value.map((entry, index) => {
    const label = `conditions[${index}]`;
    const item = object(entry, label);
    exactKeys(item, ['condition_id', 'definition'], label);
    const conditionId = slug(item.condition_id, `${label}.condition_id`);
    if (byId.has(conditionId)) throw new Error(`duplicate condition_id ${JSON.stringify(conditionId)}`);
    const definition = structuredClone(item.definition);
    const semantic = canonicalJson(definition);
    if (Buffer.byteLength(semantic, 'utf8') > MAX_CONDITION_BYTES) {
      throw new Error(`${label}.definition exceeds ${MAX_CONDITION_BYTES} canonical bytes`);
    }
    if (semanticDefinitions.has(semantic))
      throw new Error(`${label}.definition semantically duplicates another condition`);
    semanticDefinitions.add(semantic);
    const condition = { conditionId, definition, digest: conditionDigest(conditionId, definition) };
    byId.set(conditionId, condition);
    return condition;
  });
  return { ordered, byId };
}

function validateOptionsStructure(value: unknown, label: string): FrozenMatchdayRefereeOptions {
  const options = object(value, label);
  exactKeys(options, ['format', 'gameSeeds', 'seats'], label);
  if (typeof options.format !== 'string') throw new Error(`${label}.format must be a string`);
  if (!Array.isArray(options.gameSeeds)) throw new Error(`${label}.gameSeeds must be an array`);
  if (!Array.isArray(options.seats) || options.seats.length !== 2) {
    throw new Error(`${label}.seats must contain p1 then p2`);
  }
  for (const [index, expectedPid] of (['p1', 'p2'] as const).entries()) {
    const seatLabel = `${label}.seats[${index}]`;
    const seat = object(options.seats[index], seatLabel);
    exactKeys(seat, ['construction', 'name', 'pid'], seatLabel);
    if (seat.pid !== expectedPid) throw new Error(`${label}.seats must contain p1 then p2`);
    boundedString(seat.name, MAX_SEAT_NAME_CHARACTERS, `${seatLabel}.name`);
    const construction = object(seat.construction, `${seatLabel}.construction`);
    exactKeys(construction, ['artifact', 'packed', 'status'], `${seatLabel}.construction`);
    if (construction.status !== 'accepted') throw new Error(`${seatLabel}.construction must be accepted`);
    if (typeof construction.packed !== 'string') throw new Error(`${seatLabel}.construction.packed must be a string`);
    object(construction.artifact, `${seatLabel}.construction.artifact`);
  }
  return structuredClone(options) as unknown as FrozenMatchdayRefereeOptions;
}

function plainJsonObject(value: unknown, label: string): JsonObject {
  const result = object(value, label);
  const prototype = Object.getPrototypeOf(result);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} must be a plain JSON object`);
  canonicalJson(result);
  return result;
}

function validatedOptionsProjection(options: FrozenMatchdayRefereeOptions): {
  options: FrozenMatchdayRefereeOptions;
  constructionTasks: Array<{ pid: 'p1' | 'p2'; task_id: string; provenance_digest: string }>;
} {
  const constructionTasks: Array<{ pid: 'p1' | 'p2'; task_id: string; provenance_digest: string }> = [];
  const seats = (['p1', 'p2'] as const).map((pid, index) => {
    const seat = options.seats[index];
    if (!seat || seat.pid !== pid || seat.construction.status !== 'accepted') {
      throw new Error(`validated snapshot is missing the ${pid} strict construction`);
    }
    const construction = object(seat.construction, `validated ${pid} construction`);
    exactKeys(construction, ['artifact', 'packed', 'status'], `validated ${pid} construction`);
    const artifact = object(construction.artifact, `validated ${pid} construction.artifact`);
    const task = object(artifact.task, `validated ${pid} construction.artifact.task`);
    const taskId = boundedString(task.id, MAX_ID_CHARACTERS, `validated ${pid} construction task id`);
    const provenance = plainJsonObject(task.provenance, `validated ${pid} construction task provenance`);
    const provenanceBytes = Buffer.byteLength(canonicalJson(provenance), 'utf8');
    if (provenanceBytes > MAX_CONSTRUCTION_PROVENANCE_BYTES) {
      throw new Error(
        `validated ${pid} construction task provenance exceeds ${MAX_CONSTRUCTION_PROVENANCE_BYTES} canonical bytes`,
      );
    }
    constructionTasks.push({ pid, task_id: taskId, provenance_digest: canonicalJsonDigest(provenance) });
    return {
      pid,
      name: seat.name,
      construction: {
        status: 'accepted' as const,
        packed: seat.construction.packed,
        artifact: structuredClone(seat.construction.artifact),
      },
    };
  });
  return {
    options: {
      format: options.format,
      gameSeeds: options.gameSeeds.map((seed) => [...seed]) as [
        [number, number, number, number],
        [number, number, number, number],
        [number, number, number, number],
      ],
      seats,
    },
    constructionTasks,
  };
}

function validateCases(
  value: unknown,
  conditions: Map<string, FrozenCondition>,
): { cases: ValidatedCase[]; usedConditions: Set<string> } {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ENTRIES) {
    throw new Error(`cases must contain between 1 and ${MAX_ENTRIES} entries`);
  }
  const caseIds = new Set<string>();
  const bindings = new Set<string>();
  const usedConditions = new Set<string>();
  const cases = value.map((entry, index) => {
    const label = `cases[${index}]`;
    const item = object(entry, label);
    exactKeys(item, ['case_id', 'condition_id', 'options', 'provenance'], label);
    const caseId = slug(item.case_id, `${label}.case_id`);
    if (caseIds.has(caseId)) throw new Error(`duplicate case_id ${JSON.stringify(caseId)}`);
    caseIds.add(caseId);
    const conditionId = slug(item.condition_id, `${label}.condition_id`);
    const condition = conditions.get(conditionId);
    if (!condition) throw new Error(`${label} references unknown condition_id ${JSON.stringify(conditionId)}`);
    usedConditions.add(conditionId);
    const provenance = object(item.provenance, `${label}.provenance`);
    exactKeys(provenance, ['seed_source', 'source'], `${label}.provenance`);
    const projectedProvenance = {
      source: boundedString(provenance.source, MAX_PROVENANCE_CHARACTERS, `${label}.provenance.source`),
      seed_source: boundedString(provenance.seed_source, MAX_PROVENANCE_CHARACTERS, `${label}.provenance.seed_source`),
    };
    const suppliedOptions = validateOptionsStructure(item.options, `${label}.options`);
    const referee = new FrozenMatchdayReferee(suppliedOptions);
    if (referee.showdownRevision !== SHOWDOWN_LOCK.commit) {
      throw new Error(
        `${label} referee uses Showdown revision ${referee.showdownRevision}; expected pinned ${SHOWDOWN_LOCK.commit}`,
      );
    }
    const snapshot = referee.snapshot();
    const projected = validatedOptionsProjection(snapshot.options);
    const binding = `${condition.digest}:${referee.configDigest}`;
    if (bindings.has(binding)) {
      throw new Error(`${label} duplicates a condition_digest and expected_config_digest binding`);
    }
    bindings.add(binding);
    return {
      caseId,
      conditionId,
      conditionDigest: condition.digest,
      expectedConfigDigest: referee.configDigest,
      provenanceDigest: canonicalJsonDigest(projectedProvenance),
      options: projected.options,
      constructionTasks: projected.constructionTasks,
      showdownRevision: referee.showdownRevision,
      format: referee.format,
    };
  });
  return { cases, usedConditions };
}

function assertAllConditionsUsed(conditions: readonly FrozenCondition[], used: ReadonlySet<string>): void {
  const unused = conditions.filter((condition) => !used.has(condition.conditionId));
  if (unused.length)
    throw new Error(`unused conditions: ${unused.map((condition) => condition.conditionId).join(', ')}`);
}

function outputRows(cases: readonly ValidatedCase[]): JsonObject[] {
  return cases.map((entry) => ({
    case_id: entry.caseId,
    condition_digest: entry.conditionDigest,
    expected_config_digest: entry.expectedConfigDigest,
    showdown_revision: entry.showdownRevision,
    format: entry.format,
    jsonl_protocol_version: FROZEN_MATCHDAY_JSONL_PROTOCOL_VERSION,
    matchday_protocol_version: FROZEN_MATCHDAY_REFEREE_PROTOCOL_VERSION,
    battle_protocol_version: FROZEN_BATTLE_REFEREE_PROTOCOL_VERSION,
    options: entry.options,
  }));
}

function manifest(
  sourceId: string,
  input: InputSnapshot,
  conditions: readonly FrozenCondition[],
  cases: readonly ValidatedCase[],
  taskSourceContent: Buffer,
  producer: RuntimeProducerAuthoritySnapshot,
): JsonObject {
  const first = cases[0] as ValidatedCase;
  if (cases.some((entry) => entry.showdownRevision !== first.showdownRevision || entry.format !== first.format)) {
    throw new Error('validated cases disagree on frozen referee authority');
  }
  const manifestAuthorityRevision = first.showdownRevision;
  if (manifestAuthorityRevision !== SHOWDOWN_LOCK.commit) {
    throw new Error(
      `manifest authority uses Showdown revision ${manifestAuthorityRevision}; expected pinned ${SHOWDOWN_LOCK.commit}`,
    );
  }
  return {
    schema_version: FROZEN_MATCHDAY_TASK_SOURCE_MANIFEST_SCHEMA_VERSION,
    status: FROZEN_MATCHDAY_TASK_SOURCE_STATUS,
    release_ready: false,
    source_id: sourceId,
    canonical_json: CANONICAL_JSON_PROTOCOL,
    condition_digest_protocol: FROZEN_MATCHDAY_CONDITION_DIGEST_PROTOCOL,
    authority: {
      implementation: 'typescript',
      referee: 'FrozenMatchdayReferee',
      validated_options: 'FrozenMatchdayReferee.snapshot().options exact accepted-construction projection',
      config_digest: 'FrozenMatchdayReferee.configDigest',
      showdown_revision: manifestAuthorityRevision,
      format: first.format,
      jsonl_protocol_version: FROZEN_MATCHDAY_JSONL_PROTOCOL_VERSION,
      matchday_protocol_version: FROZEN_MATCHDAY_REFEREE_PROTOCOL_VERSION,
      battle_protocol_version: FROZEN_BATTLE_REFEREE_PROTOCOL_VERSION,
      request_line_bytes: FROZEN_REFEREE_REQUEST_LINE_BYTES,
    },
    producer: {
      digest_protocol: PRODUCER_DIGEST_PROTOCOL,
      digest: producer.producerDigest,
      showdown_runtime_digest: producer.showdownRuntimeDigest,
      byte_portability: FROZEN_MATCHDAY_TASK_SOURCE_RUNTIME_BYTE_PORTABILITY,
      runtime: { node: process.version, platform: process.platform, arch: process.arch },
    },
    publication: {
      precondition: FROZEN_MATCHDAY_TASK_SOURCE_PUBLICATION_PRECONDITION,
      portable_atomic_directory_noreplace: false,
      loaded_js_module_byte_attestation: FROZEN_MATCHDAY_TASK_SOURCE_LOADED_JS_MODULE_BYTE_ATTESTATION,
      authority_snapshot_scope: FROZEN_MATCHDAY_TASK_SOURCE_AUTHORITY_SNAPSHOT_SCOPE,
    },
    input: { sha256: sha256(input.bytes), bytes: input.bytes.length },
    output: {
      file: 'task-source.jsonl',
      sha256: sha256(taskSourceContent),
      bytes: taskSourceContent.length,
      rows: cases.length,
    },
    conditions: conditions.map((condition) => ({
      condition_id: condition.conditionId,
      condition_digest: condition.digest,
      definition: condition.definition,
    })),
    ordered_cases: cases.map((entry, idx) => ({
      idx,
      case_id: entry.caseId,
      condition_id: entry.conditionId,
      condition_digest: entry.conditionDigest,
      expected_config_digest: entry.expectedConfigDigest,
      provenance_digest: entry.provenanceDigest,
      construction_tasks: entry.constructionTasks,
    })),
  };
}

function assertDirectory(file: string, stat: fs.Stats, expectedMode: number, label: string): void {
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new Error(`${label} must be a non-symlink directory: ${file}`);
  if ((stat.mode & 0o7777) !== expectedMode) throw new Error(`${label} must have mode 0700: ${file}`);
}

function stablePrivateFile(file: string): Buffer {
  const pathStat = fs.lstatSync(file);
  assertPrivateRegularFile(file, pathStat, 'frozen output file');
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = fs.fstatSync(descriptor);
    assertPrivateRegularFile(file, before, 'frozen output file');
    if (before.dev !== pathStat.dev || before.ino !== pathStat.ino) {
      throw new Error(`frozen output file identity changed: ${file}`);
    }
    const content = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    const finalPathStat = fs.lstatSync(file);
    assertPrivateRegularFile(file, finalPathStat, 'frozen output file');
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      finalPathStat.dev !== after.dev ||
      finalPathStat.ino !== after.ino ||
      finalPathStat.size !== after.size ||
      finalPathStat.mtimeMs !== after.mtimeMs ||
      finalPathStat.ctimeMs !== after.ctimeMs ||
      content.length !== after.size
    ) {
      throw new Error(`frozen output file changed while it was read: ${file}`);
    }
    return content;
  } finally {
    fs.closeSync(descriptor);
  }
}

interface OutputLocation {
  requested: string;
  physical: string;
  parent: string;
  parentStat: fs.Stats;
  existing: boolean;
}

function outputLocation(outputRoot: string, input: InputSnapshot): OutputLocation {
  const requested = path.resolve(outputRoot);
  if (requested === path.dirname(requested)) throw new Error('output root must not be a filesystem root');
  const requestedParent = path.dirname(requested);
  const parentPathStat = fs.lstatSync(requestedParent);
  if (parentPathStat.isSymbolicLink() || !parentPathStat.isDirectory()) {
    throw new Error(`output parent must be a non-symlink directory: ${requestedParent}`);
  }
  const parent = fs.realpathSync.native(requestedParent);
  const parentStat = fs.statSync(parent);
  const physical = path.join(parent, path.basename(requested));
  const parentAfter = fs.lstatSync(requestedParent);
  if (
    parentAfter.isSymbolicLink() ||
    !parentAfter.isDirectory() ||
    parentAfter.dev !== parentPathStat.dev ||
    parentAfter.ino !== parentPathStat.ino ||
    parentStat.dev !== parentAfter.dev ||
    parentStat.ino !== parentAfter.ino
  ) {
    throw new Error(`output parent changed while it was resolved: ${requestedParent}`);
  }
  if (pathContainedBy(physical, input.realpath) || pathContainedBy(input.realpath, physical)) {
    throw new Error('input and output roots must not contain or alias one another');
  }
  let existing = false;
  try {
    const stat = fs.lstatSync(physical);
    assertDirectory(physical, stat, OUTPUT_DIRECTORY_MODE, 'frozen output root');
    const realpath = fs.realpathSync.native(physical);
    if (realpath !== physical) throw new Error(`frozen output root aliases another path: ${physical}`);
    if (stat.dev === input.stat.dev && stat.ino === input.stat.ino) {
      throw new Error('input and output roots must not contain or alias one another');
    }
    existing = true;
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
  return { requested, physical, parent, parentStat, existing };
}

function verifyParent(location: OutputLocation): void {
  const stat = fs.lstatSync(location.parent);
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    stat.dev !== location.parentStat.dev ||
    stat.ino !== location.parentStat.ino
  ) {
    throw new Error(`output parent changed during publication: ${location.parent}`);
  }
}

function verifyExistingOutput(location: OutputLocation, expected: ReadonlyMap<string, Buffer>): void {
  const initial = fs.lstatSync(location.physical);
  assertDirectory(location.physical, initial, OUTPUT_DIRECTORY_MODE, 'frozen output root');
  const actualEntries = fs.readdirSync(location.physical).sort();
  const expectedEntries = [...expected.keys()].sort();
  if (
    actualEntries.length !== expectedEntries.length ||
    actualEntries.some((entry, index) => entry !== expectedEntries[index])
  ) {
    throw new Error('frozen output root is partial or contains unexpected entries');
  }
  for (const [name, content] of expected) {
    const actual = stablePrivateFile(path.join(location.physical, name));
    if (!actual.equals(content)) throw new Error(`refusing non-identical frozen output rerun: ${name}`);
  }
  const final = fs.lstatSync(location.physical);
  assertDirectory(location.physical, final, OUTPUT_DIRECTORY_MODE, 'frozen output root');
  if (final.dev !== initial.dev || final.ino !== initial.ino) {
    throw new Error(`frozen output root changed while it was verified: ${location.physical}`);
  }
}

function createStage(location: OutputLocation): string {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const stage = path.join(
      location.parent,
      `.${path.basename(location.physical)}.${process.pid}.${randomBytes(16).toString('hex')}.stage`,
    );
    let created = false;
    try {
      fs.mkdirSync(stage, { mode: OUTPUT_DIRECTORY_MODE });
      created = true;
      fs.chmodSync(stage, OUTPUT_DIRECTORY_MODE);
      assertDirectory(stage, fs.lstatSync(stage), OUTPUT_DIRECTORY_MODE, 'private publication stage');
      return stage;
    } catch (error) {
      if (!created && errorCode(error) === 'EEXIST') continue;
      let cleanupError: unknown;
      if (created) {
        try {
          fs.rmSync(stage, { recursive: true });
          fsyncDirectory(location.parent, location.parentStat);
        } catch (cleanup) {
          if (errorCode(cleanup) !== 'ENOENT') cleanupError = cleanup;
        }
      }
      if (cleanupError !== undefined && error instanceof Error) {
        error.message += `; private stage cleanup also failed: ${String(cleanupError)}`;
      }
      throw error;
    }
  }
  throw new Error(`could not allocate a private publication stage beside ${location.physical}`);
}

function writeStageFile(stage: string, name: string, content: Buffer): void {
  if (path.basename(name) !== name) throw new Error(`stage file name must be a basename: ${name}`);
  const file = path.join(stage, name);
  const descriptor = fs.openSync(
    file,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    OUTPUT_FILE_MODE,
  );
  try {
    fs.fchmodSync(descriptor, OUTPUT_FILE_MODE);
    fs.writeFileSync(descriptor, content);
    fs.fsyncSync(descriptor);
    const stat = fs.fstatSync(descriptor);
    assertPrivateRegularFile(file, stat, 'staged output file');
  } finally {
    fs.closeSync(descriptor);
  }
}

function fsyncDirectory(directory: string, expected?: fs.Stats): void {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isDirectory() || (expected && (stat.dev !== expected.dev || stat.ino !== expected.ino))) {
      throw new Error(`directory changed before fsync: ${directory}`);
    }
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

/** Publication is safe only under the exported trusted single-producer precondition; Node has no portable directory NOREPLACE. */
function publishAbsentDirectory(location: OutputLocation, files: ReadonlyMap<string, Buffer>): void {
  verifyParent(location);
  const stage = createStage(location);
  let published = false;
  let publicationError: unknown;
  try {
    for (const [name, content] of files) writeStageFile(stage, name, content);
    fsyncDirectory(stage);
    verifyParent(location);
    try {
      fs.lstatSync(location.physical);
      throw new Error(
        `refusing to overwrite frozen output root: ${location.physical}; publication requires ${FROZEN_MATCHDAY_TASK_SOURCE_PUBLICATION_PRECONDITION}`,
      );
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
    const stagedIdentity = fs.lstatSync(stage);
    assertDirectory(stage, stagedIdentity, OUTPUT_DIRECTORY_MODE, 'private publication stage');
    fs.renameSync(stage, location.physical);
    published = true;
    const publishedIdentity = fs.lstatSync(location.physical);
    assertDirectory(location.physical, publishedIdentity, OUTPUT_DIRECTORY_MODE, 'published frozen output root');
    if (publishedIdentity.dev !== stagedIdentity.dev || publishedIdentity.ino !== stagedIdentity.ino) {
      throw new Error(`published frozen output root identity changed after rename: ${location.physical}`);
    }
    fsyncDirectory(location.parent, location.parentStat);
  } catch (error) {
    publicationError = error;
  }
  let cleanupError: unknown;
  if (!published) {
    try {
      fs.rmSync(stage, { recursive: true });
      fsyncDirectory(location.parent, location.parentStat);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') cleanupError = error;
    }
  }
  if (publicationError !== undefined) {
    const detail = publicationError instanceof Error ? publicationError.message : String(publicationError);
    const cleanupDetail =
      cleanupError === undefined ? '' : `; private stage cleanup also failed: ${String(cleanupError)}`;
    throw new Error(
      `frozen task source publication requires ${FROZEN_MATCHDAY_TASK_SOURCE_PUBLICATION_PRECONDITION}: ${detail}${cleanupDetail}`,
      { cause: publicationError },
    );
  }
  if (cleanupError !== undefined) throw cleanupError;
}

/** Freezes canonical private matchday cases into the exact sealed Python task-row boundary and its private manifest. */
export function freezeFrozenMatchdayTaskSource(
  inputFile: string,
  outputRoot: string,
  producerEntryUrl: string,
): FrozenMatchdayTaskSourceFreezeResult {
  const input = readPrivateInput(inputFile);
  const source = parseCanonicalInput(input);
  exactKeys(source, ['cases', 'conditions', 'schema_version', 'source_id'], 'private input');
  if (source.schema_version !== FROZEN_MATCHDAY_TASK_SOURCE_INPUT_SCHEMA_VERSION) {
    throw new Error(`private input schema_version must be ${FROZEN_MATCHDAY_TASK_SOURCE_INPUT_SCHEMA_VERSION}`);
  }
  const sourceId = slug(source.source_id, 'private input.source_id');
  const conditions = validateConditions(source.conditions);
  const producer = captureRuntimeProducerAuthority(producerEntryUrl);
  const runtimeBinding = captureReviewedRuntimeBinding(producer);
  assertReviewedRuntimeBinding(producer, runtimeBinding);
  const validated = validateCases(source.cases, conditions.byId);
  assertReviewedRuntimeBinding(producer, runtimeBinding);
  assertAllConditionsUsed(conditions.ordered, validated.usedConditions);
  const rows = outputRows(validated.cases);
  rows.forEach((row) => {
    frozenMatchdayStartRequestLine({
      condition_digest: row.condition_digest,
      showdown_revision: row.showdown_revision,
      options: row.options,
    });
  });
  const taskSourceContent = Buffer.from(canonicalJsonl(rows), 'utf8');
  const manifestValue = manifest(sourceId, input, conditions.ordered, validated.cases, taskSourceContent, producer);
  const manifestContent = Buffer.from(`${canonicalJson(manifestValue)}\n`, 'utf8');
  const files = new Map<string, Buffer>([
    ['task-source.jsonl', taskSourceContent],
    ['manifest.json', manifestContent],
  ]);
  const location = outputLocation(outputRoot, input);
  assertReviewedRuntimeBinding(producer, runtimeBinding);
  if (location.existing) verifyExistingOutput(location, files);
  else {
    publishAbsentDirectory(location, files);
    verifyExistingOutput({ ...location, existing: true }, files);
  }
  return {
    outputRoot: location.physical,
    taskSourceSha256: sha256(taskSourceContent),
    manifestSha256: sha256(manifestContent),
    rows: rows.length,
    identicalRerun: location.existing,
    publicationPrecondition: FROZEN_MATCHDAY_TASK_SOURCE_PUBLICATION_PRECONDITION,
    runtimeBytePortability: FROZEN_MATCHDAY_TASK_SOURCE_RUNTIME_BYTE_PORTABILITY,
    loadedJsModuleByteAttestation: FROZEN_MATCHDAY_TASK_SOURCE_LOADED_JS_MODULE_BYTE_ATTESTATION,
    authoritySnapshotScope: FROZEN_MATCHDAY_TASK_SOURCE_AUTHORITY_SNAPSHOT_SCOPE,
  };
}
