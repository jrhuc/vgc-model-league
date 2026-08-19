# Related work

This document defines the contribution boundary and lists components that the
project can reuse. The public comparison set includes only the papers,
repositories, and services named and linked here. The set was reviewed in
August 2026. Statements such as “we did not identify” and “to our knowledge”
apply only to this dated set. The
[Evaluation plan](evaluation-plan.md#program-status) is the only source for
implementation and release status.

## Pokémon battle environments and benchmarks

| Work | Existing capability | Use in this project |
| --- | --- | --- |
| [poke-env](https://github.com/hsahovic/poke-env) | Showdown client, battle abstractions, teambuilding support, baseline players, and PettingZoo environments | Use its agents externally as baselines instead of porting its client or heuristics. |
| [VGC-Bench](https://arxiv.org/abs/2506.10326) ([code](https://github.com/cameronangliss/VGC-Bench)) | VGC team preview and battle action spaces, heuristic, LLM, behavioral-cloning, and multi-agent reinforcement-learning policies, cross-play, population analysis, trained exploiters, and a large OTS log corpus | Reuse compatible policies, logs, and population methods. The position task adds controlled local diagnostics that link to upstream commitments. |
| [PokéAgent Challenge](https://arxiv.org/abs/2603.15563) ([arena](https://pokeagentchallenge.com/battling.html)) | Standardized Pokémon arena, VGC support, human and self-play trajectories, teams, ratings, and trained policies | Use released agents and data for strength and scaffold comparisons instead of creating another general arena. |
| [PokéChamp](https://arxiv.org/abs/2503.04094) | LLM battle agent, human action prediction, constrained battle puzzles, and lookahead and minimax evaluation | Provides prior work for Pokémon decision-level evaluation. Compare task construction and exact-action agreement. |
| [PokéLLMon](https://arxiv.org/abs/2402.01118) | LLM battle agent with external knowledge and in-context learning | Use as a scaffold comparison, not as a component to reproduce. |
| [Ihara et al. 2018](https://doi.org/10.1109/SMC.2018.00375) | Pokémon simulator with information-set Monte Carlo tree search and rollout values for root actions | Provides prior work for simulator action search and supports sampling hidden states that are consistent with the player's information. |

poke-env and VGC-Bench provide battle clients, policies, previews, and analysis.
Neither provides the complete protocol evaluated here: a contested multi-agent
draft league that links roster construction, bring, lead, and battle decisions
within one episode. This statement defines a reuse and comparison boundary, not
a priority claim.

The league imports the Pokémon Showdown simulator directly. Showdown remains
authoritative, and `Battle.toJSON/fromJSON` provides matched restorable forks.
This implementation choice does not imply that client-based projects cannot add
equivalent state access.

## Cross-stage Pokémon systems

Prior work also covers stages before battle:

- At the pinned revision, Pokémon Showdown
  [formats](https://github.com/smogon/pokemon-showdown/blob/84d7ceb4f009928221fce7a00e711bab263c5f4e/config/formats.ts)
  include Champions Draft legality formats and VGC team preview and best-of-three
  play.
  [BestOfGame](https://github.com/smogon/pokemon-showdown/blob/84d7ceb4f009928221fce7a00e711bab263c5f4e/server/room-battle-bestof.ts)
  manages games in a set and the between-game readiness interval. These formats
  do not provide persistent exclusive budget roster allocation, trades, or
  roster-bound construction.
- In August 2026, the public [DraftDex](https://draftdex.net/) site described
  shared drafts and budgets, transactions, matchup planning, results, standings,
  playoffs, and replay links. Its [terms](https://draftdex.net/terms) state that
  it does not host or simulate gameplay.
- The [VGC AI Competition framework](https://doi.org/10.1109/CoG52621.2021.9618985)
  ([code](https://gitlab.com/DracoStriker/pokemon-vgc-engine)) links simplified
  team selection and construction to battle. Its
  [follow-on work](https://doi.org/10.1109/TG.2023.3273157) studies automated
  team construction. This construction-to-battle combination is prior work.
- [*A Multi-Agent Pokemon Tournament for Evaluating Strategic Reasoning of
  Large Language Models*](https://arxiv.org/abs/2508.01623), also called LLM
  Pokémon League, has each agent independently select six Pokémon from the same
  curated pool, provide a rationale, and battle in a simplified
  single-elimination bracket. It does not use an exclusive, persistent Showdown
  VGC circuit.

Within the named public comparison set reviewed in August 2026, we did not
identify an environment that combines all of these features:

- a contested, exclusive, budget-limited draft to ten;
- public later-opponent and playoff context;
- matchup-specific construction of six from ten;
- same-six, seeded Reg M-B best-of-three play with new bring and lead choices
  before each game;
- authorized between-game context; and
- a regular season followed by playoffs for qualified seats.

Optional transactions can extend this protocol but are not required for this
comparison. The comparison is bounded by the named set and is not an exhaustive
priority claim.

Showdown authoritatively determines only later actions that it accepts. It does
not authorize the supplied context. Keep mechanical roster-membership and
accepted-transition joins separate from audited semantic plan fidelity.
Compatible external systems provide baseline candidates.

## Drafting, seasons, and negotiation outside Pokémon

Prior work on sequential multi-agent resource allocation includes:

- [Ward et al.](https://arxiv.org/abs/2009.00655), which releases 100,000 Magic:
  The Gathering drafts and drafting baselines, and
  [UrzaGPT](https://arxiv.org/abs/2508.08382), which evaluates language models on
  Magic draft picks;
- [FantasyFootballBench](https://github.com/aryatschand/FantasyFootballBench),
  which runs a multi-agent snake draft, lineups, trade negotiations, and season
  outcomes with rationales; and
- [NegotiationArena](https://arxiv.org/abs/2402.05863),
  [MultiAgentBench](https://arxiv.org/abs/2503.01935), and
  [Cattle Trade](https://arxiv.org/abs/2605.14537), which cover negotiation,
  auctions, resource allocation, private state, public offers, and long
  multi-agent trajectories.

Use these projects as protocol and baseline references for draft and trade
behavior. This project's contribution depends on linking those choices to later
teams and simulator outcomes. It does not claim drafting or negotiation as new.

## Multi-agent arena methodology

[Olam Labs' Social Arena methodology](https://olamlabs.ai/research/social-arena)
provides a systems reference for a similar circuit in a different game domain.
It gives each anonymized seat one continuous sandboxed session, routes human and
agent actions through the same environment primitives, records accepted actions
and resulting states in an append-only log, and requires replayable, forkable,
and programmatically legible state. It also distinguishes a generic shared
harness from model-native harnesses instead of treating them as the same
scaffold.

Apply these requirements to `vgc-circuit-v1`:

- use generic opponent names;
- expose an authorized seat API to both human and agent clients;
- provide logical seat-private context with explicit session and attempt
  lifecycles;
- record harness identity;
- isolate sandboxes; and
- make state forkable.

Logical continuity does not require one persistent provider process. Olam's
outcome rating uses large randomized populations and substantial sample sizes,
so it does not support ranking models from a small VGC season. Its
transcript-based behavioral scores use separate methodology. An analogous trade
or plan-fidelity measure here requires a preregistered rubric, identity-stripped
traces, multiple audited graders, and reported grader variance.

## Long-horizon agents, memory, and external validity

The interface cites the following papers for specific methodological questions.
Do not generalize their task-specific results into broad capability or transfer
claims.

| Work | Scope used in this project |
| --- | --- |
| [*Measuring AI Ability to Complete Long Software Tasks*](https://arxiv.org/abs/2503.14499) | Estimates a software-task time horizon from success rates and explicitly discusses external-validity limits. It does not show that VGC season planning transfers to software work. |
| [*$\tau$-bench: A Benchmark for Tool-Agent-User Interaction in Real-World Domains*](https://arxiv.org/abs/2406.12045) | Evaluates policy-constrained tool use in simulated airline and retail domains and reports repeated-trial reliability with `pass^k`. It provides a consistency method, not a VGC baseline. |
| [*ReAct: Synergizing Reasoning and Acting in Language Models*](https://arxiv.org/abs/2210.03629) | Studies interleaved language reasoning and environment actions on the paper's knowledge and interactive decision tasks. It supports only the use of traceable action and observation loops here. |
| [*MemGPT: Towards LLMs as Operating Systems*](https://arxiv.org/abs/2310.08560) | Proposes virtual-context management for limited context windows. It supports explicit memory treatment, not an assumption that a notebook was used. |
| [*Reflexion: Language Agents with Verbal Reinforcement Learning*](https://arxiv.org/abs/2303.11366) | Reports linguistic feedback and episodic-memory interventions on the paper's agent tasks. It supports a versioned reflection ablation but does not make an observed VGC reflection causal. |
| [*Large Language Models Cannot Self-Correct Reasoning Yet*](https://arxiv.org/abs/2310.01798) | Tests intrinsic self-correction without external feedback on the paper's reasoning tasks. Its negative results support direct checks rather than a universal impossibility claim. |
| [*BALROG: Benchmarking Agentic LLM and VLM Reasoning On Games*](https://arxiv.org/abs/2411.13543) | Benchmarks agents across games that require exploration, spatial reasoning, and longer-horizon reasoning. It provides an external comparison domain, not evidence of a shared latent ability. |
| [*Factorio Learning Environment*](https://arxiv.org/abs/2503.09617) | Provides open-ended Factorio tasks for long-term planning, program synthesis, and resource optimization. Similar planning terminology does not establish transfer to or from a contested VGC draft. |
| [*SWE-bench: Can Language Models Resolve Real-World GitHub Issues?*](https://arxiv.org/abs/2310.06770) | Builds repository-level software tasks from real GitHub issues. It is a separate external-validity target, not a proxy for VGC planning. |

A scarce draft against known future opponents is an in-environment planning
task. The linked season can test whether later VGC choices are consistent with
the plan. Generalization to any domain in the table requires a separate matched
evaluation. These papers inform controls and trace questions, not transfer
inferences in either direction.

## Infrastructure

[Prime Intellect verifiers](https://github.com/PrimeIntellect-ai/verifiers)
provides tasksets, harnesses, runtimes, traces, judges, multi-agent `Env` control
flow, evaluation, and `prime-rl` integration. The project adopts this
infrastructure and does not claim it as a contribution.
[Architecture](architecture.md) defines the component boundary.

LangChain's [*Towards Automating Eval
Engineering*](https://www.langchain.com/blog/towards-automating-eval-engineering)
describes human trace review and the promotion of observed failure modes into
controlled tasks. Those review steps inform this project's trace-analysis
method.

## Contribution claim

The contribution claim covers only validated integration of persistent league
state with the battle protocol and linked upstream and downstream evidence. The
protocol includes a contested exclusive budget draft, optional transactions,
legal VGC construction, bring and lead choices, played regular-season matches,
playoffs for qualified seats, and auditable links from plans to execution.

The static position package is the controlled native evaluation artifact. It
does not claim to invent battle environments or simulator action values.

The project does not claim these individual components as new: Pokémon agents,
doubles multi-agent play, draft formats or mechanisms, construction, team
preview, best-of-three play, negotiation, simulator search, reasoning logs,
ratings, league management, or multi-agent reinforcement-learning
infrastructure. Compatible baselines and battle artifacts support comparisons
with poke-env, VGC-Bench, and the other prior work listed above. The project
makes no priority claim over those projects.
