# Season review

Every coach writes one retrospective at the moment its own season ends, and it
is published on that team's page.

## What this measures

The trade window instruments diagnosis altitude *forward*, under uncertainty:
given three weeks of results, does a seat locate its problem at the roster,
build, or piloting level? The season review instruments the same skill
*backward*, with the answer already known. A coach that lost a series to a hole
no registration could cover should be able to say so afterwards, and a coach
whose roster was fine should not invent a draft error to explain a piloting
loss.

The two together give a cheap check on whether window behaviour was reasoning
or noise. A seat that kept its roster and can afterwards name what that cost
made a judgement; a seat that kept its roster and afterwards describes a
problem a swap would have fixed did not.

Nothing the review says changes a result, feeds a later decision, or reaches
another seat. It is a terminal artifact, so there is no incentive to posture.

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
policy object and hash. The seat receives, in one prompt: how its season ended,
the final standings, its own draft in pick order with the reasoning it gave at
the time, its free-agency decision and every other seat's, its final roster,
each of its series in order, and its final private notebook.

The instruction asks it to separate the three things that can lose a series —
the roster it drafted, the six it registered, and how it piloted them — and to
credit what worked as plainly as what did not. It does not ask leading
questions about specific picks, and the harness contributes no analysis of the
seat's play: the attribution is the measurement.

Reply shape:
`{"summary": ..., "did_well": ..., "did_poorly": ..., "would_change": ...}`.

## Persistence

`season.jsonl` in the run dir, one row per coach, with the per-seat prompt and
response traces under `season/`. A resumed league replays rows already written
rather than re-buying a retrospective whose season is already closed. The GUI
reads the log directly, so reviews appear on team pages as they are written.
