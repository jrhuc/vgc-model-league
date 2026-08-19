import assert from 'node:assert/strict';
import test from 'node:test';

import { buildInformationSetPrior, informationSetDrawPlan } from '../src/eval/information-set.js';
import { canonicalJsonDigest } from '../src/serialization.js';

function prior() {
  return buildInformationSetPrior({
    id: 'ots-compatible-spreads',
    revision: 'v1',
    publicInformationDigest: canonicalJsonDigest({ visible: 'state' }),
    completions: [
      {
        id: 'fast',
        hiddenStateDigest: canonicalJsonDigest({ spread: 'fast' }),
        provenance: 'published-prior',
        weight: 3,
      },
      {
        id: 'bulky',
        hiddenStateDigest: canonicalJsonDigest({ spread: 'bulky' }),
        provenance: 'published-prior',
        weight: 1,
      },
    ],
  });
}

test('information-set prior normalizes compatible hidden states and produces common deterministic draws', () => {
  const value = prior();
  assert.equal(value.completions[0]!.normalizedWeight, 0.75);
  assert.equal(value.completions[1]!.normalizedWeight, 0.25);
  const first = informationSetDrawPlan(value, 8, 'seed');
  const second = informationSetDrawPlan(value, 8, 'seed');
  assert.deepEqual(first, second);
  assert.equal(first.filter((draw) => draw.completionId === 'fast').length, 6);
  assert.equal(first.filter((draw) => draw.completionId === 'bulky').length, 2);
  assert.ok(first.every((draw) => draw.battleSeed.every((part) => part >= 1 && part <= 0xffff)));
});

test('information-set prior rejects duplicate or malformed support', () => {
  const digest = canonicalJsonDigest({ visible: 'state' });
  assert.throws(
    () =>
      buildInformationSetPrior({
        id: 'bad',
        revision: 'v1',
        publicInformationDigest: digest,
        completions: [
          { id: 'same', hiddenStateDigest: digest, provenance: 'one', weight: 1 },
          { id: 'same', hiddenStateDigest: digest, provenance: 'two', weight: 1 },
        ],
      }),
    /repeats completion/u,
  );
  const value = prior();
  value.completions[0]!.normalizedWeight = 0.2;
  assert.throws(() => informationSetDrawPlan(value, 2, 'seed'), /digest does not match/u);
});
