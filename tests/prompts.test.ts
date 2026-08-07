import assert from 'node:assert/strict';
import test from 'node:test';
import { renderDecision, SYSTEM, TIMED_SYSTEM } from '../src/prompts.js';

test('system prompt names the tools and reserves timer policy for timed play', () => {
  assert.match(SYSTEM, /lookup_matchup/);
  assert.match(SYSTEM, /estimate_damage/);
  assert.match(SYSTEM, /compare_action_order/);
  assert.doesNotMatch(SYSTEM, /battle timer/);
  assert.match(TIMED_SYSTEM, /battle timer/);
  assert.match(TIMED_SYSTEM, /two reference calculations plus one action-order comparison/);
  assert.ok(TIMED_SYSTEM.startsWith(SYSTEM.split('\n').slice(0, -1).join('\n')));
});

test('decision prompt leads with merged state and keeps mechanics compact', () => {
  const prompt = renderDecision({
    seriesContext: 'Series abc; game 1; score you 0, opponent 0',
    state: 'Turn: 1\n- Swampert; types Water/Ground; moves Earthquake [Ground/Physical/100/spread]',
    matchups: ['- Swampert Earthquake: Farigiraf neutral (1x)'],
    transcript: ['Turn 1 begins.'],
    notebook: 'notes',
    slotNames: ['Swampert'],
    menus: [[{ label: 'Protect', part: 'move 1', kind: 'move' }]],
  });
  assert.ok(
    prompt.indexOf('Authoritative battle state and roster reference:') < prompt.indexOf('Active matchup reference'),
  );
  assert.ok(prompt.indexOf('Active matchup reference') < prompt.indexOf('Choose for Swampert'));
  assert.match(prompt, /only when durable plans changed.*notebook.*complete replacement/);
  assert.doesNotMatch(prompt, /at most \d+ characters/);
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
  assert.match(prompt, /"choices":\[N1,N2,N3,N4\]/);
});
