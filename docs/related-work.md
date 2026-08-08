# Related work

This page scopes the contribution and identifies components to reuse. Its public
comparison set is the papers, repositories, and services named and linked below,
reviewed in August 2026. “We did not identify” and “to our knowledge” claims are
limited to that dated set.

## Pokémon battle environments and benchmarks

| Work | Existing capability | Relevance here |
| --- | --- | --- |
| [poke-env](https://github.com/hsahovic/poke-env) | Showdown client, battle abstractions, teambuilding support, baseline players, PettingZoo environments | Reuse its agents externally as baselines rather than porting its client or heuristics. |
| [VGC-Bench](https://arxiv.org/abs/2506.10326) ([code](https://github.com/cameronangliss/VGC-Bench)) | VGC team preview and battle action spaces, heuristic/LLM/BC/MARL policies, cross-play, population analysis, trained exploiters, and a large OTS log corpus | Reuse compatible policies, logs, and population methods. The position task complements this battle benchmark with controlled local diagnostics linked to upstream commitments. |
| [PokéAgent Challenge](https://arxiv.org/abs/2603.15563) ([arena](https://pokeagentchallenge.com/battling.html)) | Standardized Pokémon arena, VGC support, human and self-play trajectories, teams, ratings, and trained policies | Use released agents and data as strength and scaffold comparisons rather than creating another general arena. |
| [PokéChamp](https://arxiv.org/abs/2503.04094) | LLM battle agent, human action prediction, constrained battle puzzles, and lookahead/minimax evaluation | Establishes Pokémon decision-level evaluation as prior art. Compare task construction and exact-action agreement. |
| [PokéLLMon](https://arxiv.org/abs/2402.01118) | LLM battle agent with external knowledge and in-context learning | A scaffold comparison, not a component to reproduce. |
| [Ihara et al. 2018](https://doi.org/10.1109/SMC.2018.00375) | Pokémon simulator with information-set Monte Carlo tree search and rollout values for root actions | Establishes simulator action search as prior art and motivates sampling hidden states consistent with the player's information. |

poke-env and VGC-Bench cover battle-facing clients, policies, preview, and
analysis. Neither implements the combined research circuit targeted here: a
contested multi-agent draft league whose roster construction, bring, lead, and
battle decisions remain linked as one episode. This is a complement and reuse
boundary, not a priority claim.

The league imports Pokémon Showdown's simulator directly, so Showdown remains
authoritative and `Battle.toJSON/fromJSON` can produce matched restorable forks.
That is an implementation boundary, not a claim that client-based projects could
not add equivalent state access.

A proposed official-event control pipeline would preserve source provenance and
rights, use two independent annotations of public Top 8 broadcasts with
missingness, distinguish `public-transition-reproduced` from
`counterfactual-fork eligible`, and freeze identity-stripped tasks before
outcome joins. Source actions and consented human entrants would remain
contextual controls; [Human controls](human-controls.md) specifies the planned
admission and release gates.

## Cross-stage Pokémon systems

The stages above battle are also not empty prior art.

- At the pinned revision, Pokémon Showdown's
  [formats](https://github.com/smogon/pokemon-showdown/blob/6a1836dd71c0718e923206f3d089e61074410868/config/formats.ts)
  include Champions Draft legality formats and VGC team preview/Bo3;
  [BestOfGame](https://github.com/smogon/pokemon-showdown/blob/6a1836dd71c0718e923206f3d089e61074410868/server/room-battle-bestof.ts)
  manages the set's games and between-game readiness interval. Those formats do
  not provide persistent exclusive budget roster allocation, trades, or
  roster-bound construction.
- As reviewed in August 2026, [DraftDex](https://draftdex.net/)'s public site
  described shared drafts and budgets, transactions, matchup planning, results,
  standings, playoffs, and replay links. Its
  [terms](https://draftdex.net/terms) state that it does not host or simulate
  gameplay.
- The [VGC AI Competition framework](https://doi.org/10.1109/CoG52621.2021.9618985)
  ([code](https://gitlab.com/DracoStriker/pokemon-vgc-engine)) connects simplified
  team selection and construction to battle. Its
  [follow-on work](https://doi.org/10.1109/TG.2023.3273157) studies automated team
  construction; that construction-to-battle combination is prior art.
- [*A Multi-Agent Pokemon Tournament for Evaluating Strategic Reasoning of
  Large Language Models*](https://arxiv.org/abs/2508.01623) (LLM Pokémon League):
  each agent independently selects six Pokémon from the same curated pool and
  provides a rationale before battling in a simplified single-elimination
  bracket. It is not an exclusive, persistent Showdown VGC circuit.

In that August 2026 named public comparison set, we did not identify an
environment combining the intended circuit's contested exclusive budget draft
to ten; public later-opponent and playoff context; matchup-specific six-from-ten
construction; same-six, seeded Reg M-B Bo3 play with fresh bring and lead choices
before each game; authorized between-game context; and a regular season followed
by playoffs for qualified seats. Optional transactions may be included, but are
not required to distinguish the first slice. This is a bounded comparison, not
an exhaustive priority claim.

Only later actions accepted by Showdown would be simulator-authoritative; the
context itself would not be. Mechanical roster-membership and accepted-transition
joins are distinct from audited semantic plan fidelity. The current battle layer
uses Showdown, while compatible external baselines are planned. The connected
circuit remains an intended target, not current behavior; see [program
status](evaluation-plan.md#program-status).

## Standalone construction ablation

`vgc-whole-reg-build-v0` is an internal ablation, not a novelty or benchmark
claim. Automated team construction is prior art; the arm is useful because it
removes drafting while exercising the same `TeamBuildTask`, `StageEvidence`,
Showdown, preview-controller, battle-controller, and evidence path needed by the
planned connected circuit. It adds no separate reflection scaffold.

Public teams may be memorized. Any human-build comparison would require licensed
exact packs with provenance and would be a descriptive contextual control, not
an optimality threshold; an official stream that omits exact spreads is
evidence of a team concept, not an exact pack. Until frozen disjoint opponent
and human suites and the complete controller cross-product exist, the
arm supports only vertical-slice engineering, not a public Reg M-B comparison or
ranking.

## Drafting, seasons, and negotiation outside Pokémon

Sequential multi-agent resource allocation is well studied.

- [Ward et al.](https://arxiv.org/abs/2009.00655) release 100,000 Magic: The
  Gathering drafts and drafting baselines;
  [UrzaGPT](https://arxiv.org/abs/2508.08382) evaluates language models on Magic
  draft picks.
- [FantasyFootballBench](https://github.com/aryatschand/FantasyFootballBench)
  runs a multi-agent snake draft, lineups, trade negotiations, and season
  outcomes with rationales.
- [NegotiationArena](https://arxiv.org/abs/2402.05863),
  [MultiAgentBench](https://arxiv.org/abs/2503.01935), and
  [Cattle Trade](https://arxiv.org/abs/2605.14537) cover negotiation, auctions,
  resource allocation, private state, public offers, and long multi-agent
  trajectories.

These are protocol and baseline references for draft/trade behaviour. The
Pokémon contribution must come from connecting those choices to later teams and
simulator outcomes, not from calling drafting or negotiation itself new.

## Multi-agent arena methodology

[Olam Labs' Social Arena methodology](https://olamlabs.ai/research/social-arena)
is a close systems reference for the eventual circuit in a different game
domain. It gives each anonymized seat one continuous sandboxed session, routes
human and agent actions through the same environment primitives, records accepted
actions and resulting states append-only, and treats replayability, forkability,
and programmatic legibility as design requirements. It also distinguishes a
generic shared harness from model-native harnesses rather than silently treating
them as one scaffold.

Those are useful requirements here: generic opponent names, an authorized seat
API shared by human and agent clients, logical seat-private context with explicit
session and attempt lifecycle, harness identity, sandbox isolation, and forkable
state should be properties of `vgc-draft-circuit-v1`. Logical continuity need not
be one persistent provider process. Olam's outcome rating depends on large
randomized populations and substantial sample sizes; it does not justify turning
a small VGC season into a ranking. Its transcript-based behavioral scores are
separate methodology: any analogous trade or plan-fidelity measure here would
need a preregistered rubric, identity-stripped traces, multiple audited graders,
and reported grader variance.

## Infrastructure

[Prime Intellect verifiers](https://github.com/PrimeIntellect-ai/verifiers)
provides tasksets, harnesses, runtimes, traces, judges, multi-agent `Env` control
flow, evaluation, and `prime-rl` integration. Its native package is the planned
controlled evaluation path for the static positions and later circuit; the local
league remains trajectory generation and inspection. This infrastructure is
adopted, not claimed as a repository contribution. Native Prime/verifiers is the
target stack; Harbor and NeMo packaging is outside this plan.

LangChain’s [*Towards Automating Eval
Engineering*](https://www.langchain.com/blog/towards-automating-eval-engineering)
describes human review of traces and promotion of observed failure modes into
controlled tasks. Planned VGC analysis applies those steps to native
Prime/verifiers artifacts.

## Claim boundary

The intended contribution, once implemented and validated, is persistent
league-state-to-battle protocol integration and linked upstream/downstream
evidence: a contested exclusive budget draft and optional transactions carried
through legal VGC construction, bring, lead, played regular-season matches,
playoffs for qualified seats, and auditable plan-to-execution links. The static
position package is its controlled native evaluation artifact, not a claim to
invent battle environments or simulator action values. This is a target claim,
not a claim about the current branch.

The narrower pieces are not claimed as novel: Pokémon agents, doubles
multi-agent play, draft formats or mechanisms, construction, team preview, Bo3,
negotiation, simulator search, reasoning logs, ratings, league management, or
multi-agent RL infrastructure. The planned circuit is intended to complement
poke-env, VGC-Bench, and the other prior work above through compatible baselines
and battle artifacts. The circuit is not implemented and makes no priority claim
over those projects.
