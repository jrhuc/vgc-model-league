import assert from 'node:assert/strict';
import test from 'node:test';
import { renderDecision, SYSTEM } from '../src/prompts.js';

test('system prompt requires structured search and matchup tools', () => {
  assert.match(SYSTEM, /lookup_matchup/);
  assert.match(SYSTEM, /estimate_damage/);
  assert.match(SYSTEM, /threats/);
  assert.match(SYSTEM, /candidates/);
  assert.match(SYSTEM, /per-turn timer/);
  assert.match(SYSTEM, /free super-effective hit/);
});

test('decision prompt leads with state and keeps mechanics compact', () => {
  const prompt = renderDecision({
    seriesContext: 'Series abc; game 1; score p1 0, p2 0',
    state: 'Turn: 1\nWeather: none',
    matchups: ['- Swampert Earthquake: Farigiraf neutral (1x)'],
    mechanics: ['Compact Showdown reference:', '- Swampert: Water/Ground'],
    transcript: ['Turn 1 begins.'],
    notebook: 'notes',
    slotNames: ['Swampert'],
    menus: [[{ label: 'Protect', part: 'move 1', kind: 'move' }]],
  });
  assert.ok(prompt.indexOf('Current authoritative state:') < prompt.indexOf('Compact Showdown reference'));
  assert.ok(prompt.indexOf('Active type matchups') < prompt.indexOf('Choose for Swampert'));
  assert.match(prompt, /"threats"/);
});
