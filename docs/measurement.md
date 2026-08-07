# Measurement principles

The league measures reasoning transfer: how well general-purpose models play a
structured domain they were not trained to grind. It is a benchmark, not a
performance. Weak play is a result, and headroom for the next model generation
is a feature. The rules below decide what may be added to prompts and tools.
They exist because well-meant additions can quietly change what the results
mean. If you point a coding agent at this repository, give it this document.

## Information parity, not reasoning parity

Give every model what a human competitor would *have*. Withhold everything a
human would have to *figure out*. Deriving strategy from public information is
the task, and the gap between models that do and models that don't is the
measurement.

The harness must provide:

- Rulebook facts a human player knows for free: format rules, within-turn
  resolution order, how open team sheets work. A mechanic that cannot be
  deduced from the visible logs belongs in the system prompt.
- Simulator-computed answers through tools: matchups, exact stats, damage,
  action order. Tools compute from the pinned simulator and their outputs must
  be complete — a tool result that omits a relevant interaction is worse than
  no tool, because models build plans on it. Battle damage estimates derive
  visible abilities, items, exact own stats, opposing nature ranges, stages,
  status, HP, screens, weather, and terrain from the authoritative battle
  request and open sheets; caller claims cannot replace that state.
- Format freshness. The Champions format postdates every current model's
  training cutoff, so the legal item list, per-species movepools, and changed
  mechanics are inlined or one lookup away. A human reads the rules of a new
  format; a model must be handed them.
- Neutral process instructions applied identically to every seat, such as a
  reflection step that asks the model to question its own team choice. Process
  prompts say *when* to think, never *what* to conclude.
- The real artifact's own presentation, plus tools to re-cut it. No ordering of
  a long list is neutral, so match how the format publishes it and let the
  model re-sort: draft boards go out price-descending the way real draft
  leagues publish them, and `search_board` filters by type, price, ability,
  base stat total, or which entries learn a given move. Re-sorting the board
  alphabetically to avoid making cost "the axis" instead made recall the axis —
  the joint-most-expensive entry fell from row 2 to row 164 of 308 and went
  undrafted for the first time in nine leagues, while an equally buried but
  famous entry at the same price was still taken third. Substituting an
  ordering models cannot exploit for one a human would use is a parity break,
  not a neutrality gain.

The harness must never provide:

- Strategy, evaluation frames, or matchup coaching. "Switches resolve before
  Mega Evolution" is parity; "delay your Mega to win the weather war" is
  coaching, even though one follows from the other.
- Corrections for known model biases. When many models share a wrong prior,
  measuring which ones overcome it is the point.
- Steering through data. Never adjust board prices or example choices to nudge
  models toward play you consider correct.
- Spectator flavor fed back as strategy. Franchise names may use roster-themed
  wordplay after the draft is complete, but remain display-only metadata;
  competitive prompts identify other seats by coach/model identity. A label
  such as "Drought Dodgers" must not become evidence about weather choices.
- Derived quantities the model can compute itself. Stating the budget and the
  rule that every slot must be filled is parity; computing the resulting
  ceiling and leading with it hands over an accounting frame.
- A prescribed shape for private reasoning. Notebook and scratchpad fields ask
  for notes, not for a plan, a needs list, or any other structure. What
  representation a model reaches for is itself a measurement, and it is
  confounded the moment the harness names one.
- Web search or any external live source. Reasoning stays endogenous, and
  models cannot copy human draft or set choices for the format.

## Model error or harness gap?

Before changing anything in response to bad play, read the decision trace and
answer one question: was the fact visible in the prompt or a tool result?

- Not visible, incomplete, or misleadingly rendered: a harness gap. Fix it.
  Past examples include a move description that omitted an immunity
  interaction and a log render that made a blocked move look successful.
- Visible and ignored, or overridden by a stale prior: a model result. Record
  it and leave it alone.

Reflections and notebooks are model output too. A reflection can misattribute
a loss and write the wrong lesson forward; audit it against the game log
before treating it as ground truth. The absence of adaptation is a finding.
If current models cannot clear the bar the league sets, the answer is to wait
for stronger models, not to lower the bar with scaffolding.

## Scaffolding fossilizes

Prompt lines and helpers written to keep a weak model on rails quietly become
spec: later audits check whether they are *true* and never whether they should
*exist*, and tests start asserting their presence. For every prompt line,
config knob, and helper, ask "what breaks if this is deleted?" before "is this
accurate?", and delete when the answer is nothing. When a model behaves
strangely under an instruction-heavy prompt, suspect the prompt before the
model.

## Caps and limits

Hard caps exist to catch doom loops — runaway responses, hung calls — never to
shape play. Any cap that real traffic hits gets raised or removed, and a cap
that survives must be visible when hit: silent truncation corrupts the model's
own notes without either party knowing. Constrained modes such as the battle
timer are opt-in and labeled, never the baseline.

## Results are labeled, not comparable across scaffolds

Every result records a `scaffold` revision derived from the prompts, tool
schemas, and decision policy that shaped it. Improvements ship between runs,
never mid-run: upgrading a tool or prompt while a season is in flight splits
the season into incomparable halves. Cross-run comparisons are valid only
within a scaffold revision, and a parity fix motivated by one run's failure
still only benefits the runs after it.

## Recreate the real thing

When a mode models a real-world format, implement the actual protocol rather
than a convenient approximation, and check the vintage of any external data
before adopting it. Where the recreation must deviate, name the deviation in
the docs — see the trade window's deliberately bounded one-offer trade phase in
[Trade window](trade-window.md) for the pattern.

A bracket rebuilt from a real event inherits that rule. Open team lists publish
species, items, abilities, natures and moves but no stat points, and Champions
allots 66 of them, so a zero-point copy is not the team that cut. Each set
adopts a real spread from a same-species, same-nature set in a public corpus of
the same regulation, preferring the same item because the item decides whether
points buy bulk at all; every choice is recorded in the pool's `spreads.json`,
and sets the corpus cannot serve carry an authored spread with its reasoning.
Three deviations follow, and all three are stated to the models as well as
here: the spreads are ours and not the players', the top-cut pairings were
never published so the bracket seeds by finishing order, and the models did not
build these teams. The seeding stays out of the prompt even though it decides
the pairings. Where a team finished is a result of games these models never
played, and a seat told it holds the list that lost the final would read that
as a verdict on the team rather than on its former pilot. Letting each model spend its own stat points was rejected
for this mode — it would measure teambuilding, which the draft league already
measures, and would leave eight teams that no longer are the top cut the
provenance disclosure describes.

## Grading a decision instead of a result

A series is two or three games and reports one bit. A game is a few hundred
thousand tokens of reasoning compressed into a win or a loss that a critical
hit can flip. Games are what the harness plays; decisions are what it measures.

Every finished game is replayed from its recorded seed, teams and choices and
held against its own log line for line. Only an exact match becomes a position.
That check is what lets team resolution guess: a candidate that is not the team
that played produces a different log and is thrown away. A game the timer or
the simulator answered for a player has choices nobody wrote down, so it is
recognised as unreplayable rather than half-replayed.

A position reopens as a live battle. Every action the model was legally
offered — the same menu it was shown — is played from that position against
averaged luck, so a choice is judged on what it was worth rather than on the
damage roll it happened to draw. Regret is what the best action found was worth
minus what the chosen action was worth.

The reference is declared, and it is a yardstick rather than a stronger player:
the continuation is uniform random, the value is material differential, and the
opponent is a uniform draw from the actions it could legally have taken.
Nothing in it knows how to play Pokémon, which is the point — a reference that
played well would be a strategy opinion, and models would be scored on their
distance from that opinion. Two consequences follow and are reported, not
hidden. The search is bounded, so a regret is a lower bound under this
reference. And a value read one turn after the action cannot tell team-preview
choices apart at all, so a position whose candidates all valued the same is
marked as such rather than recorded as a decision with nothing wrong with it.

Selection and measurement run on separate draws. Quoting the best of many
noisy estimates overstates it, by an amount that grows with the number of
candidates — and candidates run from 94 in a mid-game turn to 360 at team
preview, so the overstatement would not have cancelled between position types.
A cheap screen and a refining pass pick the action; the value that enters the
regret comes from draws neither pass has seen.

Regret is reported twice. Against the action the opponent actually took, it
reads with hindsight the player did not have. Against the uniform draw, it does
not. The gap between them is the part of a decision that was a read rather than
a plan — the class of error that exists only because there is an opponent, and
the one a single-agent environment has no slot for.

Intervals resample games, never decisions. Decisions inside a game share a
seed, two teams and a running position; treating them as independent would
report an interval several times too narrow. Two models are called apart only
when their intervals miss each other.

## What a regret is divided by, and who it is compared against

Raw regret is not a clean measure of choice quality, because it is confounded
with the position it was measured in. A position where one side is far ahead
has more on offer than a level one — mean spread rises from 0.46 to 0.72 as the
material gap grows — so the player who is ahead has more room to give away and
the player who is behind has less. Over the corpus the difference in raw regret
between the two sides of a position correlates -0.20 with the difference in
their position values, which is to say raw regret partly measures how swingy a
game was rather than how well anyone chose. Dividing by what the position had
on offer takes that to -0.04. Share is therefore the reported quantity, and raw
regret is kept only as the input to it. Positions with almost nothing on offer
are left out rather than divided by, and a share above one is noise between the
screening and measuring draws, so it is clamped.

Models are compared inside positions, never across them. Both sides of every
position are graded, so the difference between them is taken in the same game,
against the same opponent, under the same scaffold, and a per-model effect is
fitted to those differences. A marginal per-model average cannot do this: a
corpus accumulated across runs of differing opponents and scaffolds measures
the company a model kept as much as its choices, and the same model routed two
ways moved by more than half the entire spread of the field before the
differencing.

Fitting effects to a graph of who met whom only identifies what the graph
connects. A comparison between two models that actually met is evidence; one
inferred through a chain of intermediaries is an extrapolation, and the two are
reported apart. A model is ranked only once it has met more than one opponent
across several games, because a single-opponent arm is anchored entirely to
that opponent, and a cluster of models that mostly played each other has a
well-identified internal order and a poorly-identified level against everyone
else. The corpus this measures was accumulated, not designed: it connects 8% of
possible pairings, which supports a modest set of direct comparisons and does
not support a full ranking. A position set every model is evaluated on does.

## A frozen position set is what a serious comparison runs on

Leagues, brackets and drafts stay open. Running a favourite model, a pool
somebody assembled for fun, or six of one evolutionary family against stronger
reasoners is the point of a playground, and none of it needs a control. Those
games are recorded and readable like any other. What they are not is a
benchmark, because who a model met and what it was handed decides too much of
the result.

A comparison that claims one model chooses better than another runs on a frozen
set instead. Positions are drawn from verified games, every one of them
discriminating, with more than one legal action and enough on offer to tell
actions apart. They are stratified by phase, by how far into the game they sit,
and by who was ahead, and allocated by the square root of how many exist, so a
rare kind of position is neither crowded out by a common one nor promoted to
parity with it. No single game may contribute more than a few, so a long game
cannot become the benchmark. The selection is a function of the corpus and a
seed, so the same inputs freeze the same set.

Each frozen position carries what its side could actually see — that side's own
log up to the moment of the decision, its request, and the menu it was offered
— along with the battle state needed to reopen it. It does not carry the
opponent's private view. A set is therefore self-contained and rerunnable
without the run that produced it, and the model that played the position
originally is recorded as provenance, never as an answer.

Every model answers the same positions, so there is no cohort left to
difference out and no graph to be sparse. Reaching that state also requires
each seat to be one thing: a provider must be pinned and the provider that
actually served the request recorded, because the same model reached two ways
was as far apart as the field itself.
