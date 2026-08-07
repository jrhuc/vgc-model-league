import type { Battle } from 'pokemon-showdown';

import { defaultPsDir } from '../paths.js';
import { type Rng, seededRng, shuffle } from '../random.js';
import type { BattleRequest, Pid } from '../types.js';
import { legalActions, openPosition, type Position, pendingSides, playJoint } from './fork.js';

export const COUNTERFACTUAL_PROTOCOL_VERSION = 3;

export const REFERENCE = {
  hiddenState: 'realized',
  continuation: 'uniform-random-non-concession',
  opponent: 'actual-or-sampled-uniform-legal-when-simultaneous',
  value: 'material-differential',
} as const;

export interface CounterfactualOptions {
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
  rolloutLimit: 60,
} as const;

export interface CounterfactualProtocol {
  version: number;
  reference: typeof REFERENCE;
  horizon: number | 'end';
  luckSamples: number;
  opponentSamples: number;
  shortlist: number;
  screenSamples: number;
  rolloutLimit: number;
}

export function counterfactualProtocol(options: CounterfactualOptions = {}): CounterfactualProtocol {
  const horizon = options.horizon ?? DEFAULTS.horizon;
  return {
    version: COUNTERFACTUAL_PROTOCOL_VERSION,
    reference: REFERENCE,
    horizon: horizon === Number.POSITIVE_INFINITY ? 'end' : horizon,
    luckSamples: options.luckSamples ?? DEFAULTS.luckSamples,
    opponentSamples: options.opponentSamples ?? DEFAULTS.opponentSamples,
    shortlist: options.shortlist ?? DEFAULTS.shortlist,
    screenSamples: options.screenSamples ?? DEFAULTS.screenSamples,
    rolloutLimit: DEFAULTS.rolloutLimit,
  };
}

export interface ActionValue {
  action: string;
  value: number;
  samples: number;
}

export interface ReferenceView {
  chosen: number;
  selected: number;
  selectedAction: string;
  signedGap: number;
  opportunityLoss: number;
  measuredContrast: number;
  discriminating: boolean;
  selectionReversed: boolean;
}

export interface PositionScore {
  pid: Pid;
  turn: number;
  chosen: string;
  legal: number;
  horizon: number;
  stateValue: number;
  vsActualOpponent: ReferenceView;
  vsSampledOpponent: ReferenceView;
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

function policyActions(request: BattleRequest): string[] {
  return legalActions(request);
}

function continueBattle(battle: Battle, turns: number, random: Rng): boolean {
  const stopAfter = battle.turn + turns;
  let steps = 0;
  while (!battle.ended && steps++ < DEFAULTS.rolloutLimit) {
    if (Number.isFinite(turns) && battle.turn >= stopAfter) return true;
    const pending = pendingSides(battle);
    if (!pending.length) return false;
    const picks: Partial<Record<Pid, string>> = {};
    for (const pid of pending) {
      const request = requestOf(battle, pid);
      const actions = request ? policyActions(request) : [];
      if (!actions.length) return false;
      picks[pid] = actions[Math.floor(random() * actions.length)] as string;
    }
    for (const pid of pending) {
      if (!battle.choose(pid, picks[pid] as string)) return false;
      if (battle.ended) return true;
    }
  }
  return battle.ended || (Number.isFinite(turns) && battle.turn >= stopAfter);
}

interface Trial {
  position: Position;
  pid: Pid;
  name: string;
  horizon: number;
  psDir: string;
  seed: string;
}

type OpponentAction = string | null;

function play(trial: Trial, action: string, opponentAction: OpponentAction, draw: number): number | null {
  const battle = openPosition(trial.position, trial.psDir);
  const luck = seededRng(`${trial.seed}:luck:${draw}`);
  const word = () => 1 + Math.floor(luck() * 0xffff);
  battle.resetRNG(`${word()},${word()},${word()},${word()}` as `${number},${string}`);
  const choices: Partial<Record<Pid, string>> = { [trial.pid]: action };
  if (opponentAction !== null) choices[foe(trial.pid)] = opponentAction;
  if (!playJoint(battle, choices)) return null;
  if (trial.horizon > 0 && !continueBattle(battle, trial.horizon, seededRng(`${trial.seed}:continuation:${draw}`))) {
    return null;
  }
  return value(battle, trial.pid, trial.name);
}

function average(
  trial: Trial,
  action: string,
  opponents: OpponentAction[],
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

interface SearchBudget {
  luckSamples: number;
  shortlist: number;
  screenSamples: number;
}

function search(
  trial: Trial,
  actions: string[],
  chosen: string,
  selectionOpponents: OpponentAction[],
  measurementOpponents: OpponentAction[],
  budget: SearchBudget,
): ReferenceView | null {
  const screened: ActionValue[] = [];
  for (const action of actions) {
    const result = average(trial, action, selectionOpponents, budget.screenSamples, 0);
    if (result) screened.push(result);
  }
  if (!screened.length) return null;
  screened.sort((a, b) => b.value - a.value || a.action.localeCompare(b.action));
  const shortlist = new Set(screened.slice(0, budget.shortlist).map((entry) => entry.action));

  const refined: ActionValue[] = [];
  for (const action of actions) {
    if (!shortlist.has(action)) continue;
    const result = average(trial, action, selectionOpponents, budget.luckSamples, 1_000);
    if (result) refined.push(result);
  }
  refined.sort((a, b) => b.value - a.value || a.action.localeCompare(b.action));
  const selectedAction = refined[0]?.action;
  const selectedWorst = screened.at(-1)?.action;
  if (!selectedAction || !selectedWorst) return null;

  const measured = new Map<string, ActionValue>();
  for (const action of new Set([chosen, selectedAction, selectedWorst])) {
    const result = average(trial, action, measurementOpponents, budget.luckSamples, 2_000);
    if (!result) return null;
    measured.set(action, result);
  }
  const chosenValue = measured.get(chosen) as ActionValue;
  const selectedValue = measured.get(selectedAction) as ActionValue;
  const worstValue = measured.get(selectedWorst) as ActionValue;
  const signedGap = selectedValue.value - chosenValue.value;
  const measuredContrast = Math.abs(selectedValue.value - worstValue.value);
  return {
    chosen: chosenValue.value,
    selected: selectedValue.value,
    selectedAction,
    signedGap,
    opportunityLoss: Math.max(0, signedGap),
    measuredContrast,
    discriminating: measuredContrast > 0,
    selectionReversed: signedGap < 0,
  };
}

function sampleOpponents(actions: string[], count: number, random: Rng): string[] {
  if (count >= actions.length) return shuffle(actions, random);
  return shuffle(actions, random).slice(0, count);
}

export function evaluatePosition(
  position: Position,
  pid: Pid,
  options: CounterfactualOptions = {},
  submittedAction = position.actual[pid],
): PositionScore | null {
  const psDir = options.psDir ?? defaultPsDir();
  const protocol = counterfactualProtocol(options);
  const horizon = protocol.horizon === 'end' ? Number.POSITIVE_INFINITY : protocol.horizon;
  const random = seededRng(options.seed ?? `${position.index}:${pid}`);
  const request = position.requests[pid];
  const chosen = submittedAction ?? position.actual[pid];
  if (!request || !chosen) return null;
  const actions = legalActions(request);
  if (!actions.includes(chosen)) return null;

  const opened = openPosition(position, psDir);
  const trial: Trial = {
    position,
    pid,
    name: opened.getSide(pid).name,
    horizon,
    psDir,
    seed: String(options.seed ?? `${position.index}:${pid}`),
  };
  const stateValue = value(opened, pid, trial.name);
  const simultaneous = position.pending.includes(foe(pid));
  const opponentRequest = position.requests[foe(pid)];
  const opponentLegal = simultaneous ? policyActions(opponentRequest) : [];
  const selectionField: OpponentAction[] = simultaneous
    ? sampleOpponents(opponentLegal, protocol.opponentSamples, random)
    : [null];
  const measurementField: OpponentAction[] = simultaneous
    ? sampleOpponents(opponentLegal, protocol.opponentSamples, random)
    : [null];
  if (!selectionField.length || !measurementField.length) return null;

  const budget = {
    luckSamples: protocol.luckSamples,
    shortlist: protocol.shortlist,
    screenSamples: protocol.screenSamples,
  };
  const actualOpponent = simultaneous ? position.actual[foe(pid)] : null;
  if (actualOpponent === undefined) return null;
  const actual: OpponentAction[] = [actualOpponent];
  const vsActualOpponent = search(trial, actions, chosen, actual, actual, budget);
  const vsSampledOpponent = search(trial, actions, chosen, selectionField, measurementField, budget);
  if (!vsActualOpponent || !vsSampledOpponent) return null;
  return {
    pid,
    turn: position.turn,
    chosen,
    legal: actions.length,
    horizon,
    stateValue,
    vsActualOpponent,
    vsSampledOpponent,
  };
}
