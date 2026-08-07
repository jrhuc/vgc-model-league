import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { cohorts, poolable, type RunScaffold, readRunScaffold } from '../src/eval/scaffold.js';
import { scaffoldComponents, scaffoldRevision } from '../src/llm-engine.js';

function writeRun(runsDir: string, runId: string, config: Record<string, unknown>): string {
  const runDir = path.join(runsDir, runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'config.json'), JSON.stringify(config), 'utf8');
  return runDir;
}

const BASE = {
  system: 'a',
  stateRender: 'b',
  toolRender: 'c',
  tools: 'd',
  policy: 'e',
  reflection: 'f',
};

test('the live scaffold decomposes into stable component hashes', () => {
  const parts = scaffoldComponents();
  assert.equal(Object.keys(parts).length, 6);
  for (const value of Object.values(parts)) assert.match(value, /^[0-9a-f]{12}$/);
  assert.deepEqual(scaffoldComponents(), parts);
  assert.match(scaffoldRevision(), /^[0-9a-f]{12}$/);
});

test('reads components from config and tolerates runs recorded before the decomposition', () => {
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scaffold-'));
  const modern = writeRun(runsDir, 'modern', { scaffold: 'aaaaaaaaaaaa', scaffold_components: BASE });
  const legacy = writeRun(runsDir, 'legacy', { scaffold: 'bbbbbbbbbbbb' });
  const broken = writeRun(runsDir, 'broken', {});

  assert.deepEqual(readRunScaffold(modern), { revision: 'aaaaaaaaaaaa', components: BASE });
  assert.deepEqual(readRunScaffold(legacy), { revision: 'bbbbbbbbbbbb', components: null });
  assert.deepEqual(readRunScaffold(broken), { revision: null, components: null });
  assert.deepEqual(readRunScaffold(path.join(runsDir, 'absent')), { revision: null, components: null });
});

test('a reflection-only revision keeps play metrics poolable and splits reflection metrics', () => {
  const a: RunScaffold = { revision: 'r1', components: BASE };
  const b: RunScaffold = { revision: 'r2', components: { ...BASE, reflection: 'changed' } };

  assert.deepEqual(poolable('calc-fidelity', a, b), { poolable: true, changed: [], reason: 'match' });
  assert.deepEqual(poolable('regret', a, b), { poolable: true, changed: [], reason: 'match' });
  assert.deepEqual(poolable('reflection-quality', a, b), {
    poolable: false,
    changed: ['reflection'],
    reason: 'component-changed',
  });
});

test('a tool revision refuses pooling and names the component that moved', () => {
  const a: RunScaffold = { revision: 'r1', components: BASE };
  const b: RunScaffold = { revision: 'r2', components: { ...BASE, tools: 'changed', toolRender: 'changed' } };
  const verdict = poolable('calc-fidelity', a, b);
  assert.equal(verdict.poolable, false);
  assert.equal(verdict.reason, 'component-changed');
  assert.deepEqual(verdict.changed.toSorted(), ['toolRender', 'tools']);
});

test('undecomposed runs fall back to exact revision equality', () => {
  const legacy: RunScaffold = { revision: 'r1', components: null };
  const same: RunScaffold = { revision: 'r1', components: null };
  const other: RunScaffold = { revision: 'r2', components: null };
  const modern: RunScaffold = { revision: 'r1', components: BASE };

  assert.equal(poolable('calc-fidelity', legacy, same).poolable, true);
  assert.equal(poolable('calc-fidelity', legacy, other).reason, 'revision-changed');
  assert.equal(poolable('calc-fidelity', legacy, modern).poolable, true);
  assert.equal(poolable('calc-fidelity', { revision: null, components: null }, same).reason, 'unknown-scaffold');
});

test('cohorts group by the components a metric reads, largest first', () => {
  const runs = new Map<string, RunScaffold>([
    ['one', { revision: 'r1', components: BASE }],
    ['two', { revision: 'r2', components: { ...BASE, reflection: 'changed' } }],
    ['three', { revision: 'r3', components: { ...BASE, tools: 'changed' } }],
    ['legacy', { revision: 'r9', components: null }],
  ]);

  const play = cohorts('calc-fidelity', runs);
  assert.deepEqual(play[0]?.runs, ['one', 'two']);
  assert.equal(play.length, 3);

  const reflection = cohorts('reflection-quality', runs);
  assert.equal(reflection.length, 4);
});
