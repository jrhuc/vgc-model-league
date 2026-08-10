# Evaluation plan

This page is the source of truth for artifact status, release gates, and work
order. [Measurement](measurement.md) defines what their results may mean.

## Program status

| Track | Unit | Status |
| --- | --- | --- |
| `vgc-positions-v1` | one battle choice | TypeScript replay/fork/export prototype exists; Python package and model runner do not |
| `vgc-frozen-matchday-v0` | one strict-construction-to-Bo3 matchday | internal and unpublished; local source, compiled-Episode, wheel, and import smokes passed; no real-model, isolated, or hosted support |
| `vgc-draft-circuit-v1` | one shared multi-seat circuit episode | referee and internal matchday adapter exist; full connected circuit `Env`, draft, schedule, playoffs, and circuit return are absent |
| local league | exploratory full runs | working |

The public program deliberately separates an inexpensive controlled choice from
the delayed draft-to-battle problem. Positions come first. The connected Draft
Circuit is the long-horizon target, not a draft-only task with an invented roster
reward.

The current branch can replay a game from its format, Showdown revision, seed,
teams, and actions; refuse mismatched logs; reopen snapshots; enumerate legal
joint actions; grade each eligible decision with one complete exhaustive action
table; and select seeded stratified positions from versioned grade-time
qualification metrics. It does **not** provide a public verifiers package, a supported
real-provider frozen evaluation, a calibrated public reward, or a validated
benchmark. All `grade-positions` output is exploratory.

## `vgc-positions-v1`

### Public task and private grader data

Each task shows one anonymized seat a canonical public-history/own-request
prompt, format and phase, numbered Showdown-accepted candidate actions, and
a schema selecting exactly one action. It excludes source identity, action, rationale, notebook, opponent
request, snapshot, scores, and panel draws. Every evaluated model receives the
same neutral position scaffold rather than another model's memory.

The first package is static: no Node process, HTTP service, tunnel, or secret at
rollout time. TypeScript must score every accepted action under the candidate
protocol and write exactly two physically separated roots:

- one public root for prompts, canonical action maps, and the candidate manifest;
- one private root for score vectors, qualification evidence, snapshots, draw
  identities, and rectangular action-value matrices.

The standalone public loader verifies the complete manifest and rejects private
or mixed roots.

The current candidate manifest and artifact rows use schema v2. The manifest
binds the full Showdown SHA, format, scaffold/reference versions, sampling seeds,
source corpus, action encoding, executed evaluator, canonical bytes, and
checksums.

The schema-v3 grading cache binds the canonical counterfactual budget (including
the rollout limit) and exhaustive-panel protocol. It retains qualification
metrics and private exact configured generator provenance in source joins, not
panel matrices or measurement values. Older caches must be restarted.

Two independent common-draw qualification panels provide the held-out span used
for grade-time eligibility. A third, untouched common-draw measurement panel
supplies final rewards only after selection. The exporter reruns all three panels
under a separate seed namespace. A failed matrix cell rejects the whole table;
actions never receive unequal sample counts.
Qualification thresholds, near-duplicate/source grouping, and corpus-balance
requirements must come from a separately reviewed eligibility policy calibrated
outside the candidate corpus. A balance failure or qualification-eligible row
without a usable measurement panel fails the whole candidate. The public and
private target roots are immutable: an identical rerun is a no-op; different
bytes require new roots. Release status belongs only to the program-status table,
not a candidate-manifest field.

The planned Python `Taskset` strictly parses one choice and looks up its frozen
measurement value. For legal action `a`, the proposed normalized reward is:

```text
(mean_value(a) - min_value) / (max_value - min_value)
```

Zero-span tasks are ineligible under the eligibility policy. Invalid output receives
`-1` and is reported separately from the worst legal action, whose reward is
zero. Preserve parsing, legality, raw value, uncertainty, span, phase, and
normalized reward as separate metrics.

The table is reproducible but inspectable. Keep calibration and held-out
evaluation corpora separate, record exposure, and never claim contamination resistance merely
because values came from a simulator. The initial source distribution is
“VGCML-generated positions,” not human or tournament VGC.

### Reference limits

The prototype reference is short-horizon material differential under sampled
uniform Showdown-accepted candidate opponent actions and uniform-random
continuations. It can miss positioning, information, setup, and long-term team value. It also sees the
realized hidden state. Label it accordingly; uniform opponent actions do not
remove hindsight. Ex-ante claims require a published compatible-hidden-state
prior or robustness across hidden states.

Do not infer a true best action from a noisy maximum, clamp a measurement
reversal, or use measurement evidence for inclusion. Report uncertainty and
sensitivity to the reference and compute budget.

### Release gates

Do not publish a model ranking, public reward, or training recipe until all
these gates pass:

1. **Replay:** every item exactly reproduces its bound source game.
2. **Sampling stability:** independent qualification panels are assessed under
   an externally calibrated eligibility policy; measurement values never choose
   inclusion.
3. **Horizon sensitivity:** report longer horizons and full-game results on a
   tractable subset.
4. **Hidden information:** distinguish realized-state and information-set
   values and test the declared hidden-state prior.
5. **Criterion validity:** score random play, compatible baselines, source
   choices, and a small blinded expert sample; report disagreement.
6. **Prompt parity and leakage:** prove no opponent-private request, source
   identity/action, score, or grader state reaches model-visible tasks.
7. **Artifact integrity:** verify canonical manifests/digests, immutable and
   physically separate public/private roots, corpus balance, and duplicate/source
   isolation.
8. **Packaging:** install the wheel and load/score it in a clean container; pass
   a local native-v1 evaluation.
9. **Hosted compatibility:** run separate real smoke tests for Environment Hub,
   Hosted Evaluation, and Hosted Training rather than inferring support.

Candidate export completes none of the criterion, horizon, hidden-information,
packaging, or hosted gates by itself.

## Internal `vgc-frozen-matchday-v0`

This implemented native-v1 `Taskset` plus `Env` is an unpublished control-flow
adapter for one strict-construction-to-Bo3 matchday. One Episode provisions the
entrant, opponent, and non-agent referee roles, runs the exact JSONL 1 / matchday
1 / battle 1 TypeScript protocol, and records a descriptive seat outcome only
after its within-matchday action and notebook joins are complete. Finalization
marks the entrant's single reward carrier as the evaluation policy view so
native verifiers aggregation reads one entrant outcome per episode instead of
cancelling the two seats; the opponent's mirrored outcome stays retained
evidence. That flag is an aggregation label, not a training path. The adapter
does not draft, schedule a season, run playoffs, define a circuit return, or
implement training.

The private TypeScript task-source freezer is implemented and tested. It derives
referee-accepted cases into `task-source.jsonl` plus a manifest. It assumes a
single trusted producer and an immutable repository/build/runtime tree from
process start through publication; its
post-capture authority checks, unattested loaded-module bytes, POSIX/LF raw-byte
scope, and lack of portable directory `NOREPLACE` are explicit bounds. Freezing
is not review or release approval.

The [package README](../environments/vgc_frozen_matchday_v0/README.md) owns the
detailed adapter contract. Verified and unsupported execution paths are recorded
once in the [support table](#verifiers-boundary-and-target-architecture) below.

## `vgc-draft-circuit-v1`

The unit will be one shared multi-seat circuit episode: one contested board and
draft, the complete public schedule and regular season, and
qualification-dependent playoffs across all seats. Replication and statistical
blocking will use the whole circuit, never a pick, draft turn, battle game, or
seat. Draft-only execution may smoke test control flow or gather traces, but it
will not support roster-quality claims.

The full-circuit environment will make the public schedule and playoff format
available to each seat. A private notebook channel will be available after each
nonterminal game for possible next-game use. Each matchup will register one
legal six from the seat's roster; the same registered matchup six will be used
throughout its Bo3, with a fresh bring four and lead two every game. Playoffs
will run only for seats that qualify. A backup Mega is only an example of a
preregistered diagnostic motif; it will never be prompt advice, required
behavior, a checklist item, or reward.

The circuit reward is currently undefined. Before any comparison or training,
the project will freeze a preregistered controlled terminal battle-return
functional emitted by the TypeScript referee. It will specify per-seat returns;
ties, byes, and nonqualifiers; invalid, defaulted, and aborted episodes; schedule
aggregation; and multi-agent credit. It will provide no intermediate shaping or
LLM-judge or semantic-label reward, and it will never turn a natural standing or
championship result into reward. A delayed return will not be interpreted as
causal per-pick credit. Comparisons will counterbalance or mirror boards, seats,
schedules, battle sides, and seeds, and uncertainty will use the whole circuit
as its block.

The full connected circuit `Env`, draft, schedule, qualification-dependent
playoffs, and circuit return remain unimplemented. The
strict-construction-to-Bo3 referee, JSONL bridge, and internal matchday-only
adapter are the existing slice; they cannot stand in for a whole circuit.
Comparative circuit rollouts will use one named profile from
[Measurement](measurement.md), and an actual hosted evaluation gate will precede
any training claim. Multi-agent training will remain a self-managed `prime-rl`
experiment until its role configuration and advantage methods are demonstrated.

### Draft Circuit release gates

Do not release a Draft Circuit comparison, training recipe, or long-horizon
result until all these gates pass:

1. freeze terminal-return and failure semantics before rollout;
2. prove end-to-end replay and complete stage joins;
3. counterbalance boards, schedules, seats, battle sides, and seeds;
4. validate role isolation and prevent future or private-information leakage;
5. validate same-six Bo3 registration and fresh preview choices every game;
6. preregister the intervention and estimand for each claimed contingency or
   adaptation effect;
7. run enough independent whole-circuit blocks for circuit-level uncertainty;
8. derive no model rank from a natural standing or championship result.

### Stage-linked trace analysis

The internal matchday adapter implements complete joins from action Traces to
accepted referee actions and from between-game notebook Traces to referee
receipts before it records an outcome. Its deterministic full-`Env` debug smoke
exercises those joins, but is not a quality evaluation.

The committed selected trace bundle is a different exploratory artifact. It links eight
selected draft, construction, preview, action, transaction, and terminal-review
events while labeling recorded facts separately from release-time
reconstruction. It is not a complete connected-circuit projection: the legacy
source did not record the application revision or exact battle system prompt,
and the public bundle omits the complete terminal-game → between-game reflection
→ next-game prompt chain. The immutable v1 bundle will not be rewritten to add a
causal-transfer claim. Any notebook-handoff intervention must be a new
versioned artifact with source-time bindings and a later action on which an
effect could be tested.

A complete mechanical draft-to-construction-to-battle projection and the
connected circuit semantics remain planned release gates for the Draft Circuit.

Architecture owns the
[Showdown authority](architecture.md#pokémon-showdown-authority) and
[state/evidence boundary](architecture.md#state-evidence-and-trust);
[Measurement](measurement.md#cross-stage-evidence) owns cross-stage evidence and
[long-horizon interpretation](measurement.md#long-horizon-claims). Mechanical
projection export, a semantic-label pilot, and preregistered controlled forks
are separate analyses. Semantic labeling is not a prerequisite for controlled
forks.

### Long-horizon interpretation gate

Release of any contingency, adaptation, or anticipation claim must pass
[Measurement's long-horizon claim rules](measurement.md#long-horizon-claims).

## Verifiers boundary and target architecture

The internal matchday package and planned native-v1 packages use
`import verifiers.v1 as vf` against exact `verifiers==0.3.0`. Verifiers owns task
loading, configured agents and harnesses, runtimes, traces, evaluation output,
and episode control. TypeScript and Showdown remain authoritative for candidate
generation, native action acceptance, state, battle reconstruction, and domain
outcomes.

[Architecture](architecture.md) owns the package and component boundaries.

Compatibility is evidence, not assumption. This is the current support table for
`vgc-frozen-matchday-v0`:

| Path | Current evidence and status |
| --- | --- |
| local source suite | Passed locally against exact `verifiers==0.3.0` |
| compiled package suite | Passed locally, including private-source freezing and one deterministic three-game full-Episode lifecycle through a real v0.3 `EnvServer`, scripted local OpenAI-compatible endpoint, real compiled referee, and debug-labeled runtime objects; no real provider/model or isolation claim |
| local wheel build and clean Python smoke | Exact local wheel build plus clean-environment Python import and native plugin registry discovery passed |
| native CLI config resolution | Positional taskset id plus dotted `--env.*` overrides parse, bind the source, and enforce the pinned-opponent pairing in the local suite; no real run |
| GitHub CI | First green run passed 2026-08-09 (PR #70): full TypeScript suite, package suite, wheel build, and clean import/plugin smoke |
| real provider/model | Not run; unsupported. The first real run must use a pinned or declared baseline opponent condition — a self-play outcome validates machinery only |
| isolated runtime image | Not built or tested; unsupported |
| Docker | Not tested; unsupported |
| Prime runtime | Not tested; unsupported |
| Environment Hub | Unpublished and not tested; unsupported |
| Hosted Evaluation | Not tested; unsupported |
| Hosted Training or other training use | All roles nontrainable; the entrant carrier's policy-view flag is evaluation aggregation only. Not tested; unsupported |

## Work order

1. Position pipeline hardening is complete before any corpus exists. The runtime
   producer-authority binding is wired into the grader and exporter, grading uses
   one complete exhaustive action table per eligible decision, and the public-root
   reader strictly verifies the current manifest, public task bytes, digest, order,
   and exact public-only layout while rejecting private or mixed roots.
2. The [corpus-sizing memo](corpus-sizing.md) freezes the v0 target of 500,
   the two-position source-game cap, a 60-opportunity excluded-yield-pilot rule,
   and the decision not to require mirrored source-game pairs. The selector and
   exporter share those target/cap authorities, and private generator provenance
   is implemented. These decisions do not authorize generation.
3. Freeze the remaining source generators, teams, allocation blocks, eligibility,
   balance, concentration, duplicate/isolation, pilot-accounting, and cost-stop
   inputs using evidence outside the candidate corpus.
4. With explicit resource approval, run only the preregistered excluded
   yield/compute/cost pilot and mechanically append `y_L`; its source groups can
   never enter calibration, candidate, or held-out corpora.
5. Use the hardened grader and exporter to produce candidate artifacts only after
   the planning gate passes, then independently review the artifacts and all
   remaining release gates.
6. Build the small native-v1 static `Taskset` with strict parsing, lookup reward,
   leakage tests, and a tool-less/null harness.
7. Run a controlled held-out evaluation; publish samples, uncertainty, cost, and
   full configuration rather than a leaderboard alone.
8. Build an isolated runtime image containing the compiled pinned referee, then
   run the internal matchday package with a real provider and model under a
   pinned or declared baseline opponent condition, never self-play. Local
   debug-runtime evidence does not pass this gate.
9. After that smoke, run the crossed notebook intervention (retained, withheld,
   and fixed-replacement arms over the same frozen rows) as the first
   controlled matchday analysis, under
   [Measurement's long-horizon claim rules](measurement.md#long-horizon-claims).
10. Run separate Docker, Prime runtime, Environment Hub, and Hosted Evaluation
   smokes for the exact wheel and image. Keep Hosted Training unsupported while
   the package is matchday-only and nontrainable.
11. Only after those package gates, connect the existing draft and
    strict-construction artifacts into a full circuit `Env`, add schedule and
    playoff flow, and preregister and freeze terminal circuit-return and failure
    semantics before comparison or training.
12. Export the mechanical draft-to-battle projection and pass its end-to-end
    replay and join-completeness gate.
13. Run the semantic-label pilot and preregistered controlled forks as separate
    parallel or later analyses; neither is conditional on the other.
14. Add GUI reporting last and only from versioned evaluation outputs; it must
    not invent scores from natural league games.

Do not add another generic Showdown client, copy external baselines, derive a
natural-corpus ranking, label predictability as exploitability, infer belief or
deception from generated text, invent hidden human spreads, require a coding/RLM
seat, or add an always-on service for the static taskset.
