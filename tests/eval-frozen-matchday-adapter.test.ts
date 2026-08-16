import assert from 'node:assert/strict';
import test from 'node:test';
import { buildNotebookTreatment } from '../src/eval/bo3-adaptation.js';
import {
  controllerSetDigest,
  STRATEGIC_CONTROLLER_STAGES,
  type StrategicControllerSet,
} from '../src/eval/controllers.js';
import type { DecisionNode } from '../src/eval/experiment-kernel.js';
import { buildMatchedForkPlan, type MatchedForkArm } from '../src/eval/fork-plan.js';
import {
  buildFrozenMatchdayBetweenGameCheckpoint,
  type FrozenMatchdayCompletedSource,
  type FrozenMatchdayContinuationControllers,
  notebookTreatmentActionDigest,
  restoreFrozenMatchdayBetweenGameCheckpoint,
  runFrozenMatchdayNotebookFork,
} from '../src/eval/frozen-matchday-adapter.js';
import { canonicalJsonDigest } from '../src/eval/serialization.js';
import {
  type FrozenMatchdayPhase,
  FrozenMatchdayReferee,
  type FrozenMatchdaySubmissionResult,
} from '../src/frozen-matchday-referee.js';
import type { Pid } from '../src/types.js';
import { frozenMatchdayOptions } from './fixtures/frozen-matchday.js';

function finishSource(): FrozenMatchdayCompletedSource {
  const referee = new FrozenMatchdayReferee(frozenMatchdayOptions());
  let phase: FrozenMatchdayPhase = 'playing';
  for (let steps = 0; steps < 200 && phase !== 'terminal'; steps += 1) {
    if (phase === 'playing') {
      const observations = {
        p1: referee.observe('p1'),
        p2: referee.observe('p2'),
      };
      let latest: FrozenMatchdaySubmissionResult | null = null;
      for (const pid of ['p1', 'p2'] as const) {
        const observation = observations[pid];
        if (!observation.battle?.request || observation.battle.request.wait) continue;
        const command = referee.legalActions(pid).actions[0]?.command;
        assert.ok(command);
        latest = referee.submit(pid, command, observation.revision, observation.stateHash);
      }
      assert.ok(latest);
      phase = latest.phase;
      continue;
    }
    const state = referee.currentState();
    const gameNumber = referee.observe('p1').gameNumber - 1;
    referee.observe('p2');
    const p1 = referee.readyNextGame(
      'p1',
      { notebookReplacement: `source p1 after game ${gameNumber}` },
      state.revision,
      state.stateHash,
    );
    assert.equal(p1.advanced, false);
    const p2 = referee.readyNextGame(
      'p2',
      { notebookReplacement: `source p2 after game ${gameNumber}` },
      state.revision,
      state.stateHash,
    );
    phase = p2.phase;
  }
  assert.equal(phase, 'terminal');
  const terminalEvidence = referee.terminalEvidence();
  assert.ok(terminalEvidence);
  return {
    caseId: 'fixture-matchday',
    decisionNodeId: 'fixture-matchday:after-game-1:notebook',
    options: referee.acceptedOptions(),
    terminalEvidence,
    privateEvidence: {
      p1: referee.seatPrivateEvidence('p1'),
      p2: referee.seatPrivateEvidence('p2'),
    },
  };
}

let cachedSource: FrozenMatchdayCompletedSource | null = null;

function source(): FrozenMatchdayCompletedSource {
  cachedSource ??= finishSource();
  return structuredClone(cachedSource);
}

function controllerIdentities(): StrategicControllerSet {
  return Object.fromEntries(
    STRATEGIC_CONTROLLER_STAGES.map((stage) => [
      stage,
      {
        id: `fixture-${stage}`,
        stage,
        kind: 'recorded' as const,
        revision: 'v1',
        configDigest: canonicalJsonDigest({ stage, fixture: true }),
      },
    ]),
  ) as StrategicControllerSet;
}

function controllers(identities: StrategicControllerSet): FrozenMatchdayContinuationControllers {
  const seat = (pid: Pid) => ({
    decideAction: ({
      legalActions,
      currentNotebook,
      decisionIndex,
    }: Parameters<FrozenMatchdayContinuationControllers['seats'][Pid]['decideAction']>[0]) => {
      const alternate = pid === 'p1' && decisionIndex === 0 && currentNotebook.includes('alternate preview');
      const selected = alternate ? legalActions.at(-1) : legalActions[0];
      assert.ok(selected);
      return { command: selected.command, actionId: selected.command };
    },
    decideNotebook: () => ({}),
  });
  return {
    controllerSetDigest: controllerSetDigest(identities),
    seats: { p1: seat('p1'), p2: seat('p2') },
  };
}

function nodeFor(checkpoint: ReturnType<typeof buildFrozenMatchdayBetweenGameCheckpoint>): DecisionNode {
  return {
    id: checkpoint.decisionNodeId,
    opportunityKey: `${checkpoint.caseId}:after-game-${checkpoint.afterGame}`,
    stage: 'notebook',
    actor: 'p1',
    parentNodeId: null,
    sourceEpisodeDigest: checkpoint.sourceTerminalDigest,
    publicStateDigest: canonicalJsonDigest(checkpoint.completedGames),
    privateStateDigest: canonicalJsonDigest(checkpoint.privateEvidence.p1),
    promptDigest: canonicalJsonDigest(['between-game-notebook-v1', checkpoint.afterGame]),
    legalActionDigest: canonicalJsonDigest(['full-replacement-or-withheld-v1']),
  };
}

function arm(
  id: string,
  treatment: ReturnType<typeof buildNotebookTreatment>,
  identities: StrategicControllerSet,
): MatchedForkArm {
  return {
    id,
    label: id,
    replacementActionDigest: notebookTreatmentActionDigest(treatment),
    treatmentDigest: treatment.treatmentDigest,
    controllers: identities,
  };
}

test('completed matchdays produce exact restorable between-game checkpoints', () => {
  const checkpoint = buildFrozenMatchdayBetweenGameCheckpoint(source(), 1);
  const restored = restoreFrozenMatchdayBetweenGameCheckpoint(checkpoint);
  assert.equal(restored.configDigest, checkpoint.sourceConfigDigest);
  assert.deepEqual(restored.currentState(), {
    revision: checkpoint.revision,
    stateHash: checkpoint.stateHash,
  });
  assert.deepEqual(restored.seatPrivateEvidence('p1'), checkpoint.privateEvidence.p1);

  const tampered = structuredClone(checkpoint);
  tampered.completedGames[0]!.turns += 1;
  assert.throws(() => restoreFrozenMatchdayBetweenGameCheckpoint(tampered), /checkpoint digest does not match/u);
});

test('notebook forks replay one prefix and continue strict matched arms on common seeds', async () => {
  const checkpoint = buildFrozenMatchdayBetweenGameCheckpoint(source(), 1);
  const identities = controllerIdentities();
  const withheld = buildNotebookTreatment({ id: 'withheld', kind: 'withheld', notebook: '' });
  const authentic = buildNotebookTreatment({
    id: 'authentic',
    kind: 'authentic',
    notebook: 'Use the alternate preview for the next game.',
  });
  const draw = {
    id: 'draw-1',
    hiddenStateSeed: 'realized-source-state',
    opponentPolicySeed: 'first-legal-controller',
    battleSeed: [7001, 7002, 7003, 7004] as [number, number, number, number],
    continuationSeed: 'draw-1-continuation',
    scheduleSeed: 'not-applicable',
  };
  const plan = buildMatchedForkPlan({
    id: 'fixture-memory-fork',
    decisionNode: nodeFor(checkpoint),
    utilityUnit: 'series-return',
    arms: [arm('withheld', withheld, identities), arm('authentic', authentic, identities)],
    draws: [draw],
  });

  const run = (armId: string, treatment: typeof withheld) =>
    runFrozenMatchdayNotebookFork({
      checkpoint,
      plan,
      armId,
      drawId: draw.id,
      clusterId: checkpoint.caseId,
      focalPid: 'p1',
      treatment,
      controllers: controllers(identities),
      maxDecisions: 200,
    });
  const [control, treatment] = await Promise.all([run('withheld', withheld), run('authentic', authentic)]);
  assert.equal(control.protocolValid, true);
  assert.equal(control.actionLegal, true);
  assert.notEqual(control.utility, null);
  assert.equal(treatment.protocolValid, true);
  assert.equal(treatment.actionLegal, true);
  assert.notEqual(treatment.utility, null);
  assert.notEqual(control.actionId, treatment.actionId);
  assert.equal(control.sourceCheckpointDigest, treatment.sourceCheckpointDigest);
  assert.equal(control.forkConfigDigest, treatment.forkConfigDigest);
  assert.ok(control.terminalDigest);
  assert.ok(treatment.terminalDigest);
});
