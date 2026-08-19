import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { counterfactualProtocol, EXHAUSTIVE_PANEL_PROTOCOL } from '../src/eval/counterfactual.js';
import { POSITION_GRADE_SCHEMA_VERSION } from '../src/eval/positions.js';
import { captureRuntimeProducerAuthority, PRODUCER_DIGEST_PROTOCOL, rawProducerDigest } from '../src/eval/producer.js';
import { ACTION_PROTOCOL } from '../src/fork.js';

test('raw producer framing separates path/content newlines and preserves invalid UTF-8 bytes', () => {
  assert.equal(PRODUCER_DIGEST_PROTOCOL, 'vgc-model-league-runtime-producer-digest-v2');
  const first = rawProducerDigest([{ path: Buffer.from('a'), content: Buffer.from('b\nc') }]);
  const collidedUnderOldCombinedFraming = rawProducerDigest([{ path: Buffer.from('a\nb'), content: Buffer.from('c') }]);
  assert.notEqual(first, collidedUnderOldCombinedFraming);

  const invalid = rawProducerDigest([
    { path: Buffer.from([0x62, 0xff]), content: Buffer.from([0x00, 0xfe, 0x0a]) },
    { path: Buffer.from([0x61, 0x80]), content: Buffer.from([0xff]) },
  ]);
  const invalidReordered = rawProducerDigest([
    { path: Buffer.from([0x61, 0x80]), content: Buffer.from([0xff]) },
    { path: Buffer.from([0x62, 0xff]), content: Buffer.from([0x00, 0xfe, 0x0a]) },
  ]);
  const changedByte = rawProducerDigest([
    { path: Buffer.from([0x61, 0x80]), content: Buffer.from([0xfe]) },
    { path: Buffer.from([0x62, 0xff]), content: Buffer.from([0x00, 0xfe, 0x0a]) },
  ]);
  assert.equal(invalid, invalidReordered);
  assert.notEqual(invalid, changedByte);
  assert.match(invalid, /^[0-9a-f]{64}$/u);
});

test('raw producer framing is deterministic across independently allocated record sets', () => {
  const first = rawProducerDigest([
    { path: Buffer.from('src/alpha.ts'), content: Buffer.from([0x00, 0x0a, 0xff]) },
    { path: 'package.json', content: Buffer.from('{"name":"fixture"}\n', 'utf8') },
  ]);
  const second = rawProducerDigest([
    { path: `${'package'}.json`, content: Buffer.from('{"name":"fixture"}\n', 'utf8') },
    { path: Buffer.from([...Buffer.from('src/alpha.ts')]), content: Buffer.from([0x00, 0x0a, 0xff]) },
  ]);
  assert.equal(first, second);
});

function runtimeAuthorityFixture(): {
  root: string;
  entry: string;
  ownFiles: string[];
  showdownFile: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'producer-runtime-authority-'));
  const entry = path.join(root, 'dist', 'tools', 'grade-positions.js');
  const ownFiles = [path.join(root, 'dist', 'src', 'alpha.js'), path.join(root, 'dist', 'src', 'beta.js')];
  for (const [file, content] of [
    [entry, 'export {};\n'],
    [ownFiles[0]!, 'export const alpha = 1;\n'],
    [ownFiles[1]!, 'export const beta = 2;\n'],
    [path.join(root, 'package.json'), '{"type":"module"}\n'],
    [path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n'],
  ] as const) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  for (const directory of ['sim', 'data', 'lib', 'server', 'config']) {
    fs.cpSync(
      path.resolve('pokemon-showdown', 'dist', directory),
      path.join(root, 'pokemon-showdown', 'dist', directory),
      { recursive: true },
    );
  }
  for (const relative of [
    'showdown.lock.json',
    'pokemon-showdown/dist/.vgc-model-league-revision',
    'pokemon-showdown/node_modules/ts-chacha20/package.json',
    'pokemon-showdown/node_modules/ts-chacha20/build/src/chacha20.js',
  ]) {
    const destination = path.join(root, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.resolve(relative), destination);
  }
  return {
    root,
    entry,
    ownFiles,
    showdownFile: path.join(root, 'pokemon-showdown', 'dist', 'sim', 'index.js'),
  };
}

function captureFixture(fixture: ReturnType<typeof runtimeAuthorityFixture>) {
  return captureRuntimeProducerAuthority(pathToFileURL(fixture.entry).href);
}

test('runtime producer capture rejects unstable or indirect authority inputs', (context) => {
  const stable = runtimeAuthorityFixture();
  context.after(() => fs.rmSync(stable.root, { recursive: true, force: true }));
  assert.match(captureFixture(stable).producerDigest, /^[0-9a-f]{64}$/u);

  const directory = runtimeAuthorityFixture();
  context.after(() => fs.rmSync(directory.root, { recursive: true, force: true }));
  fs.rmSync(directory.entry);
  fs.mkdirSync(directory.entry);
  assert.throws(() => captureFixture(directory));

  const linked = runtimeAuthorityFixture();
  context.after(() => fs.rmSync(linked.root, { recursive: true, force: true }));
  fs.rmSync(linked.entry);
  try {
    fs.symlinkSync(linked.ownFiles[0]!, linked.entry);
  } catch (error) {
    if (['EPERM', 'ENOTSUP', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      context.skip('file symlinks are unavailable');
      return;
    }
    throw error;
  }
  assert.throws(() => captureFixture(linked));

  const changing = runtimeAuthorityFixture();
  context.after(() => fs.rmSync(changing.root, { recursive: true, force: true }));
  const ready = path.join(changing.root, 'mutator-ready');
  const mutator = spawn(
    process.execPath,
    [
      '-e',
      `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(ready)}, ''); setInterval(() => fs.appendFileSync(${JSON.stringify(changing.ownFiles[0]!)}, 'x'), 1);`,
    ],
    { stdio: 'ignore' },
  );
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 5_000;
  while (!fs.existsSync(ready) && Date.now() < deadline) Atomics.wait(sleeper, 0, 0, 5);
  assert.equal(fs.existsSync(ready), true);
  try {
    assert.throws(() => captureFixture(changing));
  } finally {
    mutator.kill();
  }
});

for (const attack of ['add', 'remove', 'rename'] as const) {
  test(`captured runtime authority rejects ${attack} membership`, (context) => {
    const fixture = runtimeAuthorityFixture();
    context.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
    const captured = captureFixture(fixture);
    if (attack === 'add') {
      fs.writeFileSync(path.join(path.dirname(fixture.showdownFile), 'added.js'), 'added\n');
    } else if (attack === 'remove') {
      fs.rmSync(fixture.showdownFile);
    } else {
      fs.renameSync(fixture.showdownFile, `${fixture.showdownFile}.renamed.js`);
    }
    assert.throws(() => captured.assertUnchanged());
  });
}

test('runtime producer capture rejects dirty compiled Showdown bytes', (context) => {
  const fixture = runtimeAuthorityFixture();
  context.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const expected = captureRuntimeProducerAuthority(
    new URL('../tools/grade-positions.js', import.meta.url).href,
  ).showdownRuntimeDigest;
  const captured = captureFixture(fixture);
  assert.equal(captured.showdownRuntimeDigest, expected);
  fs.appendFileSync(fixture.showdownFile, '\ntampered\n');
  assert.throws(() => captured.assertUnchanged());
  assert.throws(() => captureFixture(fixture));
});

test('compiled position tools have distinct identities bound to the pinned Showdown runtime', () => {
  const gradeEntry = new URL('../tools/grade-positions.js', import.meta.url);
  const exporterEntry = new URL('../tools/export-position-panels.js', import.meta.url);
  const grade = captureRuntimeProducerAuthority(gradeEntry.href);
  const exporter = captureRuntimeProducerAuthority(exporterEntry.href);

  assert.equal(exporter.showdownRuntimeDigest, grade.showdownRuntimeDigest);
  grade.assertUnchanged();
  exporter.assertUnchanged();

  const boundary = fs.mkdtempSync(path.join(os.tmpdir(), 'position-export-authority-'));
  const graded = path.join(boundary, 'positions.jsonl');
  fs.writeFileSync(graded, '');
  const baseManifest = {
    schema_version: POSITION_GRADE_SCHEMA_VERSION,
    showdown_commit: (JSON.parse(fs.readFileSync('showdown.lock.json', 'utf8')) as { commit: string }).commit,
    evaluator_digest: grade.producerDigest,
    action_protocol: ACTION_PROTOCOL,
    counterfactual: counterfactualProtocol(),
    exhaustive_panels: EXHAUSTIVE_PANEL_PROTOCOL,
  };
  for (const [manifest, expected] of [
    [
      { ...baseManifest, schema_version: POSITION_GRADE_SCHEMA_VERSION - 1 },
      /graded manifest is not the current schema/u,
    ],
    [{ ...baseManifest, action_protocol: { stale: true } }, /action protocol is not current/u],
    [{ ...baseManifest, evaluator_digest: '0'.repeat(64) }, /evaluator authority is not current/u],
  ] as const) {
    fs.writeFileSync(`${graded}.manifest.json`, JSON.stringify(manifest));
    const result = spawnSync(process.execPath, [fileURLToPath(exporterEntry), '--graded', graded], {
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, expected);
  }

  const unrelatedShowdown = fs.mkdtempSync(path.join(os.tmpdir(), 'producer-unrelated-showdown-'));
  for (const entry of [gradeEntry, exporterEntry]) {
    const result = spawnSync(process.execPath, [fileURLToPath(entry), '--ps-dir', unrelatedShowdown], {
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /does not match captured producer runtime/u);
  }
});
