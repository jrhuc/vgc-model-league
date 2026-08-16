import json
from pathlib import Path


def replace(path: str, old: str, new: str, count: int = 1) -> None:
    file = Path(path)
    text = file.read_text()
    if text.count(old) != count:
        raise RuntimeError(f"{path}: expected {count} matches, found {text.count(old)}")
    file.write_text(text.replace(old, new, count))


package_file = Path("package.json")
package = json.loads(package_file.read_text())
if "summarize-strategic-pilots" in package["scripts"]:
    raise RuntimeError("package already exposes summarize-strategic-pilots")
package["scripts"]["summarize-strategic-pilots"] = "node dist/tools/summarize-strategic-pilots.js"
package_file.write_text(json.dumps(package, indent=2) + "\n")

replace(
    "tools/run-strategic-pilot.ts",
    """  --out <directory>          private report directory
""",
    """  --out <directory>          new or empty private report directory
""",
)
replace(
    "tools/run-strategic-pilot.ts",
    """function defaultOutputDirectory(): string {
""",
    """function modelStem(value: string): string {
  return `${filename(value)}-${canonicalJsonDigest(value).slice(0, 8)}`;
}

function defaultOutputDirectory(): string {
""",
)
replace(
    "tools/run-strategic-pilot.ts",
    """function writeCanonical(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${canonicalJson(value)}\\n`);
}
""",
    """function writeCanonical(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${canonicalJson(value)}\\n`, { flag: 'wx' });
}
""",
)
replace(
    "tools/run-strategic-pilot.ts",
    """  const outputDirectory = path.resolve(values.out ?? defaultOutputDirectory());
  fs.mkdirSync(outputDirectory, { recursive: true });
""",
    """  const outputDirectory = path.resolve(values.out ?? defaultOutputDirectory());
  if (fs.existsSync(outputDirectory)) {
    const stat = fs.statSync(outputDirectory);
    if (!stat.isDirectory() || fs.readdirSync(outputDirectory).length) {
      throw new Error(`frontier pilot output must be a new or empty directory: ${outputDirectory}`);
    }
  } else {
    fs.mkdirSync(outputDirectory, { recursive: true });
  }
""",
)
replace(
    "tools/run-strategic-pilot.ts",
    "`${filename(modelSpec)}-notebook-failure.json`",
    "`${modelStem(modelSpec)}-notebook-failure.json`",
)
replace(
    "tools/run-strategic-pilot.ts",
    "`${filename(modelSpec)}.json`",
    "`${modelStem(modelSpec)}.json`",
)

replace(
    "tests/eval-frontier-pilot.test.ts",
    """import type { CommonForkDraw } from '../src/eval/fork-plan.js';
""",
    """import {
  aggregateFrontierPilotReports,
  validateFrontierStrategicPilotReport,
} from '../src/eval/frontier-pilot-analysis.js';
import type { CommonForkDraw } from '../src/eval/fork-plan.js';
""",
)
replace(
    "tests/eval-frontier-pilot.test.ts",
    """  assert.notEqual(report.executionOrder[0]!.outcomeExecutionDigest, report.executionOrder[1]!.outcomeExecutionDigest);
  assert.match(report.reportDigest, /^[0-9a-f]{64}$/u);
});
""",
    """  assert.notEqual(report.executionOrder[0]!.outcomeExecutionDigest, report.executionOrder[1]!.outcomeExecutionDigest);
  assert.match(report.reportDigest, /^[0-9a-f]{64}$/u);

  validateFrontierStrategicPilotReport(report);
  const aggregate = aggregateFrontierPilotReports([report], '2026-08-16T00:00:01.000Z');
  assert.equal(aggregate.models.length, 1);
  assert.equal(aggregate.models[0]!.sourceClusters, 1);
  assert.equal(aggregate.models[0]!.validSourceClusters, 1);
  assert.equal(aggregate.models[0]!.readiness, 'insufficient-source-clusters');
  assert.equal(
    aggregate.models[0]!.meanSourceDifference,
    report.analysis.authenticVsWithheld?.meanDifference ?? null,
  );

  const changed = structuredClone(report);
  changed.generatedAt = '2026-08-16T00:00:02.000Z';
  const { reportDigest: priorDigest, ...changedBase } = changed;
  assert.ok(priorDigest);
  const replication = { ...changedBase, reportDigest: canonicalJsonDigest(changedBase) };
  const repeated = aggregateFrontierPilotReports(
    [report, replication],
    '2026-08-16T00:00:03.000Z',
  );
  assert.equal(repeated.models[0]!.runs, 2);
  assert.equal(repeated.models[0]!.sourceClusters, 1);
  assert.equal(repeated.models[0]!.sources[0]!.runs, 2);
  assert.equal(repeated.models[0]!.standardError, null);

  const tampered = structuredClone(report);
  tampered.calls[0]!.prompt += 'tampered';
  assert.throws(() => validateFrontierStrategicPilotReport(tampered), /report digest does not match/u);
});
""",
)

replace(
    "src/eval/frontier-pilot-analysis.ts",
    """        readiness: sources.length < 4 ? 'insufficient-source-clusters' : 'pilot-estimate-only',
""",
    """        readiness: sourceMeans.length < 4 ? 'insufficient-source-clusters' : 'pilot-estimate-only',
""",
)

replace(
    "docs/usage.md",
    """Add preregistered negative and upper-bound controls with exact notebook files:
""",
    """After collecting independent source directories, validate every digest and
aggregate at the source-cluster level:

```sh
pnpm run summarize-strategic-pilots -- \\
  --out runs/strategic-pilot-aggregate.json \\
  runs/source-1 runs/source-2 runs/source-3 runs/source-4
```

The summarizer scans model report JSON recursively, rejects broken plan, call,
treatment, execution, analysis, or report joins, averages repeated provider-call
runs inside each source first, and computes uncertainty across source means. It
marks fewer than four valid source clusters as insufficient and never emits a
ranking.

Add preregistered negative and upper-bound controls with exact notebook files:
""",
)
replace(
    "docs/usage.md",
    """The output directory is private evidence. `source.json` contains exact private
source evidence; each model JSON contains prompts and raw provider responses;
""",
    """The output directory is private evidence and must be new or empty. Every
artifact is written create-only; reruns require a new directory rather than
silently replacing evidence. `source.json` contains exact private source
evidence; each model JSON contains prompts and raw provider responses;
""",
)
replace(
    "docs/evaluation-plan.md",
    """### Go/no-go criteria
""",
    """Aggregate completed private reports with `pnpm run
summarize-strategic-pilots -- <report-or-directory>...`. The validator
recomputes report, model, fork-plan, call, treatment, execution, analysis, and
summary identities. Repeated provider-call runs are averaged within their
source before uncertainty is computed across source-cluster means. Fewer than
four valid source clusters remains explicitly insufficient evidence.

### Go/no-go criteria
""",
)
replace(
    "docs/strategic-evals.md",
    """The pilot is a falsification milestone. Expand the evaluation only if authentic
memory beats withholding on independently selected source clusters, false
""",
    """`tools/summarize-strategic-pilots.ts` validates the complete private report
join and aggregates repeated runs within source before computing uncertainty
across source-cluster means. It labels fewer than four valid sources as
insufficient and does not produce a model ranking.

The pilot is a falsification milestone. Expand the evaluation only if authentic
memory beats withholding on independently selected source clusters, false
""",
)
