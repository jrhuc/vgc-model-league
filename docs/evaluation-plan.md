# Evaluation plan

This page is the source of truth for artifact status, release gates, and work
order.
[Measurement](measurement.md) defines how to interpret results.

## Program status

| Track | Unit | Status |
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

### Public task and private grader data

Each task gives one anonymized seat:

- a canonical public-history and own-request prompt;
- the format and phase;
- numbered candidate actions that Showdown accepts; and
- a schema that selects exactly one action.

The task excludes the source identity, source action, rationale, notebook,
opponent request, snapshot, scores, and panel draws. Every evaluated model
receives the same neutral position scaffold, not another model's memory.

The first package is static. It requires no Node process, HTTP service, tunnel,
or secret during rollout. TypeScript must score every accepted action under the
candidate protocol and write exactly two physically separate roots:

- a public root containing prompts, canonical action maps, and the candidate
  manifest; and
- a private root containing score vectors, qualification evidence, snapshots,
  draw identities, and rectangular action-value matrices.

A release package still needs a standalone public loader that verifies the
complete manifest and rejects private or mixed roots. No maintained production
consumer currently provides that reader; it remains part of the native-package
release gate.

The current candidate manifest and artifact rows use schema v2. The manifest
binds the full Showdown SHA, format, scaffold and reference versions, sampling
seeds, source corpus, action encoding, executed evaluator, canonical bytes, and
checksums.

The schema-v3 grading cache binds the canonical counterfactual budget, including
the rollout limit, and the exhaustive-panel protocol. Source joins retain
qualification metrics and the private exact configured generator provenance.
They do not retain panel matrices or measurement values. Restart older caches.

Use two independent common-draw qualification panels to define the held-out
span for grade-time eligibility. Use a third, untouched common-draw measurement
panel for final rewards only after selection. The exporter reruns all three
panels under a separate seed namespace. If any matrix cell fails, reject the
entire table. Every action must receive the same sample count.

Define qualification thresholds, near-duplicate and source grouping, and
corpus-balance requirements in a separately reviewed eligibility policy
calibrated outside the candidate corpus. Fail the entire candidate if balance
fails or any qualification-eligible row lacks a usable measurement panel. Treat
the public and private target roots as immutable: an identical rerun is a no-op,
and different bytes require new roots. Record release status only in the
program-status table, not in a candidate-manifest field.

The planned Python `Taskset` strictly parses one choice and looks up its frozen
measurement value. For legal action `a`, the proposed normalized reward is:

```text
(mean_value(a) - min_value) / (max_value - min_value)
```

The eligibility policy excludes zero-span tasks. Assign invalid output a reward
of `-1` and report it separately from the worst legal action, which receives
zero. Preserve parsing, legality, raw value, uncertainty, span, phase, and
normalized reward as separate metrics.

Assume models can inspect the reproducible table. Keep calibration and held-out
evaluation corpora separate, record exposure, and do not claim contamination
resistance only because the values came from a simulator. The initial source
distribution is “VGCML-generated positions,” not human or tournament VGC.

### Reference limits

The prototype reference uses short-horizon material differential. It samples
uniformly from Showdown-accepted candidate opponent actions and uses
uniform-random continuations. It can miss positioning, information, setup, and
long-term team value. It also observes the realized hidden state. Label these
limits. Uniform opponent actions do not remove hindsight. Ex-ante claims require
a published compatible-hidden-state prior or evidence of robustness across
hidden states.

Do not infer a true best action from a noisy maximum, clamp a measurement
reversal, or use measurement evidence to select items. Report uncertainty and
sensitivity to the reference and compute budget.

### Release gates

Do not publish a model ranking, public reward, or training recipe until all of
these gates pass:

1. **Replay:** Every item exactly reproduces its bound source game.
2. **Sampling stability:** Assess independent qualification panels under an
   externally calibrated eligibility policy. Never use measurement values to
   select items.
3. **Horizon sensitivity:** Report longer horizons and full-game results on a
   tractable subset.
4. **Hidden information:** Distinguish realized-state values from
   information-set values and test the declared hidden-state prior.
5. **Criterion validity:** Score random play, compatible baselines, source
   choices, and a small blinded expert sample. Report disagreement.
6. **Prompt parity and leakage:** Prove that model-visible tasks contain no
   opponent-private request, source identity or action, score, or grader state.
7. **Artifact integrity:** Verify canonical manifests and digests, immutable and
   physically separate public and private roots, corpus balance, and duplicate
   and source isolation.
8. **Packaging:** Install the wheel and load and score it in a clean container.
   Pass a local native-v1 evaluation.
9. **Hosted compatibility:** Run separate real smoke tests for Environment Hub,
   Hosted Evaluation, and Hosted Training. Do not infer support.

Candidate export does not by itself pass the criterion, horizon,
hidden-information, packaging, or hosted gates.

## `vgc-circuit-v1`

The package implements two distinct eight-seat circuit lifecycles behind one
generic native-v1 `Taskset` and `Env`. A taskset selects exactly one scenario;
it cannot combine the league and tournament in one evaluation. The environment
exposes configurable `seat1` through `seat8` agent roles and one non-playing
`referee` role.

### Implemented scenarios

Both scenarios are implemented internally and remain unpublished.

- **`victory-road-top8-v1`:** Runs the seven conditional series in a fixed,
  seeded Victory Road top-eight bracket. Each slot uses its committed
  reconstructed team from `teams/vr-aug26-top8`. The reconstruction binds the
  published team details to committed stat spreads because the event did not
  publish the human spreads. This scenario does not replay player actions, the
  full Swiss event, or the exact unpublished human spreads.
- **`draft-league-v1`:** Runs an eight-seat, 80-pick snake draft from the
  committed Regulation M-B board. Each seat drafts ten entries. The league then
  runs all 28 pairings over seven blind-batched round-robin weeks, with a
  barrier after week 3 for one coach-trade opportunity and free agency. Every
  series has a new matchup-specific construction. The top four enter two
  semifinals and one final, for three conditional playoff series.

```text
80-pick snake draft (8 seats x 10 picks)
  |
  v
construct weeks 1-3 [12 matchups, blind construction block]
  |
play 12 series serially
  |
  +========== after-week-3 barrier ==========+
  | coach-trade phase -> free agency         |
  +==========================================+
  |
  v
construct weeks 4-7 [16 matchups, blind construction block]
  |
play 16 series serially -> round-robin standings -> top four
  |
construct two semifinals -> play semifinals
  |
construct conditional final -> play final
  |
terminal evidence [31 series total]
```

Both scenarios use the pinned Champions Reg M-B format. Each series registers
one six-Pokémon construction and starts a fresh bring-four and lead-two preview
for each game. An elimination series tied after the three regulation games uses
deterministic extra-game seeds until it has a winner, with a nine-game limit.

### Terminal returns

The TypeScript referee emits one frozen return for each seat. Python validates
that value against complete terminal evidence. The default circuit adapter
records it as a non-training arena metric and adds no per-turn reward. The
legacy repeated-trace projection is opt-in only. There is no intermediate
reward or local credit assignment.

For `draft-league-v1`, the return is:

```text
((round-robin series wins - round-robin series losses)
 + (playoff series wins - playoff series losses)) / 9
```

The denominator represents seven round-robin opportunities plus two possible
playoff opportunities for one seat. The reward name is
`draft_league_series_return_v1`. A recorded round-robin draw or a playoff
opportunity that the seat does not reach contributes zero to the numerator.

For `victory-road-top8-v1`, the return is:

```text
(top-cut series wins - top-cut series losses) / 3
```

The denominator represents the three possible top-cut series for one seat. The
reward name is `tournament_series_return_v1`. An opportunity that the seat does
not reach contributes zero to the numerator.

Both returns partition one series ledger, so the eight seat returns of a
complete Episode sum to exactly zero. Python enforces that conservation before
recording arena metrics. A mean taken across all eight seats is therefore zero
whatever the field played. Report counterbalanced focal-seat or assigned-model
contrasts, not one field mean. Reweight trace-level metric exports by
`circuit_seat_decisions_v1` only to remove duplicate rows.

Game records, pre-window and post-window splits, game-one-loss conversion as an
adaptation diagnostic, standings, playoff qualification, champion status, transactions, invalid turns,
and defaults are diagnostics. They do not add semantic, transaction, champion,
standing, or default shaping to either return. Do not interpret a delayed seat
return as causal credit for a particular draft pick or decision.

### Evaluation design

The primary comparative design uses heterogeneous frontier-model fields. Build
counterbalanced complete-scenario blocks so that model assignment rotates across
seats and the declared seeds, sides, and schedules. Keep one complete league or
one complete tournament as the uncertainty block. Run, analyze, and report the
two scenarios separately: they have different starting resources, lifecycle,
reward, and estimand. Do not treat a game, series, seat, or turn as an
independent replication.

The eight separately configurable roles also support a same-model symmetric
self-play target and a multi-agent `prime-rl` target. These paths can validate
machinery or support self-managed experiments, but they are not substitutes for
the heterogeneous counterbalanced evaluation. Neither target has been validated
on Hosted Evaluation or Hosted Training.

### VGC Circuit release gates

Do not release a VGC Circuit comparison, training recipe, or long-horizon
result until all of these gates pass:

1. Keep the implemented v1 terminal-return and failure semantics frozen for
   the rollout.
2. Prove end-to-end replay and complete stage joins.
3. Counterbalance boards, schedules, seats, battle sides, and seeds.
4. Validate role isolation and prevent future or private-information leakage.
5. Validate same-six Bo3 registration and fresh preview choices for every game.
6. Preregister the intervention and estimand for every claimed contingency or
   adaptation effect.
7. Run enough independent whole-circuit blocks to estimate circuit-level
   uncertainty.
8. Do not derive a model rank from a natural standing or championship result.

### Stage-linked trace analysis

The circuit environment binds each fresh one-turn Trace to the accepted or
defaulted TypeScript receipt and validates exact receipt counts before it adds a
terminal return. The TypeScript terminal evidence also links constructions,
registered teams, series, schedules, bracket advancement, transactions, and
per-seat diagnostics. These mechanical joins do not evaluate decision quality
or prove semantic plan fidelity.

The committed selected trace bundle is a separate exploratory artifact. It
links eight selected draft, construction, preview, action, transaction, and
terminal-review events. It labels recorded facts separately from release-time
reconstruction. It is not a complete connected-circuit projection. The legacy
source did not record the application revision or exact battle system prompt,
and the public bundle omits the complete terminal-game → between-game
reflection → next-game prompt chain.

Do not rewrite the immutable v1 bundle to add a causal-transfer claim. Any
notebook-handoff intervention requires a new versioned artifact with source-time
bindings and a later action on which to test an effect.

Architecture defines the
[Showdown authority](architecture.md#pokémon-showdown-authority) and
[state and evidence boundary](architecture.md#state-evidence-and-trust).
[Measurement](measurement.md#cross-stage-evidence) defines cross-stage evidence
and [long-horizon interpretation](measurement.md#long-horizon-claims).
Mechanical projection export, a semantic-label pilot, and preregistered
controlled forks are separate analyses. Semantic labeling is not required for
controlled forks.

### Long-horizon interpretation gate

Before releasing a contingency, adaptation, or anticipation claim, pass
[Measurement's long-horizon claim rules](measurement.md#long-horizon-claims).

## Verifiers boundary and support

The package uses `import verifiers.v1 as vf` with exact `verifiers==0.3.0` and
exports exactly `VgcCircuitTaskset` and `VgcCircuitEnv`. Verifiers
controls task loading, the eight configured agents, the referee role, runtimes,
traces, evaluation output, and Episode control. TypeScript and Showdown remain
authoritative for prompts, native action acceptance, state, schedules, battle
reconstruction, domain outcomes, and returns.

[Architecture](architecture.md) defines the package and component boundaries.
Do not treat untested paths as supported.

| Path | Current evidence and status |
| --- | --- |
| local TypeScript circuit suite | The post-decomposition full `pnpm test` run passed, including the deterministic 31-series draft lifecycle and the frozen-circuit build |
| copied Hub-boundary Python suite | `uv lock --check` and the locked package suite passed against exact `verifiers==0.3.0` after the package decomposition |
| local native dry run and wheel | Native-v1 dry run, wheel build, and isolated Python 3.13.15 install and plugin discovery passed |
| GitHub CI | The workflow builds the circuit bundle, runs the copied standalone package suite, performs the native-v1 dry run, builds a wheel, and tests clean-wheel plugin discovery; PR #79 passed both package and root jobs before merge |
| Prime private push preflight | Built the wheel, then stopped at `No API key configured` before upload; this proves neither authentication nor Hub publication |
| real provider or model | Not run |
| same-model symmetric self-play | Supported configuration target; no real-model or hosted validation |
| heterogeneous frontier field | Primary evaluation target; no controlled field result published |
| referee runtime image | A minimal staged executable ready-envelope smoke passed. Docker CLI was unavailable, so the image was not built or tested; no image or digest is published |
| Docker or Prime runtime | Not tested. Runtime image pull authentication and reviewed immutable runtime image digests remain blockers |
| Environment Hub | Package unpublished; not tested beyond the unauthenticated preflight above |
| Hosted Evaluation | Not tested |
| `prime-rl` or Hosted Training | Multi-agent training target; not hosted-validated |

## Work order

1. Position producer and exporter hardening is complete. The current admissible
   corpus is empty. Runtime producer-authority binding is connected to the grader
   and exporter. Grading uses one complete exhaustive action table per eligible
   decision. A standalone public-root reader is not connected; build and test it
   with the native package in step 6.
2. Apply the frozen v0 decisions in the
   [corpus-sizing memo](corpus-sizing.md): a target of 500, a cap of two
   positions per source game, a 60-opportunity excluded-yield pilot, and no
   required mirrored source-game pairs. The selector and exporter share the
   target and cap authorities, and private generator provenance is implemented.
   These decisions do not authorize generation.
3. Using evidence outside the candidate corpus, freeze the remaining source
   generators, teams, allocation blocks, eligibility, balance, concentration,
   duplicate and isolation, pilot-accounting, and cost-stop inputs.
4. After explicit resource approval, run only the preregistered excluded
   yield, compute, and cost pilot. Mechanically append `y_L`. Never include its
   source groups in calibration, candidate, or held-out corpora.
5. After the planning gate passes, use the hardened grader and exporter to
   produce candidate artifacts. Then independently review the artifacts and all
   remaining release gates.
6. Build the small native-v1 static `Taskset` and its standalone public-root
   reader with strict parsing, lookup reward, full manifest and layout checks,
   leakage tests, and a tool-less/null harness.
7. Run a controlled held-out evaluation. Publish samples, uncertainty, cost,
   and full configuration, not only a leaderboard.
8. Review the implemented circuit scenarios, return and failure semantics,
   complete terminal joins, role isolation, and private-information projections.
9. Publish the referee runtime image at a reviewed immutable digest and make its
   authenticated pull path available to the intended runtime. Record the
   reviewed referee's `configDigest` and `promptRevision` in the environment's
   `expected_config_digest` and `expected_prompt_revision`, which fail an
   Episode whose referee content drifts from the reviewed one. Publish the exact
   package only after its wheel and plugin smokes pass.
10. Run separate Docker, Prime runtime, Environment Hub, and Hosted Evaluation
    smokes for the exact wheel and image digest. Do not infer one path from
    another.
11. Preregister heterogeneous frontier fields and separate counterbalanced
    allocations for each scenario across seats, sides, schedules, and seeds. Set
    each scenario's independent block count and analysis before rollout.
12. Run the controlled league and tournament evaluations separately. Publish
    configuration, terminal returns, diagnostics, failures, uncertainty, and
    cost. Do not publish only a standing or champion list.
13. Validate same-model symmetric self-play and `prime-rl` separately. Do not
    present machinery validation or symmetric self-play as the primary frontier
    comparison.
14. Export the mechanical draft-to-battle projection and pass its end-to-end
    replay and join-completeness gate.
15. Run notebook interventions, the semantic-label pilot, and preregistered
    controlled forks as separate analyses. Follow
    [Measurement's long-horizon claim rules](measurement.md#long-horizon-claims).
16. Add GUI reporting last and only from versioned evaluation outputs. Do not
    create scores from natural league games.

Do not:

- add another generic Showdown client;
- copy external baselines;
- derive a ranking from the natural corpus;
- label predictability as exploitability;
- infer belief or deception from generated text;
- invent hidden human spreads;
- require a coding or RLM seat; or
- add an always-on service for the static taskset.
