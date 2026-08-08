# Evaluation plan

This document records what exists, what must be validated, and what is built
next. [Measurement principles](measurement.md) defines how results may be
reported.

## One research program, two artifacts

The research question is how a model's local choices score under declared
references and whether its commitments remain visible from a shared draft into
actual play. No single environment evaluates both
cleanly, so the public work is split deliberately.

| Artifact | Unit | Purpose | Status |
| --- | --- | --- | --- |
| `vgc-positions-v1` | one battle choice | controlled, inexpensive decision evaluation | prototype exporter exists; package and model runner not built |
| `vgc-whole-reg-build-v0` | one complete team build | internal construction-to-battle ablation | vertical-slice proposal only |
| `vgc-draft-circuit-v1` | draft through played matches | multi-agent planning with delayed outcomes | design only |
| local league | complete exploratory run | generate trajectories and inspect behaviour | working |

The position taskset is built first because its contract is narrow and its score
can be computed offline. The draft circuit is the eventual multi-agent flagship:
the contribution boundary is the linked draft, construction, bring, lead, and
battle episode, not another general battle environment. poke-env and VGC-Bench
supply complementary baselines and artifacts; neither implements that combined
circuit. It is not ready to be called an RL environment until those stages are
connected to battle outcomes. The internal whole-build arm may exercise that
shared path, but it does not move the positions-first order or replace the draft
circuit as the flagship.

## What is already implemented

The branch contains a useful internal prototype:

- exact replay from the recorded format, Showdown revision, seed, teams, and
  actions;
- refusal to grade games that do not reproduce their stored log;
- reopening a simulator snapshot and enumerating legal joint actions;
- bounded counterfactual rollouts under an explicit reference;
- stratified, seeded selection of positions with a per-game cap;
- component-level scaffold hashes and upstream-provider recording.

It does **not** yet contain a runner that asks a new model to answer the frozen
positions, a verifiers package, a calibrated reward, or a validated public
benchmark. Existing `grade-positions` output is exploratory data.

## Artifact 1: `vgc-positions-v1`

### Task contract

Each task shows one anonymized seat:

- a canonical position prompt built from its public history and own request;
- the format and phase;
- a numbered list of legal actions;
- the response schema for selecting exactly one action.

It excludes the source model and action, the source model's rationale and
notebook, the opponent's private request, and the simulator snapshot. The
snapshot remains grader data. A new model is not pretending to inherit the
original model's private memory; every model receives the same neutral position
scaffold.

### Static scoring, not a live service

The first package should not need Node, an HTTP service, a tunnel, or a secret at
rollout time. The provisional TypeScript exporter scores **every** legal action
on two independent qualification panels and one untouched measurement panel.
Before release it must write:

- the model-visible prompt and action map;
- a score vector keyed by canonical action;
- qualification uncertainty and an eligibility record;
- the full Showdown SHA, format, scaffold version, reference configuration,
  sampling seeds, executed evaluator digest, and content checksum.

All action values within a panel share opponent draws, battle seeds, and
continuation seeds. The matrix is rectangular: a failed cell rejects the panel
rather than giving actions different sample counts. Schema-v2 pilot artifacts
keep public tasks, private score rows, and sealed matrices in physically separate
roots and mark the manifest non-release-ready. Eligibility metrics come only
from the qualification panels; the measurement panel supplies final rewards.
`summarize-position-pilot` reports diagnostic distributions without choosing
thresholds. `freeze-positions` performs preliminary replayable-corpus selection;
only `freeze-position-splits` publishes immutable candidate train/evaluation
artifacts.

Split freeze requires two canonical manifests: the candidate pilot manifest that
binds the supplied task, score, and sealed bytes, and a separate calibration
manifest whose exact digest is bound by a reviewed schema-v2 policy. The policy
sets qualification gates, duplicate threshold, split seed and fraction, and
reviewed overall and per-stratum balance tolerances. A distinct calibration
manifest establishes distinct bytes; corpus-disjointness still needs its own
source and similarity checks.

The freezer unions source-series groups with normalized visible-position
near-duplicate clusters, then applies deterministic greedy stratification while
keeping every connected component intact. It is not a globally optimal balance.
Missing train or evaluation output, a tolerance failure, or any
qualification-eligible row with `measurement_ready` false fails the complete
candidate freeze. Candidate outputs remain `release_ready: false`.

Public and private outputs use physically separate roots with immutable target
files. A complete identical artifact-set rerun is a no-op; different bytes
require new target roots. Schema-v2 boundary validation rejects malformed or
noncanonical policy, manifest, task, score, and sealed bytes before publication. Freezing does not
waive hidden-information, criterion, horizon, or package-smoke gates.

The Python task then parses one choice and performs a deterministic lookup. For
a legal action `a`, the proposed primary reward is
`(mean_value(a) - min_value) / (max_value - min_value)` over the frozen common-draw
panel. Zero-span items cannot be normalized. Statistically unstable items become
ineligible only under the frozen policy rather than an exporter-invented cutoff.
Invalid output receives `-1`, is never replaced by a simulator action, and is
reported separately from the worst legal action, whose normalized reward is
zero. Parsing, legality, raw value, panel uncertainty, span, and phase remain
separate metrics.

A static table is reproducible and fits hosted execution, but it is inspectable.
Use separate train and evaluation splits, keep comparison items out of training,
and do not claim resistance to contamination merely because the score came from
a simulator. The first source distribution is explicitly
“VGCML-generated positions,” not representative human or tournament VGC. Publish
coverage, near-duplicate removal, and an external or human holdout before making
a broader skill claim.

### Reference and reward limits

The prototype reference uses short-horizon material differential, sampled
uniform legal opponent actions, and uniform-random continuations. This is a
computable policy, not VGC ground truth. It can miss positioning, information,
setup, and long-term team value.

It currently evaluates the realized hidden state. At team preview and early in a
game, that includes brought Pokémon and stat points the acting model did not
know. The first exporter must label this score as realized-state value. Before a
skill claim, add a declared information-set treatment: average compatible hidden
states from a published prior, or retain only positions whose action ordering is
robust across them. Uniform opponent actions do not solve hidden-state hindsight.

All legal actions should be evaluated on common random draws to reduce variance.
Do not select a noisy “best” action and then silently clamp an independent
reversal to zero. The exported reward is the value of the submitted action under
the frozen reference sample. “Reference-relative opportunity loss” may be
derived from the score vector, with uncertainty.

### Validation gates

Do not publish a model ranking or training recipe until all of these pass:

1. **Replay:** every item reproduces its source game exactly.
2. **Sampling stability:** action values and orderings are compared across the
   independent qualification panels under a policy calibrated outside the
   candidate corpus; unstable or low-span items are excluded without consulting
   measurement values.
3. **Horizon sensitivity:** the report shows how scores move at longer horizons
   and, on a tractable subset, to the end of the game.
4. **Hidden information:** realized-state and information-set scores are
   distinguished, with sensitivity to the declared hidden-state prior.
5. **Criterion checks:** random play, existing compatible baselines, source
   choices, and a small blinded expert sample are scored. Disagreement is
   reported rather than tuned away.
6. **Prompt parity and leakage:** tests prove that the model-visible task has no
   opponent-private request, source identity, source action, or grader state.
7. **Packaging:** the wheel installs, loads, and scores in a clean container; a
   local native-v1 eval passes before any Hub push.
8. **Hosted smoke test:** Hosted Evaluations and Hosted Training are tested
   separately instead of inferred from local compatibility.

The frozen comparison split is capped per source game and stratified by phase
and state with deterministic greedy component allocation. Reviewed balance
tolerances are gates, not claims of optimal partitioning. The public and private
roots are immutable once the complete candidate manifest is committed.
Exploratory positions and training data may continue under new version names.

## Internal arm: `vgc-whole-reg-build-v0`

This proposed standalone arm is an ablation of the same construction and referee
circuit, not a third public flagship. It removes drafting and asks for one
complete Regulation MB team of six. Its foundation reuses the shared
`TeamBuildTask` and `StageEvidence` contracts, Showdown validator, preview and
battle adapters, and evidence schema. It adds no arm-specific repair path or
separate reflection turn.

Showdown decides legality. A comparative submission must contain exactly six
complete legal sets. An invalid or incomplete answer remains an invalid build;
it is never repaired, replaced, or defaulted into the comparison.

Each candidate build and each team in the frozen human-reference suite `H` runs
against the frozen opponent suite `O` on one common rectangular schedule:
opponent, side, seed, two declared preview controllers, and two declared battle
controllers. Every cross-product cell must complete. The reference statistic is
the candidate's schedule mean minus the mean schedule value across `H`, under
identical cells. Uncertainty uses build episode as the outer sampling unit;
games inside one build schedule are not independent model samples.

An LLM or expert meta-judge may label legality-adjacent style, metagame fit, or
failure modes as a diagnostic. It never supplies reward or changes inclusion.
Public teams may have been memorized, so public-pack performance is not evidence
of de novo construction. An official stream without exact spreads is not an
exact team pack.

**GO:** build only the internal vertical slice needed to verify the shared task,
evidence, Showdown, controller, and artifact path.

**NO-GO:** do not publish a Regulation MB model comparison or ranking until
current human packs have exact provenance and usable licences, `O` and `H` are
frozen and disjoint, and the full two-preview-by-two-battle-controller coverage
exists. These gates do not change the positions-first priority or the draft
circuit's flagship status.

## Artifact 2: `vgc-draft-circuit-v1`

### Why the circuit, not draft-only

A legal draft pick has no cheap quality oracle. Other agents make the remaining
board dynamic, but they do not create a reward. Scarcity prediction and rule
compliance are useful metrics; neither says whether the roster was good.

The multi-agent environment therefore covers the delayed decision problem:

1. agents draft from one board in snake order under a budget;
2. each agent converts its roster into matchup teams and legal sets;
3. agents choose the bring and lead at team preview;
4. the teams play recorded games;
5. terminal game or season return is attached to the complete episode, without
   treating it as a causal label for each earlier decision.

Trades and reviews are valuable evidence, but they are optional protocol stages,
not prerequisites for the first vertical slice. A draft-only mode may exist for
smoke testing and trace collection; it must not advertise a roster-quality
reward.

The [Social Arena methodology](https://olamlabs.ai/research/social-arena) is a
useful cross-domain implementation reference. The circuit should likewise use
anonymous opponents, harness-level logical seat continuity, the same authorized
state/action surface for human and agent clients, and explicit sandbox and
harness descriptors. Logical continuity means reconstructed explicit state, not
an assumed persistent provider chat or process. Submitted model evidence and
referee-accepted transitions must remain distinct append-only records. Its
large-sample outcome ratings do not transfer to a small pilot season, and its
LLM-judged behavioral indices are not a substitute for the controlled decision
result here.

The circuit also needs canonical append-only evidence with two boundaries:
submitted model messages and actions, and referee-accepted transitions with
actor, visibility, input and resulting state hashes, RNG, and protocol identity.
Rejections and substitutions are separate events. Operational resume files may
be rebuilt, but recorded evidence may not be pruned or rewritten. A fork is a
new episode with parent run/sequence, intervention, and changed scaffold
components rather than a mutation of the source trace.

### Signals

Battle win/loss is the terminal objective. Reference-relative battle values may
be recorded as diagnostics after the position grader is validated. Deterministic
cross-stage metrics include drafted-to-built, built-to-brought, declared-to-
submitted bring, execution of a named move or interaction, legality, and repair
rates.

Semantic “plan fidelity” labels require a rubric and audited judge. Public and
private text fields show statement consistency, not a model's hidden belief.
Predictability is not called exploitability without a profitable best-response
experiment.

### Episode and training shape

The verifiers environment declares static roles such as `seat0` through
`seat7` and uses the configured subset. Each role is an `AgentConfig`-typed
field on the `EnvConfig` subclass with a declared default instance. The
concrete env overrides `Env.run(task, agents)` for episode control, with
optional `setup(agents)` before and `finalize(task, episode)` after, and
drives each seat through `Agent.run(task, runtime=None, tools=None,
on_trace=None)`, which returns a `Trace`. `finalize` runs after the trace
runtimes close, so terminal referee payloads must be captured during
`run`/interaction and aggregated in `finalize`. Frozen and reference roles are
not automatically untrainable; `setup` must set `trainable=False` on them
explicitly.

One full-season trace per seat would broadcast one scalar over every token and
would not turn turn-level diagnostics into turn-level credit. The implementation
should instead use explicit state plus short agent runs at decision boundaries,
then attach the relevant terminal and stage signals to those traces. This matches
the existing league's carried notebook without pretending that standard
trace-level RL provides per-token credit assignment.

A multi-seat season is expensive and a failed episode may replay the whole unit.
Development smoke stages (random agents, one frozen matchday, a mini-season,
then the intended six-to-eight-seat circuit) are not comparison profiles. The
comparative profiles are named and explicitly non-comparable:

- **`controlled-explicit-state` (primary):** the published `verifiers Env`
  supplies each seat with reconstructed exact state for that seat and episode,
  plus that model's notebook. The prompts, memory policy, any harness-provided
  initial memory content, and model-facing skills are frozen and SHA-256
  digested before rollout; the model notebook remains per-episode model output.
  Each seat runs in an isolated root with no sibling messaging, shared kernel, or
  shared filesystem; there is no cross-run memory, refinement state, or A2A.
  Raw traces are append-only, while summaries and evidence projections are
  observational and cannot affect legality or reward.
- **`controlled-episodic`:** retains the same controlled seat isolation and
  explicit-state boundary, but permits episode context to be compacted only by
  one declared, fixed, deterministic compaction procedure. Its procedure and
  inputs/outputs are frozen and digested, and compaction events are recorded;
  no provider or operator may introduce an adaptive or hidden summary. This is
  a separate, non-comparable profile even when the model and game schedule are
  identical.
- **`prime-agent-capable`:** a system-level ablation that permits Prime Agent
  RLM refinement, per-seat subagents, and heartbeats under a declared,
  digested configuration. It remains seat-isolated and cannot silently add
  sibling communication or shared state. This profile is not comparable with
  either controlled profile and is reported only as an ablation. A verifiers
  `Agent` is the model endpoint configured for the `Env`; it is not a Prime
  Agent and not a Prime Agent RLM subagent.

The baseline for the first profile is exact explicit state per seat/per episode
plus the model notebook: no cross-run memory, refinement, or A2A. A profile
change is a scaffold and execution-harness change, not a tuning detail. Do not
rank profiles against one another. The Prime Agent capabilities above are
allowed for offline development and operator orchestration, but never enter a
comparative rollout implicitly. Hosted evaluation comes before training.
Multi-agent training remains a self-managed `prime-rl` experiment until the
required role configuration and advantage method have been demonstrated on the
hosted product.

## Prime Intellect integration

### Use the framework at its actual boundary

verifiers should own the functions it already provides: task loading, model and
harness configuration, runtimes, trace capture, rollout retries, evaluation
outputs, multi-agent episode control, and integration with `prime-rl`.

In the published verifiers adapter only, that ownership replaces the local
`LLMEngine`, provider routing, provider retries, and top-level comparative
run/episode orchestration. The local `LLMEngine` remains a local interactive
adapter for the league and is not the published verifiers path. verifiers
resume restarts missing or errored rollouts; it does not replace this
repository's battle reconstruction or referee.

The TypeScript Showdown/domain/referee boundary remains authoritative in every
profile. The adapter can transport requests and responses, but it cannot
rewrite legal actions, accepted transitions, or rewards. A verifiers `Agent` is
the model endpoint configured for an `Env`; it is distinct from a Prime Agent
and from a Prime Agent RLM subagent. Prime Agent refinement, subagents, and
heartbeats are allowed for offline development and operator orchestration, not
silently in comparative rollout. If enabled by the `prime-agent-capable`
system-level ablation, they must be declared and digested as part of that
profile.

Freeze and digest the harness prompts, per-seat/per-episode memory policy and
any harness-provided initial memory content, and model-facing skills before
comparative rollout. Baseline memory is exact explicit state plus the model
notebook, with no cross-run memory, refinement, or A2A; the notebook is
per-episode model output. Competing seats must use isolated roots with no sibling
messaging, shared kernel, or shared filesystem. Raw traces are append-only;
summaries and evidence are observational projections and never affect
legality or reward.

For native verifiers v1, import the API as `import verifiers.v1 as vf`; the
top-level `verifiers` import is the legacy surface. A package's `__all__` may
export exactly one `Taskset` subclass and exactly one `Env` subclass together;
the loader resolves each kind by filtering `__all__` independently. Do not add
legacy `load_environment` functions to the v1 package unless a separately
tested compatibility wrapper requires them.

### Runtime boundary

`vgc-positions-v1` is static and needs no runtime bridge.

The dynamic draft circuit keeps TypeScript and Pokémon Showdown authoritative.
The versioned JSON-lines referee runs inside a runtime yielded by
`provision(task)`, using `Runtime.open_process`. That process API is supported
by the Subprocess, Docker, Prime, and Modal runtimes and exposes byte writes,
async stdout/stderr, wait, terminate, and kill, rather than an ad-hoc local
subprocess. The runtime image must include Node and the compiled pinned
bundle; the repo-root TypeScript dist is not automatically part of the wheel.
Add an HTTP transport only if a hosted runtime proves that the packaged
process cannot run. HTTP is a deployment option, not the domain API. MCP is
reserved for model-facing mechanics tools; it is not the grading control
plane.

Every dynamic client must handshake on protocol version, Showdown SHA, format,
board checksum, and scaffold version, and fail closed on mismatch.

### Proposed layout

```text
tools/
  export-verifiers-positions.ts
  referee.ts                         # later, JSON-lines dynamic protocol

environments/
  vgc_positions_v1/
    pyproject.toml
    vgc_positions_v1/
      __init__.py
      taskset.py
      parsing.py
      data/{train,eval,manifest}.jsonl
    tests/
  vgc_draft_circuit_v1/              # only after the vertical slice works
    pyproject.toml
    vgc_draft_circuit_v1/
      __init__.py
      taskset.py
      env.py
      referee.py
    tests/

configs/
  eval/vgc-positions-v1.toml
  train/vgc-positions-v1.toml
```

Pin the first package to `verifiers==0.3.0`. Scaffold it with
`uvx --from verifiers==0.3.0 init vgc-positions-v1 --path environments`; the
released `prime` CLI does not initialize native-v1 packages. Local configuration
must set `[env.agent.harness] id = "null"` explicitly because a plain taskset may
otherwise receive the bash harness. With no task toolsets, `null` is one tool-less
chat completion. A shell, coding, or MCP-enabled harness increases both scaffold
differences and score-table leakage.

### Product compatibility is a test matrix

At the current verifiers v1 release, local v1 tasksets and multi-agent `Env`
control flow exist. The current Hosted Evaluation documentation still describes
the legacy environment entry point, while Hosted Training documents a narrower
v1 taskset/harness shape. Therefore test and report these independently:

| Path | Required evidence before support is claimed |
| --- | --- |
| local v1 evaluation | clean install and small `uv run eval` |
| Environment Hub | clean Hub Action for the published wheel |
| Hosted Evaluation | an actual hosted smoke run on the package version |
| Hosted Training, positions | reward diversity and a small supported-model run |
| multi-agent training | self-managed prime-rl run with the declared role baseline |

Publishing to the Hub creates distribution, not free evaluation credits or an
automatic funding commitment.

## Work order

1. **Correct the internal prototype.** Remove unused corpus-ranking code, stop
   overclaiming mechanics classifications, fix deterministic sampling and resume
   markers, and label current scores experimental.
2. **Build the exhaustive exporter.** Render the neutral position prompt, score
   every legal action on independent qualification and measurement panels, write
   schema-v2 candidate artifacts, and calibrate policy on a separate manifest
   before freezing the candidate.
3. **Create `vgc-positions-v1`.** Keep it a small native v1 Taskset with strict
   parsing, deterministic lookup rewards, leakage tests, and a `null` harness
   config.
4. **Validate locally and on the Hub.** Run the gates above; do not spend on a
   large model sweep yet.
5. **Run the controlled pilot.** Use several open or inexpensive models over the
   same evaluation split. Publish samples, uncertainty, costs, and the complete
   config, not a leaderboard alone.
6. **Extract the shared dynamic referee.** Define `TeamBuildTask`, reuse
   `StageEvidence`, and version the JSON protocol across construction, preview,
   and battle.
7. **Exercise construction, then build the flagship slice.** Use
   `vgc-whole-reg-build-v0` only to validate that shared vertical path, then
   demonstrate draft-to-battle delayed outcomes and cross-stage metrics before
   scaling agents or attempting training.
8. **Add reports last.** The GUI should consume versioned evaluation outputs; it
   should not invent scores from the exploratory league corpus.

## Explicit non-goals

Do not add these without a concrete consumer and validation plan:

- another generic Showdown client or two-agent battle environment;
- a port of poke-env baseline code that can instead be run as an external
  baseline;
- natural-corpus Elo or model rankings;
- predictability labelled as exploitability;
- deception or “true belief” labels from provider reasoning text;
- reconstructed human positions with invented hidden stat spreads;
- Harbor, NeMo, or another adapter added only for hypothetical portability;
- a required RLM or coding-agent seat harness;
- an always-on grading service for a static taskset.
