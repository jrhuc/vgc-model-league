from pathlib import Path


def replace(path: str, old: str, new: str, count: int = 1) -> None:
    file = Path(path)
    text = file.read_text()
    if text.count(old) != count:
        raise RuntimeError(f"{path}: expected {count} exact matches, found {text.count(old)}")
    file.write_text(text.replace(old, new, count))


replace(
    "src/eval/frozen-matchday-adapter.ts",
    """  continuation: 'strict-no-fallback-controller-loop-v1',
""",
    """  continuation: 'strict-no-fallback-controller-loop-v1',
  nonFocalNotebook: 'retain-checkpoint-bytes-v1',
  executionIdentity: 'checkpoint-plan-arm-draw-treatment-controller-focal-v1',
""",
)
replace(
    "src/eval/frozen-matchday-adapter.ts",
    """export interface FrozenMatchdayForkOutcome extends AdaptationForkOutcome {
  diagnostic: string | null;
""",
    """export interface FrozenMatchdayForkOutcome extends AdaptationForkOutcome {
  executionDigest: string;
  diagnostic: string | null;
""",
)
replace(
    "src/eval/frozen-matchday-adapter.ts",
    """export function notebookTreatmentActionDigest(treatment: NotebookTreatment): string {
  return canonicalJsonDigest(['notebook-replacement-v1', treatment.notebook]);
}

function terminalUtility(
""",
    """export function notebookTreatmentActionDigest(treatment: NotebookTreatment): string {
  return canonicalJsonDigest(['notebook-replacement-v1', treatment.notebook]);
}

function forkExecutionDigest(input: {
  checkpoint: FrozenMatchdayBetweenGameCheckpoint;
  plan: MatchedForkPlan;
  armId: string;
  draw: CommonForkDraw;
  focalPid: Pid;
  treatment: NotebookTreatment;
  controllers: FrozenMatchdayContinuationControllers;
}): string {
  return canonicalJsonDigest({
    protocolVersion: FROZEN_MATCHDAY_ADAPTER_PROTOCOL.version,
    checkpointDigest: input.checkpoint.checkpointDigest,
    planDigest: input.plan.planDigest,
    armId: input.armId,
    draw: input.draw,
    focalPid: input.focalPid,
    treatmentDigest: input.treatment.treatmentDigest,
    controllerSetDigest: input.controllers.controllerSetDigest,
    nonFocalNotebook: FROZEN_MATCHDAY_ADAPTER_PROTOCOL.nonFocalNotebook,
  });
}

function terminalUtility(
""",
)
replace(
    "src/eval/frozen-matchday-adapter.ts",
    """  modeForecast?: OpponentModeProbability[];
}): FrozenMatchdayForkOutcome {
""",
    """  modeForecast?: OpponentModeProbability[];
  executionDigest: string;
}): FrozenMatchdayForkOutcome {
""",
)
replace(
    "src/eval/frozen-matchday-adapter.ts",
    """    treatmentKind: input.treatment.kind,
    actionId: input.actionId,
""",
    """    treatmentKind: input.treatment.kind,
    actionId: input.actionId,
    executionDigest: input.executionDigest,
""",
)
replace(
    "src/eval/frozen-matchday-adapter.ts",
    """  treatment: NotebookTreatment;
  otherSeatInput?: FrozenBetweenGameInput;
  controllers: FrozenMatchdayContinuationControllers;
""",
    """  treatment: NotebookTreatment;
  controllers: FrozenMatchdayContinuationControllers;
""",
)
replace(
    "src/eval/frozen-matchday-adapter.ts",
    """  const { draw } = planBindings(input);
  const referee = restoreFrozenMatchdayBetweenGameCheckpoint(input.checkpoint, draw);
""",
    """  const { draw } = planBindings(input);
  const executionDigest = forkExecutionDigest({
    checkpoint: input.checkpoint,
    plan: input.plan,
    armId: input.armId,
    draw,
    focalPid: input.focalPid,
    treatment: input.treatment,
    controllers: input.controllers,
  });
  const referee = restoreFrozenMatchdayBetweenGameCheckpoint(input.checkpoint, draw);
""",
)
replace(
    "src/eval/frozen-matchday-adapter.ts",
    """    const notebookInput =
      pid === input.focalPid ? { notebookReplacement: input.treatment.notebook } : (input.otherSeatInput ?? {});
""",
    """    const notebookInput = pid === input.focalPid ? { notebookReplacement: input.treatment.notebook } : {};
""",
)
matchday = Path("src/eval/frozen-matchday-adapter.ts")
matchday_text = matchday.read_text()
needle = """        checkpoint: input.checkpoint,
        referee,
"""
found = matchday_text.count(needle)
if found < 8:
    raise RuntimeError(f"frozen matchday adapter: expected at least 8 failure outcomes, found {found}")
matchday_text = matchday_text.replace(
    needle,
    """        checkpoint: input.checkpoint,
        referee,
        executionDigest,
""",
)
success = """    treatmentKind: input.treatment.kind,
    actionId: firstFocalActionId,
"""
if matchday_text.count(success) != 1:
    raise RuntimeError("frozen matchday adapter: terminal success shape changed")
matchday_text = matchday_text.replace(
    success,
    """    treatmentKind: input.treatment.kind,
    actionId: firstFocalActionId,
    executionDigest,
""",
    1,
)
matchday.write_text(matchday_text)

replace(
    "tests/eval-frozen-matchday-adapter.test.ts",
    """  assert.equal(control.forkConfigDigest, treatment.forkConfigDigest);
  assert.ok(control.terminalDigest);
""",
    """  assert.equal(control.forkConfigDigest, treatment.forkConfigDigest);
  assert.match(control.executionDigest, /^[0-9a-f]{64}$/u);
  assert.match(treatment.executionDigest, /^[0-9a-f]{64}$/u);
  assert.notEqual(control.executionDigest, treatment.executionDigest);
  assert.ok(control.terminalDigest);
""",
)

evaluation_plan = Path("docs/evaluation-plan.md")
plan_text = evaluation_plan.read_text()
old_status = """| Track | Unit | Status |
| --- | --- | --- |
| `vgc-positions-v1` | one battle choice | TypeScript replay/fork/export prototype exists; Python package and model runner do not |
| `vgc-circuit-v1` | one eight-seat league or tournament episode | Implemented internally as a TypeScript referee and native-v1 Python `Taskset` plus `Env`; package, referee image, and Environment Hub entry are unpublished; hosted execution is not validated |
| local league | exploratory full runs | Working |

The public program separates the lower-cost controlled choice task from the
long-horizon circuit track. Positions remain the first release track. The
league and tournament are distinct circuit evaluations; a draft-only task with
an artificial roster reward is neither one.

The current branch can:

- replay a game from its format, Showdown revision, seed, teams, and actions;
- reject mismatched logs;
- reopen snapshots;
- enumerate legal joint actions;
- grade each eligible decision with one complete exhaustive action table; and
- select seeded, stratified positions from versioned grade-time qualification
  metrics.

The internal circuit track also implements both whole-circuit scenarios, their
terminal returns, and the native-v1 adapter described below.

The repository does not provide a public verifiers package, a supported
real-provider frozen evaluation, a calibrated public reward, or a validated
benchmark. Treat all `grade-positions` output as exploratory.

## `vgc-positions-v1`
"""
new_status = """| Track | Unit | Status |
| --- | --- | --- |
| `vgc-strategic-interventions-v1` | one attributable decision or short intervention chain | Framework-agnostic kernel, information-set/reference/task contracts, and strict matchday and circuit replay/fork adapters are implemented; a native model/runtime shard package and calibrated corpora are not |
| `vgc-positions-v1` | one battle choice | Retained as a legacy realized-state random-continuation material diagnostic; the TypeScript replay/fork/export prototype exists, but it is not the primary ranking or release track |
| `vgc-circuit-v1` | one eight-seat league or tournament episode | Implemented as an ecological arena and case source; the native-v1 adapter defaults to metrics-only terminal reporting, while package publication and hosted execution remain unvalidated |
| local league | exploratory full runs | Working ecological arena |

The public program now treats controlled strategic interventions as the primary
evaluation track. The static positions package remains a named legacy
diagnostic, and complete circuits remain ecological validation and case
sources. Neither supporting artifact substitutes for matched causal shards.

The current branch can:

- replay exact games, matchdays, and circuit receipt histories under the pinned
  Showdown and referee authorities;
- create verified pre-decision checkpoints and invalidate endogenous source
  suffixes after a replacement;
- bind downstream controller identities and common hidden-state, opponent,
  battle, continuation, and schedule draws;
- evaluate complete action-by-reference rectangles in absolute utility with
  clustered uncertainty and reference-sensitivity diagnostics;
- render opaque, independently shuffled strategic actions and report invalid
  output separately from legal-action utility;
- fork exact between-game notebook bytes under strict no-fallback continuation;
- fork draft, construction, trade, notebook, and battle responses through the
  authoritative circuit referee; and
- project the existing position matrices into the new reference-suite contract
  only as a named raw-material legacy arm.

The repository does not provide a public strategic-shard package, a supported
real-provider intervention run, calibrated intervention corpora, or a validated
benchmark. Treat every current strategic, position, and circuit result as
exploratory.

## `vgc-strategic-interventions-v1`

The intended unit is one decision node or short intervention chain whose source
state, replacement, downstream controllers, common draws, and utility unit are
all content-addressed. The current implementation supplies the framework-neutral
TypeScript contracts and strict Showdown/referee adapters. It does not yet
supply a public native environment, model/runtime controller, hidden-state prior
corpus, external policy population, or calibrated release set.

A treatment must change only its declared information or action. The complete
execution identity binds the checkpoint, matched fork plan, arm, draw, focal
seat, treatment bytes, and controller set. In the v1 notebook adapter, the
non-focal seat always retains its checkpoint notebook; changing that seat
requires a future explicitly crossed treatment rather than an unbound runtime
argument.

Do not publish a ranking until the strategic release gates in
[Strategic evaluation kernel](strategic-evals.md#release-gates) pass, including
known-intervention validity and demonstrated held-out value beyond the
unmodified Pokémon harness.

## Legacy diagnostic: `vgc-positions-v1`
"""
if plan_text.count(old_status) != 1:
    raise RuntimeError("evaluation plan program-status block changed")
evaluation_plan.write_text(plan_text.replace(old_status, new_status, 1))
