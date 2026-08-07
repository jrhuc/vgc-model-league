# Related work

This page scopes the contribution and identifies components to reuse. It was
reviewed against the linked papers and repositories in August 2026. “To our
knowledge” claims are limited to this comparison set.

## Pokémon battle environments and benchmarks

| Work | Existing capability | Relevance here |
| --- | --- | --- |
| [poke-env](https://github.com/hsahovic/poke-env) | Showdown client, battle abstractions, teambuilding support, baseline players, PettingZoo environments | Run its agents externally as baselines. Do not port its client or heuristics into this repository. |
| [VGC-Bench](https://arxiv.org/abs/2506.10326) ([code](https://github.com/cameronangliss/VGC-Bench)) | VGC team preview and battle action spaces, heuristic/LLM/BC/MARL policies, cross-play, population analysis, trained exploiters, and a large OTS log corpus | Reuse compatible policies, logs, and population methods. The distinct task here is a frozen local action-value diagnostic linked to earlier draft stages. |
| [PokéAgent Challenge](https://arxiv.org/abs/2603.15563) ([arena](https://pokeagentchallenge.com/battling.html)) | Standardized Pokémon arena, VGC support, human and self-play trajectories, teams, ratings, and trained policies | Use released agents and data as strength and scaffold comparisons rather than creating another general arena. |
| [PokéChamp](https://arxiv.org/abs/2503.04094) | LLM battle agent, human action prediction, constrained battle puzzles, and lookahead/minimax evaluation | Establishes Pokémon decision-level evaluation as prior art. Compare task construction and exact-action agreement. |
| [PokéLLMon](https://arxiv.org/abs/2402.01118) | LLM battle agent with external knowledge and in-context learning | A scaffold comparison, not a component to reproduce. |
| [Ihara et al. 2018](https://doi.org/10.1109/SMC.2018.00375) | Pokémon simulator with information-set Monte Carlo tree search and rollout values for root actions | Establishes simulator action search as prior art and motivates sampling hidden states consistent with the player's information. |

A Showdown client does not normally own an authoritative restorable battle
state. This repository already does, using `Battle.toJSON/fromJSON`, which makes
matched forks practical. That is an implementation advantage, not a claim that
another project could never add a simulator.

## Cross-stage Pokémon systems

The stages above battle are also not empty prior art.

- The [VGC AI Competition framework](https://doi.org/10.1109/CoG52621.2021.9618985)
  ([code](https://gitlab.com/DracoStriker/pokemon-vgc-engine)) connects team
  selection, team construction, battle, and metagame balance in a simplified
  Pokémon engine. Its
  [follow-on work](https://doi.org/10.1109/TG.2023.3273157) studies automated team
  construction.
- [A Multi-Agent Pokémon Tournament for Evaluating Strategic Reasoning of
  LLMs](https://arxiv.org/abs/2508.01623) asks models to select teams from a
  shared pool, explain choices, battle in a simplified singles simulator, and
  analyzes reasoning/action alignment. Its pool is not an exclusive budgeted
  draft, but team-selection-to-battle LLM evaluation is prior art.

The remaining distinction is the exact protocol combination: a contested public
budgeted draft and trade season, legal VGC doubles construction and preview,
restorable Showdown states, and explicit links from plans to later actions.

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
API shared by human and agent clients, continuous seat-private context, explicit
harness descriptors, sandbox isolation, and forkable state should be properties
of `vgc-draft-circuit-v1`. Olam's outcome rating depends on large randomized
populations and substantial sample sizes; it does not justify turning a small VGC
season into a ranking. Its transcript-based behavioral scores are also separate
methodology: any analogous trade or plan-fidelity measure here would need a
preregistered rubric, identity-stripped traces, multiple audited graders, and
reported grader variance.

## Infrastructure

[Prime Intellect verifiers](https://github.com/PrimeIntellect-ai/verifiers)
provides tasksets, harnesses, runtimes, traces, judges, multi-agent `Env` control
flow, evaluation, and `prime-rl` integration. Those are infrastructure to adopt,
not repository contributions. Harbor and NeMo adapters are added only if a real
consumer cannot use the native verifiers package.

## Claim boundary

The intended contribution, once the package and circuit are implemented and
validated, is a public protocol connecting a shared, budgeted multi-agent Pokémon
draft and trade season to exact restorable VGC doubles positions. It would test
the same endpoint and weights, without task-specific training or added search,
under both a declared simulator reference and explicit plan-to-execution links.
This is a target claim, not a claim about the current branch.

The narrower pieces are not claimed as novel: Pokémon agents, doubles
multi-agent play, teambuilding, team preview, simulator search, draft mechanisms,
negotiation, reasoning logs, ratings, or multi-agent RL infrastructure.
