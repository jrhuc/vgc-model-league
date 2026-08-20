# Generate season reviews

Each coach generates one retrospective when its season ends. The access rules
follow the evidence projection in
[Architecture](architecture.md#state-evidence-and-trust).

## Evidence limits

The review provides the coach with its season outcome and earlier draft, build,
transaction-window, and match records. It records the coach's statements about
what worked, what failed, and what it would change. You can compare these
statements with earlier plans and with mechanically observed
`drafted-to-built-to-brought-to-used` links to measure statement consistency.

Do not treat a review as direct evidence of belief, causal attribution,
self-awareness, or deliberate earlier behavior. A loss cannot label a specific
draft or piloting decision, and a fluent retrospective is not a calibrated
explanation. Any semantic plan-fidelity or attribution score requires:

- a preregistered observable rubric;
- identity-stripped traces;
- several independent graders;
- reported grader disagreement; and
- blinded human audit.

The review does not change the completed season or reach another active seat.
Because the coach takes no later action in the same season, the review cannot
demonstrate a notebook handoff, behavioral change, learning, or causal transfer.
Prompt context and the expectation of a later review can still affect its text,
so the artifact is not incentive-free ground truth. Evaluate a reflection
intervention separately, assign it a version, and bind its complete
reflection-to-later-prompt-to-action chain.

## Timing

Generate each review as soon as the corresponding coach's season ends:

- Generate reviews for teams outside the playoff cut after finalizing the
  round-robin standings.
- Generate reviews for semifinal losers after resolving their semifinal.
- Generate reviews for the runner-up and champion after resolving the final.

Do not generate all reviews in a single end-of-season batch. A team eliminated
in the round robin reviews its draft without seeing playoff results in which it
did not participate.

Reviews do not block the bracket. Eliminated round-robin seats generate reviews
while semifinals run, and semifinal losers generate reviews while the final
runs. Seats in the same review batch respond concurrently. The run waits for all
outstanding reviews before returning, so a failed review causes the run to fail
after the concurrent games complete.

## Prompt contents

The review uses the same voice and dex-tool access as the draft and transaction
window prompts. It has a separate policy object and hash. Prompts identify seats
by coach and model identity. They do not include spectator-facing franchise
names.

The prompt contains:

- how the coach's season ended;
- final standings;
- the coach's draft in pick order, including its original reasoning;
- its free-agency decision and every other seat's decision;
- its final roster;
- each of its series in order; and
- its final memory, every page in full.

The instruction asks the coach to distinguish among roster drafting, registration
of six Pokémon, and piloting as possible causes of a series loss. It also asks
the coach to identify what worked. The instruction does not lead the coach
toward specific picks, and the harness does not analyze the coach's play. Treat
the resulting attribution as generated evidence, not as a measurement of hidden
mental state.

The coach returns
`{"summary": ..., "did_well": ..., "did_poorly": ..., "would_change": ...}`.

## Persistence and resume

The run directory stores one row per coach in `season.jsonl`. It stores
per-seat prompt and response-attempt traces under `season/`. On resume, the
league replays existing rows instead of requesting another retrospective for a
coach whose season has ended.
