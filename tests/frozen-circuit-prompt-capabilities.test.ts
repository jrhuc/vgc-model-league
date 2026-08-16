import assert from 'node:assert/strict';
import test from 'node:test';

import { connectedDraftPromptRevision } from '../src/draft.js';
import { type CircuitSeat, FROZEN_CIRCUIT_SEAT_IDS } from '../src/frozen-circuit-model.js';
import { FrozenCircuitReferee } from '../src/frozen-circuit-referee.js';
import { FROZEN_CIRCUIT_PROMPT_POLICY } from '../src/frozen-circuit-setup.js';
import { FrozenCircuitTransactions } from '../src/frozen-circuit-transactions.js';
import { FROZEN_MATCHDAY_FORMAT } from '../src/frozen-matchday-referee.js';
import { NO_INTERACTIVE_MECHANICS_TOOLS_NOTICE } from '../src/prompt-capabilities.js';
import { loadShowdown } from '../src/showdown.js';
import { connectedTeamBuildPromptRevision, renderStrictTeamBuildPrompt } from '../src/teambuild.js';
import {
  connectedTradeWindowPromptRevision,
  renderFreeAgencyPrompt,
  renderTradeOfferPrompt,
  type TradeWindowState,
} from '../src/trade-window.js';
import { frozenMatchdayOptions } from './fixtures/frozen-matchday.js';

const Showdown = loadShowdown();

function boardMon(id: string, speciesName: string) {
  const species = Showdown.Dex.species.get(speciesName);
  assert.equal(species.exists, true);
  return {
    id,
    name: species.name,
    species: species.name,
    base: species.baseSpecies,
    types: [...species.types],
    cost: 5,
    origin: 'base' as const,
  };
}

function transactionState(): TradeWindowState {
  const ownedA = boardMon('garchomp', 'Garchomp');
  const ownedB = boardMon('incineroar', 'Incineroar');
  const freeA = boardMon('rillaboom', 'Rillaboom');
  const freeB = boardMon('pelipper', 'Pelipper');
  return {
    board: {
      id: 'prompt-capability-test',
      format: FROZEN_MATCHDAY_FORMAT,
      budget: 10,
      picks: 1,
      source: 'test-only',
      mons: [ownedA, ownedB, freeA, freeB],
    },
    models: ['alpha', 'beta'],
    teamNames: ['alpha', 'beta'],
    rosters: [[ownedA], [ownedB]],
    budgets: [5, 5],
    notebooks: ['', ''],
    standings: [
      { entrant: 0, w: 0, l: 0, gw: 0, gl: 0 },
      { entrant: 1, w: 0, l: 0, gw: 0, gl: 0 },
    ],
    results: [[], []],
    reflections: [[], []],
  };
}

test('frozen draft prompts disclose the null-harness tool boundary', () => {
  const referee = new FrozenCircuitReferee({
    scenarioId: 'draft-league-v1',
    episodeId: 'prompt-capability-test',
    seed: 17,
  });
  const prompt = referee.pendingTurns()[0]!.prompt;
  assert.equal(FROZEN_CIRCUIT_PROMPT_POLICY.mechanicsTools, 'unavailable');
  assert.match(prompt, /No interactive mechanics tools are available in this scaffold/u);
  assert.doesNotMatch(prompt, /You have the Showdown dex tools/u);
});

test('connected draft, construction, and transaction revisions bind tool availability', () => {
  assert.notEqual(connectedDraftPromptRevision('available'), connectedDraftPromptRevision('unavailable'));
  assert.notEqual(
    connectedTeamBuildPromptRevision({ kind: 'general' }, 'open', 'available'),
    connectedTeamBuildPromptRevision({ kind: 'general' }, 'open', 'unavailable'),
  );
  assert.notEqual(connectedTradeWindowPromptRevision('available'), connectedTradeWindowPromptRevision('unavailable'));
});

test('strict construction prompts preserve the local tool arm and expose the frozen no-tool arm', () => {
  const seat = frozenMatchdayOptions().seats[0];
  assert.ok(seat);
  const construction = seat.construction;
  assert.equal(construction.status, 'accepted');
  if (construction.status !== 'accepted') throw new Error('fixture construction must be accepted');
  const available = renderStrictTeamBuildPrompt(construction.artifact.task);
  const unavailable = renderStrictTeamBuildPrompt(construction.artifact.task, { mechanicsTools: 'unavailable' });
  assert.match(available, /You have the Showdown dex tools/u);
  assert.doesNotMatch(available, /No interactive mechanics tools/u);
  assert.match(unavailable, /No interactive mechanics tools are available in this scaffold/u);
  assert.doesNotMatch(unavailable, /You have the Showdown dex tools/u);
});

test('transaction renderers and the frozen transaction coordinator use the declared no-tool arm', () => {
  const state = transactionState();
  const available = renderTradeOfferPrompt(state, 0, 'pokemon-showdown');
  const unavailableOffer = renderTradeOfferPrompt(state, 0, 'pokemon-showdown', {
    mechanicsTools: 'unavailable',
  });
  const unavailableAgency = renderFreeAgencyPrompt(state, 0, 'pokemon-showdown', {
    mechanicsTools: 'unavailable',
  });
  assert.match(available, /You have the same Showdown dex tools as during the draft/u);
  assert.match(unavailableOffer, /No interactive mechanics tools are available in this scaffold/u);
  assert.match(unavailableAgency, /No interactive mechanics tools are available in this scaffold/u);

  const seats: CircuitSeat[] = [
    { seatId: FROZEN_CIRCUIT_SEAT_IDS[0], name: 'alpha', fixedConstruction: null },
    { seatId: FROZEN_CIRCUIT_SEAT_IDS[1], name: 'beta', fixedConstruction: null },
  ];
  const pending = new FrozenCircuitTransactions(state, seats).pending(new Map(), new Map(), 2);
  assert.ok(pending);
  assert.match(pending.prompt, /No interactive mechanics tools are available in this scaffold/u);
  assert.doesNotMatch(pending.prompt, /You have the same Showdown dex tools as during the draft/u);
});

test('the shared no-tool notice is explicit rather than an invisible capability flag', () => {
  assert.match(NO_INTERACTIVE_MECHANICS_TOOLS_NOTICE, /Do not attempt tool calls/u);
});
