# Measurement principles

This document defines what results from this repository may mean. The
implementation and roadmap must follow it.

## Separate the three kinds of evidence

The repository records three different things. Do not collapse them into one
score.

1. **Battle outcomes.** Win, loss, and draw are simulator ground truth. They are
   the correct terminal objective for a battle environment, but a small set of
   uncontrolled matches is too noisy and confounded to rank models.
2. **Counterfactual battle diagnostics.** A forked simulator can estimate what
   alternative actions would do under a declared reference. The result is about
   that reference, horizon, and sampling budget. It is not an optimal-play
   label.
3. **Cross-stage evidence.** Draft rationales, team builds, bring choices,
   actions, and reviews show whether a stated plan was carried forward. Some
   links are deterministic; semantic links need judged labels and audit.

Standings describe a run. Only a controlled protocol supports a comparison
between models.

## Information policy

Give every seat the information a human competitor would have. Withhold the
strategy a human would have to derive.

The baseline harness provides:

- format rules and mechanics that cannot be inferred from the visible battle;
- complete, simulator-derived mechanics tools for public and own-team state;
- current legal data for formats newer than model training cutoffs;
- the public artifact in its normal presentation, with neutral search and filter
  tools where the artifact is too large to inspect reliably;
- the same process instructions, prompt fields, and tool schemas for every seat.

The baseline harness does not provide:

- strategy, matchup advice, or example “good” actions;
- corrections aimed at a known model weakness;
- prices, ordering, or examples adjusted to steer a result;
- derived planning frames such as a precomputed spending ceiling;
- web search or another live source of human choices;
- a required reasoning algorithm, sub-agent topology, or search policy.

Tools may calculate mechanics; they may not choose an action. A tool result must
include every interaction relevant to its answer. An incomplete authoritative
answer is worse than no answer.

No list order is neutral. When recreating a real format, use its published order
and provide neutral ways to search it. Record intentional departures rather than
quietly replacing the presentation.

## Distinguish model errors from harness errors

Before changing the harness after poor play, ask whether the needed fact was
visible.

- Missing, incomplete, or misleading information is a harness defect. Fix it and
  change the scaffold identity.
- Visible information that the model ignored or overrode is a model result. Do
  not coach it away.

A rationale, notebook, reasoning summary, or reflection is model output. It may
be post-hoc, incomplete, or wrong. The repository may measure consistency
between recorded statements, but must not call one of them the model's true
private belief or use disagreement alone as proof of deception.

## Keep scaffolds identifiable

Each run records hashes for the prompts, state renderer, tool renderer, tool
schemas, decision policy, and reflection policy. Model-visible adapter and
execution-harness identity is also part of the condition. Change a protocol or
scaffold between runs, never during one. For comparative adapters, freeze and
digest the harness prompts, memory policy, and any harness-provided initial
memory content, and model-facing skills before rollout; the model notebook is
per-episode model output.

The primary controlled baseline is `controlled-explicit-state`: exact explicit
state scoped per seat and per episode plus that model's notebook. It has no
cross-run memory, refinement state, or A2A. Competing seats run from isolated
roots with no sibling messaging, shared kernel, or shared filesystem. A
separate named, non-comparable `controlled-episodic` profile may use only a
fixed deterministic compaction procedure; that procedure and its inputs and
outputs are frozen and digested, and compaction events are append-only. A
separate named, non-comparable `prime-agent-capable` system-level ablation may
allow declared Prime Agent RLM refinement, subagents, and heartbeats. It is not
comparable with either controlled profile. The verifiers `Agent` is distinct
from both Prime Agent and Prime Agent RLM subagent.

Evidence logging has a separate identity. Raw submitted messages, actions,
traces, and referee transitions are append-only. Adding a sink or provenance
field does not by itself change model behavior; exposing a new retrieval API,
tool, prompt, or carried memory does. Summaries and evidence projections are
observational only and never affect legality or reward. Do not use an
evidence-log version as a substitute for the model-visible scaffold or adapter
identity.

Results from different scaffolds may be shown side by side only when the
changed component is irrelevant to the stated metric. Otherwise report them as
separate conditions. Model routing, provider, served upstream stack, sampling
parameters, timer mode, Showdown revision, board, and format are also
provenance. Prime Agent refinement, subagents, and heartbeats are allowed for
offline development and operator orchestration, but must not silently enter a
comparative rollout; enabled use belongs to the declared ablation.

The default condition is an untimed model without an added search or recursive
reasoning harness. Timers and other scaffolds are opt-in arms, not silent
baseline changes.

Reward hacking is a protocol risk: a model or harness can optimize a proxy,
summary, or judge signal without improving the declared decision. Contamination
is a separate risk: training or prompt exposure to frozen tasks, private score
artifacts, or source traces can invalidate a comparison. Keep those artifacts
separate, record exposure, and report failures or exclusions rather than
relabeling them as play quality.

## Caps are failure guards

Limits exist to stop hung calls and runaway tool loops, not to shape play. A
limit that normal traffic reaches must be raised or removed. Every truncation,
fallback, simulator substitution, and timer default is recorded separately.
Silently shortened model state invalidates the affected decision.

## Outcome comparisons

Win rate is appropriate when the design supplies enough games and controls the
opponent, team, side, format, and scaffold. The natural league corpus does not do
that: opponents and teams differ, the matchup graph is sparse, and the protocol
has changed over time.

Accordingly:

- do not publish an Elo or total order from the accumulated corpus;
- report exploratory match outcomes with their schedule and sample size;
- use mirrored assignments or population evaluation for battle-policy claims;
- cluster uncertainty by game or episode rather than treating turns as
  independent samples.

## Counterfactual battle scores

Only games that replay exactly from their recorded seed, teams, and actions may
supply positions. A timer or simulator action that cannot be reconstructed makes
that game ineligible.

For every counterfactual result, record:

- the value function;
- rollout horizon and continuation policy;
- opponent-action distribution;
- action-search procedure;
- random seeds and sample counts;
- simulator revision;
- selection and measurement estimates, including sampling uncertainty.

The current prototype uses material differential, uniform legal opponent
choices, uniform-random continuations, and bounded Monte Carlo search. This is a
computable reference, not a neutral one. It undervalues plans whose benefit lies
beyond the horizon and can prefer actions no competent player would choose. Call
its output **reference-relative opportunity loss** in reports. “Regret” is
acceptable only with the reference attached.

The prototype also forks the realized simulator state, including brought Pokémon
and stat points the acting seat may not have known. Its output is therefore a
realized-state diagnostic. A claim about ex-ante decision quality must instead
average over a declared distribution of hidden states compatible with the seat's
view, or restrict the task set to positions robust to those states. Report the
hidden-state treatment with every result.

Searching many noisy alternatives creates winner's bias. Qualification and
final measurement therefore use independent panels. Eligibility thresholds use
the two qualification panels only; the untouched measurement panel supplies the
published reward. An item admitted by qualification but lacking a usable
measurement panel fails the candidate freeze rather than being silently removed
using measurement evidence.

A normalized score must use a reliably estimated opportunity span. Thresholds
belong to a schema-v2 frozen policy calibrated on a separate canonical manifest,
not chosen from the candidate corpus. Qualification can still select a candidate
whose measurement ordering reverses. Do not call the selected action the true
best or interpret a per-position clamp as an unbiased estimate. Do not mix values
produced with different reference settings.

Before this diagnostic becomes a public reward, it must pass the validation
checks in [Evaluation plan](evaluation-plan.md): repeated-seed stability,
longer-horizon sensitivity, policy baselines, and expert review.

## Controlled position sets

A model-comparison set gives every model the same position, prompt renderer,
legal-action encoding, tools, sampling policy, and grading reference. Positions
are stratified by phase and game state, capped per source game, and frozen with a
selection seed. The first planned set samples VGCML-generated play; it does not
represent the distribution of expert, human, or tournament VGC without a
separate coverage argument and external holdout.

A position task contains the tested seat's public history, own request, and
legal actions. It does not contain the original model's identity, action,
rationale, notebook, or the opponent's private request. The grader may retain an
authoritative simulator snapshot outside the model-visible prompt.

The original league scaffold is provenance, not context for the new model. A
mid-game benchmark cannot give the new model another model's private notebook;
it uses one explicit, neutral position scaffold instead.

Thresholds and balance tolerances are reviewed on a separate canonical
calibration manifest, then applied unchanged to a distinct candidate manifest.
Frozen splits keep each source-series and near-duplicate connected component on
one side. The current allocation is deterministic greedy stratification, not a
global optimum. A candidate that misses the total or per-stratum tolerances fails
closed. Public tasks and private scoring/sealed artifacts live in physically
separate roots with immutable target files and are usable only with their
complete verified manifest.

## Cross-stage measurements

The draft-to-battle protocol records a linked temporal trajectory. Temporal
order alone does not make adjacent fields causal labels. Seat context and
decision logs record observations delivered to the model and actions it
submitted; they do not prove Showdown accepted the action. Legality, repair,
substitution, and transition claims must join referee or Showdown evidence.

Deterministic examples include:

- whether a drafted Pokémon was selected into the matchup team;
- whether a built Pokémon was brought;
- whether a declared bring was the submitted bring;
- whether a move or interaction named by canonical ID in a structured commitment occurred in the log;
- whether an action was legal or required repair.

Semantic examples include whether a build implements a draft thesis or whether
a review identifies the decisive error. These require a written rubric, blinded
labels, judge-model and prompt provenance, agreement estimates on a labelled
sample, and periodic human audit. Report “not applicable” separately from
failure and divide rates by eligible opportunities.

Explicit rationales are useful evidence, but requiring one changes the task.
The published environment must state that requirement and compare only runs
using the same policy.

## Recreate protocols faithfully

When a mode represents a real event, implement its rules and data vintage. Name
all deviations in the prompt and record. For example, open team sheets do not
publish stat points; a reconstructed team must identify where its spreads came
from rather than implying they are the player's originals.

Prefer existing projects for generic capabilities. Use poke-env or VGC-Bench
artifacts as external baselines where possible; do not port their clients,
policies, or datasets merely to make this repository self-contained.
