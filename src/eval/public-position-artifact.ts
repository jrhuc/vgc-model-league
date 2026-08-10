import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { type PublicPositionTask, validatePublicPositionTask } from './panel-artifact.js';
import { validateCandidateManifest } from './position-artifact-manifest.js';
import { canonicalJson } from './serialization.js';

const PUBLIC_MEMBERS = ['manifest.json', 'tasks.jsonl'] as const;

function readMember(root: string, name: (typeof PUBLIC_MEMBERS)[number]): Buffer {
  const file = path.join(root, name);
  if (!fs.lstatSync(file).isFile()) throw new Error(`${name} must be a regular non-symlink file`);
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    if (!fs.fstatSync(descriptor).isFile()) throw new Error(`${name} must be a regular non-symlink file`);
    return fs.readFileSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
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

/** Reads a public-only candidate root — non-symlink layout, canonical bytes, manifest digest and order joins. */
export function readPublicPositionCandidateRoot(root: string): readonly PublicPositionTask[] {
  const resolved = path.resolve(root);
  const rootStat = fs.lstatSync(resolved);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error('public candidate root must be a non-symlink directory');
  }
  const names = fs.readdirSync(resolved).sort();
  const expected = [...PUBLIC_MEMBERS].sort();
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
    throw new Error(`public candidate root must contain exactly ${PUBLIC_MEMBERS.join(',')}`);
  }
  const manifest = validateCandidateManifest(canonicalManifest(readMember(resolved, 'manifest.json')));
  if (manifest.outputs.tasks.file !== 'tasks.jsonl') {
    throw new Error('candidate manifest outputs.tasks.file must be exactly tasks.jsonl');
  }
  const tasksBytes = readMember(resolved, 'tasks.jsonl');
  const tasksDigest = createHash('sha256').update(tasksBytes).digest('hex');
  if (tasksDigest !== manifest.outputs.tasks.sha256) throw new Error('tasks.jsonl does not match its manifest SHA-256');
  const tasks = publicTasks(tasksBytes);
  if (tasks.length !== manifest.outputs.tasks.rows || tasks.length !== manifest.selection.count) {
    throw new Error('tasks.jsonl row count does not match its manifest selection join');
  }
  if (tasks.some((task, index) => task.task_id !== manifest.orderedTaskIds[index])) {
    throw new Error('tasks.jsonl task_id sequence does not match manifest.ordered_task_ids');
  }
  return tasks;
}
