# Trade window

A draft league opens one transaction window after round-robin week 3 by default,
or after the final round-robin week when the league is shorter. `--trade-window
<week>` moves it; `--trade-window off` is the labeled locked-roster control.
Results record the variant so the conditions are never pooled silently.

## Protocol

The window is a barrier: no later matchup may build or start before every series
through the configured week completes. In the default schedule, those earlier
round-robin series form one blind, concurrency-limited batch; the remaining
series form a later batch. `--sequential-weeks` is a labeled alternative, not the
default. Coaches act sequentially inside the window in inverse standings order,
using the normal playoff-seeding tiebreak. Earlier transactions are visible to
later coaches. The complete offer phase runs first, then free agency.

For each coach:

1. It may make up to `trades_allowed` one-for-one offers to other coaches.
   The setting is an integer from zero through three and defaults to one; zero
   skips this phase but leaves free agency enabled. A counterparty immediately
   accepts or rejects before the next offer. Each offer is an independent choice
   against the then-current rosters; no counteroffer or negotiation history is
   supplied. Offers received are not capped.
2. It atomically submits zero to six free-agent swaps. Each swap drops one
   roster entry and adds one currently undrafted board entry.

All resulting rosters must contain ten entries, stay within the original
100-point ceiling, and satisfy entry exclusivity, one entry per base species,
and Mega locks. Drops refund full board price. Unequal-price trades are legal
when both resulting rosters remain legal and within budget. Invalid submissions
use the normal reject-with-reason retry policy.

No offer, rejection, and an empty swap list are complete legal decisions. Prompts
must frame action and inaction equally; the phase measures diagnosis rather than
nudging roster churn. There is no counteroffer, multi-round negotiation,
multi-Pokémon trade, transaction fee, or second window.

## Information and responses

Every acting or responding coach receives the same kind of dossier:

- public standings and rosters;
- its own week-by-week results and opponents;
- its own draft note and series reflections;
- the remaining priced board and its roster/budget arithmetic;
- the window rules and, for a response, the exact offer terms.

The harness supplies no diagnosis, suggested swap, or “good” action. Coaches use
model/seat identities; presentation-only franchise names are withheld. Draft dex
and board-search tools remain available.

An offer contains the recipient, one owned entry to give, one recipient-owned
entry to receive, and a public message. Private rationale and a full-replacement
notebook stay with the acting coach. The responder returns accept/reject, private
rationale, and its own full-replacement notebook. Offer evidence records
`proposerFallback` and `responderFallback` (`null` when there was no offer): only
exhausting parse attempts sets the applicable flag, while an explicit no-offer
or rejection and a random coach's deterministic inaction do not. A fallback
invents no rationale. Free agency returns an atomic
swap list, private rationale, and notebook. A supplied notebook becomes that
coach's plan for later builds; another coach never sees it.

## Evidence

The protocol keeps these evidence layers distinct:

- the observable public message;
- mechanically computed terms, legality, prices, and roster changes;
- each coach's private stated rationale.

They support description and consistency checks, not claims about belief,
honesty, deception, enjoyment, or exploitability. Semantic labels require the
rubric and audit rules in [Measurement](measurement.md). Deterministic
roster-to-built-to-brought-to-used links remain primary.

Archive visibility follows the single facts-only projection in
[Architecture](architecture.md#state-evidence-and-trust); transaction files are
not an independent publication surface.

## Persistence and resume

`window.jsonl` is the append-only decision/replay log, including no-offer,
declined/accepted offer, and empty-swap decisions. Every physical line is a
nonblank canonical JSON object, and the file is newline-terminated; resume does
not normalize older or partial encodings. `window.json` is the completed
materialization of its order, transactions, private evidence, notes, and
resulting rosters. `rosters.json` remains the draft-time snapshot; later
construction uses only a completed transaction overlay.

Resume replays retained rows without provider calls and continues unresolved
coaches. The final artifact is re-read and replayed after its atomic rename and
before the caller receives the overlay. A stored later matchup build is reusable
only when its stage, series, seats, models, and both candidate-id lists exactly
match the current overlaid rosters; artifact-less or stale-candidate rows rebuild.
A draft-only config is promotable only when no result, build, series, coaching,
or season evidence exists. An inconsistent journal, completion artifact, result
prefix, playoff binding, or roster overlay stops resume rather than inventing a continuation.
Visibility follows [Architecture](architecture.md#state-evidence-and-trust), not file presence.
