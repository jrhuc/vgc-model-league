# Evaluation plan

This page is the source of truth for artifact status, release gates, and work
order. [Measurement](measurement.md) defines what their results may mean.

## Program status

| Track | Unit | Status |
| --- | --- | --- |
| `vgc-positions-v1` | one battle choice | TypeScript replay/fork/export prototype exists; Python package and model runner do not |
| `vgc-whole-reg-build-v0` | one complete team build | internal vertical-slice proposal only |
| `vgc-draft-circuit-v1` | one shared multi-seat circuit episode | strict-construction-to-Bo3 referee and JSONL bridge exist; draft linkage, reward, and verifiers `Env` do not |
| local league | exploratory full runs | working |

The public program deliberately separates an inexpensive controlled choice from
the delayed draft-to-battle problem. Positions come first. The connected Draft
Circuit is the long-horizon target, not a draft-only task with an invented roster
reward. The whole-regulation build arm is only an internal exercise of shared
construction and battle interfaces.

The current branch can replay a game from its format, Showdown revision, seed,
teams, and actions; refuse mismatched logs; reopen snapshots; enumerate legal
joint actions; run bounded counterfactual panels; and select seeded stratified
positions. It does **not** run new models on frozen tasks, provide a verifiers
package, define a calibrated public reward, or constitute a validated benchmark.
All `grade-positions` output is exploratory.

## `vgc-positions-v1`

### Public task and private grader data

Each task shows one anonymized seat a canonical public-history/own-request
prompt, format and phase, numbered Showdown-accepted candidate actions, and
a schema selecting exactly one action. It excludes source identity, action, rationale, notebook, opponent
request, snapshot, scores, and panel draws. Every evaluated model receives the
same neutral position scaffold rather than another model's memory.

The first package is static: no Node process, HTTP service, tunnel, or secret at
rollout time. TypeScript must score every accepted action from the frozen
candidate protocol before freezing and write three physically separated artifact
classes:

- public prompts and canonical action maps;
- private score vectors, qualification uncertainty, and eligibility evidence;
- sealed snapshots, draw identities, and rectangular action-value matrices.

Every manifest binds the full Showdown SHA, format, scaffold/reference versions,
sampling seeds, source corpus, action encoding, executed evaluator, canonical
bytes, and checksums. Public loaders reject private roots.

Two independent common-draw qualification panels decide eligibility. A third,
untouched common-draw measurement panel supplies final rewards. A failed matrix
cell rejects the panel; actions never receive unequal sample counts. Qualification
thresholds, near-duplicate policy, split seed/fraction, and total/per-stratum
balance tolerances come from a reviewed schema-v2 policy calibrated against a
separate canonical manifest.

`freeze-position-splits` keeps every source-series/near-duplicate connected
component intact and uses deterministic greedy stratification. That is a
reproducible allocation, not a global optimum. A missing split, balance failure,
or qualification-eligible row without a usable measurement panel fails the
whole candidate. Public and private target roots are immutable: an identical
rerun is a no-op; different bytes require new roots. Candidate manifests remain
`release_ready: false`.

The planned Python `Taskset` strictly parses one choice and looks up its frozen
measurement value. For legal action `a`, the proposed normalized reward is:

```text
(mean_value(a) - min_value) / (max_value - min_value)
```

Zero-span tasks are ineligible under the frozen policy. Invalid output receives
`-1` and is reported separately from the worst legal action, whose reward is
zero. Preserve parsing, legality, raw value, uncertainty, span, phase, and
normalized reward as separate metrics.

The table is reproducible but inspectable. Keep train and evaluation splits
separate, record exposure, and never claim contamination resistance merely
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
   an externally calibrated frozen policy; measurement values never choose
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
   physically separate public/private roots, split balance, and duplicate/source
   isolation.
8. **Packaging:** install the wheel and load/score it in a clean container; pass
   a local native-v1 evaluation.
9. **Hosted compatibility:** run separate real smoke tests for Environment Hub,
   Hosted Evaluation, and Hosted Training rather than inferring support.

Candidate freezing completes none of the criterion, horizon, hidden-information,
packaging, or hosted gates by itself.

## Internal `vgc-whole-reg-build-v0`

This proposed ablation removes drafting and asks for exactly one complete legal
Regulation M-B team of six. It must reuse the Draft Circuit's `TeamBuildTask`,
`StageEvidence`, Showdown validation, preview adapter, battle adapter, and
evidence schema. It adds no separate builder, repair/default path, or reflection.
An invalid or incomplete comparative build remains invalid.

Candidate and frozen human-reference builds would face a frozen opponent suite
on the same rectangular cross-product of opponent, side, seed, two preview
controllers, and two battle controllers. Every cell must complete. The statistic
is the candidate schedule mean minus the mean human-reference value on identical
cells; uncertainty clusters by build episode. Meta-judges may label diagnostic
style or failure modes but never determine reward or inclusion.

Build only the vertical slice needed to verify the shared contracts. Do not
publish a Regulation M-B comparison until exact current human packs have usable
licences and provenance, opponent and human suites are frozen and disjoint, and
controller coverage is complete. Public or reconstructed teams are not evidence
of de novo construction; an official stream without spreads is not an exact
pack.

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

The connected draft, schedule, reward, and native Prime/verifiers `Env` remain
unimplemented. The strict-construction-to-Bo3 referee and JSONL bridge are the
existing slice. Comparative rollouts will use one named profile from
[Measurement](measurement.md), and hosted evaluation will precede training.
Multi-agent training will remain a self-managed `prime-rl` experiment until its
role configuration and advantage methods are demonstrated.

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

### Stage-linked trace analysis (planned, unimplemented)

A replayable, complete join from each analyzed Prime/verifiers `Trace` to the
authoritative TypeScript referee evidence is a release gate. Architecture owns
the [Showdown authority](architecture.md#pokémon-showdown-authority) and
[state/evidence boundary](architecture.md#state-evidence-and-trust);
[Measurement](measurement.md#cross-stage-evidence) owns cross-stage evidence and
[long-horizon interpretation](measurement.md#long-horizon-claims). Mechanical
projection export, a semantic-label pilot, and preregistered controlled forks
are separate analyses. Semantic labeling is not a prerequisite for controlled
forks.

### Official-event human controls (planned, gated)

No human corpus has been ingested. The bounded inventory in
[Human controls](human-controls.md) identified no official Reg M-B match corpus
through 2026-08-08; that document owns the dated source inventory,
reconstruction and admission, human-reference treatment, and rights and release
gates. Worlds is a prospective official-event source and can be assigned to
Reg M-B only after an official Worlds-specific rules source is retained. NAIC
Reg M-A may calibrate annotation and reconstruction machinery only; it does not
validate Reg M-B.

### Long-horizon interpretation gate

Release of any contingency, adaptation, or anticipation claim must pass
[Measurement's long-horizon claim rules](measurement.md#long-horizon-claims).

## Verifiers boundary and target architecture

The planned native-v1 packages use `import verifiers.v1 as vf`. Verifiers owns
task loading, configured agents/harnesses, runtimes, traces, rollout retries,
evaluation output, episode control, and `prime-rl` integration. In the published
adapter only, it replaces local provider routing, retries, `LLMEngine`, and
comparative orchestration. TypeScript and Showdown remain authoritative for
candidate generation, native action acceptance, state, battle reconstruction, and reward.

`vgc-positions-v1` is a static `Taskset`. The dynamic Draft Circuit will be an
`Env` whose control flow is programmed in `Env.run(task, agents)`. Each role is
provisioned through `Agent.provision(task)`, and its runtime launches the
versioned JSONL TypeScript referee with `Runtime.open_process`. The image
must include Node and the compiled pinned bundle. Clients fail closed on
protocol and every digest implemented by the relevant referee slice. These APIs
are verified against `verifiers==0.3.0`; Docker, Hub, and hosted compatibility
remain separate smokes. See [Architecture](architecture.md) for the component
boundary.

Seats are separate roles, not one policy. Per-role `AgentConfig` keeps reference
roles non-trainable and gives each competing seat an isolated runtime. The
measurement profiles and comparison limits are canonical in
[Measurement](measurement.md).

Compatibility is evidence, not assumption:

| Path | Evidence required before support is claimed |
| --- | --- |
| local native-v1 | clean install and small local evaluation |
| Environment Hub | clean Hub Action for the exact wheel |
| Hosted Evaluation | actual hosted smoke run |
| Hosted Training, positions | reward diversity and a small supported-model run |
| multi-agent training | self-managed `prime-rl` run with the declared baseline |

Publishing a wheel does not grant evaluation credits or imply funding.

## Work order

1. Use the existing exporter and freezer to produce separate calibration and
   candidate artifacts, review the frozen policy, and pass the remaining gates.
2. Build the small native-v1 static `Taskset` with strict parsing, lookup reward,
   leakage tests, and a tool-less/null harness.
3. Run a controlled pilot over one frozen split; publish samples, uncertainty,
   cost, and full configuration rather than a leaderboard alone.
4. Package the frozen matchday bridge in the runtime image and wrap it in a
   native-v1 multi-agent `Env` with isolated roles.
5. Connect the existing draft and strict-construction artifacts to that `Env`,
   then preregister and freeze the controlled terminal return and failure
   semantics before comparison or training.
6. Export the mechanical stage projection and pass its end-to-end replay and
   join-completeness gate.
7. Run the semantic-label pilot and preregistered controlled forks as separate
   parallel or later analyses; neither is conditional on the other.
8. Calibrate the human-control machinery on NAIC Reg M-A and collect Worlds only
   after the applicable source and rights gates pass.
9. Add GUI reporting last and only from versioned evaluation outputs; it must not
   invent scores from natural league games.

Do not add another generic Showdown client, copy external baselines, derive a
natural-corpus ranking, label predictability as exploitability, infer belief or
deception from generated text, invent hidden human spreads, require a coding/RLM
seat, or add an always-on service for the static taskset.
