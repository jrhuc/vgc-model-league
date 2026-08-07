# Evaluation plan

What is decided, what is being built, and why. [Measurement principles](measurement.md)
says what the harness may surface to a model and is the binding document; this
one records the choices behind the measurements and the order they happen in.
When a decision here is settled and shipped, its rule moves into
`measurement.md` and its entry here shrinks to a line.

## What is being measured

A series is two or three games and reports one bit that a critical hit can flip.
Win rate is the weakest thing this repository can produce and the easiest thing
for anyone else to reproduce. What it can produce that others cannot follows
from three properties held at once: a perfect simulator that can be forked at any
position, both sides' private reasoning on record, and a season structure that
makes a model commit to a plan before it has to execute one.

Three metric families follow.

**Regret** compares a choice against what the other legal choices were worth,
by forking the position and searching under a declared reference. It needs
positions held constant to be comparable across models. It is the flagship, and
it is the family no other Pokémon work can compute at all (see
[Position against related work](#position-against-related-work)).

**Commitment fidelity** compares what a model said it would do against what it
later did, across altitudes that form a causal chain. It needs no positions held
constant, because the comparison is within a single model's own trajectory.

**Self-consistency** compares what a model said publicly against what it
privately believed at the same moment. It needs nothing held constant at all and
aggregates over any run, including runs already recorded.

### The five altitudes

One season makes the same model decide at five altitudes, and each arrow is a
checkable commitment:

1. **Draft** — take one Pokémon from a shared board under a budget, against
   five to seven other agents picking from the same board, with a stated
   rationale.
2. **Teambuild** — choose six of ten and build spreads, which either cashes out
   the draft thesis or abandons it.
3. **Trade** — negotiate a roster change with another agent, where the stated
   justification sits alongside the private reasoning that produced it.
4. **Battle** — bring four of six and choose each turn, where drafted synergy
   either appears on the field or does not.
5. **Reflection** — account for the result afterwards, checkable against the log.

Every other benchmark in the peer set measures one altitude. Measuring five in
one causal chain, with simulator ground truth at the bottom, is the claim this
repository should be built around. Two instances are already on record: a seat
that drafted a Bolt Beak archetype and never once used Electro Shot, and seats
whose reflections misattributed losses to roster quality when the log showed
otherwise. Both are commitment-edge failures, found by accident before there was
a metric for them.

The altitudes may dissociate — a model may draft shallowly and play cleanly, or
the reverse, and both patterns have been observed informally. If they dissociate,
then "how well does a model play VGC" is not one number, and every benchmark
reporting one is answering a question it has not established is well posed. That
is a publishable negative result and it costs nothing extra to test.

## Position against related work

Peer work, and what each holds:

| | agents | hidden info | simulator truth | private reasoning | per-decision counterfactual | cross-altitude commitment |
| --- | --- | --- | --- | --- | --- | --- |
| Factory/Factorio environments | 1 | no | yes | n/a | no | no |
| Social-deduction arenas | N | yes | no | yes | no | no |
| Poker arenas | 2+ | yes | yes, with a solver | partial | yes, against the solver | no |
| VGC-Bench | 2 | yes | yes | no | no | no |
| verifiers `KuhnPokerEnv` | 2 | yes | yes, trivial game | yes | no | no |
| this repository | 2–8 | yes | yes, no solver exists | both sides | yes, bounded | yes |

The last two columns are the contribution. Everything else in the table is
prior art and must be described as such.

### What poke-env and VGC-Bench already do, and what they cannot

[poke-env](https://github.com/hsahovic/poke-env) provides a gen-9 damage
calculator, doubles battle state, a teambuilder, a Showdown websocket client,
heuristic baseline players, and a PettingZoo `ParallelEnv` for doubles. Parts of
`reference.ts`, `state.ts`, `sim.ts`, `teams.ts` and `showdown.ts` duplicate it.
**"Two agents play VGC" is prior art and must never be presented as novel.**

The structural difference is that poke-env is a *client*: it reconstructs battle
state from the Showdown protocol stream, so it observes a battle the server owns.
There is no `deepcopy` or clone path anywhere in its player, battle, or
environment modules, and there cannot usefully be one. This repository embeds
`@pkmn/sim` in process and owns the battle object, which is the only reason
`src/eval/fork.ts` can exist. Counterfactual regret is not an incidental
difference in implementation; it is the capability the architecture was chosen
for, and it is unavailable to any client-side approach.

[VGC-Bench](https://arxiv.org/abs/2506.10326) trains small policy networks:
behaviour cloning over 700k+ scraped battle logs, then self-play, fictitious
play, double oracle and policy exploitation, evaluated by cross-play win-rate
matrices over 200 battles per pairing, with a generalisation test against 72
unseen teams. Its LLM player is a baseline wrapper around Llama-3.1-8B evaluated
over **20 battles**. Their subject is the training algorithm; the language model
is a footnote. Ours is the language model. The overlap is the substrate, not the
question, and the README must say so in those terms.

Their 700k battle-log corpus, already scraped and parsed, is the corpus the human
anchor below needs.

### The gap between VGC-Bench and the verifiers stack

They fail in opposite directions, and the gap between them is where this
repository sits.

VGC-Bench's evaluation is population-based and game-theoretic: cross-play
matrices, and double oracle, which finds a best response and therefore measures
**exploitability**. That is a real strength and it is about strategic robustness.
It has no per-decision reward, no reasoning capture, and no social layer.

The verifiers multi-agent release is about **credit assignment for training** —
Role-Conditioned Advantage Estimation, hierarchical GRPO, `Env.run(task, agents)`
control flow, `Episode`. Its evaluation side is a reward function over a finished
trace plus `BestOfNEnv` for pass@k. There is no exploitability notion, no
population evaluation, and no cross-play concept anywhere in it. If you want to
know whether an agent is exploitable, verifiers gives you nothing.

Two consequences:

- **We lack an exploitability measure too, and should add one.** It is
  format-agnostic, survives regulation changes, and a cheap first version costs
  no API calls: measure **predictability** — how well a model's next action is
  predicted from its own decision history in the same run. High predictability is
  an exploitability proxy and it is computable from decision logs already on disk.
- **A population/exploitability evaluation pattern is a genuine gap in
  verifiers.** Contributing one upward is a collaboration story rather than a
  submission, and it is the strongest reason for that ecosystem to care about
  this repository beyond one more environment.

RAE deserves a citation for an independent convergence: it exists because
different roles have structurally different reward distributions, so each role is
measured against its own baseline. The measurement version of the same problem
appeared here — raw regret correlated −0.197 with which side was ahead, because
decided positions have more on offer — and was fixed the same way, by
normalising per position (`share = min(1, regret / spread)`), which dropped the
correlation to −0.043.

## Decided

### Rankings and Elo are not the product

Win rate, Elo and league standings are description, never a ranking claim, and
never the headline. They are noisy at any sample size this project can afford,
trivially reproducible with poke-env, coupled to the regulation in force, and
they are not what this repository is good at. Regret share, commitment fidelity,
self-consistency, predictability and mechanics-error rate all survive a
regulation change untouched, because none of them depend on which Pokémon are
legal. The season generates data; it is not the result.

This is a scope decision, not a presentation preference. Panels, docs and any
published artifact follow it.

### Identity is anonymous, continuity is not

A seat is identified to other seats by a pseudonym, never by its model spec.
Reputation imported from outside the league is not information a seat earns in
play, and a model that knows it faces a frontier model can condition on that
before a single turn resolves. Recorded logs currently name both seats by spec,
which reached the model through the battle log itself.

The pseudonym is stable within a run and randomised across runs. That is a
deliberate departure from arenas that randomise per game: a stable pseudonym
removes imported reputation while preserving the read a model builds from
watching one opponent across a season, which is the more interesting capability
and the one a draft league is shaped around. Whether a model bargains harder
against a counterpart it has beaten stays answerable, and answerable inside a
single league rather than across many.

Real identities stay in `series.json` and the records, and are revealed in the
archive after the fact. Only what a seat can see during play is anonymous.

Frozen positions are anonymised at freeze time, since their logs come from runs
that predate this. Live runs need the pseudonym assigned at battle-start and
recorded, so replay reads the name it was played under instead of deriving one
from the spec — `corpus.ts` currently derives `p1-${spec}` and must prefer a
recorded name, falling back to the derived form for older runs.

### A benchmark seat pins to one inference stack

Shipped. A gateway spread one seat across nineteen upstream stacks. The gap
between stacks is not shown to matter and not shown not to; pinning removes the
question for free. `VGC_OPENROUTER_PIN` sets the stack list and disables
fallback, and the stack that answered is recorded on each decision.

### Comparison runs on a frozen position set

Shipped. Leagues, brackets and drafts stay open — running a favourite model or a
pool assembled for fun is the point of a playground, and those games are recorded
and readable like any other. What they are not is a benchmark. A claim that one
model chooses better than another runs on a frozen set every model answers.

### Rankings are not published from the accumulated corpus

The corpus was accumulated, not designed. It connects 8% of possible pairings,
median three opponents per model, and supports about twenty direct pairwise
comparisons rather than a ranking of fifty. Direct comparisons — where two models
actually met — are reported; chain-inferred ones are marked as extrapolation.
Arenas that do publish ratings run six figures of games first.

### The simulator stays in TypeScript, behind a service boundary

Porting to Python via poke-env would delete counterfactual regret, because
poke-env cannot fork. Reimplementing `@pkmn/sim` bindings in Python buys nothing
a protocol boundary does not already buy. The decision is to expose the graded
surface over JSON instead: positions and grading as an HTTP endpoint, battle
reference tools as an MCP toolset.

Every upstream ecosystem already assumes the graded thing is an external program
behind a protocol — verifiers routes all model traffic through an interception
server and runs harnesses in containers; NeMo Gym defines an environment as a
dataset, a harness, a verifier and per-task state behind a service. One service
therefore serves all of them, and no adapter locks the repository in.

## Building next

### 1. Position-set runner, built as a service, then the pilot

A model is handed a frozen position and returns a choice, which is graded by the
existing regret machinery. This is the piece that turns the frozen set into a
measurement, and it is shared with the human anchor below.

Built as a server rather than an in-process function it also becomes the boundary
every upstream integration needs, at close to zero extra cost. That is the reason
for the shape.

Parity requirement: the model sees what that seat saw and nothing else — its own
POV log, its request, its menu, the same system prompt and tools a live seat
gets. It does not see the opponent's private view, who played the position, or
what was played. The position reopens from its snapshot so tools compute against
the real battle rather than a description of one.

Pilot: `deepseek-v4-flash`, `glm-5.2`, `gpt-5.6-terra` over 100 positions each,
roughly $9 at list prices, chosen to span three price tiers rather than to rank
anyone. Its job is to find out whether grading reads sensibly on fresh answers —
whether refusals and unparseable choices are rare, whether regret on fresh
answers sits in the same range as regret on recorded ones, and whether the strata
behave. A frontier pass follows once the pilot's findings are fixed; budget about
$60 for two frontier seats at the same size.

### 2. Heuristic baselines

There is currently no non-LLM floor: every number is model-versus-model with
nothing anchoring the bottom of the scale. Port max-base-power and
simple-heuristics players from poke-env's `baselines.py` — roughly 200 lines of
TypeScript, zero API cost per game, no rate limits. For a project paying its own
credits this is the cheapest credibility available, and it makes every regret
figure interpretable. poke-env's gen-9 damage calculator is also a free
cross-check oracle for `reference.ts`.

### 3. Commitment-chain metrics

The measurement behind the five altitudes. Each edge is a comparison between a
recorded statement and a later recorded fact, so all of it grades offline against
runs already on disk.

- **Draft thesis to teambuild** — was the Pokémon a pick's rationale named
  actually selected into the six.
- **Teambuild to bring** — was the stated wincon brought in the games it was
  built for.
- **Draft synergy to execution** — was the interaction a pick was justified by
  ever actually executed. The Electro Shot case is the template.
- **Trade justification to use** — was an acquired Pokémon played, and did the
  stated reason for wanting it materialise.
- **Reflection to log** — does the post-game account match what the log shows.

Report each as a rate per opportunity, never a raw count, so seats with more
opportunities are not penalised. A judge model classifying a trace sees model
names stripped first.

### 4. Self-consistency metrics

These compare a model against itself at one moment, so they need no controlled
environment and aggregate over any run.

- **Stated versus believed** — a public offer against the private reasoning
  behind it. A false claim counts only when the reasoning shows the model knew
  otherwise; being wrong is not lying.
- **Promise-keeping** — whether a stated intention matched the later action.
- **Reflection accuracy** — whether a post-game explanation matches the game log.

Blocked on data rather than machinery: the whole corpus holds two real trade
proposals. The trade window is default-on, so volume accrues with ordinary runs.

Providers that return encrypted reasoning cannot support the stated-versus-
believed comparison. Record which seats those were rather than scoring them.

Worth testing once volume exists: whether deception is stable across altitudes —
whether a seat that misrepresents in trades also misreports in reflections. That
is a cross-altitude trait measurement with verifiable ground truth at each point,
and nothing in the peer set can pose it.

### 5. Predictability as an exploitability proxy

Fit a cheap predictor to a seat's own decision history within a run and measure
how well it predicts that seat's next action. High predictability means an
opponent modelling it would profit. Costs no API calls, runs over existing
decision logs, format-agnostic, and it is the axis VGC-Bench evaluates well and
the verifiers stack does not evaluate at all.

### 6. Human anchor

Present a position from a real human game to a model and compare its choice
against the human's under the same reference. Open team sheets publish species,
items, abilities, natures and moves but no stat points, so a mid-game position
cannot be reproduced exactly from a replay. The spread-reconstruction convention
already used for rebuilt brackets applies unchanged, and the deviation is stated
to models as it is for those brackets.

VGC-Bench's 700k+ scraped and parsed battle logs are the obvious corpus. Check
the regulation and season before adopting it, and prefer team preview and early
turns, where the two sheets determine most of what either player knew.

### 7. Data room rebuild

The panels that ranked models on twenty series are gone. What replaces them:

- Regret share with intervals, frozen set only, empty until seats have answered
- The commitment chain as the centrepiece: one seat's season as a chain of stated
  plans and what became of each
- A deliberately sparse head-to-head grid: only pairs that met, everything else
  greyed, because the gaps are the finding
- Read gap against ex-ante regret as two axes — plan quality and read quality,
  the error class that exists only because there is an opponent
- Stratum coverage per model, which shows why marginal comparison fails
- Mechanics errors per thousand decisions, the provable-error rate
- Predictability per seat
- Self-consistency rates once trades produce volume
- Kept but never ranked: the luck ledger, scaffold health, play-rate descriptions

Trade traces are worth showing as reasoning, message and action together, because
the gap between the three is the measurement.

## Upstream integration

Two goals, in order: retire hand-rolled infrastructure that has an upstream
equivalent, and position for collaboration with an ecosystem that can fund runs
this project cannot afford alone.

### What is genuinely duplicated

`llm-engine.ts` and `providers.ts` (~2,400 lines) reimplement what the verifiers
stack does with an **interception server**: the harness never calls the provider,
model traffic is proxied, and the trace is built live from it. Ours does the same
work — tool-call loop, retry, failure classification, usage and cost accounting,
the Anthropic cache-breakpoint fix — with recording tangled into playing rather
than separated from it. Their seam is the better design regardless of whether the
integration happens.

More cheaply duplicated: `restart.ts` and `recovery.ts` against their
`--resume <dir>` semantics; the worker-thread pool against their
orchestrator/worker split with docker and sandbox runtimes; `runs/<id>/` against
`outputs/<env>--<model>--<harness>/<uuid>/traces.jsonl`.

Not duplicated and not portable: `src/eval/fork.ts`, `regret.ts`, the paired
estimator, the draft, trade and reflection layers, the anonymisation policy, and
the frozen set. A verifiers reward is a function of a finished trace; nothing in
the stack forks a position, because almost no environment can.

### What to publish, and how to position each

**`vgc-draft-v1` is the flagship multi-agent environment.** This is the shape to
lead with, for reasons that all point the same way:

- It is genuinely N-agent — six to eight agents in snake order over one shared
  board — where the reference multi-agent environment upstream is two-player Kuhn
  poker. It exercises `Env.run(task, agents)` harder than anything shipped with it.
- Every pick is public and every rationale is private, which is exactly the
  structure that makes stated-versus-believed measurable with no extra machinery.
- The action space is a budget-constrained combinatorial choice over a board,
  with a denial dimension: taking something because another agent needs it. That
  is adversarial reasoning about other agents' plans with a verifiable substrate.
- The taskset is effectively infinite even with the board held fixed, because the
  other agents generate it. See below.
- It is cheap. A draft is roughly ten decisions per agent with no battle
  simulation, against 28.9k input tokens per battle decision. Draft-only runs cost
  a small fraction of a league, which matters more here than anywhere.
- It is format-agnostic: a regulation change swaps the board and leaves the
  mechanism untouched.
- Nobody covers it. poke-env has a teambuilder, not a draft. VGC-Bench scrapes
  teams. Sequential multi-agent resource allocation with private valuations is
  absent from the LLM benchmark landscape, and it is a mechanism rather than a
  game, so the result generalises past Pokémon.

#### The population is the taskset generator, and that is not the same as board regeneration

A fixed board does not make a fixed task. What an agent is actually asked at pick
seven is *the board minus whatever five other models took*, and that residue is
combinatorial in the number of agents and picks. No agent can cache "at pick seven
take X", because whether X is still there is decided by other models' private
reasoning. The environment resamples its own task distribution as a consequence of
being multi-agent, at zero cost, and it does so more aggressively than a shuffled
board would — a regenerated board changes what exists, while a live population
changes what is *available and contested*, which is the part the decision turns on.
The same property is why a self-play draft is a usable training signal without any
task authoring at all.

That covers one threat and not the other. Opponent variance defends against
memorising trajectories; it does not defend against memorising *valuations*. What
each entry is worth is a property of the board, not of the position, so a
published fixed board eventually becomes a known artifact with a learnable tier
list, and every draft over it degrades from judgement to recall. Board
regeneration is the only defence against that one, and it is the reason to keep
it — not anti-memorisation in general.

Regeneration is not free either. A fixed board is what makes cross-run picks
comparable at all: the mega-slot census and the row-164 ordering effect, where
name-sorting buried an entry and it went undrafted for the first time in nine
drafts, are only legible because the board was the same each time. Regenerate
every board and that entire class of finding disappears. The split is the same one
this repository already makes everywhere else: **a frozen canonical board carries
the census and any comparison claim; regenerated boards carry the published
environment**, where memorisation is the threat and comparability across boards is
not wanted.

There is a sharper consequence for measurement. Population-generated variance is
*uncontrolled* variance — a seat's draft is scored against whoever else happened
to be in it, which is precisely the cross-play confound VGC-Bench answers with
population evaluation. For training that variance is the point; for a benchmark
number it is contamination. Measuring the draft therefore needs the opposite of
the live environment: **frozen draft positions** — replay a recorded draft up to
pick *k*, insert the model under test, grade the pick. Same board, same history,
same question for every model. It is the draft analogue of the frozen position
set, it reuses recorded drafts already on disk, and it costs one call per position.

One honest limit, because it changes what can be claimed. Unlike a battle
position, a draft position has no cheap oracle: valuing a pick means playing the
season, so there is no fork-and-search regret number here and it should not be
implied that there is. What a frozen draft position does grade, at zero
additional cost, is the *scarcity read*. When a rationale says an entry will
survive to the next turn, the recorded continuation settles whether it did. That
is a verifiable claim about other agents' behaviour, checkable against ground
truth, with no simulator and no oracle — and it is the first commitment edge in
the chain. Draft is the better environment shape; positions remain the better
regret vehicle. Publishing both is not hedging, it is the two halves.

**`vgc-positions-v1` is the flagship single-agent eval.** Frozen set, reward
`1 − regret_share`, mechanics-legality as a separate metric. Verifiable, dense,
unsaturated, and structurally un-gameable — a simulator counterfactual cannot be
reward-hacked. It is the artifact with no equivalent anywhere, and once published
other people spend their credits running it.

**`vgc-league-v1` is third and conditional.** Full two-seat play is the shape
closest to prior art, and publishing it framed as "two agents play VGC" invites
the correct objection that poke-env shipped that years ago and VGC-Bench already
trains on it. If it ships at all it is positioned on the per-decision regret
signal and the logged private reasoning of both sides, never on the matchup.

**`vgc-trades-v1`** maps onto the frozen-counterpart pattern their `UserSimEnv`
already uses — one role scored, the counterpart frozen and unscored — and their
agentic-judge environment, where the judge explores the trace rather than reading
a summary, is a better stated-versus-believed classifier than one written here
from scratch.

### Which ecosystem, and why not to choose exclusively

Target the verifiers/Prime Intellect ecosystem first: it has the Hub, a bounty
program paying $1,000–5,000+ for application-only environments, a residency
offering compute and a stipend, and a multi-agent release that shipped recently
enough to still need showcase environments. A hidden-information multi-agent
environment with a dense simulator-verified reward is not a generic submission.

Nous's Atropos was the other candidate and is no longer one: the repository was
archived on 2026-07-04 with an explicit unmaintained notice, and Nous now tracks
a fork of NVIDIA's NeMo Gym instead of shipping its own environment framework.
Checked 2026-08-07 — verifiers had been pushed to the same day.

The consolidation points somewhere useful. NeMo Gym ships bridges to both
verifiers and Harbor; verifiers ships a `HarborTaskset` that loads Harbor tasks
directly. Harbor is the format the surviving frameworks agree on, which makes it
the portable artifact rather than any one framework's environment class. The
service boundary is the real asset either way: a Harbor task and a verifiers
`Taskset` are then both thin clients of the same HTTP endpoint, and a framework
being archived costs a client, not a port. That is the argument for building the
boundary before picking a target, and it just paid out once.

### Recursive language models

RLM treats a long prompt as an external environment the model writes code
against, chunking and recursively calling itself over segments; Prime Agent adds
a harness whose prompt, sub-agents, skills and memory are editable mid-trajectory.
Reported results are strong, including above-human-expert on ARC-AGI 3 with a
frontier model.

**It must not become the seat harness.** `measurement.md` holds that machinery
shaping how a model is allowed to think muddies the data it was meant to collect,
and an RLM seat measures model × scaffold rather than model. Adopting it as the
default would break the policy this work exists to defend.

Two legitimate uses:

- **As a labelled arm.** `scaffoldRevision()` and the six component hashes
  already exist to attribute results to scaffolds. Bare seat versus RLM seat,
  graded per decision, measures what a harness is worth — a question almost
  nobody can answer cleanly because almost everyone only has win rates. Opt-in and
  labelled, exactly like the battle timer.
- **On the harness's own side.** Season review, trade judging and reflection
  grading are long-context reads in analysis code, not in a seat. Recursive
  reading there carries no measurement cost.

## Scope

This is a scope refactor, not an evaluation add-on. The subject is decision
quality and whether stated reasoning survives contact with a simulator, across
five altitudes. The league, bracket and draft machinery is the data generator.
Play a season for fun with any pool you like — that is the playground working as
intended — but the published claims are about decisions, not standings.
