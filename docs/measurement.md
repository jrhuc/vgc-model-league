# Measurement principles

This document defines how to interpret results. Follow these requirements in
implementations and reports.

## Separate evidence types

1. **Battle outcomes** are Showdown ground truth and the terminal objective for
   a battle environment. Do not use a small, uncontrolled set of matches to
   rank models.
2. **Counterfactual diagnostics** estimate alternative-action values for a
   declared reference, horizon, and sampling budget. They are not labels for
   optimal play.
3. **Cross-stage evidence** connects draft statements, builds, bring choices,
   actions, and reviews. Compute mechanical connections. Use audited labels for
   semantic connections.

Standings describe one run. Compare results only under a controlled protocol.

## Information policy

Give each seat the information available to a human competitor. Withhold
strategy that the competitor would need to derive. The baseline may include:

- format rules and current public mechanics;
- complete simulator-derived tools for visible and own-team state;
- the public artifact in its normal order;
- neutral search and filter tools;
- identical process instructions and schemas.

Do not provide strategy, matchup advice, curated good actions, corrections for
known model weaknesses, derived planning frames, live human-choice search, or a
required reasoning algorithm, search policy, or subagent topology. Tools may
calculate mechanics, but they must not choose an action. An authoritative answer
must include every interaction that materially affects it.

The generic format-authority notice is allowed as neutral process information.
It is visible to the model across league roles. It tells seats that Champions
may postdate their training data, that the prompt and pinned simulator are
authoritative, and that mechanics absent from the rules and legal actions are
unavailable. It contains no strategy or matchup diagnosis. Include its exact
bytes in the affected scaffold identities. Do not treat it as invisible,
evidence-only metadata.

If required information was absent, incomplete, or misleading, fix the harness
and change its scaffold identity. If the model ignored visible information,
record that behavior as a model result instead of adding coaching. Rationale,
notebooks, reasoning summaries, and reviews are generated statements, not
private beliefs. Disagreement does not by itself indicate deception.

## Scaffolds and rollout profiles

Record component identities for prompts, state and tool renderers, tool schemas,
decision and reflection policies, the adapter, and model-visible context. Also
record provider routing, served stack, sampling, timer, Showdown revision,
format, board, and execution harness. Freeze each comparative condition before
rollout. Do not change it during the run.

The three named profiles are not comparable:

- **`controlled-explicit-state` (primary):** Provide exact state scoped to one
  seat and episode, plus that model's per-episode notebook. Freeze and digest
  harness prompts, memory policy, any harness-supplied initial memory,
  model-facing skills, and adapter identity. Give seats isolated roots with no
  cross-run memory, refinement, A2A, sibling messaging, shared kernel, or shared
  filesystem.
- **`controlled-episodic`:** Use the same explicit-state and isolation boundary.
  One declared, fixed, deterministic procedure may compact episode context.
  Freeze and digest the procedure and its inputs and outputs. Record each
  compaction event.
- **`prime-agent-capable`:** This system-level ablation may use declared,
  digested Prime Agent RLM refinement, per-seat subagents, and heartbeats while
  preserving seat isolation. A verifiers `Agent` is not a Prime Agent or an RLM
  subagent.

After each nonterminal game, the circuit referee allows each seat one bounded,
full-replacement notebook submission. Omission retains the seat's current
notebook. An empty replacement clears it. A malformed or over-limit notebook is
model output. Diagnose it, treat it as an omission, and verify the value retained
by the referee. A provider or runtime failure during the notebook interaction
instead fails the Episode because v0.3 retains the failed Trace. Report
diagnosed retention and failed Episodes separately.

The circuit arena metric is the scenario-specific terminal series return
defined in the [Evaluation plan](https://github.com/jrhuc/vgc-evals/blob/main/docs/evaluation-plan.md#terminal-returns). It is a
seat-level terminal outcome, not reward for any local trace. The default native
adapter keeps player traces non-trainable and records the return only as
`circuit_terminal_series_return_v1`. Game outcomes, pre-window and post-window
splits, adaptation, standings, champion status, transactions, and defaults
remain diagnostics. Use heterogeneous, counterbalanced frontier fields as an
ecological comparison. Same-model symmetric self-play validates machinery and
is not a strength comparison.

The notebook is optional generated evidence, not a hidden belief. Replacing it
does not directly affect the referee, legality, Showdown state, RNG, score, or
public observations. The referee inserts the current retained value into new,
authorized seat prompts, where it may affect later submitted choices. Include
the elicitation and reinjection prompts in the scaffold identity.

Use Prime Agent capabilities for offline development or operator orchestration.
Include them in a comparative rollout only through the named ablation. By
default, runs are untimed and do not add a search or recursive reasoning
harness. Timers and other scaffolds are opt-in arms.

Append raw submitted messages and actions, traces, referee transitions, and
profile events without modifying previous entries. Summaries are observational
and must not affect legality or reward. An invisible evidence sink does not
change the scaffold. A retrieval API, tool, prompt, or carried memory does.
Evidence-log versions do not replace scaffold or adapter identities.

Keep training exposure, public tasks, private scores, sealed state, and source
traces separate. Record contamination and protocol failures. Do not relabel them
as play quality.

## Limits and outcomes

Use caps to stop hung calls and runaway tool loops, not to shape normal play.
Raise or remove a limit if normal traffic reaches it. Record truncations,
fallbacks, model defaults, simulator substitutions, and timer defaults
separately. Silent state truncation invalidates the decision.

A win rate requires enough games and controlled opponent, team, side, format,
and scaffold conditions. The natural league corpus contains heterogeneous
matchups and protocol versions. Therefore:

- do not derive an Elo or total order from it;
- report exploratory outcomes with the schedule, condition, and sample size;
- use mirrored assignments or population evaluation for battle-policy claims;
- cluster uncertainty by game or episode, not by turn.

Roster fielding counts and a drafted Pokémon's win, draw, and loss record are
selected, conditioned diagnostics. Fielding depends on the coach, roster,
opponent, build, bring, pilot, schedule, and previous results. Game outcomes
also include RNG. Use these diagnostics to form hypotheses about usage. Do not
use them to estimate an asset's causal impact or quality. Named Kimi patterns in
the legacy archive have the same confounds and do not provide capability or
rank evidence. A legacy short `modelKey` can group multiple provider and model
identifiers. Provider aliases and archive keys do not establish a frozen
treatment, served revision, scaffold, or sampling condition.

## Counterfactual decision rules

A position is eligible only if its source game replays exactly from the recorded
seed, teams, actions, format, and Showdown revision. Record the value function,
horizon, continuation policy, opponent-action sampling design, random seeds,
sample counts, exhaustive panel protocol, qualification metrics, and
uncertainty. Do not combine values from different references.

The current prototype uses:

- material differential;
- seeded simple random sampling without replacement from Showdown-accepted,
  request-derived candidate opponent actions, or one null opponent slot for a
  unilateral decision;
- uniform-random continuations;
- bounded Monte Carlo rollouts.

It evaluates each accepted candidate action on common draws. It does not use a
screen, shortlist, or actual-opponent estimator. A chosen-action loss calculated
from these values is **reference-relative opportunity loss**. If you call it
“regret,” attach the reference. This short-horizon measure evaluates the
realized hidden state, including information that the acting seat might not have
known. For an ex-ante claim, average a published prior over compatible hidden
states or retain positions that are robust across those states.

Within a panel, the frozen request-menu candidate protocol uses common random
draws for every Showdown-accepted action that it produces. Native `Side.choose`
filtering removes false positives. The generator does not claim to cover every
custom Showdown mechanic. Its declared omissions are part of the protocol.

Two independent qualification panels produce versioned grade-time eligibility
metrics under a policy calibrated outside the candidate corpus. Selection reads
only the projected qualification span and legal-action count from those
metrics. The exporter evaluates selected positions again under a separate seed
namespace. Its untouched measurement panel provides the rewards. The candidate
build fails if an admitted row lacks a complete rectangular action table or a
usable measurement panel. Do not use measurement values to select or remove
rows. Do not call a noisy maximum the true best or silently clamp an independent
reversal.

A normalized value requires a reliable opportunity span. Calibrate
qualification thresholds and corpus-balance requirements outside the candidate
corpus. Do not let the exporter choose them. The [evaluation
plan](https://github.com/jrhuc/vgc-evals/blob/main/docs/evaluation-plan.md) lists the remaining validation gates.

## Controlled position sets and artifacts

Give each compared model the same anonymized prompt renderer, numbered action
encoding, tools, sampling policy, and scoring reference. Use seeded selection,
stratify it by phase and state, and cap positions per source game. Do not place
source-series or near-duplicate groups in more than one of the calibration,
candidate, and held-out corpora.

The first source is VGCML-generated play. It is not representative of human VGC
without an external holdout and a coverage argument. Record the generating
models for each position. A model evaluated on positions from its own play has
a distribution advantage, so prefer leave-own-games-out splits for cross-model
comparisons. Report accuracy as a function of measured opportunity span along
with any scalar mean. When the opportunity span is below the provider sampling
noise floor, model disagreement on near-tied positions is not evidence.

A public task contains the tested seat's public history, own request, and legal
actions. It excludes source identity, source action, rationale, notebook,
opponent-private requests, and simulator snapshots. The original league
scaffold is provenance, not inherited context.

Public tasks use one immutable public root. Private score tables, sealed
snapshots, and matrices use one physically separate immutable private root.
Model and browser loaders accept only public artifacts with a verified, complete
manifest. Do not release candidate artifacts until every release gate passes.

## Cross-stage evidence

Do not infer causality from temporal adjacency. A submitted action is not an
accepted transition. Join seat logs with referee evidence before making claims
about legality, repair, substitution, or outcomes. Deterministic mechanical
measures include:

- drafted-to-built and built-to-brought membership;
- declared versus submitted bring;
- whether a named canonical move or interaction occurred;
- legality, repair, and substitution rates.

Treat mechanical connections and audited semantic statement consistency as
separate evidence products. Semantic analysis requires a written observable
rubric, identity-stripped traces, multiple blinded labels, agreement estimates,
and periodic human audit. Human- or LLM-produced labels are diagnostic only.
They must not affect task inclusion, legality, action acceptance, seat context,
reward, `Env.finalize`, or training. Report not-applicable cases separately and
divide rates by eligible opportunities. Requiring a rationale changes the task.
Compare only runs with the same requirement.

A notebook handoff is a mechanical receipt showing that exact retained bytes
appeared in a later authorized prompt. A reflection trace adds a generated
statement. Neither shows that the model used the note, changed behavior because
of it, or benefited from it. A causal transfer claim requires:

- a versioned intervention, such as crossed retained, replaced, and withheld
  notebook conditions;
- a preregistered later-action contrast;
- fixed downstream controllers and common draws where applicable;
- an artifact that binds the complete reflection-to-prompt-to-action chain.

A terminal season review has no later action in the current season, so it cannot
demonstrate learning or transfer.

Recorded human choices are reference actions, not answer keys. Analyze action
agreement separately from the paired reference-value difference between human
and model actions on the same frozen action-value matrix. Use the existing term
**reference-relative opportunity loss** for value-derived loss. Do not introduce
a new `R`-relative term. Join event outcomes only after freezing position
selection and scoring. Treat outcomes as context, not evidence of optimality.

When recreating a real event, preserve its rules and data vintage and disclose
deviations. For example, open team sheets do not reveal hidden stat points. A
reconstruction must state the source of exact spreads.

### Long-horizon claims

Keep these claims separate:

1. **Episode linkage** establishes complete replay and joins. It does not
   establish behavioral adaptation or benefit.
2. **Behavioral responsiveness or adaptation** requires randomized or
   counterbalanced condition assignment, or a disclosed observational context,
   and a preregistered action contrast.
3. **Beneficial or causal anticipation** requires a crossed intervention or fork
   over the future condition and the upstream choice or policy, with fixed
   downstream controllers and common draws. It also requires placebo and
   cross-phase controls, uncertainty clustered by whole-circuit block, and
   replication across circuit blocks.

Do not infer causality from an endogenous association between a model choice and
condition. A change to a public schedule can cause whole-circuit interference.
Wins, standings, and plan text do not support these stronger claims. A backup
Mega is an example of a preregistered diagnostic motif. It is not required
behavior or evidence by itself.

Drafting against scarce resources and scheduled future opponents is planning
within this VGC environment. Episode linkage can make the plan inspectable. Do
not use this evidence to claim transfer to software work, tool-agent tasks,
open-ended construction, or other real-world domains. Such external validity
claims require matched studies in those domains. Similarity to an external
benchmark or paper can motivate a study but does not provide transfer evidence.
