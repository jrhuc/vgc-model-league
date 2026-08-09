import type { Battle } from 'pokemon-showdown';

import { defaultPsDir } from '../paths.js';
import { type Rng, seededRng, shuffle } from '../random.js';
import type { BattleRequest, Pid } from '../types.js';
import {
  acceptedBattleActions,
  acceptedLegalActions,
  openPosition,
  type Position,
  pendingSides,
  playJoint,
  requestActionCandidateEntries,
} from './fork.js';
import { canonicalJsonDigest } from './serialization.js';

export const COUNTERFACTUAL_PROTOCOL_VERSION = 4;

export const REFERENCE = {
  hiddenState: 'realized',
  continuation: 'uniform-random-permutation-first-showdown-accepted-request-derived-non-concession',
  opponent: 'actual-or-sampled-uniform-showdown-accepted-request-derived-when-simultaneous',
  actionSet: 'showdown-accepted-request-derived-candidates-not-universal-showdown-completeness',
  value: 'material-differential',
} as const;

export const EXHAUSTIVE_PANEL_PROTOCOL = {
  version: 5,
  actionSet: 'showdown-accepted-request-derived-candidates-not-universal-showdown-completeness',
  panels: ['stability-a', 'stability-b', 'measurement'],
  matrixDigest: 'sha256-canonical-exhaustive-panel-matrix-v2',
  drawPlan: 'seeded-srswor-opponents-and-battle-words-v1',
  opponent: 'srswor-uniform-legal-when-simultaneous-or-null-census-when-unilateral',
  commonRandomNumbers: ['opponent-action', 'battle-rng', 'continuation-rng'],
  completeness: 'rectangular-or-ineligible',
  normalization: '(measurement-mean-min)/(max-min)',
  uncertaintyEstimator: 'two-stage-srswor-opponent-cluster-v1',
  uncertaintyRequirements: 'at-least-two-luck-replications-and-two-opponent-slots-unless-opponent-census-size-one',
  normalApproximation: 'diagnostic-mean-minus-1.96-standard-errors-not-claimed-calibrated',
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

interface CounterfactualProtocol {
  version: number;
  reference: typeof REFERENCE;
  horizon: number | 'end';
  luckSamples: number;
  opponentSamples: number;
  shortlist: number;
  screenSamples: number;
  rolloutLimit: number;
}

export function validateCounterfactualOptions(options: CounterfactualOptions): void {
  if (!options || typeof options !== 'object' || Array.isArray(options))
    throw new Error('counterfactual options must be an object');
  if (options.psDir !== undefined && (typeof options.psDir !== 'string' || !options.psDir))
    throw new Error('counterfactual psDir must be a non-empty string');
  if (options.seed !== undefined) {
    const validSeed =
      (typeof options.seed === 'string' && Boolean(options.seed)) ||
      (typeof options.seed === 'number' && Number.isSafeInteger(options.seed));
    if (!validSeed) throw new Error('counterfactual seed must be a non-empty string or safe integer');
  }
  if (
    options.horizon !== undefined &&
    options.horizon !== Number.POSITIVE_INFINITY &&
    (!Number.isSafeInteger(options.horizon) || options.horizon < 0)
  )
    throw new Error('counterfactual horizon must be a non-negative safe integer or positive infinity');
  for (const [name, value] of [
    ['luckSamples', options.luckSamples],
    ['opponentSamples', options.opponentSamples],
    ['shortlist', options.shortlist],
    ['screenSamples', options.screenSamples],
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1))
      throw new Error(`counterfactual ${name} must be a positive safe integer`);
  }
}

export function counterfactualProtocol(options: CounterfactualOptions = {}): CounterfactualProtocol {
  validateCounterfactualOptions(options);
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

export function exhaustiveCounterfactualProtocol(options: CounterfactualOptions = {}) {
  const { version, reference, horizon, luckSamples, opponentSamples } = counterfactualProtocol(options);
  return { version, reference, horizon, luckSamples, opponentSamples };
}

interface ActionValue {
  action: string;
  value: number;
  samples: number;
}

interface ReferenceView {
  chosen: number;
  selected: number;
  selectedAction: string;
  signedGap: number;
  opportunityLoss: number;
  measuredContrast: number;
  discriminating: boolean;
  selectionReversed: boolean;
}

interface PositionScore {
  pid: Pid;
  turn: number;
  chosen: string;
  legal: number;
  horizon: number;
  stateValue: number;
  vsActualOpponent: ReferenceView;
  vsSampledOpponent: ReferenceView;
}

interface ExhaustiveActionValue {
  action: string;
  value: number;
  standardError: number | null;
  samples: number;
  reward: number | null;
}

interface HeldOutGap {
  selectedAction: string;
  alternativeAction: string;
  value: number;
  standardError: number | null;
  normalApproxLower95: number | null;
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
  opponentPopulation: number;
  opponentSlots: number;
  luckReplications: number;
  draws: ExhaustiveDraw[];
  actions: ExhaustiveActionValue[];
  matrix: number[][];
  matrixDigest: string;
  span: number;
}

interface ExhaustivePanelDrawPlanInput {
  panelSeed: string;
  id: ExhaustivePanel['id'];
  opponentLegalActions: readonly string[];
  opponentSlots: number;
  luckReplications: number;
}

interface ExhaustivePanelDrawPlan {
  seedNamespace: string;
  opponentPopulation: number;
  opponentSlots: number;
  luckReplications: number;
  draws: ExhaustiveDraw[];
}

interface ExhaustivePanelMatrixDigestInput {
  id: ExhaustivePanel['id'];
  seedNamespace: string;
  opponentPopulation: number;
  opponentSlots: number;
  luckReplications: number;
  draws: readonly ExhaustiveDraw[];
  actions: readonly string[];
  matrix: readonly (readonly number[])[];
}

export function exhaustivePanelMatrixDigest(input: ExhaustivePanelMatrixDigestInput): string {
  return canonicalJsonDigest([
    'exhaustive-panel-matrix-v2',
    input.id,
    input.seedNamespace,
    input.opponentPopulation,
    input.opponentSlots,
    input.luckReplications,
    input.draws,
    input.actions,
    input.matrix,
  ]);
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

function policyActions(battle: Battle, pid: Pid): string[] {
  return acceptedBattleActions(battle, pid);
}

function sampledPolicyAction(battle: Battle, pid: Pid, request: BattleRequest, random: Rng): string | null {
  for (const candidate of shuffle(requestActionCandidateEntries(request), random)) {
    if (acceptedLegalActions(battle, pid, [candidate]).length) return candidate.command;
  }
  return null;
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
      const action = request ? sampledPolicyAction(battle, pid, request, random) : null;
      if (!action) return false;
      picks[pid] = action;
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

function sampleVariance(values: readonly number[]): number {
  const center = mean(values);
  return values.reduce((sum, entry) => sum + (entry - center) ** 2, 0) / (values.length - 1);
}

interface TwoStageClusterEstimate {
  value: number;
  standardError: number | null;
}

/** Estimates a mean from opponent actions sampled without replacement, with repeated luck draws
 * inside each opponent-action block. For n sampled opponents from population N, block means b_i,
 * m luck replications, sampling fraction f=n/N, between-block sample variance s_b^2, and within-block
 * sample variances s_i^2, V-hat=(1-f)s_b^2/n + f mean(s_i^2/m)/n. The finite-population correction
 * removes opponent-action uncertainty at a census while retaining simulation uncertainty. A null
 * standard error means the luck stage, or a non-census opponent stage, is not replicated enough to
 * identify its variance. Normal approximations made from this diagnostic standard error are not
 * claimed to be calibrated confidence bounds. */
export function twoStageClusterEstimate(
  blocks: readonly (readonly number[])[],
  opponentPopulation: number,
): TwoStageClusterEstimate {
  const opponentSlots = blocks.length;
  if (!Number.isInteger(opponentPopulation) || opponentPopulation < 1)
    throw new Error('opponentPopulation must be a positive integer');
  if (!opponentSlots || opponentSlots > opponentPopulation)
    throw new Error('blocks must contain between one and opponentPopulation opponent slots');
  const luckReplications = blocks[0]?.length ?? 0;
  if (!luckReplications || blocks.some((block) => block.length !== luckReplications))
    throw new Error('opponent blocks must be non-empty and have equal luck replications');
  const blockMeans = blocks.map(mean);
  const value = mean(blockMeans);
  if (luckReplications < 2 || (opponentSlots < 2 && opponentSlots < opponentPopulation)) {
    return { value, standardError: null };
  }
  const samplingFraction = opponentSlots / opponentPopulation;
  const betweenVariance = opponentSlots > 1 ? sampleVariance(blockMeans) : 0;
  const withinMeanVariance = mean(blocks.map((block) => sampleVariance(block) / luckReplications));
  const variance = ((1 - samplingFraction) * betweenVariance + samplingFraction * withinMeanVariance) / opponentSlots;
  return { value, standardError: Math.sqrt(Math.max(0, variance)) };
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
  screened.sort((a, b) => b.value - a.value || Buffer.compare(Buffer.from(a.action), Buffer.from(b.action)));
  const shortlist = new Set(screened.slice(0, budget.shortlist).map((entry) => entry.action));

  const refined: ActionValue[] = [];
  for (const action of actions) {
    if (!shortlist.has(action)) continue;
    const result = average(trial, action, selectionOpponents, budget.luckSamples, 1_000);
    if (result) refined.push(result);
  }
  refined.sort((a, b) => b.value - a.value || Buffer.compare(Buffer.from(a.action), Buffer.from(b.action)));
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

export function exhaustivePanelDrawPlan(input: ExhaustivePanelDrawPlanInput): ExhaustivePanelDrawPlan {
  if (!input.panelSeed) throw new Error('panelSeed must be non-empty');
  if (!Number.isInteger(input.opponentSlots) || input.opponentSlots < 1)
    throw new Error('opponentSlots must be a positive integer');
  if (!Number.isInteger(input.luckReplications) || input.luckReplications < 1)
    throw new Error('luckReplications must be a positive integer');
  if (
    input.opponentLegalActions.some((action) => !action) ||
    new Set(input.opponentLegalActions).size !== input.opponentLegalActions.length
  )
    throw new Error('opponentLegalActions entries must be non-empty and unique');
  const opponentPopulation = input.opponentLegalActions.length || 1;
  if (input.opponentSlots > opponentPopulation) throw new Error('opponentSlots cannot exceed the opponent population');
  if (!input.opponentLegalActions.length && input.opponentSlots !== 1)
    throw new Error('a unilateral draw plan must use one null opponent slot');
  const seedNamespace = `${input.panelSeed}:panel:${input.id}`;
  const opponents: OpponentAction[] = input.opponentLegalActions.length
    ? sampleOpponents([...input.opponentLegalActions], input.opponentSlots, seededRng(`${seedNamespace}:opponents`))
    : [null];
  const draws: ExhaustiveDraw[] = [];
  for (const opponentAction of opponents) {
    for (let luck = 0; luck < input.luckReplications; luck += 1) {
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
  return {
    seedNamespace,
    opponentPopulation,
    opponentSlots: opponents.length,
    luckReplications: input.luckReplications,
    draws,
  };
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
  const opened = openPosition(position, psDir);
  const actions = policyActions(opened, pid);
  if (!actions.includes(chosen)) return null;

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
  const opponentPid = foe(pid);
  const opponentRequest = position.requests[opponentPid];
  const opponentLegal = simultaneous && opponentRequest ? policyActions(opened, opponentPid) : [];
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
  const actualOpponent = simultaneous ? position.actual[opponentPid] : null;
  if (actualOpponent === undefined || (actualOpponent !== null && !opponentLegal.includes(actualOpponent))) return null;
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
  if (!Number.isInteger(opponentSamples) || opponentSamples < 1 || !Number.isInteger(luckSamples) || luckSamples < 1)
    return null;
  const opponentSlots = opponentLegal.length ? Math.min(opponentSamples, opponentLegal.length) : 1;
  const plan = exhaustivePanelDrawPlan({
    panelSeed: trial.seed,
    id,
    opponentLegalActions: opponentLegal,
    opponentSlots,
    luckReplications: luckSamples,
  });
  const { seedNamespace, opponentPopulation, luckReplications, draws } = plan;
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
  const estimates: ExhaustiveActionValue[] = actions.map((action, actionIndex) => {
    const blocks = Array.from({ length: opponentSlots }, (_, opponentIndex) =>
      matrix
        .slice(opponentIndex * luckReplications, (opponentIndex + 1) * luckReplications)
        .map((row) => row[actionIndex] as number),
    );
    const estimate = twoStageClusterEstimate(blocks, opponentPopulation);
    return { action, ...estimate, samples: draws.length, reward: null };
  });
  const values = estimates.map((entry) => entry.value);
  const maximum = Math.max(...values);
  const minimum = Math.min(...values);
  const span = maximum - minimum;
  for (const estimate of estimates) estimate.reward = span > 0 ? (estimate.value - minimum) / span : null;
  const matrixDigest = exhaustivePanelMatrixDigest({
    id,
    seedNamespace,
    opponentPopulation,
    opponentSlots,
    luckReplications,
    draws,
    actions,
    matrix,
  });
  return {
    id,
    seedNamespace,
    opponentPopulation,
    opponentSlots,
    luckReplications,
    draws,
    actions: estimates,
    matrix,
    matrixDigest,
    span,
  };
}

function rankedActions(panel: ExhaustivePanel): ExhaustiveActionValue[] {
  return [...panel.actions].sort(
    (a, b) => b.value - a.value || Buffer.compare(Buffer.from(a.action), Buffer.from(b.action)),
  );
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
  const opened = openPosition(position, psDir);
  const actions = policyActions(opened, pid);
  if (actions.length < 2) return null;

  const trial: Trial = {
    position,
    pid,
    name: opened.getSide(pid).name,
    horizon,
    psDir,
    seed: String(options.seed ?? `${position.index}:${pid}`),
  };
  const simultaneous = position.pending.includes(foe(pid));
  const opponentPid = foe(pid);
  const opponentRequest = position.requests[opponentPid];
  const opponentLegal = simultaneous && opponentRequest ? policyActions(opened, opponentPid) : [];
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
  const differenceBlocks = (comparisonIndex: number) =>
    Array.from({ length: stabilityB.opponentSlots }, (_, opponentIndex) =>
      stabilityB.matrix
        .slice(opponentIndex * stabilityB.luckReplications, (opponentIndex + 1) * stabilityB.luckReplications)
        .map((row) => (row[selectedIndex] as number) - (row[comparisonIndex] as number)),
    );
  const gapEstimate = twoStageClusterEstimate(differenceBlocks(alternativeIndex), stabilityB.opponentPopulation);
  const spanEstimate = twoStageClusterEstimate(differenceBlocks(worstIndex), stabilityB.opponentPopulation);
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
      value: gapEstimate.value,
      standardError: gapEstimate.standardError,
      normalApproxLower95:
        gapEstimate.standardError === null ? null : gapEstimate.value - 1.96 * gapEstimate.standardError,
    },
    heldOutSpan: {
      selectedAction: selectionBest.action,
      alternativeAction: selectionWorst.action,
      value: spanEstimate.value,
      standardError: spanEstimate.standardError,
      normalApproxLower95:
        spanEstimate.standardError === null ? null : spanEstimate.value - 1.96 * spanEstimate.standardError,
    },
    stability: [stabilityA, stabilityB],
    measurement,
    anchorAgreement,
    maxNormalizedRewardDrift,
  };
}
