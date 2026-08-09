import { createHash, type Hash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PRODUCER_DIGEST_PROTOCOL = 'vgc-model-league-runtime-producer-digest-v2' as const;

export interface RawProducerDigestRecord {
  path: Buffer | string;
  content: Buffer;
}

export interface RuntimeProducerAuthority {
  producerDigest: string;
  showdownRuntimeDigest: string;
}

export interface RuntimeProducerAuthoritySnapshot extends RuntimeProducerAuthority {
  rootRealpath: string;
  showdownRealpath: string;
  assertUnchanged(): void;
}

interface StableFileRecord extends RawProducerDigestRecord {
  relative: string;
  stat: fs.BigIntStats;
}

interface RootIdentity {
  requested: string;
  realpath: string;
  stat: fs.BigIntStats;
}

interface StableFileSetSnapshot {
  records: StableFileRecord[];
  assertUnchanged(): void;
}

const PINNED_SHOWDOWN_RUNTIME_DIGESTS: Readonly<Record<string, string>> = {
  '6a1836dd71c0718e923206f3d089e61074410868': 'f13dc660b05704cb843adc9f39368c5fa5f8d2ffdc1b44fc76317cef71625881',
};

function bytes(value: Buffer | string): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
}

function lengthFrame(hash: Hash, value: Buffer): void {
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(value.length));
  hash.update(length).update(value);
}

function taggedFrame(hash: Hash, tag: string, value: Buffer): void {
  lengthFrame(hash, Buffer.from(tag, 'utf8'));
  lengthFrame(hash, value);
}

/** Hashes path and content bytes with unambiguous, domain-versioned raw framing. */
export function rawProducerDigest(records: readonly RawProducerDigestRecord[]): string {
  const normalized = records
    .map((record) => {
      if (!Buffer.isBuffer(record.content)) throw new Error('producer authority content must be raw bytes');
      return { path: bytes(record.path), content: record.content };
    })
    .sort((left, right) => Buffer.compare(left.path, right.path));
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index - 1]!.path.equals(normalized[index]!.path)) {
      throw new Error('producer authority contains a duplicate raw path');
    }
  }
  const hash = createHash('sha256');
  taggedFrame(hash, 'domain', Buffer.from(PRODUCER_DIGEST_PROTOCOL, 'utf8'));
  const count = Buffer.allocUnsafe(8);
  count.writeBigUInt64BE(BigInt(normalized.length));
  taggedFrame(hash, 'record-count', count);
  for (const record of normalized) {
    taggedFrame(hash, 'path', record.path);
    taggedFrame(hash, 'content', record.content);
  }
  return hash.digest('hex');
}

function assertStableRegularFile(file: string, stat: fs.BigIntStats, label: string): void {
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${label} must be a regular non-symlink file: ${file}`);
  }
}

function assertStableDirectory(file: string, stat: fs.BigIntStats, label: string): void {
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} must be a non-symlink directory: ${file}`);
  }
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

function sameRootIdentity(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.nlink === right.nlink && left.mode === right.mode;
}

function captureRootIdentity(root: string): RootIdentity {
  const requested = path.resolve(root);
  const realpath = fs.realpathSync.native(requested);
  const stat = fs.lstatSync(realpath, { bigint: true });
  assertStableDirectory(realpath, stat, 'producer authority root');
  return { requested, realpath, stat };
}

function assertRootIdentity(identity: RootIdentity): void {
  const realpath = fs.realpathSync.native(identity.requested);
  if (realpath !== identity.realpath) {
    throw new Error(`producer authority root realpath changed from ${identity.realpath} to ${realpath}`);
  }
  const stat = fs.lstatSync(identity.realpath, { bigint: true });
  assertStableDirectory(identity.realpath, stat, 'producer authority root');
  if (!sameRootIdentity(identity.stat, stat)) {
    throw new Error(`producer authority root identity changed: ${identity.realpath}`);
  }
}

function stableFileRecord(root: string, relative: string): StableFileRecord {
  const file = path.join(root, relative);
  const pathStat = fs.lstatSync(file, { bigint: true });
  assertStableRegularFile(file, pathStat, 'producer authority input');
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    assertStableRegularFile(file, before, 'producer authority input');
    if (!sameFileState(pathStat, before)) {
      throw new Error(`producer authority input identity changed before it was read: ${file}`);
    }
    const content = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    const finalPathStat = fs.lstatSync(file, { bigint: true });
    assertStableRegularFile(file, finalPathStat, 'producer authority input');
    if (
      !sameFileState(before, after) ||
      !sameFileState(after, finalPathStat) ||
      BigInt(content.length) !== after.size
    ) {
      throw new Error(`producer authority input changed while it was read: ${file}`);
    }
    return {
      relative,
      path: Buffer.from(relative.split(path.sep).join('/'), 'utf8'),
      content,
      stat: before,
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

function checkedRelativePath(relative: string): string {
  if (!relative || path.isAbsolute(relative)) throw new Error(`producer authority path must be relative: ${relative}`);
  const normalized = path.normalize(relative);
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
    throw new Error(`producer authority path escapes its root: ${relative}`);
  }
  return normalized;
}

function exactMembership(relativeFiles: readonly string[]): string[] {
  const normalized = relativeFiles
    .map(checkedRelativePath)
    .sort((left, right) =>
      Buffer.compare(
        Buffer.from(left.split(path.sep).join('/'), 'utf8'),
        Buffer.from(right.split(path.sep).join('/'), 'utf8'),
      ),
    );
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index - 1] === normalized[index]) {
      throw new Error(`producer authority contains a duplicate path: ${normalized[index]}`);
    }
  }
  return normalized;
}

function sameMembership(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((relative, index) => relative === right[index]);
}

function assertRecordsUnchanged(root: string, records: readonly StableFileRecord[]): void {
  for (const record of records) {
    const file = path.join(root, record.relative);
    let stat: fs.BigIntStats;
    try {
      stat = fs.lstatSync(file, { bigint: true });
    } catch (error) {
      throw new Error(`producer authority membership or file state changed after it was read: ${file}`, {
        cause: error,
      });
    }
    assertStableRegularFile(file, stat, 'producer authority input');
    if (!sameFileState(record.stat, stat)) {
      throw new Error(`producer authority input changed after it was read: ${file}`);
    }
  }
}

function stableFileSetSnapshot(
  root: string,
  enumerateRelativeFiles: (rootRealpath: string) => readonly string[],
): StableFileSetSnapshot {
  const rootIdentity = captureRootIdentity(root);
  const initialMembership = exactMembership(enumerateRelativeFiles(rootIdentity.realpath));
  const records = initialMembership.map((relative) => stableFileRecord(rootIdentity.realpath, relative));
  const finalMembership = exactMembership(enumerateRelativeFiles(rootIdentity.realpath));
  if (!sameMembership(initialMembership, finalMembership)) {
    throw new Error('producer authority membership changed while its file set was read');
  }
  assertRecordsUnchanged(rootIdentity.realpath, records);
  assertRootIdentity(rootIdentity);
  return {
    records,
    assertUnchanged(): void {
      assertRootIdentity(rootIdentity);
      const currentMembership = exactMembership(enumerateRelativeFiles(rootIdentity.realpath));
      if (!sameMembership(initialMembership, currentMembership)) {
        throw new Error('producer authority membership changed after its stable snapshot');
      }
      assertRecordsUnchanged(rootIdentity.realpath, records);
      assertRootIdentity(rootIdentity);
    },
  };
}

/** Reads an explicit file set through stable descriptors and globally restats it before hashing. */
export function stableProducerDigest(root: string, relativeFiles: readonly string[]): string {
  const membership = exactMembership(relativeFiles);
  const snapshot = stableFileSetSnapshot(root, () => membership);
  return rawProducerDigest(snapshot.records);
}

function visitFiles(directory: string, accept: (file: string) => boolean): string[] {
  const directoryStat = fs.lstatSync(directory, { bigint: true });
  assertStableDirectory(directory, directoryStat, 'producer authority directory');
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    const stat = fs.lstatSync(file, { bigint: true });
    if (stat.isSymbolicLink()) throw new Error(`producer authority must not contain symlinks: ${file}`);
    if (stat.isDirectory()) return visitFiles(file, accept);
    if (!stat.isFile()) throw new Error(`producer authority contains an invalid file state: ${file}`);
    return accept(file) ? [file] : [];
  });
}

function runtimeLayout(entry: string): { root: string; sourceRoot: string; extension: '.js' | '.ts' } {
  const entryDirectory = path.dirname(entry);
  const compiled = path.basename(path.dirname(entryDirectory)) === 'dist';
  return compiled
    ? {
        root: path.resolve(entryDirectory, '../..'),
        sourceRoot: path.resolve(entryDirectory, '../src'),
        extension: '.js',
      }
    : {
        root: path.resolve(entryDirectory, '..'),
        sourceRoot: path.resolve(entryDirectory, '../src'),
        extension: '.ts',
      };
}

function enumerateShowdownRuntimeAuthority(root: string): string[] {
  const showdown = path.join(root, 'pokemon-showdown');
  const compiledRoots = ['sim', 'data', 'lib', 'server', 'config'];
  const compiled = compiledRoots.flatMap((directory) =>
    visitFiles(path.join(showdown, 'dist', directory), (file) => file.endsWith('.js') || file.endsWith('.json')),
  );
  const explicit = [
    path.join(root, 'showdown.lock.json'),
    path.join(showdown, 'dist', '.vgc-model-league-revision'),
    path.join(showdown, 'node_modules', 'ts-chacha20', 'package.json'),
    path.join(showdown, 'node_modules', 'ts-chacha20', 'build', 'src', 'chacha20.js'),
  ];
  return [...new Set([...compiled, ...explicit].map((file) => path.relative(root, file)))];
}

/** Returns the pinned compiled Showdown files whose bytes can exercise referee simulation or timer authority. */
export function showdownRuntimeAuthorityFiles(root: string): string[] {
  const identity = captureRootIdentity(root);
  return exactMembership(enumerateShowdownRuntimeAuthority(identity.realpath));
}

function pinnedShowdownRevision(records: readonly RawProducerDigestRecord[]): string {
  const lockPath = Buffer.from('showdown.lock.json', 'utf8');
  const lockRecord = records.find((record) => bytes(record.path).equals(lockPath));
  if (!lockRecord) throw new Error('Showdown runtime authority is missing showdown.lock.json');
  const lock = JSON.parse(lockRecord.content.toString('utf8')) as { commit?: unknown };
  if (typeof lock.commit !== 'string' || !/^[0-9a-f]{40}$/u.test(lock.commit)) {
    throw new Error('showdown.lock.json must contain a full pinned commit SHA');
  }
  return lock.commit;
}

function assertReviewedShowdownRecords(records: readonly RawProducerDigestRecord[]): string {
  const revision = pinnedShowdownRevision(records);
  const expected = PINNED_SHOWDOWN_RUNTIME_DIGESTS[revision];
  if (!expected) throw new Error(`no reviewed Showdown runtime digest is recorded for pinned revision ${revision}`);
  const actual = rawProducerDigest(records);
  if (actual !== expected) {
    throw new Error(
      `compiled Pokémon Showdown runtime digest ${actual} does not match reviewed ${expected} for ${revision}; rebuild with pnpm run setup:showdown`,
    );
  }
  return actual;
}

function showdownFileSet(root: string): StableFileSetSnapshot {
  return stableFileSetSnapshot(root, enumerateShowdownRuntimeAuthority);
}

/** Computes the raw-framed digest of one stable compiled pinned Showdown runtime file-set snapshot. */
export function showdownRuntimeDigest(root: string): string {
  return rawProducerDigest(showdownFileSet(root).records);
}

/** Rejects compiled Showdown bytes that do not match the reviewed build for the pinned revision. */
export function assertPinnedShowdownRuntime(root: string): string {
  return assertReviewedShowdownRecords(showdownFileSet(root).records);
}

function runtimeRelativeFiles(entry: string, root: string): { own: string[]; showdown: string[] } {
  const layout = runtimeLayout(entry);
  const sourceRoot = path.join(root, path.relative(layout.root, layout.sourceRoot));
  const own = [
    path.join(root, path.relative(layout.root, entry)),
    ...visitFiles(sourceRoot, (file) => file.endsWith(layout.extension)),
    path.join(root, 'package.json'),
    path.join(root, 'pnpm-lock.yaml'),
  ].map((file) => path.relative(root, file));
  return {
    own: [...new Set(own)],
    showdown: enumerateShowdownRuntimeAuthority(root),
  };
}

function snapshotRuntimeProducerAuthority(entryUrl: string): RuntimeProducerAuthoritySnapshot {
  const entry = fileURLToPath(entryUrl);
  const layout = runtimeLayout(entry);
  const enumerate = (root: string): string[] => {
    const runtime = runtimeRelativeFiles(entry, root);
    return [...new Set([...runtime.own, ...runtime.showdown])];
  };
  const snapshot = stableFileSetSnapshot(layout.root, enumerate);
  const rootRealpath = fs.realpathSync.native(layout.root);
  const showdownRealpath = fs.realpathSync.native(path.join(rootRealpath, 'pokemon-showdown'));
  const showdownRecords = snapshot.records.filter((record) => {
    const relative = bytes(record.path).toString('utf8');
    return relative === 'showdown.lock.json' || relative.startsWith('pokemon-showdown/');
  });
  if (showdownRecords.length < 2) {
    throw new Error('producer authority lost its Showdown runtime records while taking a stable snapshot');
  }
  const showdownRuntimeDigest = assertReviewedShowdownRecords(showdownRecords);
  const producerDigest = rawProducerDigest(snapshot.records);
  return {
    producerDigest,
    showdownRuntimeDigest,
    rootRealpath,
    showdownRealpath,
    assertUnchanged(): void {
      snapshot.assertUnchanged();
      if (fs.realpathSync.native(layout.root) !== rootRealpath) {
        throw new Error('producer authority root realpath changed after its stable snapshot');
      }
      if (fs.realpathSync.native(path.join(rootRealpath, 'pokemon-showdown')) !== showdownRealpath) {
        throw new Error('Showdown runtime authority root realpath changed after its stable snapshot');
      }
    },
  };
}

/** Captures the complete runtime authority and retains a verifier for pre-publication rechecks. */
export function captureRuntimeProducerAuthority(entryUrl: string): RuntimeProducerAuthoritySnapshot {
  return snapshotRuntimeProducerAuthority(entryUrl);
}
