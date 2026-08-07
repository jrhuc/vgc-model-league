import assert from 'node:assert/strict';
import test from 'node:test';

import {
  type GameSource,
  legalActionEntries,
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

test('extra or rejected recorded choices cannot verify against an unchanged log', () => {
  const base = source();
  const { choices, log } = scripted(base);
  const trailing = { p1: [...choices.p1, 'move 1'], p2: choices.p2 };
  assert.equal(replayGame({ ...base, choices: trailing }, log).verified, false);

  const rejected = { p1: ['move 999', ...choices.p1], p2: choices.p2 };
  assert.equal(replayGame({ ...base, choices: rejected }, log).verified, false);
});

test('a truncated choice list is reported rather than passed off as a finished game', () => {
  const base = source();
  const { choices, log } = scripted(base);
  const replay = replayGame({ ...base, choices: { p1: choices.p1.slice(0, 1), p2: choices.p2.slice(0, 1) } }, log);
  assert.equal(replay.ranOutOfChoices, true);
  assert.equal(replay.verified, false);
});

test('every recorded position carries each requested side action and choice index', () => {
  const base = source();
  const { choices, log } = scripted(base);
  const { positions } = replayGame({ ...base, choices }, log);

  const preview = positions[0];
  assert.equal(preview?.turn, 0);
  assert.equal(preview?.requests.p1.teamPreview, true);
  assert.equal(preview?.actual.p1, choices.p1[0]);
  assert.equal(preview?.actual.p2, choices.p2[0]);
  for (const [index, position] of positions.entries()) assert.equal(position.index, index);

  for (const position of positions) {
    for (const pid of position.pending) {
      const choiceIndex = position.choiceIndex[pid];
      assert.notEqual(choiceIndex, undefined);
      assert.equal(choices[pid][choiceIndex as number], position.actual[pid]);
    }
  }
});

test('one-sided replacement requests remain decision positions', () => {
  const base = source();
  const { choices, log } = scripted(base);
  const { positions } = replayGame({ ...base, choices }, log);
  const replacement = positions.find((position) => position.pending.length === 1);
  assert.ok(replacement, 'the scripted game reached a one-sided replacement');
  const pid = replacement.pending[0] as Pid;
  assert.equal(replacement.actual[pid], choices[pid][replacement.choiceIndex[pid] as number]);
  assert.ok(legalActions(replacement.requests[pid]).includes(replacement.actual[pid] as string));
});

test('the counterfactual action set contains each offered legal command once', () => {
  const base = source();
  const { choices, log } = scripted(base);
  const { positions } = replayGame({ ...base, choices }, log);
  const turn = positions.find((position) => position.turn > 0 && position.pending.length === 2);
  assert.ok(turn, 'the scripted game reached a battle turn');

  const actions = legalActions(turn.requests.p1);
  assert.ok(actions.length > 1);
  assert.ok(actions.includes(turn.actual.p1 as string));
  assert.equal(new Set(actions).size, actions.length);
  assert.ok(!actions.includes('forfeit'));
  assert.ok(actions.every((action) => (action.match(/ mega/g) ?? []).length <= 1));
  const entries = legalActionEntries(turn.requests.p1);
  assert.deepEqual(
    entries.map((entry) => entry.command),
    actions,
  );
  assert.deepEqual(
    entries.map((entry) => entry.number),
    entries.map((_, index) => index),
  );
  assert.ok(entries.every((entry) => entry.label));
  assert.deepEqual(actions, [...actions].sort((a, b) => Buffer.from(a).compare(Buffer.from(b))));
});

test('a forced replacement cannot pass every fainted slot while a reserve remains', () => {
  const request = {
    forceSwitch: [true, true],
    side: {
      name: 'Player 1',
      pokemon: [
        { active: true, condition: '0 fnt', details: 'One' },
        { active: true, condition: '0 fnt', details: 'Two' },
        { active: false, condition: '100/100', details: 'Reserve' },
      ],
    },
  } as unknown as BattleRequest;
  assert.deepEqual(legalActions(request).toSorted(), ['pass, switch 3', 'switch 3, pass']);
});

test('every enumerated command is accepted by Showdown at its source position', () => {
  const base = source();
  const { choices, log } = scripted(base);
  const { positions } = replayGame({ ...base, choices }, log);
  const position = positions.find((entry) => entry.turn > 0 && entry.pending.length === 2);
  assert.ok(position);

  for (const pid of ['p1', 'p2'] as const) {
    for (const action of legalActions(position.requests[pid])) {
      const battle = openPosition(position);
      assert.equal(battle.choose(pid, action), true, `${pid} rejected ${action}`);
    }
  }
});

test('a position reopens as a live battle that alternative actions can be played from', () => {
  const base = source();
  const { choices, log } = scripted(base);
  const { positions } = replayGame({ ...base, choices }, log);
  const position = positions.find((entry) => entry.turn > 0 && entry.pending.length === 2);
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
    if (!playJoint(forked, { p1: action, p2: position.actual.p2 as string })) continue;
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
  const position = positions.find((entry) => entry.turn > 0 && entry.pending.length === 2);
  assert.ok(position);

  const battle = openPosition(position);
  assert.equal(playJoint(battle, { p1: 'move 9', p2: position.actual.p2 as string }), false);
});

test('a position records what each side had actually been shown by then', () => {
  const base = source();
  const { choices, log } = scripted(base);
  const replay = replayGame({ ...base, choices }, log);
  assert.equal(replay.verified, true);

  const position = replay.positions.at(-1);
  assert.ok(position);
  for (const pid of ['p1', 'p2'] as const) {
    assert.ok(position.seen[pid] > 0);
    assert.ok(position.seen[pid] <= replay.pov[pid].length);
  }
  assert.ok(
    replay.positions.every((entry, index) => index === 0 || entry.seen.p1 >= replay.positions[index - 1]!.seen.p1),
  );

  const hidden = replay.pov.p2.slice(0, position.seen.p2);
  const omniscient = replay.log.slice(0, position.seen.p2);
  assert.notDeepEqual(hidden, omniscient);
  assert.ok(hidden.length < replay.log.length);
});
