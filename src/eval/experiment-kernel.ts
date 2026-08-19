import { canonicalJsonDigest } from './serialization.js';

export const EXPERIMENT_KERNEL_PROTOCOL = {
  version: 1,
  state: 'canonical-json-digest-v1',
  event: 'decision-node-action-pre-post-digest-v1',
  fork: 'replay-prefix-replace-one-drop-suffix-v1',
  contrast: 'matched-draw-cluster-mean-v1',
} as const;

export type StrategicStage = 'draft' | 'construction' | 'trade' | 'preview' | 'battle' | 'notebook' | 'terminal-review';

export interface DecisionNode {
  id: string;
  opportunityKey: string;
  stage: StrategicStage;
  actor: string;
  parentNodeId: string | null;
  sourceEpisodeDigest: string;
  publicStateDigest: string;
  privateStateDigest: string;
  promptDigest: string;
  legalActionDigest: string;
}

export interface ExperimentEvent<Action> {
  id: string;
  node: DecisionNode;
  action: Action;
  actionDigest: string;
  preStateDigest: string;
  postStateDigest: string;
}

export interface ExperimentCheckpoint<State, Action> {
  protocolVersion: typeof EXPERIMENT_KERNEL_PROTOCOL.version;
  initialStateDigest: string;
  state: State;
  stateDigest: string;
  eventLogDigest: string;
  events: ExperimentEvent<Action>[];
}

export interface ExperimentReducer<State, Action> {
  apply(state: State, action: Action, node: DecisionNode): State;
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

function eventId<Action>(event: Omit<ExperimentEvent<Action>, 'id'>): string {
  return canonicalJsonDigest([EXPERIMENT_KERNEL_PROTOCOL.event, event]);
}

function assertNode(node: DecisionNode): void {
  for (const [name, value] of Object.entries(node)) {
    if (name === 'parentNodeId') continue;
    if (typeof value !== 'string' || !value) throw new Error(`decision node ${name} must be a non-empty string`);
  }
  if (node.parentNodeId !== null && !node.parentNodeId) {
    throw new Error('decision node parentNodeId must be null or a non-empty string');
  }
}

export class ReplayableExperiment<State, Action> {
  private readonly initial: State;
  private readonly reducer: ExperimentReducer<State, Action>;
  private readonly log: ExperimentEvent<Action>[] = [];

  constructor(initialState: State, reducer: ExperimentReducer<State, Action>) {
    canonicalJsonDigest(initialState);
    this.initial = copy(initialState);
    this.reducer = reducer;
  }

  events(): ExperimentEvent<Action>[] {
    return copy(this.log);
  }

  state(): State {
    return this.replay(this.log);
  }

  append(node: DecisionNode, action: Action): ExperimentEvent<Action> {
    assertNode(node);
    canonicalJsonDigest(action);
    if (this.log.some((event) => event.node.id === node.id)) {
      throw new Error(`decision node ${JSON.stringify(node.id)} already exists in the event log`);
    }
    const expectedParent = this.log.at(-1)?.node.id ?? null;
    if (node.parentNodeId !== expectedParent) {
      throw new Error(
        `decision node ${JSON.stringify(node.id)} names parent ${JSON.stringify(node.parentNodeId)}, expected ${JSON.stringify(expectedParent)}`,
      );
    }
    const preState = this.replay(this.log);
    const postState = this.reducer.apply(copy(preState), copy(action), copy(node));
    const base: Omit<ExperimentEvent<Action>, 'id'> = {
      node: copy(node),
      action: copy(action),
      actionDigest: canonicalJsonDigest(action),
      preStateDigest: canonicalJsonDigest(preState),
      postStateDigest: canonicalJsonDigest(postState),
    };
    const event = { id: eventId(base), ...base };
    this.log.push(copy(event));
    return copy(event);
  }

  appendMany(entries: readonly { node: DecisionNode; action: Action }[]): ExperimentEvent<Action>[] {
    return entries.map((entry) => this.append(entry.node, entry.action));
  }

  verify(): void {
    this.replay(this.log);
  }

  checkpoint(): ExperimentCheckpoint<State, Action> {
    const state = this.replay(this.log);
    return {
      protocolVersion: EXPERIMENT_KERNEL_PROTOCOL.version,
      initialStateDigest: canonicalJsonDigest(this.initial),
      state: copy(state),
      stateDigest: canonicalJsonDigest(state),
      eventLogDigest: canonicalJsonDigest(this.log),
      events: copy(this.log),
    };
  }

  forkAt(nodeId: string, replacementAction: Action): ReplayableExperiment<State, Action> {
    const index = this.log.findIndex((event) => event.node.id === nodeId);
    if (index < 0) throw new Error(`cannot fork unknown decision node ${JSON.stringify(nodeId)}`);
    const fork = new ReplayableExperiment(this.initial, this.reducer);
    for (const event of this.log.slice(0, index)) fork.append(event.node, event.action);
    const target = this.log[index] as ExperimentEvent<Action>;
    fork.append(target.node, replacementAction);
    return fork;
  }

  private replay(events: readonly ExperimentEvent<Action>[]): State {
    let state = copy(this.initial);
    let parentNodeId: string | null = null;
    const nodes = new Set<string>();
    for (const event of events) {
      assertNode(event.node);
      if (nodes.has(event.node.id)) throw new Error(`event log repeats decision node ${JSON.stringify(event.node.id)}`);
      if (event.node.parentNodeId !== parentNodeId) {
        throw new Error(`event ${JSON.stringify(event.id)} breaks the decision-node parent chain`);
      }
      if (canonicalJsonDigest(state) !== event.preStateDigest) {
        throw new Error(`event ${JSON.stringify(event.id)} pre-state digest does not replay`);
      }
      if (canonicalJsonDigest(event.action) !== event.actionDigest) {
        throw new Error(`event ${JSON.stringify(event.id)} action digest does not match its action`);
      }
      const next = this.reducer.apply(copy(state), copy(event.action), copy(event.node));
      if (canonicalJsonDigest(next) !== event.postStateDigest) {
        throw new Error(`event ${JSON.stringify(event.id)} post-state digest does not replay`);
      }
      const base: Omit<ExperimentEvent<Action>, 'id'> = {
        node: event.node,
        action: event.action,
        actionDigest: event.actionDigest,
        preStateDigest: event.preStateDigest,
        postStateDigest: event.postStateDigest,
      };
      if (eventId(base) !== event.id)
        throw new Error(`event ${JSON.stringify(event.id)} identity does not match its bytes`);
      nodes.add(event.node.id);
      parentNodeId = event.node.id;
      state = next;
    }
    return copy(state);
  }
}

export interface MatchedForkOutcome {
  caseId: string;
  decisionNodeId: string;
  armId: string;
  drawId: string;
  clusterId: string;
  protocolValid: boolean;
  actionLegal: boolean;
  utility: number | null;
}

export interface PairedArmContrast {
  treatmentArmId: string;
  controlArmId: string;
  matchedPairs: number;
  validPairs: number;
  clusters: number;
  treatmentInvalidRate: number;
  controlInvalidRate: number;
  meanDifference: number | null;
  standardError: number | null;
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardError(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  const center = mean(values);
  const variance = values.reduce((sum, value) => sum + (value - center) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance / values.length);
}

function outcomeKey(outcome: MatchedForkOutcome): string {
  return canonicalJsonDigest([outcome.caseId, outcome.decisionNodeId, outcome.drawId]);
}

function validUtility(outcome: MatchedForkOutcome): number | null {
  if (!outcome.protocolValid || !outcome.actionLegal || outcome.utility === null) return null;
  if (!Number.isFinite(outcome.utility)) throw new Error('matched fork utility must be finite when supplied');
  return outcome.utility;
}

export function pairedArmContrast(
  outcomes: readonly MatchedForkOutcome[],
  treatmentArmId: string,
  controlArmId: string,
): PairedArmContrast {
  if (!treatmentArmId || !controlArmId || treatmentArmId === controlArmId) {
    throw new Error('paired contrast requires two different non-empty arm ids');
  }
  const select = (armId: string): Map<string, MatchedForkOutcome> => {
    const selected = new Map<string, MatchedForkOutcome>();
    for (const outcome of outcomes.filter((entry) => entry.armId === armId)) {
      const key = outcomeKey(outcome);
      if (selected.has(key)) throw new Error(`arm ${JSON.stringify(armId)} repeats matched draw ${key}`);
      selected.set(key, outcome);
    }
    if (!selected.size) throw new Error(`arm ${JSON.stringify(armId)} has no outcomes`);
    return selected;
  };
  const treatment = select(treatmentArmId);
  const control = select(controlArmId);
  if (treatment.size !== control.size || [...treatment.keys()].some((key) => !control.has(key))) {
    throw new Error('paired contrast arms do not contain the same matched draws');
  }
  const clusterDifferences = new Map<string, number[]>();
  let treatmentInvalid = 0;
  let controlInvalid = 0;
  let validPairs = 0;
  for (const [key, treatmentOutcome] of treatment) {
    const controlOutcome = control.get(key) as MatchedForkOutcome;
    if (treatmentOutcome.clusterId !== controlOutcome.clusterId) {
      throw new Error(`paired draw ${key} disagrees on its uncertainty cluster`);
    }
    const treatmentUtility = validUtility(treatmentOutcome);
    const controlUtility = validUtility(controlOutcome);
    if (treatmentUtility === null) treatmentInvalid += 1;
    if (controlUtility === null) controlInvalid += 1;
    if (treatmentUtility === null || controlUtility === null) continue;
    validPairs += 1;
    const clusterKey = canonicalJsonDigest([treatmentOutcome.caseId, treatmentOutcome.clusterId]);
    clusterDifferences.set(clusterKey, [
      ...(clusterDifferences.get(clusterKey) ?? []),
      treatmentUtility - controlUtility,
    ]);
  }
  const clusterMeans = [...clusterDifferences.values()].map(mean);
  return {
    treatmentArmId,
    controlArmId,
    matchedPairs: treatment.size,
    validPairs,
    clusters: clusterMeans.length,
    treatmentInvalidRate: treatmentInvalid / treatment.size,
    controlInvalidRate: controlInvalid / control.size,
    meanDifference: clusterMeans.length ? mean(clusterMeans) : null,
    standardError: standardError(clusterMeans),
  };
}
