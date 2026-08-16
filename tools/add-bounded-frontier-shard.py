from pathlib import Path


def replace(path: str, old: str, new: str, count: int = 1) -> None:
    file = Path(path)
    text = file.read_text()
    if text.count(old) != count:
        raise RuntimeError(f"{path}: expected {count} matches, found {text.count(old)}")
    file.write_text(text.replace(old, new, count))


replace(
    "src/eval/frontier-pilot.ts",
    """export const FRONTIER_STRATEGIC_PILOT_PROTOCOL = {
  version: 1,
  source: 'deterministic-first-legal-completed-matchday-v1',
  treatment: 'model-written-game-one-private-notebook-v1',
  policy: 'frontier-model-focal-first-legal-opponent-v1',
""",
    """export const FRONTIER_STRATEGIC_PILOT_PROTOCOL = {
  version: 2,
  source: 'deterministic-first-legal-completed-matchday-v1',
  treatment: 'model-written-game-one-private-notebook-v1',
  policy: 'bounded-frontier-decisions-then-first-legal-continuation-v2',
""",
)
replace(
    "src/eval/frontier-pilot.ts",
    """export interface FrontierPilotModelConfig {
  modelSpec: string;
  reasoning: ReasoningLevel | null;
  maxTokens: number;
""",
    """export type FrontierPilotModelDecisionLimit = number | 'all';

export interface FrontierPilotModelConfig {
  modelSpec: string;
  reasoning: ReasoningLevel | null;
  modelDecisionLimit: FrontierPilotModelDecisionLimit;
  downstreamPolicy: 'first-showdown-accepted-action-v1';
  maxTokens: number;
""",
)
replace(
    "src/eval/frontier-pilot.ts",
    """  reasoning?: ReasoningLevel;
  maxTokens?: number;
  timeoutSeconds?: number;
""",
    """  reasoning?: ReasoningLevel;
  modelDecisionLimit?: FrontierPilotModelDecisionLimit;
  maxTokens?: number;
  timeoutSeconds?: number;
""",
    3,
)
replace(
    "src/eval/frontier-pilot.ts",
    """function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}
""",
    """function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}

function modelDecisionLimit(value: FrontierPilotModelDecisionLimit | undefined): FrontierPilotModelDecisionLimit {
  if (value === undefined) return 1;
  if (value === 'all') return value;
  return positiveInteger(value, 'modelDecisionLimit');
}
""",
)
replace(
    "src/eval/frontier-pilot.ts",
    """  const base = {
    modelSpec: input.modelSpec,
    reasoning: input.reasoning ?? null,
    maxTokens,
""",
    """  const base = {
    modelSpec: input.modelSpec,
    reasoning: input.reasoning ?? null,
    modelDecisionLimit: modelDecisionLimit(input.modelDecisionLimit),
    downstreamPolicy: 'first-showdown-accepted-action-v1' as const,
    maxTokens,
""",
)
replace(
    "src/eval/frontier-pilot.ts",
    """  private readonly callTraces: FrontierPilotCallTrace[] = [];
  private readonly povHistory: string[] = [];
""",
    """  private readonly callTraces: FrontierPilotCallTrace[] = [];
  private readonly povHistory: string[] = [];
  private modelDecisions = 0;
""",
)
replace(
    "src/eval/frontier-pilot.ts",
    """    if (context.legalActions.length === 1) {
      const selected = context.legalActions[0]!;
      return {
        command: selected.command,
        actionId: canonicalJsonDigest(['frontier-pilot-forced-action-v1', selected.command]),
      };
    }
    const opportunityId = canonicalJsonDigest([
""",
    """    if (context.legalActions.length === 1) {
      const selected = context.legalActions[0]!;
      return {
        command: selected.command,
        actionId: canonicalJsonDigest(['frontier-pilot-forced-action-v1', selected.command]),
      };
    }
    if (this.model.modelDecisionLimit !== 'all' && this.modelDecisions >= this.model.modelDecisionLimit) {
      const selected = context.legalActions[0]!;
      return {
        command: selected.command,
        actionId: canonicalJsonDigest([
          'frontier-pilot-declared-downstream-action-v1',
          this.model.downstreamPolicy,
          selected.command,
        ]),
      };
    }
    const opportunityId = canonicalJsonDigest([
""",
)
replace(
    "src/eval/frontier-pilot.ts",
    """    this.callTraces.push(traced(base));
    return { command: selected.canonicalAction, actionId: parsed.actionId };
""",
    """    this.callTraces.push(traced(base));
    this.modelDecisions += 1;
    return { command: selected.canonicalAction, actionId: parsed.actionId };
""",
)
replace(
    "src/eval/frontier-pilot.ts",
    """        ...(input.reasoning === undefined ? {} : { reasoning: input.reasoning }),
        ...(input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens }),
""",
    """        ...(input.reasoning === undefined ? {} : { reasoning: input.reasoning }),
        modelDecisionLimit: model.modelDecisionLimit,
        ...(input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens }),
""",
)

replace(
    "tools/run-strategic-pilot.ts",
    """  type FrontierPilotSourceArtifact,
  frontierPilotProvider,
""",
    """  type FrontierPilotModelDecisionLimit,
  type FrontierPilotSourceArtifact,
  frontierPilotProvider,
""",
)
replace(
    "tools/run-strategic-pilot.ts",
    """const HELP = `Usage: pnpm run strategic-pilot -- --models <spec> [--models <spec> ...]
""",
    """const HELP = `Usage: pnpm run strategic-pilot -- [--models <spec> ...]
""",
)
replace(
    "tools/run-strategic-pilot.ts",
    """  --models <spec>            repeat for every frontier model to test
  --pool <name>              existing team pool (default: test)
""",
    """  --models <spec>            repeat for every frontier model to test
  --prepare-source-only      freeze source.json before any provider call
  --pool <name>              existing team pool (default: test)
""",
)
replace(
    "tools/run-strategic-pilot.ts",
    """  --reasoning <level>        minimal, low, medium, high, or xhigh
  --nitro                    add OpenRouter's :nitro routing variant
""",
    """  --reasoning <level>        minimal, low, medium, high, or xhigh
  --model-decisions <n|all>  focal model non-forced choices per arm (default: 1)
  --nitro                    add OpenRouter's :nitro routing variant
""",
)
replace(
    "tools/run-strategic-pilot.ts",
    """digests. One team pair is one source cluster and is never a ranking.`;
""",
    """digests. The default is one attributable focal choice followed by a
declared first-legal continuation; use --model-decisions all for the ecological
full-policy follow-up. One team pair is one source cluster and is never a ranking.`;
""",
)
replace(
    "tools/run-strategic-pilot.ts",
    """function reasoning(value: string | undefined): ReasoningLevel | undefined {
""",
    """function parsedModelDecisionLimit(value: string): FrontierPilotModelDecisionLimit {
  if (value === 'all') return value;
  return integer(value, 'model-decisions');
}

function reasoning(value: string | undefined): ReasoningLevel | undefined {
""",
)
replace(
    "tools/run-strategic-pilot.ts",
    """      help: { type: 'boolean', default: false },
      models: { type: 'string', multiple: true },
      pool: { type: 'string', default: 'test' },
""",
    """      help: { type: 'boolean', default: false },
      models: { type: 'string', multiple: true },
      'prepare-source-only': { type: 'boolean', default: false },
      pool: { type: 'string', default: 'test' },
""",
)
replace(
    "tools/run-strategic-pilot.ts",
    """      reasoning: { type: 'string' },
      nitro: { type: 'boolean', default: false },
""",
    """      reasoning: { type: 'string' },
      'model-decisions': { type: 'string', default: '1' },
      nitro: { type: 'boolean', default: false },
""",
)
replace(
    "tools/run-strategic-pilot.ts",
    """  const rawModels = values.models ?? [];
  if (!rawModels.length) throw new Error('at least one --models spec is required');
  const models = values.nitro ? rawModels.map(nitroSpec) : rawModels;
""",
    """  const rawModels = values.models ?? [];
  if (values['prepare-source-only'] && rawModels.length) {
    throw new Error('--prepare-source-only cannot be combined with --models');
  }
  if (values['prepare-source-only'] && values.source) {
    throw new Error('--prepare-source-only creates a new source and cannot be combined with --source');
  }
  if (!values['prepare-source-only'] && !rawModels.length) {
    throw new Error('at least one --models spec is required unless --prepare-source-only is used');
  }
  const models = values.nitro ? rawModels.map(nitroSpec) : rawModels;
""",
)
replace(
    "tools/run-strategic-pilot.ts",
    """  const reasoningLevel = reasoning(values.reasoning);
  const drawCount = integer(values.draws, 'draws');
""",
    """  const reasoningLevel = reasoning(values.reasoning);
  const modelDecisionLimit = parsedModelDecisionLimit(values['model-decisions']);
  const drawCount = integer(values.draws, 'draws');
""",
)
replace(
    "tools/run-strategic-pilot.ts",
    """  writeCanonical(path.join(outputDirectory, 'source.json'), sourceArtifact);
  const checkpoint = buildFrozenMatchdayBetweenGameCheckpoint(sourceArtifact.source, 1);
""",
    """  writeCanonical(path.join(outputDirectory, 'source.json'), sourceArtifact);
  if (values['prepare-source-only']) {
    const preparedBase = {
      protocolVersion: 1,
      generatedAt: new Date().toISOString(),
      sourceArtifactDigest: sourceArtifact.sourceArtifactDigest,
      sourceFile: 'source.json',
      models: [],
      interpretation: 'source-frozen-before-provider-calls',
    };
    writeCanonical(path.join(outputDirectory, 'summary.json'), {
      ...preparedBase,
      batchDigest: canonicalJsonDigest(preparedBase),
    });
    console.log(`prepared frontier pilot source: ${path.join(outputDirectory, 'source.json')}`);
    return 0;
  }
  const checkpoint = buildFrozenMatchdayBetweenGameCheckpoint(sourceArtifact.source, 1);
""",
)
replace(
    "tools/run-strategic-pilot.ts",
    """        ...(reasoningLevel === undefined ? {} : { reasoning: reasoningLevel }),
        maxTokens,
""",
    """        ...(reasoningLevel === undefined ? {} : { reasoning: reasoningLevel }),
        modelDecisionLimit,
        maxTokens,
""",
)
replace(
    "tools/run-strategic-pilot.ts",
    """        ...(reasoningLevel === undefined ? {} : { reasoning: reasoningLevel }),
        drawCount,
""",
    """        ...(reasoningLevel === undefined ? {} : { reasoning: reasoningLevel }),
        modelDecisionLimit,
        drawCount,
""",
)
replace(
    "tools/run-strategic-pilot.ts",
    """    drawCount,
    models: results,
""",
    """    drawCount,
    modelDecisionLimit,
    models: results,
""",
)

replace(
    "tests/eval-frontier-pilot.test.ts",
    """    provider,
    publicContext: context(),
  });
  const first = actionContext();
""",
    """    provider,
    publicContext: context(),
    modelDecisionLimit: 'all',
  });
  const first = actionContext();
""",
    1,
)
marker = "\ntest('frontier task identity changes when authorized notebook state changes', async () => {"
addition = """

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
"""
test_file = Path("tests/eval-frontier-pilot.test.ts")
test_text = test_file.read_text()
if test_text.count(marker) != 1:
    raise RuntimeError(f"frontier bounded test marker changed: {test_text.count(marker)}")
test_file.write_text(test_text.replace(marker, addition + marker, 1))

replace(
    "docs/usage.md",
    """  --draws 4 \\
  --reasoning high \\
""",
    """  --draws 4 \\
  --model-decisions 1 \\
  --reasoning high \\
""",
    1,
)
replace(
    "docs/usage.md",
    """The v1 pilot is deliberately narrow. It constructs one deterministic source
""",
    """The v2 pilot is deliberately narrow. It constructs one deterministic source
""",
)
replace(
    "docs/usage.md",
    """treatment bytes. The same model then plays the remaining matched continuations
under two arms:
""",
    """treatment bytes. By default the same model makes the first non-forced Game 2
choice, usually team preview, and a declared first-legal policy completes the
series. This is the cheapest attributable shard. Increase `--model-decisions`
for a short intervention chain or use `all` for the ecological full-policy
follow-up. The matched arms are:
""",
)
prepare = """
Freeze each source before any provider call:

```sh
pnpm run strategic-pilot -- \\
  --prepare-source-only \\
  --pool test \\
  --focal-team <team-id> \\
  --opponent-team <team-id> \\
  --seed source-1 \\
  --out runs/source-1
```

"""
usage = Path("docs/usage.md")
usage_text = usage.read_text()
usage_marker = "Repeat `--models` to run the same source and common draws for multiple models.\n"
if usage_text.count(usage_marker) != 1:
    raise RuntimeError("usage source preparation marker changed")
usage.write_text(usage_text.replace(usage_marker, prepare + usage_marker, 1))

replace(
    "docs/frontier-pilot-checklist.md",
    """Choose source team pairs and source seeds before provider calls. Record the
selection rule outside the private result directories. A convenient first
matrix is four distinct team-pair or source-seed cases from an existing pool.
Do not select cases because authentic memory happened to help.
""",
    """Choose source team pairs and source seeds before provider calls. Record the
selection rule outside the private result directories. A convenient first
matrix is four distinct team-pair or source-seed cases from an existing pool.
Do not select cases because authentic memory happened to help.

Freeze every case before provider calls:

```sh
pnpm run strategic-pilot -- \\
  --prepare-source-only \\
  --pool test \\
  --focal-team <team-id> \\
  --opponent-team <team-id> \\
  --seed source-1 \\
  --out runs/source-1
```
""",
)
replace(
    "docs/frontier-pilot-checklist.md",
    """  --draws 1 \\
  --reasoning high \\
""",
    """  --draws 1 \\
  --model-decisions 1 \\
  --reasoning high \\
""",
)
replace(
    "docs/frontier-pilot-checklist.md",
    """  --draws 8 \\
  --reasoning high \\
""",
    """  --draws 8 \\
  --model-decisions 1 \\
  --reasoning high \\
""",
)
replace(
    "docs/frontier-pilot-checklist.md",
    """Provider APIs do not expose a portable sampling seed. The pilot uses
""",
    """The default one-model-decision condition isolates the first non-forced Game 2
choice and then uses the declared deterministic continuation. Run a separately
identified short chain or `--model-decisions all` only after this inexpensive
shard works.

Provider APIs do not expose a portable sampling seed. The pilot uses
""",
)
