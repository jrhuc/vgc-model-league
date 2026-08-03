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
  assert.equal(pauseScope('opencode-go:glm-5.2', 'rate_limit'), 'opencode-go:glm-5.2');
  assert.equal(pauseScope('google:gemini-3.6-flash', 'quota'), 'google');
});

test('a model pause blocks only that seat while others keep playing', async () => {
  const gate = new RecoveryGate();
  const paused = gate.pause('openrouter:google/gemini-3.6-flash', 'upstream', 'hollow response');
  assert.equal(await settled(gate.wait('openrouter:x-ai/grok-4.5')), true);
  assert.equal(await settled(gate.wait('openrouter:google/gemini-3.6-flash')), false);
  assert.equal(gate.resume('openrouter:google/gemini-3.6-flash'), true);
  assert.equal(await settled(paused), true);
});

test('a rate-limit pause holds only the limited model while siblings keep playing', async () => {
  const gate = new RecoveryGate();
  void gate.pause('opencode-go:glm-5.2', 'rate_limit', '429');
  assert.equal(await settled(gate.wait('opencode-go:glm-5.2')), false);
  assert.equal(await settled(gate.wait('opencode-go:kimi-k3')), true);
  gate.resume('opencode-go:glm-5.2');
  assert.equal(await settled(gate.wait('opencode-go:glm-5.2')), true);
});

test('a quota pause holds every seat on the same provider', async () => {
  const gate = new RecoveryGate();
  void gate.pause('opencode-go:glm-5.2', 'quota', 'credits exhausted');
  assert.equal(await settled(gate.wait('opencode-go:kimi-k3')), false);
  assert.equal(await settled(gate.wait('openrouter:x-ai/grok-4.5')), true);
  gate.resume('opencode-go');
  assert.equal(await settled(gate.wait('opencode-go:kimi-k3')), true);
});

test('concurrent pauses resume independently and listeners see the remainder', async () => {
  const gate = new RecoveryGate();
  const events: Array<string | undefined> = [];
  gate.onChange((pause) => events.push(pause?.scope));
  void gate.pause('openrouter:minimax/minimax-m3', 'upstream', 'flake');
  void gate.pause('opencode-go:glm-5.2', 'rate_limit', '429');
  assert.deepEqual(events, ['openrouter:minimax/minimax-m3', 'opencode-go:glm-5.2']);
  gate.resume('openrouter:minimax/minimax-m3');
  assert.equal(events.at(-1), 'opencode-go:glm-5.2');
  assert.equal(await settled(gate.wait('opencode-go:glm-5.2')), false);
  gate.resume();
  assert.equal(events.at(-1), undefined);
  assert.equal(gate.paused, undefined);
});
