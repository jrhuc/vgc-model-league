import type { Battle } from 'pokemon-showdown';

import { defaultPsDir } from '../paths.js';
import { type Rng, seededRng } from '../random.js';
import type { BattleRequest, Pid } from '../types.js';
import { legalActions, openPosition, type Position, pendingSides, playJoint } from './fork.js';

/** Every number in this module is a value under a declared reference, never an optimum. The
 * continuation is uniform random play, the opponent model is a uniform draw from the actions the
 * opponent could legally have taken, and luck is averaged rather than replayed. Nothing here knows
 * how to play Pokémon, which is the point: it is a common yardstick, not a stronger player.
 *
 * The search is bounded, so a reported regret is a lower bound on regret under this reference: the
 * best action found is the best of those looked at, and an action the screen ranked badly on few
 * samples is never revisited. */
export const REFERENCE = {
  continuation: 'uniform-random',
  opponent: 'uniform-legal',
  value: 'material-differential',
} as const;

export interface RegretOptions {
  psDir?: string;
  /** Turns of reference continuation played after the joint action before the value is read.
   * Zero measures only what the turn itself did; `Infinity` plays the game out. */
  horizon?: number;
  /** Luck draws averaged per evaluated pair. A single draw would grade the decision on the crit it
   * happened to get. */
  luckSamples?: number;
  /** Opponent actions drawn for the hindsight-free value. */
  opponentSamples?: number;
  /** Actions kept from the cheap screen for a full-precision second pass. */
  shortlist?: number;
  screenSamples?: number;
  seed?: string | number;
}

const DEFAULTS = {
  horizon: 2,
  luckSamples: 8,
  opponentSamples: 4,
  shortlist: 8,
  screenSamples: 2,
  ROLLOUT_LIMIT: 60,
} as const;

export interface ActionValue {
  action: string;
  value: number;
  samples: number;
}

export interface RegretView {
  chosen: number;
  best: number;
  bestAction: string;
  regret: number;
  discriminating: boolean;
}

export interface PositionRegret {
  pid: Pid;
  turn: number;
  chosen: string;
  legal: number;
  horizon: number;
  /** Against the action the opponent actually took. Reads the decision with hindsight the player
   * did not have, so it answers "what did this cost against what happened", not "was it wrong". */
  exPost: RegretView;
  /** Against a uniform draw from the opponent's legal actions. Hindsight-free, and the number a
   * model can be held to. */
  exAnte: RegretView;
}

function foe(pid: Pid): Pid {
  return pid === 'p1' ? 'p2' : 'p1';
}

function material(battle: Battle, pid: Pid): number {
  const side = battle.getSide(pid);
  let total = 0;
  for (const pokemon of side.pokemon) total += pokemon.hp > 0 ? pokemon.hp / pokemon.maxhp : 0;
  return side.pokemon.length ? total / side.pokemon.length : 0;
}

/** A finished game is worth its result; an unfinished one is worth the material it left standing.
 * Both land in [-1, 1] so a horizon that sometimes ends the game stays on one scale. */
function value(battle: Battle, pid: Pid, name: string): number {
  if (battle.ended) {
    if (!battle.winner) return 0;
    return battle.winner === name ? 1 : -1;
  }
  return material(battle, pid) - material(battle, foe(pid));
}

function requestOf(battle: Battle, pid: Pid): BattleRequest | null {
  return (battle.getSide(pid).activeRequest as unknown as BattleRequest | null) ?? null;
}

function continueBattle(battle: Battle, turns: number, random: Rng): void {
  const stopAfter = battle.turn + turns;
  let steps = 0;
  while (!battle.ended && steps++ < DEFAULTS.ROLLOUT_LIMIT) {
    if (Number.isFinite(turns) && battle.turn >= stopAfter) return;
    const pending = pendingSides(battle);
    if (!pending.length) return;
    const picks: Partial<Record<Pid, string>> = {};
    for (const pid of pending) {
      const request = requestOf(battle, pid);
      const actions = request ? legalActions(request) : [];
      if (!actions.length) return;
      picks[pid] = actions[Math.floor(random() * actions.length)] as string;
    }
    for (const pid of pending) {
      if (!battle.choose(pid, picks[pid] as string)) return;
    }
  }
}

interface Trial {
  position: Position;
  pid: Pid;
  name: string;
  horizon: number;
  psDir: string;
}

/** Luck is keyed to the draw rather than to the action, so two candidate actions are compared in the
 * same worlds: the same damage rolls, the same crits, the same reference continuation. */
function play(trial: Trial, action: string, opponentAction: string, draw: number): number | null {
  const battle = openPosition(trial.position, trial.psDir);
  const word = (offset: number) => 1 + ((draw * 7919 + offset * 104_729) % 0xffff);
  battle.resetRNG(`${word(0)},${word(1)},${word(2)},${word(3)}` as `${number},${string}`);
  const choices = { [trial.pid]: action, [foe(trial.pid)]: opponentAction } as Record<Pid, string>;
  if (!playJoint(battle, choices)) return null;
  if (trial.horizon > 0) continueBattle(battle, trial.horizon, seededRng(`continuation:${draw}`));
  return value(battle, trial.pid, trial.name);
}

function average(
  trial: Trial,
  action: string,
  opponents: string[],
  luckSamples: number,
  drawOffset: number,
): ActionValue | null {
  let total = 0;
  let samples = 0;
  for (const [index, opponentAction] of opponents.entries()) {
    for (let luck = 0; luck < luckSamples; luck += 1) {
      const result = play(trial, action, opponentAction, drawOffset + index * luckSamples + luck);
      if (result === null) return null;
      total += result;
      samples += 1;
    }
  }
  return samples ? { action, value: total / samples, samples } : null;
}

/** Picking the best of many noisy estimates and then quoting that estimate overstates it, and the
 * overstatement grows with the number of candidates — which varies by position type, so it would not
 * even cancel. Selection and measurement are therefore split: a cheap screen and a refining pass
 * choose the action, and the value that enters the regret comes from draws neither pass has seen. */
function search(
  trial: Trial,
  actions: string[],
  chosen: string,
  opponents: string[],
  options: Required<Pick<RegretOptions, 'luckSamples' | 'shortlist' | 'screenSamples'>>,
): RegretView | null {
  const screened: ActionValue[] = [];
  for (const action of actions) {
    const result = average(trial, action, opponents, options.screenSamples, 0);
    if (result) screened.push(result);
  }
  screened.sort((a, b) => b.value - a.value);
  const shortlist = new Set(screened.slice(0, options.shortlist).map((entry) => entry.action));
  shortlist.add(chosen);

  let leader: ActionValue | null = null;
  for (const action of actions) {
    if (!shortlist.has(action)) continue;
    const result = average(trial, action, opponents, options.luckSamples, 1_000);
    if (result && (!leader || result.value > leader.value)) leader = result;
  }
  if (!leader) return null;

  const measured = [chosen, leader.action].map((action) =>
    average(trial, action, opponents, options.luckSamples, 2_000),
  );
  const [chosenValue, bestValue] = measured;
  if (!chosenValue || !bestValue) return null;
  return {
    chosen: chosenValue.value,
    best: bestValue.value,
    bestAction: leader.action,
    regret: Math.max(0, bestValue.value - chosenValue.value),
    /** False when no candidate could be told from any other, which is what horizon zero has to say
     * about team preview and forced switches: nothing has resolved yet. */
    discriminating: screened.length > 1 && screened[0]!.value !== screened.at(-1)!.value,
  };
}

export function evaluatePosition(position: Position, pid: Pid, options: RegretOptions = {}): PositionRegret | null {
  const psDir = options.psDir ?? defaultPsDir();
  const horizon = options.horizon ?? DEFAULTS.horizon;
  const luckSamples = options.luckSamples ?? DEFAULTS.luckSamples;
  const opponentSamples = options.opponentSamples ?? DEFAULTS.opponentSamples;
  const shortlist = options.shortlist ?? DEFAULTS.shortlist;
  const screenSamples = options.screenSamples ?? DEFAULTS.screenSamples;
  const random = seededRng(options.seed ?? `${position.index}:${pid}`);

  const actions = legalActions(position.requests[pid]);
  const chosen = position.actual[pid];
  if (!actions.includes(chosen)) return null;

  const trial: Trial = { position, pid, name: openPosition(position, psDir).getSide(pid).name, horizon, psDir };

  const opponentLegal = legalActions(position.requests[foe(pid)]);
  /** One draw of opponent actions serves every candidate, so the hindsight-free comparison is made
   * against the same field rather than against a fresh sample per action. */
  const field = Array.from(
    { length: Math.min(opponentSamples, opponentLegal.length) },
    () => opponentLegal[Math.floor(random() * opponentLegal.length)] as string,
  );
  if (!field.length) return null;

  const budget = { luckSamples, shortlist, screenSamples };
  const exPost = search(trial, actions, chosen, [position.actual[foe(pid)]], budget);
  const exAnte = search(trial, actions, chosen, field, budget);
  if (!exPost || !exAnte) return null;

  return { pid, turn: position.turn, chosen, legal: actions.length, horizon, exPost, exAnte };
}
