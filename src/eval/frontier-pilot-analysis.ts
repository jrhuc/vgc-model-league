import { analyzeBo3Adaptation, BO3_ADAPTATION_PROTOCOL } from './bo3-adaptation.js';
import {
  FRONTIER_STRATEGIC_PILOT_PROTOCOL,
  type FrontierPilotCallTrace,
  type FrontierPilotSummary,
  type FrontierStrategicPilotReport,
} from './frontier-pilot.js';
import { FROZEN_MATCHDAY_ADAPTER_PROTOCOL } from './frozen-matchday-adapter.js';
import { canonicalJsonDigest } from './serialization.js';

export const FRONTIER_PILOT_AGGREGATION_PROTOCOL = {
  version: 1,
  reportValidation: 'canonical-report-plan-call-treatment-and-execution-digests-v1',
  sourceUnit: 'mean-within-source-replication-v1',
  uncertainty: 'standard-error-across-source-cluster-means-v1',
  ranking: 'forbidden-pilot-diagnostic-only-v1',
} as const;

export interface FrontierPilotSourceAggregate {
  sourceArtifactDigest: string;
  runs: number;
  matchedPairs: number;
  validPairs: number;
  meanDifference: number | null;
  replicationStandardError: number | null;
  positiveRunRate: number | null;
}

export interface FrontierPilotModelAggregate {
  modelConfigDigest: string;
  modelSpec: string;
  reasoning: FrontierStrategicPilotReport['model']['reasoning'];
  sourceClusters: number;
  validSourceClusters: number;
  runs: number;
  matchedPairs: number;
  validPairs: number;
  meanSourceDifference: number | null;
  standardError: number | null;
  positiveSourceRate: number | null;
  authenticInvalidRate: number | null;
  withheldInvalidRate: number | null;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  reportedCost: number;
  sources: FrontierPilotSourceAggregate[];
  readiness: 'insufficient-source-clusters' | 'pilot-estimate-only';
}

export interface FrontierPilotAggregateReport {
  protocolVersion: typeof FRONTIER_PILOT_AGGREGATION_PROTOCOL.version;
  generatedAt: string;
  inputReportDigests: string[];
  models: FrontierPilotModelAggregate[];
  interpretation: {
    unit: typeof FRONTIER_PILOT_AGGREGATION_PROTOCOL.sourceUnit;
    uncertainty: typeof FRONTIER_PILOT_AGGREGATION_PROTOCOL.uncertainty;
    ranking: typeof FRONTIER_PILOT_AGGREGATION_PROTOCOL.ranking;
    minimumSuggestedSourceClusters: 4;
  };
  aggregateDigest: string;
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

function close(left: number | null, right: number | null): boolean {
  if (left === null || right === null) return left === right;
  return Math.abs(left - right) <= 1e-12;
}

function expectedSummary(report: FrontierStrategicPilotReport): FrontierPilotSummary {
  const contrast = report.analysis.authenticVsWithheld;
  return {
    matchedPairs: contrast?.matchedPairs ?? 0,
    validPairs: contrast?.validPairs ?? 0,
    authenticMeanSeriesReturnDifference: contrast?.meanDifference ?? null,
    authenticInvalidRate: contrast?.treatmentInvalidRate ?? null,
    withheldInvalidRate: contrast?.controlInvalidRate ?? null,
    protocolValidOutcomes: report.outcomes.filter((outcome) => outcome.protocolValid).length,
    legalOutcomes: report.outcomes.filter((outcome) => outcome.actionLegal).length,
    totalOutcomes: report.outcomes.length,
    modelCalls: report.calls.length,
    inputTokens: report.calls.reduce((sum, call) => sum + (call.usage.input_tokens ?? 0), 0),
    outputTokens: report.calls.reduce((sum, call) => sum + (call.usage.output_tokens ?? 0), 0),
    reasoningTokens: report.calls.reduce((sum, call) => sum + (call.usage.reasoning_tokens ?? 0), 0),
    reportedCost: report.calls.reduce((sum, call) => sum + (call.usage.cost ?? 0), 0),
  };
}

function assertCall(call: FrontierPilotCallTrace): void {
  const { callDigest, ...base } = call;
  if (canonicalJsonDigest(base) !== callDigest) throw new Error(`frontier pilot call ${call.id} has a broken digest`);
}

function assertTreatment(report: FrontierStrategicPilotReport): void {
  for (const treatment of report.treatments) {
    const expected = canonicalJsonDigest({
      protocolVersion: BO3_ADAPTATION_PROTOCOL.version,
      id: treatment.id,
      kind: treatment.kind,
      notebook: treatment.notebook,
      sourceDigest: treatment.sourceDigest,
    });
    if (expected !== treatment.treatmentDigest) {
      throw new Error(`frontier pilot ${treatment.kind} treatment digest does not match its bytes`);
    }
  }
}

function assertExecution(report: FrontierStrategicPilotReport): void {
  if (report.executionOrder.length !== report.outcomes.length) {
    throw new Error('frontier pilot execution order does not cover every outcome');
  }
  const treatmentByKind = new Map(report.treatments.map((treatment) => [treatment.kind, treatment]));
  for (const [index, outcome] of report.outcomes.entries()) {
    const order = report.executionOrder[index];
    const arm = report.plan.arms.find((entry) => entry.id === outcome.armId);
    const draw = report.plan.draws.find((entry) => entry.id === outcome.drawId);
    const treatment = treatmentByKind.get(outcome.treatmentKind);
    if (
      !order ||
      order.index !== index ||
      order.armId !== outcome.armId ||
      order.drawId !== outcome.drawId ||
      order.treatmentKind !== outcome.treatmentKind ||
      order.outcomeExecutionDigest !== outcome.executionDigest ||
      !arm ||
      !draw ||
      !treatment
    ) {
      throw new Error(`frontier pilot outcome ${index} does not join its plan and execution order`);
    }
    const expected = canonicalJsonDigest({
      protocolVersion: FROZEN_MATCHDAY_ADAPTER_PROTOCOL.version,
      checkpointDigest: report.checkpointDigest,
      planDigest: report.plan.planDigest,
      armId: outcome.armId,
      draw,
      focalPid: report.focalPid,
      treatmentDigest: treatment.treatmentDigest,
      controllerSetDigest: arm.controllerSetDigest,
      sourceObservation: FROZEN_MATCHDAY_ADAPTER_PROTOCOL.sourceObservation,
      nonFocalNotebook: FROZEN_MATCHDAY_ADAPTER_PROTOCOL.nonFocalNotebook,
    });
    if (expected !== outcome.executionDigest || outcome.sourceCheckpointDigest !== report.checkpointDigest) {
      throw new Error(`frontier pilot outcome ${index} has a broken execution identity`);
    }
  }
}

export function validateFrontierStrategicPilotReport(report: FrontierStrategicPilotReport): void {
  const { reportDigest, ...base } = report;
  if (
    report.protocolVersion !== FRONTIER_STRATEGIC_PILOT_PROTOCOL.version ||
    canonicalJsonDigest(base) !== reportDigest
  ) {
    throw new Error('frontier strategic pilot report digest does not match its contents');
  }
  const { configDigest, ...modelBase } = report.model;
  if (canonicalJsonDigest(modelBase) !== configDigest) {
    throw new Error('frontier strategic pilot model config digest does not match');
  }
  const { planDigest, ...planBase } = report.plan;
  if (canonicalJsonDigest(planBase) !== planDigest) {
    throw new Error('frontier strategic pilot plan digest does not match');
  }
  for (const call of report.calls) assertCall(call);
  assertTreatment(report);
  assertExecution(report);
  const analysis = analyzeBo3Adaptation(report.outcomes);
  if (canonicalJsonDigest(analysis) !== canonicalJsonDigest(report.analysis)) {
    throw new Error('frontier strategic pilot analysis does not recompute from its outcomes');
  }
  const summary = expectedSummary(report);
  const exactFields: Array<keyof FrontierPilotSummary> = [
    'matchedPairs',
    'validPairs',
    'protocolValidOutcomes',
    'legalOutcomes',
    'totalOutcomes',
    'modelCalls',
    'inputTokens',
    'outputTokens',
    'reasoningTokens',
  ];
  if (exactFields.some((field) => summary[field] !== report.summary[field])) {
    throw new Error('frontier strategic pilot summary counts do not recompute');
  }
  const numericFields: Array<keyof FrontierPilotSummary> = [
    'authenticMeanSeriesReturnDifference',
    'authenticInvalidRate',
    'withheldInvalidRate',
    'reportedCost',
  ];
  if (numericFields.some((field) => !close(summary[field] as number | null, report.summary[field] as number | null))) {
    throw new Error('frontier strategic pilot summary values do not recompute');
  }
}

function sourceAggregate(sourceArtifactDigest: string, reports: readonly FrontierStrategicPilotReport[]) {
  const differences = reports
    .map((report) => report.analysis.authenticVsWithheld?.meanDifference ?? null)
    .filter((value): value is number => value !== null);
  return {
    sourceArtifactDigest,
    runs: reports.length,
    matchedPairs: reports.reduce((sum, report) => sum + (report.analysis.authenticVsWithheld?.matchedPairs ?? 0), 0),
    validPairs: reports.reduce((sum, report) => sum + (report.analysis.authenticVsWithheld?.validPairs ?? 0), 0),
    meanDifference: differences.length ? mean(differences) : null,
    replicationStandardError: standardError(differences),
    positiveRunRate: differences.length ? differences.filter((value) => value > 0).length / differences.length : null,
  } satisfies FrontierPilotSourceAggregate;
}

export function aggregateFrontierPilotReports(
  reports: readonly FrontierStrategicPilotReport[],
  generatedAt = new Date().toISOString(),
): FrontierPilotAggregateReport {
  if (!reports.length) throw new Error('frontier pilot aggregation needs at least one report');
  const digests = new Set<string>();
  const byModel = new Map<string, FrontierStrategicPilotReport[]>();
  for (const report of reports) {
    validateFrontierStrategicPilotReport(report);
    if (digests.has(report.reportDigest)) throw new Error(`frontier pilot report ${report.reportDigest} is repeated`);
    digests.add(report.reportDigest);
    byModel.set(report.model.configDigest, [...(byModel.get(report.model.configDigest) ?? []), report]);
  }
  const models = [...byModel.entries()]
    .map(([modelConfigDigest, modelReports]) => {
      const first = modelReports[0]!;
      const bySource = new Map<string, FrontierStrategicPilotReport[]>();
      for (const report of modelReports) {
        if (canonicalJsonDigest(report.model) !== canonicalJsonDigest(first.model)) {
          throw new Error(`model config digest ${modelConfigDigest} joins different model configs`);
        }
        bySource.set(report.sourceArtifactDigest, [...(bySource.get(report.sourceArtifactDigest) ?? []), report]);
      }
      const sources = [...bySource.entries()]
        .map(([sourceDigest, sourceReports]) => sourceAggregate(sourceDigest, sourceReports))
        .sort((left, right) => left.sourceArtifactDigest.localeCompare(right.sourceArtifactDigest));
      const sourceMeans = sources
        .map((source) => source.meanDifference)
        .filter((value): value is number => value !== null);
      const matchedPairs = modelReports.reduce(
        (sum, report) => sum + (report.analysis.authenticVsWithheld?.matchedPairs ?? 0),
        0,
      );
      const treatmentInvalid = modelReports.reduce((sum, report) => {
        const contrast = report.analysis.authenticVsWithheld;
        return sum + (contrast ? contrast.treatmentInvalidRate * contrast.matchedPairs : 0);
      }, 0);
      const controlInvalid = modelReports.reduce((sum, report) => {
        const contrast = report.analysis.authenticVsWithheld;
        return sum + (contrast ? contrast.controlInvalidRate * contrast.matchedPairs : 0);
      }, 0);
      return {
        modelConfigDigest,
        modelSpec: first.model.modelSpec,
        reasoning: first.model.reasoning,
        sourceClusters: sources.length,
        validSourceClusters: sourceMeans.length,
        runs: modelReports.length,
        matchedPairs,
        validPairs: modelReports.reduce(
          (sum, report) => sum + (report.analysis.authenticVsWithheld?.validPairs ?? 0),
          0,
        ),
        meanSourceDifference: sourceMeans.length ? mean(sourceMeans) : null,
        standardError: standardError(sourceMeans),
        positiveSourceRate: sourceMeans.length
          ? sourceMeans.filter((value) => value > 0).length / sourceMeans.length
          : null,
        authenticInvalidRate: matchedPairs ? treatmentInvalid / matchedPairs : null,
        withheldInvalidRate: matchedPairs ? controlInvalid / matchedPairs : null,
        modelCalls: modelReports.reduce((sum, report) => sum + report.summary.modelCalls, 0),
        inputTokens: modelReports.reduce((sum, report) => sum + report.summary.inputTokens, 0),
        outputTokens: modelReports.reduce((sum, report) => sum + report.summary.outputTokens, 0),
        reasoningTokens: modelReports.reduce((sum, report) => sum + report.summary.reasoningTokens, 0),
        reportedCost: modelReports.reduce((sum, report) => sum + report.summary.reportedCost, 0),
        sources,
        readiness: sourceMeans.length < 4 ? 'insufficient-source-clusters' : 'pilot-estimate-only',
      } satisfies FrontierPilotModelAggregate;
    })
    .sort((left, right) => left.modelSpec.localeCompare(right.modelSpec));
  const base = {
    protocolVersion: FRONTIER_PILOT_AGGREGATION_PROTOCOL.version,
    generatedAt,
    inputReportDigests: [...digests].sort(),
    models,
    interpretation: {
      unit: FRONTIER_PILOT_AGGREGATION_PROTOCOL.sourceUnit,
      uncertainty: FRONTIER_PILOT_AGGREGATION_PROTOCOL.uncertainty,
      ranking: FRONTIER_PILOT_AGGREGATION_PROTOCOL.ranking,
      minimumSuggestedSourceClusters: 4 as const,
    },
  };
  return { ...base, aggregateDigest: canonicalJsonDigest(base) };
}
