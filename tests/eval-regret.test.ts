import assert from 'node:assert/strict';
import test from 'node:test';
import {
  type GameSource,
  legalActions,
  newBattle,
  omniscientLog,
  type Position,
  pendingSides,
  replayGame,
} from '../src/eval/fork.js';
import { evaluatePosition, REFERENCE } from '../src/eval/regret.js';
import { loadPool } from '../src/teams.js';
import type { Pid } from '../src/types.js';

const SEED: [number, number, number, number] = [5, 10, 15, 20];
const BUDGET = { luckSamples: 3, screenSamples: 1, shortlist: 3, opponentSamples: 2 };

let cached: Position[] | undefined;

function positions(): Position[] {
  if (cached) return cached;
  const pool = loadPool();
  const [first, second] = pool.teams;
  if (!first || !second) throw new Error('the test pool needs two teams');
  const base: GameSource = {
    format: pool.format,
    seed: SEED,
    names: { p1: 'p1-a', p2: 'p2-b' },
    packed: { p1: first.packed, p2: second.packed },
    choices: { p1: [], p2: [] },
  };

  const battle = newBattle(base);
  const choices: Record<Pid, string[]> = { p1: [], p2: [] };
  let steps = 0;
  while (!battle.ended && steps++ < 400) {
    const pending = pendingSides(battle);
    if (!pending.length) break;
    const taken: Partial<Record<Pid, string>> = {};
    for (const pid of pending) {
      const actions = legalActions(battle.getSide(pid).activeRequest as never);
      const action = actions[Math.min(actions.length - 1, 1)];
      if (action === undefined) throw new Error(`no legal action for ${pid}`);
      taken[pid] = action;
      choices[pid].push(action);
    }
    for (const pid of pending) battle.choose(pid, taken[pid] as string);
  }
  const replay = replayGame({ ...base, choices }, omniscientLog(battle.log));
  assert.equal(replay.verified, true);
  cached = replay.positions;
  return cached;
}

function battleTurn(): Position {
  const position = positions().find((entry) => entry.turn > 0);
  assert.ok(position, 'the scripted game reached a battle turn');
  return position;
}

test('the reference every number is measured against is named, not implied', () => {
  assert.deepEqual(Object.keys(REFERENCE).toSorted(), ['continuation', 'opponent', 'value']);
});

test('regret is non-negative and the chosen action never beats the best found', () => {
  const result = evaluatePosition(battleTurn(), 'p1', { ...BUDGET, horizon: 0 });
  assert.ok(result);
  for (const view of [result.exPost, result.exAnte]) {
    assert.ok(view.regret >= 0);
    assert.ok(view.best >= view.chosen - 1e-9);
    assert.ok(Math.abs(view.regret - Math.max(0, view.best - view.chosen)) < 1e-9);
  }
  assert.ok(result.legal > 1);
  assert.equal(result.horizon, 0);
});

test('the same position and budget grade the same way twice', () => {
  const position = battleTurn();
  const first = evaluatePosition(position, 'p1', { ...BUDGET, horizon: 0, seed: 'fixed' });
  const second = evaluatePosition(position, 'p1', { ...BUDGET, horizon: 0, seed: 'fixed' });
  assert.deepEqual(first, second);
});

test('taking the action the search preferred does not score worse than the one taken', () => {
  const position = battleTurn();
  const graded = evaluatePosition(position, 'p1', { ...BUDGET, horizon: 0, seed: 'fixed' });
  assert.ok(graded);
  if (graded.exPost.bestAction === graded.chosen) {
    assert.equal(graded.exPost.regret, 0);
    return;
  }
  const swapped: Position = { ...position, actual: { ...position.actual, p1: graded.exPost.bestAction } };
  const rerun = evaluatePosition(swapped, 'p1', { ...BUDGET, horizon: 0, seed: 'fixed' });
  assert.ok(rerun);
  assert.ok(rerun.exPost.regret <= graded.exPost.regret + 1e-9);
});

test('a horizon of zero admits that it cannot grade team preview', () => {
  const preview = positions()[0];
  assert.ok(preview);
  assert.equal(preview.turn, 0);

  const myopic = evaluatePosition(preview, 'p1', { ...BUDGET, horizon: 0 });
  assert.ok(myopic);
  assert.equal(myopic.exAnte.discriminating, false);
  assert.equal(myopic.exAnte.regret, 0);

  const played = evaluatePosition(preview, 'p1', { ...BUDGET, horizon: 2 });
  assert.ok(played);
  assert.equal(played.exAnte.discriminating, true);
});

test('a position the recorded action is not legal in is refused rather than graded', () => {
  const position = battleTurn();
  const invented: Position = { ...position, actual: { ...position.actual, p1: 'move 9 9' } };
  assert.equal(evaluatePosition(invented, 'p1', { ...BUDGET, horizon: 0 }), null);
});

test('both sides of the same position are gradeable', () => {
  const position = battleTurn();
  for (const pid of ['p1', 'p2'] as const) {
    const result = evaluatePosition(position, pid, { ...BUDGET, horizon: 0 });
    assert.ok(result);
    assert.equal(result.pid, pid);
    assert.equal(result.chosen, position.actual[pid]);
  }
});
