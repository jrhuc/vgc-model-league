import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FROZEN_CIRCUIT_MAX_CONSTRUCTION_ATTEMPTS,
  FROZEN_CIRCUIT_MAX_DRAFT_ATTEMPTS,
  FROZEN_CIRCUIT_MAX_PROMPT_BYTES,
  type FrozenCircuitPendingTurn,
  FrozenCircuitReferee,
} from '../src/frozen-circuit-referee.js';
import { FROZEN_MATCHDAY_NOTEBOOK_LIMIT } from '../src/frozen-matchday-referee.js';

function firstCommand(turn: FrozenCircuitPendingTurn): string {
  const marker = 'AUTHORITY-ACCEPTED COMMANDS:\n';
  const offset = turn.prompt.lastIndexOf(marker);
  assert.ok(offset >= 0);
  const commands = JSON.parse(turn.prompt.slice(offset + marker.length)) as string[];
  assert.ok(commands.length > 0);
  return commands[0]!;
}

function deterministicResponse(turn: FrozenCircuitPendingTurn): string {
  if (turn.kind === 'action') return firstCommand(turn);
  if (turn.kind === 'notebook') return '{}';
  throw new Error(`unexpected ${turn.kind} turn`);
}

function containsObjectKey(value: unknown, key: string): boolean {
  if (Array.isArray(value)) return value.some((entry) => containsObjectKey(entry, key));
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return Object.hasOwn(record, key) || Object.values(record).some((entry) => containsObjectKey(entry, key));
}

test('Victory Road scenario completes all seven conditional Bo3 series through frozen authorities', () => {
  const referee = new FrozenCircuitReferee({
    scenarioId: 'victory-road-top8-v1',
    episodeId: 'fixed-lifecycle',
    seed: 0,
  });
  let submissions = 0;
  let diagnosedNotebookOmissions = 0;
  const privateNotebookSubmissions = [
    'not JSON',
    JSON.stringify({ notebookReplacement: 'x'.repeat(FROZEN_MATCHDAY_NOTEBOOK_LIMIT + 1) }),
  ];
  while (!referee.terminalEvidence() && submissions < 2_000) {
    const turns = referee.pendingTurns();
    assert.ok(turns.length > 0);
    for (const turn of turns) {
      assert.ok(Buffer.byteLength(turn.prompt, 'utf8') <= FROZEN_CIRCUIT_MAX_PROMPT_BYTES);
      const retainedNotebook = referee.observe(turn.seatId).private.notebook;
      const omittedNotebook =
        turn.kind === 'notebook' ? (privateNotebookSubmissions[diagnosedNotebookOmissions] ?? null) : null;
      const result = referee.submit(turn.turnId, turn.seatId, omittedNotebook ?? deterministicResponse(turn));
      if (omittedNotebook !== null) {
        assert.equal(result.accepted, false);
        assert.equal(result.defaulted, false);
        assert.ok(result.diagnostic);
        assert.equal(referee.observe(turn.seatId).private.notebook, retainedNotebook);
        diagnosedNotebookOmissions += 1;
      }
      submissions += 1;
      if (result.terminal) break;
    }
  }
  assert.equal(diagnosedNotebookOmissions, 2);
  const terminal = referee.terminalEvidence();
  assert.ok(terminal);
  assert.equal(terminal.summary.series.length, 7);
  assert.deepEqual(
    terminal.summary.series.map((series) => series.seriesIndex).sort((left, right) => left - right),
    [0, 1, 2, 3, 4, 5, 6],
  );
  assert.ok(terminal.summary.series.every((series) => series.gameCount >= 2 && series.gameCount <= 9));
  assert.ok(terminal.summary.series.every((series) => series.games.length === series.gameCount));
  assert.ok(terminal.summary.series.every((series) => series.acceptedJoins.length === 2));
  assert.equal(
    terminal.summary.perSeat.reduce((sum, seat) => sum + seat.total.series.wins, 0),
    7,
  );
  assert.equal(terminal.summary.turnReceipts.length, submissions);
  assert.equal(terminal.summary.defaults.filter((entry) => entry.kind === 'action').length, 0);
  for (const privateKey of ['packedTeam', 'seriesSeeds', 'notebookReplacement', 'authoritativeLog']) {
    assert.equal(containsObjectKey(terminal.summary, privateKey), false);
  }
  const published = JSON.stringify(terminal.summary);
  for (const privateResponse of privateNotebookSubmissions) assert.equal(published.includes(privateResponse), false);
  assert.equal(terminal.privateEvidence.series.length, 7);
  assert.ok(
    terminal.privateEvidence.series.every(
      ({ evidence }) =>
        evidence.requireWinner === true &&
        evidence.result.type === 'win' &&
        evidence.gameSeeds.length === evidence.games.length,
    ),
  );
  assert.ok(terminal.summary.perSeat.every((seat) => seat.name === seat.seatId));
  assert.ok(
    terminal.summary.perSeat.every(
      (seat) =>
        seat.reward.name === 'tournament_series_return_v1' &&
        seat.reward.value === (seat.topCut.series.wins - seat.topCut.series.losses) / 3,
    ),
  );
});

test('draft replies receive a bounded retry then a separately recorded deterministic legal default', () => {
  const referee = new FrozenCircuitReferee({ scenarioId: 'draft-league-v1', episodeId: 'draft-retry', seed: 4 });
  const first = referee.pendingTurns();
  assert.equal(first.length, 1);
  assert.equal(first[0]!.kind, 'draft');
  assert.equal(first[0]!.attempt, 1);
  const rejected = referee.submit(first[0]!.turnId, first[0]!.seatId, 'not JSON');
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.advanced, false);
  assert.equal(rejected.defaulted, false);
  assert.ok(rejected.problems?.length);

  const retry = referee.pendingTurns();
  assert.equal(retry.length, 1);
  assert.equal(retry[0]!.attempt, FROZEN_CIRCUIT_MAX_DRAFT_ATTEMPTS);
  assert.notEqual(retry[0]!.turnId, first[0]!.turnId);
  assert.match(retry[0]!.prompt, /RETRY 2\/2/u);
  const defaulted = referee.submit(retry[0]!.turnId, retry[0]!.seatId, 'still invalid');
  assert.equal(defaulted.accepted, false);
  assert.equal(defaulted.advanced, true);
  assert.equal(defaulted.defaulted, true);
  assert.equal(referee.observe(first[0]!.seatId).private.roster.length, 1);
  assert.equal(FROZEN_CIRCUIT_MAX_CONSTRUCTION_ATTEMPTS, 2);
});

test('blind construction waves expose at most one pending turn per seat', () => {
  const referee = new FrozenCircuitReferee({ scenarioId: 'draft-league-v1', episodeId: 'construction-waves', seed: 2 });
  let constructionReceipts = 0;
  for (let steps = 0; steps < 1_000; steps += 1) {
    const turns = referee.pendingTurns();
    const seatIds = turns.map((turn) => turn.seatId);
    assert.equal(new Set(seatIds).size, seatIds.length);
    if (turns[0]?.kind === 'action') break;
    for (const turn of turns) {
      const response = turn.kind === 'draft' || turn.kind === 'construction' ? 'invalid' : '{}';
      referee.submit(turn.turnId, turn.seatId, response);
      if (turn.kind === 'construction' && turn.attempt === FROZEN_CIRCUIT_MAX_CONSTRUCTION_ATTEMPTS) {
        constructionReceipts += 1;
      }
    }
  }
  assert.equal(constructionReceipts, 24);
  assert.ok(referee.pendingTurns().every((turn) => turn.kind === 'action'));
});

test('draft league completes 28 blind-batched round-robin series, transactions, and three playoffs', () => {
  const referee = new FrozenCircuitReferee({ scenarioId: 'draft-league-v1', episodeId: 'league-lifecycle', seed: 0 });
  let submissions = 0;
  while (!referee.terminalEvidence() && submissions < 5_000) {
    const turns = referee.pendingTurns();
    assert.ok(turns.length > 0);
    assert.equal(new Set(turns.map((turn) => turn.seatId)).size, turns.length);
    for (const turn of turns) {
      let response = '{}';
      if (turn.kind === 'action') response = firstCommand(turn);
      else if (turn.kind === 'draft' || turn.kind === 'construction') response = 'invalid';
      else if (turn.kind === 'trade_offer') response = '{"offer":null}';
      else if (turn.kind === 'trade_response') response = '{"accept":false}';
      else if (turn.kind === 'free_agency') response = '{"swaps":[]}';
      const result = referee.submit(turn.turnId, turn.seatId, response);
      submissions += 1;
      if (result.terminal) break;
    }
  }
  const terminal = referee.terminalEvidence();
  assert.ok(terminal);
  assert.equal(terminal.summary.series.length, 31);
  assert.equal(terminal.summary.series.filter((series) => series.stage === 'roundrobin').length, 28);
  assert.equal(terminal.summary.series.filter((series) => series.stage === 'playoff').length, 3);
  assert.deepEqual(
    [
      ...new Set(
        terminal.summary.series.filter((series) => series.stage === 'roundrobin').map((series) => series.week),
      ),
    ],
    [1, 2, 3, 4, 5, 6, 7],
  );
  assert.equal(terminal.summary.finalStandings?.length, 8);
  assert.ok(terminal.summary.finalStandings?.every((standing) => standing.gameDraws >= 0));
  assert.equal(terminal.summary.bracket.flat().length, 3);
  assert.equal(terminal.summary.transactions?.offers.length, 8);
  assert.equal(terminal.summary.transactions?.freeAgency.length, 8);
  assert.ok(
    terminal.summary.perSeat.every((seat) => {
      const roundRobin = {
        wins: seat.roundRobinPreWindow.series.wins + seat.roundRobinPostWindow.series.wins,
        losses: seat.roundRobinPreWindow.series.losses + seat.roundRobinPostWindow.series.losses,
      };
      return (
        seat.reward.name === 'draft_league_series_return_v1' &&
        seat.reward.value ===
          (roundRobin.wins - roundRobin.losses + seat.playoffs.series.wins - seat.playoffs.series.losses) / 9
      );
    }),
  );
  for (const privateKey of ['seriesSeeds', 'packedTeam', 'notebookReplacement', 'authoritativeLog']) {
    assert.equal(containsObjectKey(terminal.summary, privateKey), false);
  }
});

test('scenario seed deterministically binds counterbalancing and independent game blocks', () => {
  const left = new FrozenCircuitReferee({ scenarioId: 'draft-league-v1', episodeId: 'left', seed: 9 });
  const same = new FrozenCircuitReferee({ scenarioId: 'draft-league-v1', episodeId: 'same', seed: 9 });
  const other = new FrozenCircuitReferee({ scenarioId: 'draft-league-v1', episodeId: 'other', seed: 10 });
  assert.equal(left.configDigest, same.configDigest);
  assert.notEqual(left.configDigest, other.configDigest);
  assert.deepEqual(left.pendingTurns(), same.pendingTurns());
});
