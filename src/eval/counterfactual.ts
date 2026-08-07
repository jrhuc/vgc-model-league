import { createHash } from 'node:crypto';

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

export const EXHAUSTIVE_PANEL_PROTOCOL = {
  version: 1,
  panels: ['stability-a', 'stability-b', 'measurement'],
  opponent: 'sampled-uniform-legal-when-simultaneous-or-null-when-unilateral',
  commonRandomNumbers: ['opponent-action', 'battle-rng', 'continuation-rng'],
  completeness: 'rectangular-or-ineligible',
  normalization: '(measurement-mean-min)/(max-min)',
  uncertainty: 'sample-standard-error-and-paired-normal-95-lower-bound',
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

export interface ExhaustiveActionValue {
  action: string;
  value: number;
  standardError: number;
  samples: number;
  reward: number | null;
}

export interface HeldOutGap {
  selectedAction: string;
  alternativeAction: string;
  value: number;
  standardError: number;
  lower95: number;
}

export interface ExhaustiveDraw {
  index: number;
  opponentAction: string | null;
  battleSeed: [number, number, number, number];
  continuationSeed: string;
}

export interface ExhaustivePanel {
  id: 'stability-a' | 'stability-b' | 'measurement';
  seedNamespace: string;
  draws: ExhaustiveDraw[];
  actions: ExhaustiveActionValue[];
  matrix: number[][];
  matrixDigest: string;
  span: number;
}

export interface ExhaustiveActionTable {
  pid: Pid;
  turn: number;
  legal: number;
  horizon: number;
  stateValue: number;
  selectionBest: string;
  measurementBest: string;
  rankingStable: boolean;
  valueSpan: number;
  heldOutGap: HeldOutGap;
  heldOutSpan: HeldOutGap;
  stability: [ExhaustivePanel, ExhaustivePanel];
  measurement: ExhaustivePanel;
  anchorAgreement: boolean;
  maxNormalizedRewardDrift: number | null;
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

function mean(values: readonly number[]): number {
  return values.reduce((sum, entry) => sum + entry, 0) / values.length;
}

function standardError(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const center = mean(values);
  const variance = values.reduce((sum, entry) => sum + (entry - center) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance / values.length);
}

function playDraw(trial: Trial, action: string, draw: ExhaustiveDraw): number | null {
  const battle = openPosition(trial.position, trial.psDir);
  battle.resetRNG(draw.battleSeed.join(',') as `${number},${string}`);
  const choices: Partial<Record<Pid, string>> = { [trial.pid]: action };
  if (draw.opponentAction !== null) choices[foe(trial.pid)] = draw.opponentAction;
  if (!playJoint(battle, choices)) return null;
  if (trial.horizon > 0 && !continueBattle(battle, trial.horizon, seededRng(draw.continuationSeed))) return null;
  return value(battle, trial.pid, trial.name);
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

function exhaustivePanel(
  trial: Trial,
  actions: string[],
  opponentLegal: string[],
  opponentSamples: number,
  luckSamples: number,
  id: ExhaustivePanel['id'],
): ExhaustivePanel | null {
  const seedNamespace = `${trial.seed}:panel:${id}`;
  const opponents: OpponentAction[] = opponentLegal.length
    ? sampleOpponents(opponentLegal, opponentSamples, seededRng(`${seedNamespace}:opponents`))
    : [null];
  const draws: ExhaustiveDraw[] = [];
  for (const opponentAction of opponents) {
    for (let luck = 0; luck < luckSamples; luck += 1) {
      const index = draws.length;
      const random = seededRng(`${seedNamespace}:battle:${index}`);
      const word = () => 1 + Math.floor(random() * 0xffff);
      draws.push({
        index,
        opponentAction,
        battleSeed: [word(), word(), word(), word()],
        continuationSeed: `${seedNamespace}:continuation:${index}`,
      });
    }
  }
  if (!draws.length) return null;
  const matrix: number[][] = [];
  for (const draw of draws) {
    const row: number[] = [];
    for (const action of actions) {
      const result = playDraw(trial, action, draw);
      if (result === null) return null;
      row.push(result);
    }
    matrix.push(row);
  }
  const columns = actions.map((_, actionIndex) => matrix.map((row) => row[actionIndex] as number));
  const values = columns.map(mean);
  const maximum = Math.max(...values);
  const minimum = Math.min(...values);
  const span = maximum - minimum;
  const estimates = actions.map((action, index) => ({
    action,
    value: values[index] as number,
    standardError: standardError(columns[index] as number[]),
    samples: draws.length,
    reward: span > 0 ? ((values[index] as number) - minimum) / span : null,
  }));
  const matrixDigest = createHash('sha256')
    .update(JSON.stringify([id, seedNamespace, draws, actions, matrix]))
    .digest('hex');
  return { id, seedNamespace, draws, actions: estimates, matrix, matrixDigest, span };
}

function rankedActions(panel: ExhaustivePanel): ExhaustiveActionValue[] {
  return [...panel.actions].sort((a, b) => b.value - a.value || Buffer.from(a.action).compare(Buffer.from(b.action)));
}

function anchors(panel: ExhaustivePanel): { best: Set<string>; worst: Set<string> } {
  const values = panel.actions.map((entry) => entry.value);
  const maximum = Math.max(...values);
  const minimum = Math.min(...values);
  return {
    best: new Set(panel.actions.filter((entry) => entry.value === maximum).map((entry) => entry.action)),
    worst: new Set(panel.actions.filter((entry) => entry.value === minimum).map((entry) => entry.action)),
  };
}

function sameSet(first: Set<string>, second: Set<string>): boolean {
  return first.size === second.size && [...first].every((entry) => second.has(entry));
}

/** Exhaustively evaluates every legal action on two stability panels and an untouched measurement
 * panel. Every action in one panel uses the same opponent slots, battle RNG seeds, and continuation
 * seeds. A failed cell rejects the whole rectangular panel instead of changing an action's sample size. */
export function evaluateActionTable(
  position: Position,
  pid: Pid,
  options: CounterfactualOptions = {},
): ExhaustiveActionTable | null {
  const psDir = options.psDir ?? defaultPsDir();
  const protocol = counterfactualProtocol(options);
  const horizon = protocol.horizon === 'end' ? Number.POSITIVE_INFINITY : protocol.horizon;
  const request = position.requests[pid];
  if (!request) return null;
  const actions = legalActions(request);
  if (actions.length < 2) return null;

  const opened = openPosition(position, psDir);
  const trial: Trial = {
    position,
    pid,
    name: opened.getSide(pid).name,
    horizon,
    psDir,
    seed: String(options.seed ?? `${position.index}:${pid}`),
  };
  const simultaneous = position.pending.includes(foe(pid));
  const opponentRequest = position.requests[foe(pid)];
  const opponentLegal = simultaneous ? policyActions(opponentRequest) : [];
  if (simultaneous && !opponentLegal.length) return null;
  const build = (id: ExhaustivePanel['id']) =>
    exhaustivePanel(trial, actions, opponentLegal, protocol.opponentSamples, protocol.luckSamples, id);
  const stabilityA = build('stability-a');
  const stabilityB = build('stability-b');
  const measurement = build('measurement');
  if (!stabilityA || !stabilityB || !measurement) return null;

  const selectedRanking = rankedActions(stabilityA);
  const selectionBest = selectedRanking[0];
  const selectionWorst = selectedRanking.at(-1);
  const stabilityAlternative = rankedActions(stabilityB).find((entry) => entry.action !== selectionBest?.action);
  const measurementBest = rankedActions(measurement)[0];
  if (!selectionBest || !selectionWorst || !stabilityAlternative || !measurementBest) return null;
  const selectedIndex = actions.indexOf(selectionBest.action);
  const worstIndex = actions.indexOf(selectionWorst.action);
  const alternativeIndex = actions.indexOf(stabilityAlternative.action);
  const differences = stabilityB.matrix.map(
    (row) => (row[selectedIndex] as number) - (row[alternativeIndex] as number),
  );
  const spanDifferences = stabilityB.matrix.map((row) => (row[selectedIndex] as number) - (row[worstIndex] as number));
  const gapValue = mean(differences);
  const gapStandardError = standardError(differences);
  const spanValue = mean(spanDifferences);
  const spanStandardError = standardError(spanDifferences);
  const firstAnchors = anchors(stabilityA);
  const secondAnchors = anchors(stabilityB);
  const anchorAgreement =
    sameSet(firstAnchors.best, secondAnchors.best) && sameSet(firstAnchors.worst, secondAnchors.worst);
  const maxNormalizedRewardDrift =
    stabilityA.span > 0 && stabilityB.span > 0
      ? Math.max(
          ...stabilityA.actions.map((entry, index) =>
            Math.abs((entry.reward as number) - (stabilityB.actions[index]?.reward as number)),
          ),
        )
      : null;
  const stabilityBest = rankedActions(stabilityB)[0]?.action;
  return {
    pid,
    turn: position.turn,
    legal: actions.length,
    horizon,
    stateValue: value(opened, pid, trial.name),
    selectionBest: selectionBest.action,
    measurementBest: measurementBest.action,
    rankingStable: selectionBest.action === stabilityBest,
    valueSpan: measurement.span,
    heldOutGap: {
      selectedAction: selectionBest.action,
      alternativeAction: stabilityAlternative.action,
      value: gapValue,
      standardError: gapStandardError,
      lower95: gapValue - 1.96 * gapStandardError,
    },
    heldOutSpan: {
      selectedAction: selectionBest.action,
      alternativeAction: selectionWorst.action,
      value: spanValue,
      standardError: spanStandardError,
      lower95: spanValue - 1.96 * spanStandardError,
    },
    stability: [stabilityA, stabilityB],
    measurement,
    anchorAgreement,
    maxNormalizedRewardDrift,
  };
}
