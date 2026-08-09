# Season review

Every coach writes one retrospective at the moment its own season ends. Access
follows the evidence projection in
[Architecture](architecture.md#state-evidence-and-trust).

## What this records

The review is a terminal retrospective generated with the season outcome and the
coach's earlier draft, build, window, and match record in context. It records
what the coach **states** worked, failed, and should change. Comparing that text
to earlier stated plans and mechanically observed drafted-to-built-to-brought-
to-used links can measure statement consistency.

It is not direct evidence of belief, causal attribution, self-awareness, or
whether earlier behavior was deliberate rather than noise. A loss cannot label
one draft or piloting decision, and eloquent hindsight is not a calibrated
explanation. Any semantic plan-fidelity or attribution score needs a
preregistered observable rubric, identity-stripped traces, several independent
graders, reported disagreement, and blinded human audit.

Nothing the review says changes the completed season or reaches another seat
during play. There is no later action in that coach's current season, so the
review cannot demonstrate a notebook handoff, behavioral change, learning, or
causal transfer. Prompt context and expected later review can still shape the
text, so the artifact is never treated as incentive-free ground truth. A
reflection intervention must be separately versioned and bind a complete
reflection-to-later-prompt-to-action chain.

## When it fires

At the moment a season closes, never in a single batch at the end — a team
knocked out in the round robin judges its draft without seeing playoff results
it was never part of.

- Teams outside the playoff cut, once round-robin standings are final.
- Semifinal losers, once their semifinal resolves.
- The runner-up and the champion, once the final resolves.

The bracket does not wait for any of them. A review is bought alongside the
games still being played — the seats knocked out of the round robin write theirs
while the semifinals run, the semifinal losers while the final runs — and the
seats within one batch answer concurrently. The run joins any outstanding
reviews before it returns, so a failed review still fails the run, just later.

## Prompt

Same voice and dex-tool access as the draft and window prompts, with its own
policy object and hash. Seats and standings use coach/model identities;
spectator-facing franchise names never enter the review prompt. The seat
receives, in one prompt: how its season ended, the final standings, its own
draft in pick order with the reasoning it gave at the time, its free-agency
decision and every other seat's, its final roster, each of its series in order,
and its final private notebook.

The instruction asks it to separate the three things that can lose a series —
the roster it drafted, the six it registered, and how it piloted them — and to
credit what worked as plainly as what did not. It does not ask leading
questions about specific picks, and the harness contributes no analysis of the
seat's play. The resulting attribution is generated evidence, not a measurement
of the coach's hidden mental state.

Reply shape:
`{"summary": ..., "did_well": ..., "did_poorly": ..., "would_change": ...}`.

## Persistence

`season.jsonl` in the run dir holds one row per coach, with per-seat prompt and
response-attempt traces under `season/`. A resumed league replays rows already
written rather than re-buying a retrospective whose season is already closed.
Storage does not change the projection or publication boundary defined in
[Architecture](architecture.md#state-evidence-and-trust).
