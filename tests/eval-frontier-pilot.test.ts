import assert from 'node:assert/strict';
import test from 'node:test';
import type { CommonForkDraw } from '../src/eval/fork-plan.js';
import {
  buildFrontierPilotMatchday,
  buildFrontierPilotSourceArtifact,
  completeFrontierPilotSource,
  FrontierPilotActionController,
  type FrontierPilotPublicContext,
  generateFrontierAuthenticNotebook,
  runFrontierStrategicPilot,
} from '../src/eval/frontier-pilot.js';
import {
  aggregateFrontierPilotReports,
  validateFrontierStrategicPilotReport,
} from '../src/eval/frontier-pilot-analysis.js';
import type { FrozenMatchdayActionContext } from '../src/eval/frozen-matchday-adapter.js';
import { buildFrozenMatchdayBetweenGameCheckpoint } from '../src/eval/frozen-matchday-adapter.js';
import { canonicalJsonDigest } from '../src/eval/serialization.js';
import type { Completion, Provider, ProviderMessage } from '../src/types.js';
import { MATCHDAY_FORMAT, MATCHDAY_TEAM_A, MATCHDAY_TEAM_B } from './fixtures/frozen-matchday.js';

class PilotProvider implements Provider {
  readonly prompts: string[] = [];

  async complete(_system: string, messages: ProviderMessage[]): Promise<Completion> {
    const prompt = messages.at(-1)?.content ?? '';
    this.prompts.push(prompt);
    if (prompt.includes('Write the private notebook that this seat will receive')) {
      return {
        text: JSON.stringify({ notebook: 'Use the alternate preview and preserve speed control.' }),
        usage: { input_tokens: 100, output_tokens: 20, reasoning_tokens: 10, cost: 0.01 },
        toolCalls: [],
      };
    }
    const ids = [...prompt.matchAll(/^- (a_[0-9a-f]+):/gmu)].map((match) => match[1]!);
    assert.ok(ids.length >= 2);
    const selected = prompt.includes('alternate preview') ? ids.at(-1)! : ids[0]!;
    return {
      text: JSON.stringify({ action_id: selected }),
      usage: { input_tokens: 120, output_tokens: 8, cost: 0.005 },
      toolCalls: [],
    };
  }
}

function context(): FrontierPilotPublicContext {
  const seats = {
    p1: { pid: 'p1' as const, name: 'frontier', teamId: 'a', openSheet: [] },
    p2: { pid: 'p2' as const, name: 'fixed', teamId: 'b', openSheet: [] },
  };
  return { format: MATCHDAY_FORMAT, seats, contextDigest: canonicalJsonDigest({ format: MATCHDAY_FORMAT, seats }) };
}

function actionContext(): FrozenMatchdayActionContext {
  const draw: CommonForkDraw = {
    id: 'draw',
    hiddenStateSeed: 'hidden',
    opponentPolicySeed: 'opponent',
    battleSeed: [1, 2, 3, 4],
    continuationSeed: 'continuation',
    scheduleSeed: 'schedule',
  };
  return {
    pid: 'p1',
    observation: {
      protocolVersion: 1,
      battleProtocolVersion: 1,
      pid: 'p1',
      phase: 'playing',
      gameNumber: 2,
      score: { p1: 0, p2: 1, ties: 0 },
      revision: 4,
      stateHash: canonicalJsonDigest('state'),
      povLines: ['|turn|3'],
      battle: {
        protocolVersion: 1,
        pid: 'p1',
        seat: { pid: 'p1', name: 'frontier' },
        revision: 2,
        stateHash: canonicalJsonDigest('battle'),
        request: { active: [{ moves: [] }, { moves: [] }] },
        povLines: [],
        terminal: false,
      },
      terminal: false,
    },
    legalActions: [
      { number: 0, choices: [0], command: 'move 1 1', label: 'Use move one' },
      { number: 1, choices: [1], command: 'move 2 1', label: 'Use move two' },
    ],
    currentNotebook: 'Use the alternate preview.',
    decisionIndex: 0,
    draw,
  };
}

let cachedSource: ReturnType<typeof buildFrontierPilotSourceArtifact> | null = null;

function sourceArtifact() {
  if (cachedSource) return structuredClone(cachedSource);
  const matchday = buildFrontierPilotMatchday({
    format: MATCHDAY_FORMAT,
    focal: { id: 'team-a', packed: MATCHDAY_TEAM_A },
    opponent: { id: 'team-b', packed: MATCHDAY_TEAM_B },
    seed: 'frontier-pilot-test',
  });
  cachedSource = buildFrontierPilotSourceArtifact({
    publicContext: matchday.publicContext,
    source: completeFrontierPilotSource({ caseId: 'frontier-pilot-test', options: matchday.options }),
  });
  return structuredClone(cachedSource);
}

test('frontier action controller uses strict opaque tasks and joins the selected command', async () => {
  const provider = new PilotProvider();
  const controller = new FrontierPilotActionController({
    modelSpec: 'openrouter:test/frontier',
    provider,
    publicContext: context(),
    modelDecisionLimit: 'all',
  });
  const first = actionContext();
  const decision = await controller.decideAction(first);
  assert.equal(decision.command, 'move 2 1');
  const second = actionContext();
  second.decisionIndex = 1;
  second.observation.povLines = ['|move|p1a: Alpha|Protect|p1a: Alpha'];
  await controller.decideAction(second);
  const traces = controller.traces();
  assert.equal(traces.length, 2);
  assert.equal(traces[0]!.status, 'valid');
  assert.equal(traces[0]!.canonicalAction, decision.command);
  assert.match(traces[0]!.callDigest, /^[0-9a-f]{64}$/u);
  assert.match(traces[1]!.prompt, /\|turn\|3/u);
  assert.match(traces[1]!.prompt, /\|move\|p1a: Alpha\|Protect/u);
});

test('frontier action controller bounds provider decisions before declared continuation', async () => {
  const provider = new PilotProvider();
  const controller = new FrontierPilotActionController({
    modelSpec: 'openrouter:test/frontier',
    provider,
    publicContext: context(),
    modelDecisionLimit: 1,
  });
  const first = await controller.decideAction(actionContext());
  assert.equal(first.command, 'move 2 1');
  const secondContext = actionContext();
  secondContext.decisionIndex = 1;
  const second = await controller.decideAction(secondContext);
  assert.equal(second.command, 'move 1 1');
  assert.equal(controller.traces().length, 1);
});

test('frontier task identity changes when authorized notebook state changes', async () => {
  const controlProvider = new PilotProvider();
  const treatmentProvider = new PilotProvider();
  const control = new FrontierPilotActionController({
    modelSpec: 'openrouter:test/frontier',
    provider: controlProvider,
    publicContext: context(),
  });
  const treatment = new FrontierPilotActionController({
    modelSpec: 'openrouter:test/frontier',
    provider: treatmentProvider,
    publicContext: context(),
  });
  const controlContext = actionContext();
  controlContext.currentNotebook = '';
  const treatmentContext = actionContext();
  treatmentContext.currentNotebook = 'Use the alternate preview.';
  await control.decideAction(controlContext);
  await treatment.decideAction(treatmentContext);
  assert.notEqual(control.traces()[0]!.id, treatment.traces()[0]!.id);
  assert.notEqual(control.traces()[0]!.promptDigest, treatment.traces()[0]!.promptDigest);
});

test('frontier notebook generation binds exact model-written bytes', async () => {
  const source = sourceArtifact();
  const checkpoint = buildFrozenMatchdayBetweenGameCheckpoint(source.source, 1);
  const provider = new PilotProvider();
  const generated = await generateFrontierAuthenticNotebook({
    checkpoint,
    focalPid: 'p1',
    publicContext: source.publicContext,
    modelSpec: 'openrouter:test/frontier',
    provider,
  });
  assert.equal(generated.status, 'valid');
  assert.equal(generated.treatment?.kind, 'authentic');
  assert.equal(generated.treatment?.notebook, 'Use the alternate preview and preserve speed control.');
  assert.equal(generated.treatment?.sourceDigest, generated.trace.callDigest);
  const sourceLine = checkpoint.sourcePovLines.p1.find((line) => line.startsWith('|'));
  assert.ok(sourceLine);
  assert.ok(provider.prompts[0]?.includes(sourceLine));
});

test('frontier pilot runs balanced authentic and withheld forks with private call evidence', async () => {
  const source = sourceArtifact();
  const checkpoint = buildFrozenMatchdayBetweenGameCheckpoint(source.source, 1);
  const provider = new PilotProvider();
  const generated = await generateFrontierAuthenticNotebook({
    checkpoint,
    focalPid: 'p1',
    publicContext: source.publicContext,
    modelSpec: 'openrouter:test/frontier',
    provider,
  });
  assert.equal(generated.status, 'valid');
  assert.ok(generated.treatment);
  const report = await runFrontierStrategicPilot({
    sourceArtifact: source,
    modelSpec: 'openrouter:test/frontier',
    provider,
    authenticTreatment: generated.treatment,
    notebookTrace: generated.trace,
    drawCount: 1,
    drawSeed: 'frontier-pilot-test-draw',
    maxDecisions: 250,
    generatedAt: '2026-08-16T00:00:00.000Z',
  });
  assert.equal(report.outcomes.length, 2);
  assert.equal(report.analysis.authenticVsWithheld?.matchedPairs, 1);
  assert.equal(report.analysis.authenticVsWithheld?.validPairs, 1);
  assert.ok(report.calls.length > 1);
  assert.equal(report.summary.protocolValidOutcomes, 2);
  assert.equal(report.summary.legalOutcomes, 2);
  assert.notEqual(report.executionOrder[0]!.outcomeExecutionDigest, report.executionOrder[1]!.outcomeExecutionDigest);
  assert.match(report.reportDigest, /^[0-9a-f]{64}$/u);

  validateFrontierStrategicPilotReport(report);
  const aggregate = aggregateFrontierPilotReports([report], '2026-08-16T00:00:01.000Z');
  assert.equal(aggregate.models.length, 1);
  assert.equal(aggregate.models[0]!.sourceClusters, 1);
  assert.equal(aggregate.models[0]!.validSourceClusters, 1);
  assert.equal(aggregate.models[0]!.readiness, 'insufficient-source-clusters');
  assert.equal(aggregate.models[0]!.meanSourceDifference, report.analysis.authenticVsWithheld?.meanDifference ?? null);

  const duplicate = structuredClone(report);
  duplicate.generatedAt = '2026-08-16T00:00:02.000Z';
  const { reportDigest: duplicatePriorDigest, ...duplicateBase } = duplicate;
  assert.ok(duplicatePriorDigest);
  const duplicateReport = { ...duplicateBase, reportDigest: canonicalJsonDigest(duplicateBase) };
  assert.throws(
    () => aggregateFrontierPilotReports([report, duplicateReport], '2026-08-16T00:00:03.000Z'),
    /run evidence .* is repeated/u,
  );

  const changed = structuredClone(report);
  changed.generatedAt = '2026-08-16T00:00:04.000Z';
  const changedCall = { ...changed.calls[0]!, latencyMs: changed.calls[0]!.latencyMs + 1 };
  const { callDigest: priorCallDigest, ...changedCallBase } = changedCall;
  assert.ok(priorCallDigest);
  changed.calls[0] = { ...changedCallBase, callDigest: canonicalJsonDigest(changedCallBase) };
  const { reportDigest: priorDigest, ...changedBase } = changed;
  assert.ok(priorDigest);
  const replication = { ...changedBase, reportDigest: canonicalJsonDigest(changedBase) };
  const repeated = aggregateFrontierPilotReports([report, replication], '2026-08-16T00:00:05.000Z');
  assert.equal(repeated.models[0]!.runs, 2);
  assert.equal(repeated.models[0]!.sourceClusters, 1);
  assert.equal(repeated.models[0]!.sources[0]!.runs, 2);
  assert.equal(repeated.models[0]!.standardError, null);

  const tampered = structuredClone(report);
  tampered.calls[0]!.prompt += 'tampered';
  assert.throws(() => validateFrontierStrategicPilotReport(tampered), /report digest does not match/u);
});
