import assert from 'node:assert/strict';
import test from 'node:test';

import {
  type GameSource,
  legalActions,
  newBattle,
  omniscientLog,
  openPosition,
  pendingSides,
  playJoint,
  replayGame,
} from '../src/eval/fork.js';
import { loadPool } from '../src/teams.js';
import type { BattleRequest, Pid } from '../src/types.js';

const SEED: [number, number, number, number] = [11, 22, 33, 44];

function source(): GameSource {
  const pool = loadPool();
  const [first, second] = pool.teams;
  if (!first || !second) throw new Error('the test pool needs two teams');
  return {
    format: pool.format,
    seed: SEED,
    names: { p1: 'p1-scripted', p2: 'p2-scripted' },
    packed: { p1: first.packed, p2: second.packed },
    choices: { p1: [], p2: [] },
  };
}

/** Plays the first legal action at every request, which makes the game a fixed function of the
 * seed and the two teams and gives the replay something recorded to be checked against. */
function scripted(base: GameSource): { choices: Record<Pid, string[]>; log: string[] } {
  const battle = newBattle(base);
  const choices: Record<Pid, string[]> = { p1: [], p2: [] };
  let steps = 0;
  while (!battle.ended && steps++ < 400) {
    const pending = pendingSides(battle);
    if (!pending.length) break;
    const taken: Partial<Record<Pid, string>> = {};
    for (const pid of pending) {
      const request = battle.getSide(pid).activeRequest as unknown as BattleRequest;
      const action = legalActions(request)[0];
      if (action === undefined) throw new Error(`no legal action for ${pid}`);
      taken[pid] = action;
      choices[pid].push(action);
    }
    for (const pid of pending) battle.choose(pid, taken[pid] as string);
  }
  return { choices, log: omniscientLog(battle.log) };
}

test('a game replays from its seed, teams and choices line for line', () => {
  const base = source();
  const { choices, log } = scripted(base);
  const replay = replayGame({ ...base, choices }, log);

  assert.equal(replay.verified, true);
  assert.equal(replay.ranOutOfChoices, false);
  assert.ok(replay.positions.length > 0);
  assert.equal(replay.winner, log.some((line) => line.startsWith('|win|')) ? replay.winner : null);
});

test('a replay that is fed a different battle refuses to verify', () => {
  const base = source();
  const { choices, log } = scripted(base);
  const replay = replayGame({ ...base, seed: [1, 2, 3, 4], choices }, log);
  assert.equal(replay.verified, false);
});

test('a truncated choice list is reported rather than passed off as a finished game', () => {
  const base = source();
  const { choices, log } = scripted(base);
  const replay = replayGame({ ...base, choices: { p1: choices.p1.slice(0, 1), p2: choices.p2.slice(0, 1) } }, log);
  assert.equal(replay.ranOutOfChoices, true);
  assert.equal(replay.verified, false);
});

test('every recorded position carries both sides own request and the action each took', () => {
  const base = source();
  const { choices, log } = scripted(base);
  const { positions } = replayGame({ ...base, choices }, log);

  const preview = positions[0];
  assert.equal(preview?.turn, 0);
  assert.equal(preview?.requests.p1.teamPreview, true);
  assert.equal(preview?.actual.p1, choices.p1[0]);
  assert.equal(preview?.actual.p2, choices.p2[0]);
  for (const [index, position] of positions.entries()) assert.equal(position.index, index);
});

test('the action set offered to a regret matrix is the one the model was shown', () => {
  const base = source();
  const { choices, log } = scripted(base);
  const { positions } = replayGame({ ...base, choices }, log);
  const turn = positions.find((position) => position.turn > 0);
  assert.ok(turn, 'the scripted game reached a battle turn');

  const actions = legalActions(turn.requests.p1);
  assert.ok(actions.length > 1);
  assert.ok(actions.includes(turn.actual.p1));
  assert.equal(new Set(actions).size, actions.length);
  assert.ok(!actions.some((action) => action.includes('forfeit')));
});

test('a position reopens as a live battle that alternative actions can be played from', () => {
  const base = source();
  const { choices, log } = scripted(base);
  const { positions } = replayGame({ ...base, choices }, log);
  const position = positions.find((entry) => entry.turn > 0);
  assert.ok(position);

  const hp = (pid: Pid, battle: ReturnType<typeof openPosition>) =>
    battle
      .getSide(pid)
      .pokemon.reduce((total, mon) => total + mon.hp / mon.maxhp, 0)
      .toFixed(4);

  const replayed = openPosition(position);
  assert.equal(playJoint(replayed, position.actual), true);

  const alternatives = legalActions(position.requests.p1).filter((action) => action !== position.actual.p1);
  const outcomes = new Set<string>();
  for (const action of alternatives.slice(0, 12)) {
    const forked = openPosition(position);
    if (!playJoint(forked, { p1: action, p2: position.actual.p2 })) continue;
    outcomes.add(`${hp('p1', forked)}/${hp('p2', forked)}`);
  }
  assert.ok(outcomes.size > 1, 'alternative actions lead somewhere other than the same state');

  const again = openPosition(position);
  assert.equal(playJoint(again, position.actual), true);
  assert.equal(hp('p1', again), hp('p1', replayed));
  assert.equal(hp('p2', again), hp('p2', replayed));
});

test('an illegal action is rejected instead of silently doing something else', () => {
  const base = source();
  const { choices, log } = scripted(base);
  const { positions } = replayGame({ ...base, choices }, log);
  const position = positions.find((entry) => entry.turn > 0);
  assert.ok(position);

  const battle = openPosition(position);
  assert.equal(playJoint(battle, { p1: 'move 9', p2: position.actual.p2 }), false);
});
