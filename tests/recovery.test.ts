import assert from 'node:assert/strict';
import test from 'node:test';

import { pauseScope, RecoveryGate } from '../src/recovery.js';

const settled = async (promise: Promise<void>): Promise<boolean> => {
  let done = false;
  void promise.then(() => {
    done = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  return done;
};

test('pause scopes widen to the provider only for shared-credit failures', () => {
  assert.equal(pauseScope('openrouter:google/gemini-3.6-flash', 'upstream'), 'openrouter:google/gemini-3.6-flash');
  assert.equal(pauseScope('openrouter:google/gemini-3.6-flash', 'network'), 'openrouter:google/gemini-3.6-flash');
  assert.equal(pauseScope('openrouter:moonshotai/kimi-k3:nitro', 'rate_limit'), 'openrouter:moonshotai/kimi-k3:nitro');
  assert.equal(pauseScope('prime:Qwen/Qwen3-32B', 'rate_limit'), 'prime:Qwen/Qwen3-32B');
  assert.equal(pauseScope('prime:Qwen/Qwen3-32B', 'quota'), 'prime');
});

test('a model pause blocks only that seat while others keep playing', async () => {
  const gate = new RecoveryGate();
  const paused = gate.pause('openrouter:google/gemini-3.6-flash', { kind: 'upstream', summary: 'hollow response' });
  assert.equal(await settled(gate.wait('openrouter:x-ai/grok-4.5')), true);
  assert.equal(await settled(gate.wait('openrouter:google/gemini-3.6-flash')), false);
  assert.equal(gate.resume('openrouter:google/gemini-3.6-flash'), true);
  assert.equal(await settled(paused), true);
});

test('a quota pause holds every seat on the same provider', async () => {
  const gate = new RecoveryGate();
  void gate.pause('prime:Qwen/Qwen3-32B', { kind: 'quota', summary: 'credits exhausted' });
  assert.equal(await settled(gate.wait('prime:Qwen/Qwen3-235B-A22B')), false);
  assert.equal(await settled(gate.wait('openrouter:x-ai/grok-4.5')), true);
  gate.resume('prime');
  assert.equal(await settled(gate.wait('prime:Qwen/Qwen3-235B-A22B')), true);
});

test('concurrent pauses resume independently and listeners see the remainder', async () => {
  const gate = new RecoveryGate();
  const events: Array<string | undefined> = [];
  gate.onChange((pause) => events.push(pause?.scope));
  void gate.pause('openrouter:minimax/minimax-m3', { kind: 'upstream', summary: 'flake' });
  void gate.pause('prime:Qwen/Qwen3-32B', { kind: 'rate_limit', summary: '429' });
  assert.deepEqual(events, ['openrouter:minimax/minimax-m3', 'prime:Qwen/Qwen3-32B']);
  gate.resume('openrouter:minimax/minimax-m3');
  assert.equal(events.at(-1), 'prime:Qwen/Qwen3-32B');
  assert.equal(await settled(gate.wait('prime:Qwen/Qwen3-32B')), false);
  gate.resume();
  assert.equal(events.at(-1), undefined);
  assert.equal(gate.paused, undefined);
});
