#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const USAGE = `Usage: pnpm run archive-run -- <run-id> [<run-id>...]

Packs runs/<run-id> (every trace, log, and config) into a compressed tarball
under $VGC_RUN_ARCHIVE_DIR (default ~/vgc-run-archive) with a manifest and
checksum, then verifies the tarball reads back. Never deletes the source run.`;

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const runsDir = path.join(repoRoot, 'runs');
const destDir = path.resolve(process.env.VGC_RUN_ARCHIVE_DIR ?? path.join(os.homedir(), 'vgc-run-archive'));

const runIds = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));
if (runIds.length === 0) {
  console.error(USAGE);
  process.exit(2);
}

fs.mkdirSync(destDir, { recursive: true });
let failures = 0;
for (const runId of runIds) {
  const source = path.join(runsDir, runId);
  if (!/^[A-Za-z0-9._-]+$/.test(runId) || !fs.existsSync(path.join(source, 'config.json'))) {
    console.error(`skip ${runId}: not a run directory with a config.json`);
    failures += 1;
    continue;
  }
  const status = readJson(path.join(source, 'status.json'));
  if (status?.state === 'running') {
    console.error(`skip ${runId}: status.json says the run is still running`);
    failures += 1;
    continue;
  }
  const tarball = path.join(destDir, `${runId}.tar.gz`);
  execFileSync('tar', ['-czf', tarball, '-C', runsDir, runId]);
  execFileSync('tar', ['-tzf', tarball], { stdio: 'ignore' });
  const bytes = fs.statSync(tarball).size;
  const sha256 = createHash('sha256').update(fs.readFileSync(tarball)).digest('hex');
  const files = countFiles(source);
  fs.writeFileSync(
    path.join(destDir, `${runId}.manifest.json`),
    `${JSON.stringify({ runId, archivedAt: new Date().toISOString(), bytes, sha256, files, mode: readJson(path.join(source, 'config.json'))?.mode ?? null }, null, 2)}\n`,
  );
  console.log(`archived ${runId}: ${files} files, ${(bytes / 1e6).toFixed(1)} MB → ${tarball}`);
}
console.log(`archives live in ${destDir}; sync offsite with e.g. "rclone copy ${destDir} <remote>:vgc-run-archive"`);
process.exit(failures > 0 ? 1 : 0);

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function countFiles(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) total += 1;
  }
  return total;
}
