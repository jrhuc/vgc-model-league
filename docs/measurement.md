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
  no tool, because models build plans on it.
- Format freshness. The Champions format postdates every current model's
  training cutoff, so the legal item list, per-species movepools, and changed
  mechanics are inlined or one lookup away. A human reads the rules of a new
  format; a model must be handed them.
- Neutral process instructions applied identically to every seat, such as a
  reflection step that asks the model to question its own team choice. Process
  prompts say *when* to think, never *what* to conclude.

The harness must never provide:

- Strategy, evaluation frames, or matchup coaching. "Switches resolve before
  Mega Evolution" is parity; "delay your Mega to win the weather war" is
  coaching, even though one follows from the other.
- Corrections for known model biases. When many models share a wrong prior,
  measuring which ones overcome it is the point.
- Steering through data. Never adjust board prices, menu ordering, or example
  choices to nudge models toward play you consider correct. Ordering is part
  of this: a list sorted by one attribute makes that attribute the axis the
  option space is read along, so the draft board sorts by name and leaves cost
  as a column.
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
the docs — see the trade window's free-agency-only rule in
[Trade window](trade-window.md) for the pattern.
