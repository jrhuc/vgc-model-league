# Weekly review

A coach's memory is the only seat-private state that carries across a season.
The draft writes its notebook, the weekly review and the post-window
reconciliation revise the whole memory, every team build and transaction
decision reads it, and the season review sees its final form. No other stage
writes it.

## Memory

Memory is a set of named pages. The `notebook` page appears in full in every
later prompt of that coach. Every other page appears in those prompts as an
index line (name, size, first line) and is fetched in full with
`read_memory_page`, which the builder, the transaction stages, and the review
all offer. A coach may hold 16 pages of up to 8,000 characters each, 48,000 in
all; page names are lowercase slugs. A reply that exceeds a limit is rejected
with the reason and the coach replies again; nothing is clipped. The harness
does not suggest what pages to keep or how to organise them.

## When it runs

A review runs at each barrier the league exposes. With `--sequential-weeks`,
that is the end of every round-robin week. With the default blind batches, it is
the end of each transaction-window week and the end of the round robin. The
review precedes the transaction window that opens in the same week, so the
window reads the revised notebook. `--through-week` stops before the review of
the week it stops at.

`review_weeks` in `config.json` records the schedule. Playoffs run on the final
round-robin review.

### Reconciliation after a window

When a transaction window closes, every coach whose roster changed runs a
reconciliation before any later build: the same tools and reply shape, with
the roster before and after the window in place of the period's results.
Coaches whose roster did not change are not called. Rows live in
`reviews/week-<n>-transactions.jsonl` and bind the new roster version.

## What the coach sees

Each coach receives, for its own seat only:

- standings through the week;
- its own series since the previous review: result, registered sets, and its
  final battle note;
- the public results of every other series in the same period;
- its remaining schedule with each opponent's current roster;
- the public transactions of the season so far;
- its roster and its current memory;
- which window opens next, or that rosters are locked.

It has the draft dex and board tools and five league tools:

- `read_public_series` returns the spectator log of any completed series.
  Closed sheets never publish `|showteam|`, so the tool returns exactly what a
  viewer saw.
- `read_own_series` returns the coach's own turn-by-turn choices with the
  reasons it gave at the time and its end-of-game notes.
- `read_own_build` returns the six the coach registered and its plan.
- `read_memory_page` returns one of the coach's own pages in full.
- `read_memory_history` returns the coach's own memory as it stood after the
  review of an earlier week.

A coach cannot read another coach's decisions, builds, or memory. The prompt
states that every coach builds a new six for each matchup and that sets seen in
one series may not return. Later team builds repeat that notice and list the
coach's own results with what it registered; the full context of a series
against the same opponent comes along only when the matchup repeats.

## Response data

The coach replies with one JSON object holding the complete replacement
`notebook`, an optional `pages` object that replaces every other page when
present, and an optional `reasoning` field. Returning the current memory
unchanged is a complete answer. The reasoning is competition-private: no other
coach sees it, and the season bundle releases it to spectators with its week.
The memory itself stays in the run directory.

## Persistence and resume

`reviews/week-<n>.jsonl` holds one row per coach: the complete memory after the
review, the reasoning, the roster version it was written against, and the
digests of the memory before and after. Every build records the digest of the
memory it read in its provenance, and every window records one digest per
seat. Seat
transcripts, including every tool call and result, are under
`reviews/week-<n>/`.

Rows replay without provider calls. A stored row must continue the digest chain
from the memory the league holds when it is replayed, a stored window must
follow a complete review of its week, and evidence after a window must follow
the reconciliation of every roster that window changed. Resume stops when it
finds a window or later evidence without the review that should precede it.

The review prompt policy has its own scaffold hash, `review_scaffold`, recorded
in `config.json` and in every series record.
