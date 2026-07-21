import assert from 'node:assert/strict';
import test from 'node:test';
import { renderDecision, SYSTEM } from '../src/prompts.js';

test('system prompt concentrates strategic and tool policy', () => {
  assert.match(SYSTEM, /complete four-Pokémon modes/);
  assert.match(SYSTEM, /one intended Mega/);
  assert.match(SYSTEM, /lookup_matchup/);
  assert.match(SYSTEM, /estimate_damage/);
  assert.match(SYSTEM, /two reference calculations plus one action-order comparison/);
  assert.match(SYSTEM, /per-turn timer/);
  assert.match(SYSTEM, /free super-effective hit/);
});

test('decision prompt leads with merged state and keeps mechanics compact', () => {
  const prompt = renderDecision({
    seriesContext: 'Series abc; game 1; score p1 0, p2 0',
    state: 'Turn: 1\n- Swampert; types Water/Ground; moves Earthquake [Ground/Physical/100/spread]',
    matchups: ['- Swampert Earthquake: Farigiraf neutral (1x)'],
    transcript: ['Turn 1 begins.'],
    notebook: 'notes',
    slotNames: ['Swampert'],
    menus: [[{ label: 'Protect', part: 'move 1', kind: 'move' }]],
  });
  assert.ok(
    prompt.indexOf('Authoritative battle state and roster reference:') < prompt.indexOf('Active type matchups'),
  );
  assert.ok(prompt.indexOf('Active type matchups') < prompt.indexOf('Choose for Swampert'));
  assert.match(prompt, /"threats"/);
  assert.match(prompt, /notebook":"durable series notes, at most 1600 characters"/);
  assert.equal(prompt.match(/"choices"/g)?.length, 1);
});

test('team preview renders one shared ordered menu', () => {
  const menu = [
    { label: 'Pick Gengar', part: '1', kind: 'team' as const },
    { label: 'Pick Politoed', part: '2', kind: 'team' as const },
    { label: 'Pick Swampert', part: '3', kind: 'team' as const },
  ];
  const prompt = renderDecision({
    state: 'Turn: 0',
    slotNames: ['pick 1', 'pick 2', 'pick 3', 'pick 4'],
    menus: [menu, menu, menu, menu],
  });

  assert.equal(prompt.match(/Pick Gengar/g)?.length, 1);
  assert.match(prompt, /choices 1-2 lead; choices 3-4 back/);
  assert.match(prompt, /Do not combine a lead whose purpose depends on one Mega/);
  assert.match(prompt, /"choices":\[N1,N2,N3,N4\]/);
});
