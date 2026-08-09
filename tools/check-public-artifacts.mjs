import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(root, 'artifacts', 'public', 'landing', 'circuit-trace-v1');

function readRegular(name) {
  const file = path.resolve(directory, name);
  if (!file.startsWith(`${directory}${path.sep}`)) throw new Error(`${name} escapes its bundle`);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${name} is not a regular file`);
  const realDirectory = fs.realpathSync.native(directory);
  const realFile = fs.realpathSync.native(file);
  if (!realFile.startsWith(`${realDirectory}${path.sep}`)) throw new Error(`${name} escapes its bundle`);
  const descriptor = fs.openSync(realFile, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    if (!fs.fstatSync(descriptor).isFile()) throw new Error(`${name} is not a regular file`);
    return fs.readFileSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

const directoryStat = fs.lstatSync(directory);
if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
  throw new Error('public artifact bundle must be a regular directory');
}
const manifestBytes = readRegular('manifest.json');
const manifest = JSON.parse(manifestBytes.toString('utf8'));

if (
  typeof manifest !== 'object' ||
  manifest === null ||
  typeof manifest.artifacts !== 'object' ||
  manifest.artifacts === null ||
  Array.isArray(manifest.artifacts)
) {
  throw new Error('manifest.artifacts must be an object');
}

const artifactBytes = new Map();
for (const [name, entry] of Object.entries(manifest.artifacts ?? {})) {
  if (typeof entry !== 'object' || entry === null) throw new Error(`manifest artifact ${name} must be an object`);
  if (typeof entry.path !== 'string' || path.isAbsolute(entry.path) || entry.path.includes('\0')) {
    throw new Error(`manifest artifact ${name} has an unsafe path`);
  }
  const file = path.resolve(directory, entry.path);
  if (!file.startsWith(`${directory}${path.sep}`)) throw new Error(`manifest artifact ${name} escapes its bundle`);
  const bytes = readRegular(entry.path);
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (typeof entry.sha256 !== 'string' || actual !== entry.sha256) {
    throw new Error(`${entry.path} SHA-256 mismatch: ${actual}`);
  }
  artifactBytes.set(name, bytes);
}

const scans = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/iu,
  /\b(?:sk-(?:proj-|live-)?[A-Za-z0-9_-]{20,}|gh[oprsu]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})\b/u,
  /["'](?:api[_-]?key|authorization|client[_-]?secret|credential(?:s)?|password|private[_-]?key|(?:(?:access|refresh|session|bearer|auth)[_-]?)?token)["']\s*[:=]\s*["'][^"'\n]{8,}["']/iu,
  /\b(?:authorization|x-api-key)\s*:\s*(?:bearer\s+)?\S+/iu,
  /(?:https?|postgres(?:ql)?):\/\/[^\s/:]+:[^\s/@]+@/iu,
];

for (const [name, bytes] of [
  ['manifest.json', manifestBytes],
  ['curated', artifactBytes.get('curated')],
  ['full', artifactBytes.get('full')],
]) {
  if (!Buffer.isBuffer(bytes)) throw new Error(`manifest is missing ${name}`);
  const raw = bytes.toString('utf8');
  if (scans.some((pattern) => pattern.test(raw))) {
    throw new Error(`${name} contains a credential`);
  }
}

process.stdout.write(`checked ${path.relative(root, directory)} (${artifactBytes.size} raw artifacts)\n`);
