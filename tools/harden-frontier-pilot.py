from pathlib import Path


def replace(path: str, old: str, new: str, count: int = 1) -> None:
    file = Path(path)
    text = file.read_text()
    if text.count(old) != count:
        raise RuntimeError(f"{path}: expected {count} matches, found {text.count(old)}")
    file.write_text(text.replace(old, new, count))


replace(
    "src/eval/frontier-pilot.ts",
    """  type FrozenMatchdayContinuationControllers,
  type FrozenMatchdayForkOutcome,
""",
    """  type FrozenMatchdayContinuationControllers,
  type FrozenMatchdayForkOutcome,
  type FrozenMatchdayNotebookContext,
""",
)
replace(
    "src/eval/frontier-pilot.ts",
    """  sampling: 'temperature-zero-no-provider-seed-balanced-arm-order-v1',
  report: 'content-addressed-private-run-report-v1',
""",
    """  sampling: 'temperature-zero-no-provider-seed-balanced-arm-order-v1',
  history: 'bounded-full-authorized-continuation-pov-v1',
  taskIdentity: 'opportunity-and-authorized-state-digest-v1',
  report: 'content-addressed-private-run-report-v1',
""",
)
replace(
    "src/eval/frontier-pilot.ts",
    """  'Use only the authorized state, private notebook, open team sheets, and legal actions in the prompt.',
  'Optimize the probability of winning the complete series, not merely the current turn.',
""",
    """  'Use only the authorized state, private notebook, open team sheets, and legal actions in the prompt.',
  'No interactive mechanics tools are available in this pilot.',
  'Optimize the probability of winning the complete series, not merely the current turn.',
""",
)
replace(
    "src/eval/frontier-pilot.ts",
    """function actionState(context: FrozenMatchdayActionContext, publicContextValue: FrontierPilotPublicContext): string {
  const battle = context.observation.battle;
  const state = {
    objective: 'maximize complete-series win probability',
    format: publicContextValue.format,
    seat: context.pid,
    gameNumber: context.observation.gameNumber,
    score: context.observation.score,
    privateNotebook: context.currentNotebook,
    openTeamSheets: publicContextValue.seats,
    recentBattleSummary: summarizeBattleEvents(context.observation.povLines, context.pid),
    recentRawPovLines: context.observation.povLines.slice(-400),
    currentRequest: battle?.request ?? null,
    stateHash: context.observation.stateHash,
  };
  return JSON.stringify(state, null, 2);
}
""",
    """function actionState(
  context: FrozenMatchdayActionContext,
  publicContextValue: FrontierPilotPublicContext,
  povHistory: readonly string[],
): string {
  const battle = context.observation.battle;
  const state = {
    objective: 'maximize complete-series win probability',
    format: publicContextValue.format,
    seat: context.pid,
    gameNumber: context.observation.gameNumber,
    score: context.observation.score,
    privateNotebook: context.currentNotebook,
    openTeamSheets: publicContextValue.seats,
    continuationBattleSummary: summarizeBattleEvents([...povHistory], context.pid),
    continuationRawPovLines: povHistory.slice(-800),
    currentRequest: battle?.request ?? null,
    stateHash: context.observation.stateHash,
  };
  return JSON.stringify(state, null, 2);
}
""",
)
replace(
    "src/eval/frontier-pilot.ts",
    """  private readonly actionIdentitySalt: string;
  private readonly callTraces: FrontierPilotCallTrace[] = [];
""",
    """  private readonly actionIdentitySalt: string;
  private readonly callTraces: FrontierPilotCallTrace[] = [];
  private readonly povHistory: string[] = [];
""",
)
replace(
    "src/eval/frontier-pilot.ts",
    """  traces(): FrontierPilotCallTrace[] {
    return structuredClone(this.callTraces);
  }

  async decideAction(context: FrozenMatchdayActionContext) {
    if (context.legalActions.length === 1) {
""",
    """  traces(): FrontierPilotCallTrace[] {
    return structuredClone(this.callTraces);
  }

  private remember(lines: readonly string[]): void {
    this.povHistory.push(...lines);
    if (this.povHistory.length > 2_000) this.povHistory.splice(0, this.povHistory.length - 2_000);
  }

  async decideAction(context: FrozenMatchdayActionContext) {
    this.remember(context.observation.povLines);
    if (context.legalActions.length === 1) {
""",
)
replace(
    "src/eval/frontier-pilot.ts",
    """    const taskId = canonicalJsonDigest([
      'frontier-pilot-task-v1',
      context.draw.id,
      context.pid,
      context.decisionIndex,
      context.observation.gameNumber,
    ]);
    const task = buildStrategicChoiceTask({
      id: taskId,
      format: this.options.publicContext.format,
      phase: context.observation.battle?.request?.teamPreview ? 'team-preview' : 'battle-action',
      state: actionState(context, this.options.publicContext),
      actions: context.legalActions.map((action) => ({ canonicalAction: action.command, label: action.label })),
      presentationSeed: taskId,
""",
    """    const opportunityId = canonicalJsonDigest([
      'frontier-pilot-opportunity-v1',
      context.draw.id,
      context.pid,
      context.decisionIndex,
      context.observation.gameNumber,
    ]);
    const state = actionState(context, this.options.publicContext, this.povHistory);
    const taskId = canonicalJsonDigest([
      FRONTIER_STRATEGIC_PILOT_PROTOCOL.taskIdentity,
      opportunityId,
      canonicalJsonDigest(state),
    ]);
    const task = buildStrategicChoiceTask({
      id: taskId,
      format: this.options.publicContext.format,
      phase: context.observation.battle?.request?.teamPreview ? 'team-preview' : 'battle-action',
      state,
      actions: context.legalActions.map((action) => ({ canonicalAction: action.command, label: action.label })),
      presentationSeed: opportunityId,
""",
)
replace(
    "src/eval/frontier-pilot.ts",
    """  decideNotebook() {
    return {};
  }
""",
    """  decideNotebook(context: FrozenMatchdayNotebookContext) {
    this.remember(context.observation.povLines);
    return {};
  }
""",
)
replace(
    "src/eval/frontier-pilot.ts",
    """  const battleConfig = {
    policy: FRONTIER_STRATEGIC_PILOT_PROTOCOL.policy,
    seats: {
""",
    """  const battleConfig = {
    protocol: FRONTIER_STRATEGIC_PILOT_PROTOCOL,
    policy: FRONTIER_STRATEGIC_PILOT_PROTOCOL.policy,
    seats: {
""",
)

replace(
    "tests/eval-frontier-pilot.test.ts",
    """  const decision = await controller.decideAction(actionContext());
  assert.equal(decision.command, 'move 2 1');
  const traces = controller.traces();
  assert.equal(traces.length, 1);
  assert.equal(traces[0]!.status, 'valid');
  assert.equal(traces[0]!.canonicalAction, decision.command);
  assert.match(traces[0]!.callDigest, /^[0-9a-f]{64}$/u);
""",
    """  const first = actionContext();
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
  assert.match(traces[1]!.prompt, /\\|turn\\|3/u);
  assert.match(traces[1]!.prompt, /\\|move\\|p1a: Alpha\\|Protect/u);
""",
)

addition = """

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
"""
test_file = Path("tests/eval-frontier-pilot.test.ts")
test_text = test_file.read_text()
marker = "\ntest('frontier notebook generation binds exact model-written bytes', async () => {"
if test_text.count(marker) != 1:
    raise RuntimeError("frontier pilot test insertion marker changed")
test_file.write_text(test_text.replace(marker, addition + marker, 1))
