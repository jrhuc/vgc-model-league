# Configure the transaction windows

By default, a draft league opens a transaction window after each of round-robin
weeks 1, 2, and 3. A league with fewer weeks keeps only the windows that fit.
Rosters lock when the last window closes and stay locked through the playoffs.

Use `--transactions <weeks>` with a comma-separated list, for example
`--transactions 2,4`, to choose the windows. Use `--transactions off` for the
labeled locked-roster control. Results record the schedule and the roster
version each series was built on, so analyses do not combine conditions without
labeling them.

## Scheduling

Each window acts as a barrier. No later matchup can build or start until every
series through that window's week finishes. Without sequential weeks, the
round-robin series between two barriers run as one blind, concurrency-limited
batch. With `--sequential-weeks`, each week is its own batch and the window
opens as soon as its week ends.

Coaches act in inverse standings order through that week, using the standard
playoff-seeding tiebreak. Earlier transactions are visible to later coaches. The
complete trade offer phase runs before the free-agency phase. Every coach sees
the public record of accepted trades and swaps from earlier windows, and which
window of the schedule is open.

## Coach actions

Each coach can take these actions:

1. Make up to `trades_allowed` one-for-one offers to other coaches. This integer
   setting accepts values from zero through three and defaults to one. A value
   of zero skips trade offers but keeps free agency enabled. The counterparty
   immediately accepts or rejects each offer before the next offer. Each offer
   uses the current rosters and does not include counteroffers or negotiation
   history. The protocol does not cap received offers.
2. Submit an atomic list of zero to six free-agent swaps. Each swap drops one
   roster entry and adds one currently undrafted board entry.

Every resulting roster must:

- contain ten entries;
- remain within the original 100-point limit;
- preserve entry exclusivity;
- contain at most one entry for each base species; and
- satisfy Mega locks.

Drops refund the full board price. A trade can exchange entries with different
prices if both resulting rosters remain legal and within budget. Invalid
submissions use the standard reject-with-reason retry policy.

A coach completes a legal decision by making no offer, rejecting an offer, or
submitting an empty swap list. Prompts must present action and inaction equally
so that the phase measures diagnosis without encouraging roster changes. The
protocol does not support counteroffers, multi-round negotiation, multi-Pokémon
trades, or transaction fees.

## Prompt information

Each acting or responding coach receives:

- public standings and rosters;
- the public transactions of earlier windows;
- its own weekly results and opponents;
- its own draft note and series reflections;
- the remaining priced board and its roster and budget calculations;
- the transaction-window rules; and
- for a response, the exact offer terms.

The harness does not provide a diagnosis, suggested swap, or preferred action.
Prompts identify coaches by model and seat identity and omit presentation-only
franchise names. Draft dex and board-search tools remain available.

## Response data

An offer contains:

- the recipient;
- one entry owned by the proposer to give;
- one entry owned by the recipient to receive; and
- a public message.

The acting coach also returns a competition-private rationale. The responder
returns an accept or reject decision and its own rationale. Neither reply
rewrites the coach's notebook; a coach whose roster changed revises it in the
reconciliation that follows the window (see [Weekly review](weekly-review.md)).

Offer evidence records `proposerFallback` and `responderFallback`. The value is
`null` when no offer exists. The applicable flag is set only after all parse
attempts fail. An explicit no-offer or rejection does not set it, and neither
does a random coach's deterministic inaction. A fallback does not create a
rationale.

A free-agency response contains an atomic swap list and a rationale.

Rationales are competition-private: no other coach can read them, and the
public season bundle releases them to spectators once the window is complete.

## Interpret the evidence

Keep these evidence layers separate:

- the observable public message;
- mechanically computed terms, legality, prices, and roster changes; and
- each coach's competition-private stated rationale.

Use these layers for descriptions and consistency checks. Do not use them to
claim belief, honesty, deception, enjoyment, or exploitability. Semantic labels
must follow the rubric and audit rules in [Measurement](measurement.md).
Deterministic `roster-to-built-to-brought-to-used` links remain the primary
evidence.

Archive visibility follows the facts-only projection in
[Architecture](architecture.md#state-evidence-and-trust). Transaction files do
not define an independent publication surface.

## Persistence and resume

Each window writes into `transactions/after-week-<n>/`. Its `window.jsonl` is
the append-only decision and replay log. It includes no-offer, declined-offer,
accepted-offer, and empty-swap decisions. Each physical line is a nonblank
canonical JSON object, and the file ends with a newline. Resume does not
normalize older or partial encodings. Protocol-9 leagues hold one window at the
run root; the archive still reads it.

`window.json` materializes the completed order, transactions, private evidence,
notes, and resulting rosters. `rosters.json` remains the draft-time snapshot.
Later construction uses only a completed transaction overlay. Each closed window
increments the roster version; every build and series record binds the version
it used, and resume replays the windows in order before adopting any evidence
built on a later version.

On resume, the league replays retained rows without provider calls and continues
with unresolved coaches. After atomically renaming the final artifact, it reads
and replays that artifact before returning the overlay to the caller.

A stored build for a later matchup is reusable only if its stage, series, seats,
models, and both candidate-ID lists exactly match the current overlaid rosters.
Rows without artifacts and rows with stale candidates rebuild.

A draft-only configuration can be promoted only if no result, build, series,
coaching, or season evidence exists. Resume stops rather than constructing a
continuation when it finds an inconsistent journal, completion artifact, result
prefix, playoff binding, or roster overlay.
