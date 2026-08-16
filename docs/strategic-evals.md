# Strategic evaluation kernel

This document defines the replacement evaluation direction. The Pokémon harness
and pinned Showdown simulator remain the domain authority. Whole leagues remain
an ecological arena and source of cases; they are not the primary unit of
measurement.

## Research target

The strategic suite asks whether a model's upstream information, commitments,
and memory causally improve later VGC utility under matched simulator forks.
The intended products are:

1. **Information-set choices:** evaluate actions over a declared distribution of
   hidden states and reference policies, in absolute game or series utility.
2. **Best-of-three adaptation:** cross authentic, withheld, stale, false,
   placebo, and oracle notebook conditions at the same later decision.
3. **Draft option value:** replace a focal pick, transaction, or construction
   while downstream controllers, schedules, and random draws remain fixed.
4. **Stage decomposition:** substitute draft, construction, preview, and battle
   controllers independently to locate where integrated value is created or
   lost.
5. **Circuit arena:** use complete leagues only after controlled shards have
   established the capability and failure mode being tested.

A benchmark release must add held-out insight beyond ordinary battle win rate,
invalid-output rate, cost, and model identity. Otherwise retain the harness and
do not publish the evaluation layer.

## Implemented kernel

The first refactor slice is framework-agnostic TypeScript under `src/eval/`.

### Replay and forks

`experiment-kernel.ts` records accepted decisions as canonical events with
pre-state and post-state digests. It replays the complete event chain before a
checkpoint is accepted. A fork replays the prefix, replaces one action, and
intentionally drops the endogenous suffix. Later code must regenerate that
suffix with declared controllers rather than pretending old downstream actions
remain valid.

### Controller identity

`controllers.ts` binds every stage controller to an ID, kind, revision, and
configuration digest. `fork-plan.ts` rejects a matched experiment when an arm
changes an undeclared controller. This prevents a notebook, schedule, or draft
intervention from silently changing the builder or battle policy.

### Information sets and references

`information-set.ts` represents a published weighted support over hidden states
compatible with the model-visible information. It creates deterministic common
draw plans for all candidate actions.

`reference-runner.ts` evaluates every action on the complete arm-by-draw
rectangle and rejects the table when any cell fails. `reference-suite.ts`
aggregates declared opponent and continuation policies without creating a
single hidden answer key. It reports:

- expected utility in the declared game or series unit;
- lower-tail robust utility;
- absolute expected and robust regret;
- worst-reference regret;
- reference disagreement and best-action weight; and
- cluster-level uncertainty for each arm.

Per-position min-max normalization is not part of this contract.

### Model-facing tasks

`strategic-task.ts` assigns stable opaque action IDs and independently shuffles
the display order. It supports an action-only arm and explicit forecast arms.
Invalid output is returned as a separate endpoint; no implicit fallback utility
or `-1` strategic score is assigned.

Forecast fields are mechanically scored with proper scoring rules and cannot
increase action utility.

### Best-of-three memory interventions

`bo3-adaptation.ts` binds exact treatment bytes and analyzes matched later
outcomes. Authentic-memory lift, stale-memory effect, false-memory harm,
placebo effect, oracle lift, protocol validity, legality, and belief calibration
remain separate outputs.

The current module is the measurement and artifact contract. The next slice
must connect it to replayed `FrozenMatchdayReferee` cases so every treatment
shares the public history, hidden-state draw, opponent controller, battle RNG,
and continuation controller.

## Required experiment shape

Every causal shard must bind:

- one decision node and its authorized public and private state digests;
- all replacement actions or information treatments;
- exact downstream controller identities;
- common hidden-state, opponent-policy, battle, continuation, and schedule
  draws;
- one explicit utility unit;
- protocol validity and legality apart from utility; and
- a cluster ID at the source case or whole-circuit block level.

Changing a prompt, renderer, tool protocol, memory policy, controller, hidden
state prior, reference policy, or utility creates a new condition identity.

## Migration sequence

### Matchday adapter

Add a replay adapter that reconstructs a frozen matchday to a declared
between-game or battle decision, applies a notebook treatment, and continues
with fixed controllers on common draws. The adapter must emit the generic event
and fork artifacts rather than inventing a second scoring schema.

### Information-set battle scorer

Refactor `counterfactual.ts` behind the reference-runner interface. Preserve the
existing native Showdown acceptance filter and common-random-number matrices,
but replace the realized-state, uniform-random, material-only singleton
reference with versioned arms. Keep the old reference available only as a
named diagnostic arm.

### Circuit event adapter

Project draft, construction, transaction, preview, battle, and notebook
receipts into canonical decision events. Add `replayTo`, verified checkpoints,
and `fork` over the circuit state machine. The full circuit environment should
record one seat-level episode result, not repeat one delayed reward on every
one-turn decision trace.

### Strategic shard environment

Create a separate native environment for attributable decision nodes and short
intervention chains. Training should target these shards. The existing circuit
environment remains evaluation-only until the outer framework can represent
episode results without assigning the same return to every local action.

### Draft and stage-decomposition shards

Start from partial drafts and fixed downstream controller populations. Cross
schedule visibility, schedule perturbation, builder substitution, battle-policy
substitution, and retained-plan conditions before returning to complete
31-series leagues.

## Release gates

Do not publish a model ranking until all of the following pass:

1. exact replay and fork reproduction;
2. controller parity and common-draw checks;
3. known-intervention validity for authentic, false, irrelevant, and oracle
   information;
4. action-order and equivalent-rendering invariance;
5. sensitivity reporting across hidden-state priors, policies, horizons, and
   utility functions;
6. random, heuristic, search or RL, and blinded expert criterion checks;
7. event, team, source-policy, scaffold, and model-family holdouts;
8. uncertainty clustered by the true intervention unit; and
9. demonstrated held-out incremental value beyond the unmodified Pokémon
   harness.
