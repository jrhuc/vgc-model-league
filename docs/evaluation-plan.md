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
| `vgc-positions-v1` | one battle choice | controlled, inexpensive decision evaluation | exporter and package not built |
| `vgc-draft-circuit-v1` | draft through played matches | multi-agent planning with delayed outcomes | design only |
| local league | complete exploratory run | generate trajectories and inspect behaviour | working |

The position taskset is built first because its contract is narrow and its score
can be computed offline. The draft circuit is the eventual multi-agent flagship,
but it is not ready to be called an RL environment until drafting is connected
to team construction and battle outcomes.

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
rollout time. A TypeScript exporter will use the embedded simulator to score
**every** legal action before release. It will write:

- the model-visible prompt and action map;
- a score vector keyed by canonical action;
- repeated-seed uncertainty and an eligibility flag;
- the full Showdown SHA, format, scaffold version, reference configuration,
  sampling seeds, and content checksum.

The Python task then parses one choice and performs a deterministic lookup. For
a legal action `a`, the proposed primary reward is
`(mean_value(a) - min_value) / (max_value - min_value)` over the frozen common-draw
panel. Zero-span and unstable items are ineligible rather than assigned a score.
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
2. **Sampling stability:** action values and orderings are compared across
   independent seed panels; unstable or low-span items are removed.
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

The frozen comparison split is stratified by phase and state, capped per source
game, versioned, and unchanged after results are collected. Exploratory positions
and training data may continue to grow under new version names.

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

The verifiers environment will declare static roles such as `seat0` through
`seat7` and use the configured subset. The control flow belongs in
`Env.run(task, agents)`; cross-agent and delayed rewards belong in
`Env.finalize`.

One full-season trace per seat would broadcast one scalar over every token and
would not turn turn-level diagnostics into turn-level credit. The implementation
should instead use explicit state plus short agent runs at decision boundaries,
then attach the relevant terminal and stage signals to those traces. This matches
the existing league's carried notebook without pretending that standard
trace-level RL provides per-token credit assignment.

A multi-seat season is expensive and a failed episode may replay the whole unit.
Develop it in named, non-comparable profiles:

- a deterministic random-agent smoke run;
- one frozen matchday from recorded rosters;
- a small mini-season;
- only then the intended six-to-eight-seat circuit.

Hosted evaluation comes before training. Multi-agent training remains a
self-managed `prime-rl` experiment until the required role configuration and
advantage method have been demonstrated on the hosted product.

## Prime Intellect integration

### Use the framework at its actual boundary

verifiers should own the functions it already provides: task loading, model and
harness configuration, runtimes, trace capture, rollout retries, evaluation
outputs, multi-agent episode control, and integration with `prime-rl`.

The local `LLMEngine` overlaps with that combined stack, not just with the
interception server. It remains for local interactive leagues; the published
adapter bypasses it. verifiers resume restarts missing or errored rollouts. It
does not replace this repository's in-progress battle reconstruction.

For native verifiers v1, a package exports `Taskset`, and optionally `Env` or
`Harness`, classes through `__all__`. Do not add legacy `load_environment`
functions to the v1 package unless a separately tested compatibility wrapper
requires them.

### Runtime boundary

`vgc-positions-v1` is static and needs no runtime bridge.

The dynamic draft circuit keeps TypeScript and Pokémon Showdown authoritative.
Start with a versioned JSON-lines referee process launched beside the Python
environment. Add an HTTP transport only if a hosted runtime proves that the
local process cannot be packaged. HTTP is a deployment option, not the domain
API. MCP is reserved for model-facing mechanics tools; it is not the grading
control plane.

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

Pin the initial verifiers version. The position package should use the tool-less
`null` harness unless parity tests justify a task-scoped MCP toolset. A shell or
coding harness increases both scaffold differences and score-table leakage.

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
   every legal action on frozen draw panels, split model-visible and grader data,
   and write the manifest.
3. **Create `vgc-positions-v1`.** Keep it a small native v1 Taskset with strict
   parsing, deterministic lookup rewards, leakage tests, and a `null` harness
   config.
4. **Validate locally and on the Hub.** Run the gates above; do not spend on a
   large model sweep yet.
5. **Run the controlled pilot.** Use several open or inexpensive models over the
   same evaluation split. Publish samples, uncertainty, costs, and the complete
   config, not a leaderboard alone.
6. **Extract the dynamic referee.** Define the JSON protocol from the existing
   draft, teambuild, preview, and battle state machines.
7. **Build a draft-to-battle vertical slice.** Demonstrate delayed outcomes and
   cross-stage metrics before scaling agents or attempting training.
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
