import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  emptyMemory,
  MEMORY_LIMITS,
  memoryDigest,
  parseMemoryReply,
  readMemoryPage,
  renderMemory,
  validateMemory,
} from '../src/franchise-memory.js';

test('memory digests are independent of page order', () => {
  const a = { notebook: 'n', 'opp.alpha': 'x', lessons: 'y' };
  const b = { lessons: 'y', notebook: 'n', 'opp.alpha': 'x' };
  assert.equal(memoryDigest(a), memoryDigest(b));
  assert.notEqual(memoryDigest(a), memoryDigest({ ...a, lessons: 'z' }));
});

test('memory limits reject with the reason instead of clipping', () => {
  assert.equal(validateMemory(emptyMemory('x'.repeat(MEMORY_LIMITS.pageChars))), undefined);
  assert.match(String(validateMemory(emptyMemory('x'.repeat(MEMORY_LIMITS.pageChars + 1)))), /limit is 8000/);
  assert.match(String(validateMemory({ notebook: '', 'Bad Name': 'x' })), /page name "Bad Name"/);
  const many: Record<string, string> = { notebook: '' };
  for (let index = 0; index < MEMORY_LIMITS.pages; index += 1) many[`p${index}`] = 'x';
  assert.match(String(validateMemory(many)), /17 pages; the limit is 16/);
  const heavy: Record<string, string> = { notebook: '' };
  for (let index = 0; index < 7; index += 1) heavy[`p${index}`] = 'x'.repeat(MEMORY_LIMITS.pageChars);
  assert.match(String(validateMemory(heavy)), /totals 56000 characters/);
});

test('a reply without pages keeps them and a reply with pages replaces all of them', () => {
  const current = { notebook: 'old', lessons: 'keep', scouting: 'drop' };
  const kept = parseMemoryReply({ notebook: ' new ' }, current);
  assert.ok(typeof kept !== 'string');
  assert.deepEqual(kept.memory, { notebook: 'new', lessons: 'keep', scouting: 'drop' });
  assert.equal(kept.changed, true);
  const replaced = parseMemoryReply({ notebook: 'old', pages: { lessons: 'revised' } }, current);
  assert.ok(typeof replaced !== 'string');
  assert.deepEqual(replaced.memory, { notebook: 'old', lessons: 'revised' });
  const unchanged = parseMemoryReply({ notebook: 'old' }, current);
  assert.ok(typeof unchanged !== 'string');
  assert.equal(unchanged.changed, false);
  assert.match(String(parseMemoryReply({ notebook: 'n', pages: { notebook: 'x' } }, current)), /may not contain/);
  assert.match(String(parseMemoryReply({ notebook: 'n', pages: ['x'] }, current)), /must be an object/);
  assert.match(String(parseMemoryReply({ pages: {} }, current)), /"notebook" must be a string/);
});

test('the prompt shows the notebook in full and indexes the other pages', () => {
  const memory = { notebook: 'Lead Garchomp.', 'opp.beta': 'Beta brings Trick Room.\nSecond line.', lessons: '' };
  const index = renderMemory(memory).join('\n');
  assert.match(index, /^YOUR NOTEBOOK:\nLead Garchomp\./);
  assert.match(
    index,
    /YOUR MEMORY PAGES \(name \| characters \| first line\):\n- lessons \| 0 \| \n- opp\.beta \| 36 \| Beta brings Trick Room\./,
  );
  assert.doesNotMatch(index, /Second line/);
  assert.match(
    renderMemory(memory, 'full').join('\n'),
    /YOUR MEMORY PAGE opp\.beta:\nBeta brings Trick Room\.\nSecond line\./,
  );
  assert.deepEqual(renderMemory(emptyMemory()), ['YOUR NOTEBOOK:', '(empty)']);
  assert.equal(readMemoryPage(memory, { name: 'opp.beta' }), 'Beta brings Trick Room.\nSecond line.');
  assert.equal(readMemoryPage(memory, { name: 'lessons' }), '(empty)');
  assert.match(
    readMemoryPage(memory, { name: 'missing' }),
    /no page named "missing". Your pages: notebook, lessons, opp.beta/,
  );
});
