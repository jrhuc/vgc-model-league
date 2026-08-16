from pathlib import Path


def replace(path: str, old: str, new: str, count: int = 1) -> None:
    file = Path(path)
    text = file.read_text()
    if text.count(old) != count:
        raise RuntimeError(f"{path}: expected {count} matches, found {text.count(old)}")
    file.write_text(text.replace(old, new, count))


replace(
    "src/eval/frontier-pilot-analysis.ts",
    """export const FRONTIER_PILOT_AGGREGATION_PROTOCOL = {
  version: 1,
  reportValidation: 'canonical-report-plan-call-treatment-and-execution-digests-v1',
""",
    """export const FRONTIER_PILOT_AGGREGATION_PROTOCOL = {
  version: 2,
  reportValidation: 'canonical-report-plan-call-treatment-and-execution-digests-v2',
  replicationIdentity: 'reject-duplicate-source-plan-treatment-outcome-and-call-evidence-v1',
""",
)
replace(
    "src/eval/frontier-pilot-analysis.ts",
    """  inputReportDigests: string[];
  models: FrontierPilotModelAggregate[];
""",
    """  inputReportDigests: string[];
  inputRunEvidenceDigests: string[];
  models: FrontierPilotModelAggregate[];
""",
)
replace(
    "src/eval/frontier-pilot-analysis.ts",
    """function sourceAggregate(sourceArtifactDigest: string, reports: readonly FrontierStrategicPilotReport[]) {
""",
    """function runEvidenceDigest(report: FrontierStrategicPilotReport): string {
  return canonicalJsonDigest({
    sourceArtifactDigest: report.sourceArtifactDigest,
    checkpointDigest: report.checkpointDigest,
    model: report.model,
    plan: report.plan,
    treatments: report.treatments,
    executionOrder: report.executionOrder,
    outcomes: report.outcomes,
    calls: report.calls,
  });
}

function sourceAggregate(sourceArtifactDigest: string, reports: readonly FrontierStrategicPilotReport[]) {
""",
)
replace(
    "src/eval/frontier-pilot-analysis.ts",
    """  const digests = new Set<string>();
  const byModel = new Map<string, FrontierStrategicPilotReport[]>();
""",
    """  const digests = new Set<string>();
  const evidenceDigests = new Set<string>();
  const byModel = new Map<string, FrontierStrategicPilotReport[]>();
""",
)
replace(
    "src/eval/frontier-pilot-analysis.ts",
    """    if (digests.has(report.reportDigest)) throw new Error(`frontier pilot report ${report.reportDigest} is repeated`);
    digests.add(report.reportDigest);
    byModel.set(report.model.configDigest, [...(byModel.get(report.model.configDigest) ?? []), report]);
""",
    """    if (digests.has(report.reportDigest)) throw new Error(`frontier pilot report ${report.reportDigest} is repeated`);
    digests.add(report.reportDigest);
    const evidenceDigest = runEvidenceDigest(report);
    if (evidenceDigests.has(evidenceDigest)) {
      throw new Error(`frontier pilot run evidence ${evidenceDigest} is repeated`);
    }
    evidenceDigests.add(evidenceDigest);
    byModel.set(report.model.configDigest, [...(byModel.get(report.model.configDigest) ?? []), report]);
""",
)
replace(
    "src/eval/frontier-pilot-analysis.ts",
    """    inputReportDigests: [...digests].sort(),
    models,
""",
    """    inputReportDigests: [...digests].sort(),
    inputRunEvidenceDigests: [...evidenceDigests].sort(),
    models,
""",
)

replace(
    "tests/eval-frontier-pilot.test.ts",
    """  const changed = structuredClone(report);
  changed.generatedAt = '2026-08-16T00:00:02.000Z';
  const { reportDigest: priorDigest, ...changedBase } = changed;
  assert.ok(priorDigest);
  const replication = { ...changedBase, reportDigest: canonicalJsonDigest(changedBase) };
""",
    """  const duplicate = structuredClone(report);
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
""",
)
replace(
    "tests/eval-frontier-pilot.test.ts",
    """  const repeated = aggregateFrontierPilotReports([report, replication], '2026-08-16T00:00:03.000Z');
""",
    """  const repeated = aggregateFrontierPilotReports([report, replication], '2026-08-16T00:00:05.000Z');
""",
)
