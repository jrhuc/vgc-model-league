import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { counterfactualProtocol, EXHAUSTIVE_PANEL_PROTOCOL } from '../src/eval/counterfactual.js';
import { ACTION_PROTOCOL } from '../src/eval/fork.js';
import { POSITION_GRADE_SCHEMA_VERSION } from '../src/eval/positions.js';
import {
  assertPinnedShowdownRuntime,
  captureRuntimeProducerAuthority,
  PRODUCER_DIGEST_PROTOCOL,
  rawProducerDigest,
  showdownRuntimeAuthorityFiles,
  showdownRuntimeDigest,
  stableProducerDigest,
} from '../src/eval/producer.js';

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

test('stable producer reads reject symlinks, directories, and mutation across descriptor stats', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'producer-stable-read-'));
  const regular = path.join(root, 'authority.bin');
  fs.writeFileSync(regular, Buffer.from([0xff, 0x00, 0x0a]));
  assert.match(stableProducerDigest(root, ['authority.bin']), /^[0-9a-f]{64}$/u);
  assert.throws(() => stableProducerDigest(root, ['.']), /regular non-symlink file/u);

  const link = path.join(root, 'authority-link');
  try {
    fs.symlinkSync(regular, link);
  } catch (error) {
    if (['EPERM', 'ENOTSUP', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      context.skip('file symlinks are unavailable');
      return;
    }
    throw error;
  }
  assert.throws(() => stableProducerDigest(root, ['authority-link']), /regular non-symlink file/u);

  const originalRead = fs.readFileSync;
  let mutated = false;
  try {
    fs.readFileSync = ((file: fs.PathOrFileDescriptor, options?: unknown) => {
      const content = originalRead(file, options as never);
      if (typeof file === 'number' && !mutated) {
        mutated = true;
        fs.appendFileSync(regular, Buffer.from([0x01]));
      }
      return content;
    }) as typeof fs.readFileSync;
    assert.throws(() => stableProducerDigest(root, ['authority.bin']), /changed while it was read/u);
  } finally {
    fs.readFileSync = originalRead;
  }
});

test('global restat rejects an OLD-A plus NEW-B hybrid assembled between descriptor reads', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'producer-hybrid-read-'));
  const first = path.join(root, 'a.bin');
  const second = path.join(root, 'b.bin');
  fs.writeFileSync(first, 'OLD-A');
  fs.writeFileSync(second, 'OLD-B');
  const originalClose = fs.closeSync;
  let closes = 0;
  try {
    fs.closeSync = ((descriptor: number) => {
      originalClose(descriptor);
      closes += 1;
      if (closes === 1) {
        fs.writeFileSync(first, 'NEW-A');
        fs.writeFileSync(second, 'NEW-B');
      }
    }) as typeof fs.closeSync;
    assert.throws(() => stableProducerDigest(root, ['a.bin', 'b.bin']), /changed after it was read/u);
  } finally {
    fs.closeSync = originalClose;
  }
});

function minimalShowdownAuthority(): { root: string; mutableFile: string; members: number } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'producer-membership-'));
  for (const directory of ['sim', 'data', 'lib', 'server', 'config']) {
    const target = path.join(root, 'pokemon-showdown', 'dist', directory);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, `${directory}.js`), `module.exports = ${JSON.stringify(directory)};\n`);
  }
  fs.writeFileSync(path.join(root, 'showdown.lock.json'), '{"commit":"0000000000000000000000000000000000000000"}\n');
  fs.writeFileSync(path.join(root, 'pokemon-showdown', 'dist', '.vgc-model-league-revision'), 'test\n');
  const chacha = path.join(root, 'pokemon-showdown', 'node_modules', 'ts-chacha20');
  fs.mkdirSync(path.join(chacha, 'build', 'src'), { recursive: true });
  fs.writeFileSync(path.join(chacha, 'package.json'), '{}\n');
  fs.writeFileSync(path.join(chacha, 'build', 'src', 'chacha20.js'), 'module.exports = {};\n');
  const mutableFile = path.join(root, 'pokemon-showdown', 'dist', 'sim', 'sim.js');
  return { root, mutableFile, members: showdownRuntimeAuthorityFiles(root).length };
}

for (const attack of ['add', 'remove', 'rename'] as const) {
  test(`Showdown snapshot rejects ${attack} membership during its whole-set read`, () => {
    const fixture = minimalShowdownAuthority();
    const originalClose = fs.closeSync;
    let closes = 0;
    let attacked = false;
    try {
      fs.closeSync = ((descriptor: number) => {
        originalClose(descriptor);
        closes += 1;
        if (closes === fixture.members && !attacked) {
          attacked = true;
          if (attack === 'add') {
            fs.writeFileSync(path.join(fixture.root, 'pokemon-showdown', 'dist', 'sim', 'added.js'), 'added\n');
          } else if (attack === 'remove') {
            fs.rmSync(fixture.mutableFile);
          } else {
            fs.renameSync(fixture.mutableFile, `${fixture.mutableFile}.renamed.js`);
          }
        }
      }) as typeof fs.closeSync;
      assert.throws(() => showdownRuntimeDigest(fixture.root), /membership changed/u);
    } finally {
      fs.closeSync = originalClose;
    }
    assert.equal(attacked, true);
  });
}

test('reviewed Showdown runtime digest rejects a dirty compiled runtime copy', () => {
  const repository = path.resolve('.');
  const expected = showdownRuntimeDigest(repository);
  assert.equal(assertPinnedShowdownRuntime(repository), expected);

  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'showdown-runtime-authority-'));
  for (const relative of showdownRuntimeAuthorityFiles(repository)) {
    const source = path.join(repository, relative);
    const destination = path.join(copy, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
  assert.equal(showdownRuntimeDigest(copy), expected);
  assert.equal(assertPinnedShowdownRuntime(copy), expected);
  fs.appendFileSync(path.join(copy, 'pokemon-showdown/dist/sim/index.js'), '\n/* tampered compiled runtime */\n');
  assert.throws(
    () => assertPinnedShowdownRuntime(copy),
    /does not match reviewed .* rebuild with pnpm run setup:showdown/u,
  );
});

test('compiled position tools have distinct identities bound to the pinned Showdown runtime', () => {
  const repository = path.resolve('.');
  const expectedShowdownDigest = assertPinnedShowdownRuntime(repository);
  const gradeEntry = new URL('../tools/grade-positions.js', import.meta.url);
  const exporterEntry = new URL('../tools/export-position-panels.js', import.meta.url);
  const grade = captureRuntimeProducerAuthority(gradeEntry.href);
  const exporter = captureRuntimeProducerAuthority(exporterEntry.href);

  assert.equal(grade.showdownRuntimeDigest, expectedShowdownDigest);
  assert.equal(exporter.showdownRuntimeDigest, expectedShowdownDigest);
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

test('freeze package script runs the canonical Showdown check before the freezer', () => {
  const packageValue = JSON.parse(fs.readFileSync('package.json', 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.equal(
    packageValue.scripts['freeze-frozen-matchday-task-source'],
    'node tools/setup-showdown.mjs --check && node dist/tools/freeze-frozen-matchday-task-source.js',
  );
});
