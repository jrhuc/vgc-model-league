import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { type PublicPositionTask, validatePublicPositionTask } from './panel-artifact.js';
import { validateCandidateManifest } from './position-artifact-manifest.js';
import { canonicalJson } from './serialization.js';

const PUBLIC_MEMBERS = ['manifest.json', 'tasks.jsonl'] as const;

interface RootIdentity {
  requested: string;
  realpath: string;
  stat: fs.BigIntStats;
}

interface StableRead {
  bytes: Buffer;
  stat: fs.BigIntStats;
}

function sameRootIdentity(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.nlink === right.nlink && left.mode === right.mode;
}

function sameFileState(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.nlink === right.nlink &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function assertDirectory(stat: fs.BigIntStats, label: string): void {
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label} must be a non-symlink directory`);
}

function assertRegularFile(stat: fs.BigIntStats, label: string): void {
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} must be a regular non-symlink file`);
}

function captureRoot(root: string): RootIdentity {
  const requested = path.resolve(root);
  const requestedStat = fs.lstatSync(requested, { bigint: true });
  assertDirectory(requestedStat, 'public candidate root');
  const realpath = fs.realpathSync.native(requested);
  const physicalStat = fs.lstatSync(realpath, { bigint: true });
  assertDirectory(physicalStat, 'public candidate root');
  if (!sameRootIdentity(requestedStat, physicalStat)) throw new Error('public candidate root identity changed');
  return { requested, realpath, stat: requestedStat };
}

function assertRootUnchanged(root: RootIdentity): void {
  const requestedStat = fs.lstatSync(root.requested, { bigint: true });
  assertDirectory(requestedStat, 'public candidate root');
  if (!sameRootIdentity(root.stat, requestedStat)) throw new Error('public candidate root identity changed');
  const currentRealpath = fs.realpathSync.native(root.requested);
  if (currentRealpath !== root.realpath) throw new Error('public candidate root realpath changed');
  const physicalStat = fs.lstatSync(root.realpath, { bigint: true });
  assertDirectory(physicalStat, 'public candidate root');
  if (!sameRootIdentity(root.stat, physicalStat)) throw new Error('public candidate root identity changed');
}

function exactMembership(root: RootIdentity): Map<string, fs.BigIntStats> {
  assertRootUnchanged(root);
  const names = fs
    .readdirSync(root.realpath)
    .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  const expected = [...PUBLIC_MEMBERS].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
    throw new Error(`public candidate root must contain exactly ${PUBLIC_MEMBERS.join(',')}`);
  }
  const states = new Map(
    PUBLIC_MEMBERS.map((name) => [name, fs.lstatSync(path.join(root.realpath, name), { bigint: true })] as const),
  );
  for (const name of PUBLIC_MEMBERS) assertRegularFile(states.get(name)!, name);
  assertRootUnchanged(root);
  return states;
}

function stableRead(root: RootIdentity, name: (typeof PUBLIC_MEMBERS)[number], expected: fs.BigIntStats): StableRead {
  assertRootUnchanged(root);
  const file = path.join(root.realpath, name);
  const pathBefore = fs.lstatSync(file, { bigint: true });
  assertRegularFile(pathBefore, name);
  if (!sameFileState(expected, pathBefore)) throw new Error(`${name} changed before it was read`);
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    assertRegularFile(before, name);
    if (!sameFileState(pathBefore, before)) throw new Error(`${name} path identity changed before it was read`);
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    const pathAfter = fs.lstatSync(file, { bigint: true });
    assertRegularFile(pathAfter, name);
    if (!sameFileState(before, after) || !sameFileState(after, pathAfter) || BigInt(bytes.length) !== after.size) {
      throw new Error(`${name} changed while it was read`);
    }
    assertRootUnchanged(root);
    return { bytes, stat: after };
  } finally {
    fs.closeSync(descriptor);
  }
}

function assertFinalState(root: RootIdentity, reads: ReadonlyMap<string, fs.BigIntStats>): void {
  assertRootUnchanged(root);
  const current = exactMembership(root);
  for (const name of PUBLIC_MEMBERS) {
    if (!sameFileState(reads.get(name)!, current.get(name)!)) throw new Error(`${name} changed after it was read`);
  }
  assertRootUnchanged(root);
}

function strictUtf8(bytes: Buffer, label: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error) {
    throw new Error(`${label} is not valid UTF-8`, { cause: error });
  }
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`${label} is malformed JSON`, { cause: error });
  }
}

function canonicalManifest(bytes: Buffer): unknown {
  const manifest = parseJson(strictUtf8(bytes, 'manifest.json'), 'manifest.json');
  const expected = Buffer.from(`${canonicalJson(manifest)}\n`, 'utf8');
  if (!bytes.equals(expected)) throw new Error('manifest.json must contain exactly one canonical JSON line');
  return manifest;
}

function publicTasks(bytes: Buffer): PublicPositionTask[] {
  if (!bytes.length) throw new Error('tasks.jsonl must be nonempty');
  if (bytes.includes(0x0d)) throw new Error('tasks.jsonl must use LF line endings');
  if (bytes.at(-1) !== 0x0a) throw new Error('tasks.jsonl must end with a newline');
  const rows: PublicPositionTask[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const newline = bytes.indexOf(0x0a, offset);
    if (newline === offset) throw new Error(`tasks.jsonl row ${rows.length} is blank`);
    const raw = bytes.subarray(offset, newline + 1);
    const value = parseJson(
      strictUtf8(raw.subarray(0, -1), `tasks.jsonl row ${rows.length}`),
      `tasks.jsonl row ${rows.length}`,
    );
    const expected = Buffer.from(`${canonicalJson(value)}\n`, 'utf8');
    if (!raw.equals(expected)) throw new Error(`tasks.jsonl row ${rows.length} is not canonical JSON`);
    validatePublicPositionTask(value, rows.length);
    rows.push(value);
    offset = newline + 1;
  }
  return rows;
}

/** Reads only the exact public candidate artifact root and returns its validated task rows. */
export function readPublicPositionCandidateRoot(root: string): readonly PublicPositionTask[] {
  const rootIdentity = captureRoot(root);
  const initial = exactMembership(rootIdentity);
  const manifestRead = stableRead(rootIdentity, 'manifest.json', initial.get('manifest.json')!);
  const manifest = validateCandidateManifest(canonicalManifest(manifestRead.bytes));
  if (manifest.outputs.tasks.file !== 'tasks.jsonl') {
    throw new Error('candidate manifest outputs.tasks.file must be exactly tasks.jsonl');
  }
  const tasksRead = stableRead(rootIdentity, 'tasks.jsonl', initial.get('tasks.jsonl')!);
  const tasksDigest = createHash('sha256').update(tasksRead.bytes).digest('hex');
  if (tasksDigest !== manifest.outputs.tasks.sha256) throw new Error('tasks.jsonl does not match its manifest SHA-256');
  const tasks = publicTasks(tasksRead.bytes);
  if (tasks.length !== manifest.outputs.tasks.rows || tasks.length !== manifest.selection.count) {
    throw new Error('tasks.jsonl row count does not match its manifest selection join');
  }
  if (tasks.some((task, index) => task.task_id !== manifest.orderedTaskIds[index])) {
    throw new Error('tasks.jsonl task_id sequence does not match manifest.ordered_task_ids');
  }
  assertFinalState(
    rootIdentity,
    new Map([
      ['manifest.json', manifestRead.stat],
      ['tasks.jsonl', tasksRead.stat],
    ]),
  );
  return tasks;
}
