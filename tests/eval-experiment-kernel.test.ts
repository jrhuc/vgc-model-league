import assert from 'node:assert/strict';
import test from 'node:test';

import {
  pairedArmContrast,
  ReplayableExperiment,
  type DecisionNode,
  type MatchedForkOutcome,
} from '../src/eval/experiment-kernel.js';

interface State {
  total: number;
  history: string[];
}

interface Action {
  id: string;
  delta: number;
}

function node(id: string, parentNodeId: string | null): DecisionNode {
  return {
    id,
    opportunityKey: `opportunity:${id}`,
    stage: 'draft',
    actor: 'seat-1',
    parentNodeId,
    sourceEpisodeDigest: 'episode',
    publicStateDigest: 'public',
    privateStateDigest: 'private',
    promptDigest: 'prompt',
    legalActionDigest: 'legal',
  };
}

const reducer = {
  apply(state: State, action: Action): State {
    return { total: state.total + action.delta, history: [...state.history, action.id] };
  },
};

test('event kernel replays exact accepted transitions and forks one decision', () => {
  const experiment = new ReplayableExperiment<State, Action>({ total: 0, history: [] }, reducer);
  experiment.append(node('n1', null), { id: 'a1', delta: 2 });
  experiment.append(node('n2', 'n1'), { id: 'a2', delta: 3 });
  experiment.verify();
  assert.deepEqual(experiment.state(), { total: 5, history: ['a1', 'a2'] });
  const checkpoint = experiment.checkpoint();
  assert.equal(checkpoint.events.length, 2);
  assert.equal(checkpoint.stateDigest, checkpoint.events[1]!.postStateDigest);

  const fork = experiment.forkAt('n2', { id: 'replacement', delta: -4 });
  assert.deepEqual(fork.state(), { total: -2, history: ['a1', 'replacement'] });
  assert.equal(fork.events().length, 2);
  assert.equal(experiment.state().total, 5);
});

test('event kernel rejects broken parent chains and duplicate nodes', () => {
  const experiment = new ReplayableExperiment<State, Action>({ total: 0, history: [] }, reducer);
  assert.throws(() => experiment.append(node('n1', 'missing'), { id: 'a1', delta: 1 }), /expected null/u);
  experiment.append(node('n1', null), { id: 'a1', delta: 1 });
  assert.throws(() => experiment.append(node('n1', 'n1'), { id: 'again', delta: 1 }), /already exists/u);
});

function outcome(
  armId: string,
  drawId: string,
  clusterId: string,
  utility: number | null,
): MatchedForkOutcome {
  return {
    caseId: 'case',
    decisionNodeId: 'node',
    armId,
    drawId,
    clusterId,
    protocolValid: utility !== null,
    actionLegal: utility !== null,
    utility,
  };
}

test('paired contrasts preserve matched draws and cluster uncertainty', () => {
  const outcomes = [
    outcome('control', 'd1', 'c1', 0.2),
    outcome('treatment', 'd1', 'c1', 0.4),
    outcome('control', 'd2', 'c1', 0.3),
    outcome('treatment', 'd2', 'c1', 0.5),
    outcome('control', 'd3', 'c2', 0.1),
    outcome('treatment', 'd3', 'c2', 0.5),
    outcome('control', 'd4', 'c2', null),
    outcome('treatment', 'd4', 'c2', 0.6),
  ];
  const contrast = pairedArmContrast(outcomes, 'treatment', 'control');
  assert.equal(contrast.matchedPairs, 4);
  assert.equal(contrast.validPairs, 3);
  assert.equal(contrast.clusters, 2);
  assert.ok(Math.abs((contrast.meanDifference ?? 0) - 0.3) < 1e-12);
  assert.ok(Math.abs((contrast.standardError ?? 0) - 0.1) < 1e-12);
  assert.equal(contrast.controlInvalidRate, 0.25);
  assert.equal(contrast.treatmentInvalidRate, 0);
});

test('paired contrasts reject incomplete draw rectangles', () => {
  const outcomes = [outcome('control', 'd1', 'c1', 0), outcome('treatment', 'd2', 'c1', 1)];
  assert.throws(() => pairedArmContrast(outcomes, 'treatment', 'control'), /same matched draws/u);
});
