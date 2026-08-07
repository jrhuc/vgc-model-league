import type { Battle } from 'pokemon-showdown';

import { defaultPsDir } from '../paths.js';
import { type Rng, seededRng } from '../random.js';
import type { BattleRequest, Pid } from '../types.js';
import { legalActions, openPosition, type Position, pendingSides, playJoint } from './fork.js';

export const REFERENCE = {
  continuation: 'uniform-random',
  opponent: 'uniform-legal',
  value: 'material-differential',
} as const;

export interface RegretOptions {
  psDir?: string;
  horizon?: number;
  luckSamples?: number;
  opponentSamples?: number;
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
  spread: number;
  discriminating: boolean;
}

export interface PositionRegret {
  pid: Pid;
  turn: number;
  chosen: string;
  legal: number;
  horizon: number;
  exPost: RegretView;
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
    spread: Math.max(0, (screened[0]?.value ?? 0) - (screened.at(-1)?.value ?? 0)),
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
