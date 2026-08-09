# Measurement principles

This document defines what results may mean. Implementation and reports must
follow it.

## Keep evidence types separate

1. **Battle outcomes** are Showdown ground truth and the terminal objective for
   a battle environment. A small uncontrolled match set cannot rank models.
2. **Counterfactual diagnostics** estimate alternative-action values under a
   declared reference, horizon, and sampling budget. They are not optimal-play
   labels.
3. **Cross-stage evidence** links draft statements, builds, bring choices,
   actions, and reviews. Mechanical links can be computed; semantic links need
   audited labels.

Standings describe one run. Only a controlled protocol supports comparison.

## Information policy

Give each seat information a human competitor would have; withhold strategy it
would have to derive. The baseline may provide format rules, current public
mechanics, complete simulator-derived tools for visible and own-team state, the
public artifact in its normal order, neutral search/filter tools, and identical
process instructions and schemas.

It must not provide strategy, matchup advice, curated good actions, corrections
for known model weaknesses, derived planning frames, live human-choice search,
or a required reasoning algorithm, search policy, or subagent topology. Tools
may calculate mechanics but never choose an action. An authoritative answer must
include every interaction material to it.

The generic format-authority notice is allowed neutral process information. It
is model-visible across league roles and tells seats that Champions may postdate
training data, the prompt and pinned simulator are authoritative, and mechanics
absent from the rules/legal actions are unavailable. It contains no strategy or
matchup diagnosis. Its exact bytes belong to the affected scaffold identities;
it is not invisible evidence-only metadata.

If required information was absent, incomplete, or misleading, fix the harness
and change its scaffold identity. If visible information was ignored, preserve
it as a model result rather than coaching it away. Rationale, notebooks,
reasoning summaries, and reviews are generated statements, not private beliefs;
disagreement alone is not deception.

## Scaffolds and rollout profiles

Record component identities for prompts, state/tool renderers, tool schemas,
decision/reflection policies, adapter, and model-visible context. Also record
provider routing, served stack, sampling, timer, Showdown revision, format,
board, and execution harness. Freeze a comparative condition before rollout and
never change it mid-run.

The three named profiles are deliberately non-comparable:

- **`controlled-explicit-state` (primary):** exact state scoped to one seat and
  episode plus that model's per-episode notebook. Harness prompts, memory policy,
  any harness-supplied initial memory, model-facing skills, and adapter identity
  are frozen and digested. Seats have isolated roots with no cross-run memory,
  refinement, A2A, sibling messaging, shared kernel, or shared filesystem.
- **`controlled-episodic`:** the same explicit-state and isolation boundary, but
  episode context may be compacted by one declared, fixed, deterministic
  procedure. Freeze and digest its procedure and inputs/outputs and record every
  compaction event.
- **`prime-agent-capable`:** a system-level ablation that may use declared,
  digested Prime Agent RLM refinement, per-seat subagents, and heartbeats while
  retaining seat isolation. It is not comparable with either controlled
  profile. A verifiers `Agent` is not a Prime Agent or RLM subagent.

The internal matchday adapter gives each seat one bounded full-replacement
notebook submission after each nonterminal game. Omission retains that seat's
current notebook; an empty replacement clears it. Malformed or over-limit
returned notebook evidence is model output, so it is diagnosed and treated as
omission, with the referee-retained value verified; a provider or runtime
failure during the notebook interaction instead fails the Episode because v0.3
retains the failed Trace. Report diagnosed retention and failed Episodes
separately.

The adapter's native run metric is the entrant seat's terminal outcome: the
entrant's single reward carrier is the evaluation policy view, and the
opponent's mirrored outcome is retained evidence, never a second measurement. A
self-play matchday validates machinery — its expected outcome is even by
construction — so strength or comparison claims require a pinned or declared
baseline opponent condition.

The notebook is optional generated evidence, not a hidden belief. Replacing it
has no direct effect on the referee, legality, Showdown state, RNG, score, or
public observations. The adapter reinjects the retained current value into fresh
authorized seat prompts, where it may mediate later submitted choices. Its
elicitation and reinjection prompts are part of the scaffold identity.

Do not rank profiles against one another. Prime Agent capabilities are fine for
offline development or operator orchestration but may enter a comparative
rollout only through the named ablation. The default is untimed and adds no
search or recursive reasoning harness; timers and other scaffolds are opt-in
arms.

Raw submitted messages/actions, traces, referee transitions, and profile events
are append-only. Summaries are observational and never affect legality or
reward. Adding an invisible evidence sink does not change the scaffold; adding a
retrieval API, tool, prompt, or carried memory does. Do not use an evidence-log
version as a substitute for scaffold or adapter identity.

Keep training exposure, public tasks, private scores, sealed state, and source
traces distinct. Record contamination and protocol failures rather than
relabeling them as play quality.

## Limits and outcomes

Caps stop hung calls and runaway tool loops; they must not shape normal play.
Raise or remove a limit normal traffic reaches. Record truncations, fallbacks,
model defaults, simulator substitutions, and timer defaults separately. Silent
state truncation invalidates the decision.

Win rate requires enough games and controlled opponent, team, side, format, and
scaffold. The natural league corpus has heterogeneous matchups and protocol
versions, so:

- never derive an Elo or total order from it;
- report exploratory outcomes with schedule, condition, and sample size;
- use mirrored assignments or population evaluation for battle-policy claims;
- cluster uncertainty by game or episode, not turn.

Roster fielding counts and a drafted Pokémon's win/draw/loss record are selected,
conditioned diagnostics: fielding depends on coach, roster, opponent, build,
bring, pilot, schedule, and prior results, while game outcomes also contain RNG.
They can motivate a hypothesis about usage, never estimate an asset's causal
impact or quality. Named Kimi patterns in the legacy archive have the same
confounds and are neither capability nor rank evidence. A legacy short
`modelKey` can group multiple provider/model identifiers; provider aliases and
archive keys do not establish a frozen treatment, served revision, scaffold, or
sampling condition.

## Counterfactual decision rules

A position is eligible only when its source game replays exactly from the
recorded seed, teams, actions, format, and Showdown revision. Record the value
function, horizon, continuation policy, opponent-action distribution, search,
random seeds, sample counts, selection/measurement estimates, and uncertainty.
Never mix values from different references.

The current prototype uses material differential, uniform Showdown-accepted
request-derived candidate opponent actions, uniform-random continuations, and
bounded Monte Carlo rollouts. Call
its output **reference-relative opportunity loss** (or attach the reference to
“regret”). It is short-horizon and evaluates the realized hidden state, including
information the acting seat may not have known. An ex-ante claim must average a
published prior over compatible hidden states or retain positions robust across
those states.

Every Showdown-accepted action produced by the frozen request-menu candidate
protocol uses common random draws within a panel. Native `Side.choose` filtering
removes false positives; the generator does not claim coverage of every custom
Showdown mechanic, and its declared omissions remain part of the protocol. Two
independent qualification panels determine eligibility under a policy calibrated
outside the candidate corpus; an untouched measurement panel supplies rewards. A row
admitted by qualification but missing a usable measurement panel fails the
candidate build. Do not select or remove rows using measurement values, call a
noisy maximum the true best, or silently clamp an independent reversal.

A normalized value requires a reliable opportunity span. Qualification
thresholds and corpus-balance requirements must be calibrated outside the
candidate corpus, not chosen by exporter discretion. The
[evaluation plan](evaluation-plan.md) lists the remaining validation gates.

## Controlled position sets and artifacts

Every compared model receives the same anonymized prompt renderer, numbered
action encoding, tools, sampling policy, and scoring reference. Selection is
seeded, stratified by phase/state, and capped per source game. Source-series and
near-duplicate groups cannot cross calibration, candidate, and held-out corpora. The first source is
VGCML-generated play, not representative human VGC without an external holdout
and coverage argument. Record the generating models for every position: a model
evaluated on positions arising from its own play holds a distribution
advantage, so cross-model comparison prefers leave-own-games-out splits.
Report accuracy as a function of the measured opportunity span alongside any
scalar mean; below the provider sampling noise floor, model disagreement on
near-tied positions is not evidence.

A public task contains the tested seat's public history, own request, and legal
actions. It excludes source identity/action/rationale/notebook, opponent-private
requests, and simulator snapshots. The original league scaffold is provenance,
not inherited context.

Public tasks use one immutable public root. Private score tables and sealed
snapshots/matrices share one physically separate immutable private root.
Model/browser loaders accept only public artifacts and only with a verified
complete manifest. Candidate artifacts are not released until every release gate
passes.

## Cross-stage evidence

Temporal adjacency is not causality. A submitted action is not an accepted
transition; join seat logs to referee evidence for legality, repair,
substitution, or outcome claims. Deterministic mechanical measures include:

- drafted-to-built and built-to-brought membership;
- declared versus submitted bring;
- whether a named canonical move or interaction occurred;
- legality, repair, and substitution rates.

Mechanical links and audited semantic statement consistency are separate
evidence products. Semantic analysis requires a written observable rubric,
identity-stripped traces, multiple blinded labels, agreement estimates, and
periodic human audit. Human- or LLM-produced labels are diagnostic only and
never affect task inclusion, legality, action acceptance, seat context, reward,
`Env.finalize`, or training. Report not-applicable separately and divide rates
by eligible opportunities. Requiring a rationale changes the task, so compare
only runs with the same requirement.

A notebook handoff is a mechanical receipt: exact retained bytes appeared in a
later authorized prompt. A reflection trace adds a generated statement. Neither
shows that the model used the note, changed behavior because of it, or benefited.
Causal transfer requires a versioned intervention (for example, crossed
retained/replaced/withheld notebook conditions), a preregistered later-action
contrast, fixed downstream controllers/common draws where applicable, and an
artifact that binds the complete reflection-to-prompt-to-action chain. A
terminal season review has no later action in the current season and therefore
cannot demonstrate learning or transfer.

Recorded human choices are reference actions, not answer keys. Analyze action
agreement separately from the paired reference-value difference between the
human and model actions on the identical frozen action-value matrix. Use the
already canonical term **reference-relative opportunity loss** for the
value-derived loss; do not introduce a new `R`-relative term. Join event outcomes
only after position selection and scoring are frozen. Outcomes are context, not
optimality evidence.

When recreating a real event, preserve its rules and data vintage and disclose
deviations. Open team sheets, for example, do not reveal hidden stat points; a
reconstruction must state where exact spreads came from.

### Long-horizon claims

Keep three claims distinct:

1. **Episode linkage** establishes replay and join completeness. It does not by
   itself establish behavioral adaptation or benefit.
2. **Behavioral responsiveness or adaptation** requires a randomized or
   counterbalanced condition assignment, or a disclosed observational context,
   plus a preregistered action contrast.
3. **Beneficial or causal anticipation** requires a crossed intervention or fork
   over the future condition and the upstream choice or policy, with fixed
   downstream controllers and common draws. It also requires placebo and
   cross-phase controls, uncertainty clustered by whole-circuit block, and
   replication across circuit blocks.

An endogenous model choice × condition association is not causal. Changes to a
public schedule may create whole-circuit interference. Wins, standings, and plan
prose are insufficient for any of these stronger claims. A backup Mega is only
an example of a preregistered diagnostic motif, not required behavior or evidence
by itself.

Drafting against scarce resources and scheduled future opponents is genuine
planning *within this VGC environment*; it need not be renamed an engineering or
software task to count as planning behavior. Episode linkage can make that plan
inspectable. Whether the behavior transfers to software work, tool-agent tasks,
open-ended construction, or other real-world domains is a separate external
validity question requiring matched studies in those domains. Similarity to an
external benchmark or paper is motivation, never transfer evidence.
