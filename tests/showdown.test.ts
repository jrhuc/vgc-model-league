import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { showdownCommit } from '../src/showdown.js';

test('external Showdown runtime revision discovery remains explicit', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'external-showdown-revision-'));
  const bin = path.join(root, 'bin');
  const runtime = path.join(root, 'runtime');
  fs.mkdirSync(bin);
  fs.mkdirSync(runtime);
  const revision = 'e'.repeat(40);
  const git = path.join(bin, 'git');
  fs.writeFileSync(
    git,
    `#!/bin/sh
printf '%s\n' ${JSON.stringify(revision)}
`,
    'utf8',
  );
  fs.chmodSync(git, 0o755);
  const previous = process.env.PATH;
  try {
    process.env.PATH = `${bin}${path.delimiter}${previous ?? ''}`;
    assert.equal(showdownCommit(runtime), revision);
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  }
});
