# Evaluation plan

What is decided, what is being built, and why. [Measurement principles](measurement.md)
says what the harness may surface to a model and is the binding document; this
one records the choices behind the measurements and the order they happen in.
When a decision here is settled and shipped, its rule moves into
`measurement.md` and its entry here shrinks to a line.

## What is being measured, in one paragraph

A series is two or three games and reports one bit that a critical hit can flip.
Decisions are the unit worth measuring, and this repository can measure them
because it holds a perfect simulator, a verified replay of every game, and both
sides' private reasoning. Two families follow from that, and they have different
validity requirements. **Regret** compares a choice against what other choices
were worth, needs positions held constant to be comparable across models, and is
the flagship. **Self-consistency** compares what a model said against what it
privately believed, needs nothing held constant at all, and is nearly free on
data already recorded.

## Decided

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
pool assembled for fun is the point of a playground, and those games are
recorded and readable like any other. What they are not is a benchmark. A claim
that one model chooses better than another runs on a frozen set every model
answers.

### Rankings are not published from the accumulated corpus

The corpus was accumulated, not designed. It connects 8% of possible pairings,
median three opponents per model, and supports about twenty direct pairwise
comparisons rather than a ranking of fifty. Direct comparisons — where two
models actually met — are reported; chain-inferred ones are marked as
extrapolation. Arenas that do publish ratings run six figures of games first.

## Building next

### 1. Position-set runner, then the pilot

A model is handed a frozen position and returns a choice, which is graded by the
existing regret machinery. This is the piece that turns the frozen set into a
measurement, and it is shared with the human anchor below.

Parity requirement: the model sees what that seat saw and nothing else — its own
POV log, its request, its menu, the same system prompt and tools a live seat
gets. It does not see the opponent's private view, who played the position, or
what was played. The position reopens from its snapshot so tools compute against
the real battle rather than a description of one.

Pilot: `deepseek-v4-flash`, `glm-5.2`, `gpt-5.6-terra` over 100 positions each,
roughly $9 at list prices, chosen to span three price tiers rather than to rank
anyone. Its job is to find out whether grading reads sensibly on fresh answers —
whether refusals and unparseable choices are rare, whether regret on fresh
answers sits in the same range as regret on recorded ones, and whether the
strata behave. A frontier pass follows once the pilot's findings are fixed;
budget about $60 for two frontier seats at the same size.

### 2. Self-consistency metrics

These compare a model against itself, so they need no controlled environment and
aggregate over any run. The ground truth and the claim come from the same model
at the same moment.

- **Stated versus believed** — a public offer against the private reasoning
  behind it. A false claim counts only when the reasoning shows the model knew
  otherwise; being wrong is not lying. Reported as a rate per opportunity, not
  as a raw count, so seats with more offers are not penalised.
- **Promise-keeping** — whether a stated intention matched the later action.
- **Reflection accuracy** — whether a post-game explanation matches the game
  log. Reflections already misattribute losses, and the harness has the log to
  check them against.

Blocked on data rather than machinery: the whole corpus holds two real trade
proposals. The trade window is default-on, so volume accrues with ordinary runs.
Where a judge model classifies a trace, model names are stripped first.

Providers that return encrypted reasoning cannot support the stated-versus-
believed comparison. Record which seats those were rather than scoring them.

### 3. Human anchor

Present a position from a real human game to a model and compare its choice
against the human's under the same reference. Open team sheets publish species,
items, abilities, natures and moves but no stat points, so a mid-game position
cannot be reproduced exactly from a replay. The spread-reconstruction convention
already used for rebuilt brackets applies unchanged, and the deviation is stated
to models as it is for those brackets.

Public OTS replay corpora exist at a scale — hundreds of thousands of games —
that makes the sampling problem easy and the vintage problem the real one: check
the regulation and season of any corpus before adopting it, and prefer team
preview and early turns, where the two sheets determine most of what either
player knew.

### 4. Data room rebuild

The panels that ranked models on twenty series are gone. What replaces them:

- Regret share with intervals, frozen set only, empty until seats have answered
- A deliberately sparse head-to-head grid: only pairs that met, everything else
  greyed, because the gaps are the finding
- Read gap against ex-ante regret as two axes — plan quality and read quality,
  the error class that exists only because there is an opponent
- Stratum coverage per model, which shows why marginal comparison fails
- Mechanics errors per thousand decisions, the provable-error rate
- Self-consistency rates once trades produce volume
- Kept: the luck ledger, scaffold health, and play-rate descriptions that are
  labelled as description and never ranked

Qualitative observations may appear as profile cards provided they are marked as
unverified. Trade traces are worth showing as reasoning, message and action
together, because the gap between the three is the measurement.

### 5. Related work

The peer set is single-agent environments with oracles and multi-agent social
arenas without them, not prior Pokémon agents. Two claims need care. Regret in
the online-learning sense — against the best fixed action in hindsight — is
established prior work in repeated matrix games and is not what is measured
here; per-decision counterfactual regret in a simulator is. And an arena with a
solver can report distance from optimal play, which is a stronger statement than
a bounded search under a declared weak reference. The honest position is that
this measures where no solver exists and no oracle can be built.
