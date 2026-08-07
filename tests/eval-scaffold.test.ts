import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readRunScaffold } from '../src/eval/scaffold.js';
import { scaffoldComponents, scaffoldRevision } from '../src/llm-engine.js';

function writeRun(runsDir: string, runId: string, config: Record<string, unknown>): string {
  const runDir = path.join(runsDir, runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'config.json'), JSON.stringify(config), 'utf8');
  return runDir;
}

const COMPONENTS = {
  system: 'a',
  stateRender: 'b',
  toolRender: 'c',
  tools: 'd',
  policy: 'e',
  context: 'f',
  reflection: 'g',
};

test('the live scaffold decomposes into stable component hashes', () => {
  const parts = scaffoldComponents();
  assert.equal(Object.keys(parts).length, 7);
  for (const value of Object.values(parts)) assert.match(value, /^[0-9a-f]{12}$/);
  assert.deepEqual(scaffoldComponents(), parts);
  assert.match(scaffoldRevision(), /^[0-9a-f]{12}$/);
});

test('reads components from config and tolerates runs recorded before the decomposition', () => {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scaffold-'));
  const modern = writeRun(runsDir, 'modern', { scaffold: 'aaaaaaaaaaaa', scaffold_components: COMPONENTS });
  const legacy = writeRun(runsDir, 'legacy', { scaffold: 'bbbbbbbbbbbb' });
  const broken = writeRun(runsDir, 'broken', {});

  assert.deepEqual(readRunScaffold(modern), { revision: 'aaaaaaaaaaaa', components: COMPONENTS });
  assert.deepEqual(readRunScaffold(legacy), { revision: 'bbbbbbbbbbbb', components: null });
  assert.deepEqual(readRunScaffold(broken), { revision: null, components: null });
  assert.deepEqual(readRunScaffold(path.join(runsDir, 'absent')), { revision: null, components: null });
});
