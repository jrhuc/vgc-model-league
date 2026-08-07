import assert from 'node:assert/strict';
import test from 'node:test';

import { parseRoutingPreferences } from '../src/providers.js';

test('nothing is pinned unless a run asks for it', () => {
  assert.equal(parseRoutingPreferences({} as NodeJS.ProcessEnv), undefined);
});

test('a pinned seat names its stack and refuses to be served by another', () => {
  const routing = parseRoutingPreferences({ VGC_OPENROUTER_PIN: 'deepinfra' } as NodeJS.ProcessEnv);
  assert.deepEqual(routing, { order: ['deepinfra'], allow_fallbacks: false });
});

test('a pin cannot disguise an allowed provider set as one controlled route', () => {
  assert.throws(
    () => parseRoutingPreferences({ VGC_OPENROUTER_PIN: 'deepinfra, together' } as NodeJS.ProcessEnv),
    /exactly one upstream provider/,
  );
});

test('a pin overrides the ordering of the preferences it is combined with', () => {
  const routing = parseRoutingPreferences({
    VGC_OPENROUTER_PROVIDER: '{"order":["novita"],"ignore":["azure"]}',
    VGC_OPENROUTER_PIN: 'deepinfra',
  } as NodeJS.ProcessEnv);
  assert.deepEqual(routing, { order: ['deepinfra'], ignore: ['azure'], allow_fallbacks: false });
});

test('preferences without a pin are passed through as written', () => {
  const routing = parseRoutingPreferences({
    VGC_OPENROUTER_PROVIDER: '{"order":["novita"]}',
  } as NodeJS.ProcessEnv);
  assert.deepEqual(routing, { order: ['novita'] });
});

test('an empty pin is not a pin', () => {
  assert.equal(parseRoutingPreferences({ VGC_OPENROUTER_PIN: '   ' } as NodeJS.ProcessEnv), undefined);
});

test('preferences that are not JSON are refused rather than ignored', () => {
  assert.throws(() => parseRoutingPreferences({ VGC_OPENROUTER_PROVIDER: 'deepinfra' } as NodeJS.ProcessEnv));
  assert.throws(() => parseRoutingPreferences({ VGC_OPENROUTER_PROVIDER: '["deepinfra"]' } as NodeJS.ProcessEnv));
});
