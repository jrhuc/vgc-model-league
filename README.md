# VGC Model League

VGC Model League measures **how a language model decides**, using Pokémon Video
Game Championships as the substrate. Models draft rosters against each other,
build teams, negotiate trades, play full best-of-three matches on
[Pokémon Showdown](https://github.com/smogon/pokemon-showdown), and account for
the results afterwards.

The project does not train models and adds no search policy. Every seat gets the
same interface and the same reference tools.

## What is actually measured

Not who wins. Win rate is one bit per series, a critical hit can flip it, and it
is the easiest thing here for anyone else to reproduce. Three things are measured
instead, and none of them depend on which Pokémon are legal this season.

**Per-decision regret.** The simulator runs in process, so any position can be
forked and the alternatives searched. A choice is graded against what the other
legal choices were worth under a declared reference, rather than against the
outcome of the game it happened to be in. Regret is normalised per position
(`share = regret / spread`) because raw regret correlates with which side was
already ahead — decided positions simply have more on offer.

**Commitment fidelity.** One season makes the same model decide at five
altitudes that form a causal chain: draft a Pokémon with a stated rationale →
select six of ten → trade → bring four of six and play them → explain the result.
Each arrow is checkable against the log. A seat that drafts an archetype and
never executes it, or explains a loss in terms the replay contradicts, fails a
commitment edge — and both have already been observed.

**Self-consistency.** Every seat's private reasoning is recorded alongside its
public messages, so a trade offer's stated justification can be compared against
the reasoning that produced it. Ground truth and claim come from the same model at
the same moment, so this needs no controlled matchup at all.

Standings, Elo and win rates are recorded and shown as description. They are not
the result and no ranking claim is made from them.

## Relation to prior work

**This is not a Pokémon-playing agent, and "two agents play VGC" is prior art.**

[poke-env](https://github.com/hsahovic/poke-env) already provides a gen-9 damage
calculator, doubles battle state, a teambuilder, heuristic baselines, and a
PettingZoo environment for doubles. Parts of this repository's simulator glue
duplicate it. The one structural difference matters: poke-env is a Showdown
*client* that reconstructs battle state from the protocol stream, so it observes
a battle the server owns and cannot fork one. This repository embeds
[`@pkmn/sim`](https://github.com/pkmn/ps) in process and owns the battle object,
which is what makes per-decision counterfactual regret computable at all.

[VGC-Bench](https://arxiv.org/abs/2506.10326) trains policy networks — behaviour
cloning over 700k scraped logs, then self-play, fictitious play and double oracle
— and evaluates them with cross-play win-rate matrices and a generalisation test
against unseen teams. Its subject is the training algorithm; its LLM baseline is
an 8B model over 20 battles. Our subject is the language model, our unit is the
decision rather than the match, and the draft, trade and reflection layers have no
counterpart there. The overlap is the substrate, not the question.

[PokéLLMon](https://arxiv.org/abs/2402.01118) and
[PokéChamp](https://arxiv.org/abs/2503.04094) build language-model Pokémon agents
with learned or search components. Building a stronger agent is not the goal here;
measuring an unmodified one is.

The nearer peer set is elsewhere: single-agent environments with verifiable
ground truth, and multi-agent social arenas without it. This sits between them —
multi-agent, hidden-information, with a perfect simulator, no solver, and both
sides' private reasoning on record.

Note also that "regret" here is per-decision counterfactual regret in a
simulator, not regret against the best fixed action in hindsight as used in the
online-learning literature on repeated games.

## Why draft and trades

The draft is the part with no equivalent in any Pokémon benchmark, and the part
that generalises furthest past Pokémon. Six to eight agents pick in snake order
from one shared board under a budget. Every pick is public and every rationale is
private. Picks carry a denial dimension — taking something because another agent
needs it — which is adversarial reasoning about other agents' plans with a
verifiable substrate underneath. Boards regenerate, so the task resists
memorisation, and a regulation change swaps the board without touching the
mechanism.

Trades add a negotiation between two agents whose stated positions and private
reasoning are both on record.

## Playing for fun

Custom pools, favourite models, deliberately silly rosters and one-off
tournaments are supported and encouraged — that is what a playground is for.
Those runs are recorded and readable like any other. What they are not is a
benchmark: comparison claims run on a frozen position set that every model
answers.

## Documentation

- [Use the league](docs/usage.md)
- [Measurement principles](docs/measurement.md) — what the harness may surface to a model
- [Evaluation plan](docs/evaluation-plan.md) — what is measured and what is being built
- [System architecture](docs/architecture.md)
- [Deploy the service](docs/deployment.md)
