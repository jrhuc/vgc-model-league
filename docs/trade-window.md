# Trade window

A draft league opens one transaction window after round-robin week 3 by default,
or after the final round-robin week when the league is shorter. `--trade-window
<week>` moves it; `--trade-window off` is the labeled locked-roster control.
Results record the variant so the conditions are never pooled silently.

## Protocol

The window is a barrier: no later matchup may build or start before every series
through the configured week completes. Coaches act sequentially in inverse
standings order, using the normal playoff-seeding tiebreak. Earlier transactions
are visible to later coaches. Trades run first, then free agency.

For each coach:

1. It may make up to `trades_allowed` one-for-one offer (one by default) to
   another coach. The counterparty immediately accepts or rejects before the
   next coach acts. Offers received are not capped.
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
rationale, and its own full-replacement notebook. Free agency returns an atomic
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

## Persistence and resume

`window.jsonl` is the append-only decision/replay log, including unmade,
declined, and accepted offers and empty swap decisions. After completion,
`window.json` records order, transactions, stated evidence, notes, and resulting
rosters. `rosters.json` remains the draft-time snapshot; post-window consumers
apply the completed overlay.

Resume replays completed rows without model calls, reconstructs the live board
and rosters, and continues unresolved coaches. A historical run whose config
omits `trades_allowed` means zero offers and preserves its free-agency-only
protocol. Transaction evidence travels with published draft assets.
