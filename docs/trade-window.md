# Trade window (mid-season free agency)

Status: specified, not implemented. Locked-roster runs remain the baseline
format. A window run is a labeled variant; the delta between the two is the
measurement. Do not make the window the default.

## What this measures

The draft league currently has no in-run feedback loop: a draft error is
permanent. The window closes that loop once, mid-season, and instruments
diagnosis altitude — given its own results, does a seat correctly locate its
problem at the roster level (swap), the build level (fix movesets within the
existing roster, swap nothing), or the piloting level (change nothing)?
Keeping the roster is a first-class outcome, not a failure to engage.
Ground-truth probes from run 3: inkling's fix was a moveset (Electro Shot —
per-series fixable; roster churn would be the wrong altitude), kimi's was
roster/mega flexibility, and Opus's no-mega Tyranitar lean was correct under
locked rosters but arguably wrong with access to the undrafted Mega Tyranitar
package — the window turns that prior into a does-evidence-overcome-prior
question.

Information parity, not scaffolding: seats get what a human coach has (own
results, own accumulated notes, public rosters, the board). No "what went
wrong" analysis, no diagnostic checklist, no suggested swaps. The diagnosis is
the measurement.

## Provenance

Modeled on Wolfey's Draft League. S1 ran unlimited post-draft grace-period
moves plus 6 free-agency moves and 6 trades per team through the end of week
3, frozen after. S2 (Champions format) locked rosters season-long with one
mid-season change week. We adopt the S2 shape (single window) with the S1 cap
(6 moves). Coach-to-coach trades do not exist here — series run in parallel
and seats have no channel to negotiate — so the window is free agency only; a
named deviation from the real leagues.

## Rules

- One window per season, after week K of the round robin. Default K = 3
  (of 7 weeks at 8 seats), configurable per run.
- Each seat may make up to 6 swaps. A swap is one drop plus one add,
  resolved as a pair.
- Adds come from the undrafted pool at board price. Drops refund full board
  price (no friction fee: friction punishes weak models twice).
- The original point budget (100) is a hard ceiling on the post-window
  roster. Roster size stays exactly 10.
- All draft legality rules apply to the post-window roster: entry
  exclusivity, one entry per base species, Mega entries priced separately
  with the stone locked. A seat may buy a Mega entry without having drafted
  its base forme, and may drop a base while adding its Mega (Opus example:
  drop Mr. Rime 3 → add a 1-point mon, drop nothing else, Tyranitar 14 →
  Mega Tyranitar 16 nets +2, balanced by the −2; two swaps, still 100/100).
- Making no changes is a legal, complete response to the window.
- Transactions are sequential in inverse standings order (worst record
  first; ties by the standings tiebreak already used for playoff seeding).
  Each seat sees the live board at its turn: mons dropped by seats earlier
  in the order are immediately available.
- A seat's whole transaction list is submitted in one reply and validated
  atomically by the harness via the existing reject-with-reason retry loop.
  No new enforcement machinery; an illegal list is rejected with the reason
  and the seat replies again.

## Window prompt

Same voice and tool access as the draft prompt (`DRAFT_PROMPT_POLICY`). The
seat receives, in one prompt:

- The league standings table (public: W/L, game score, rank for every seat).
- Its own series results week by week: opponent, roster faced, game scores.
- Its own accumulated words: final draft notebook and per-series reflection
  notes, verbatim. Nothing the harness wrote about its play.
- Every opponent's current roster (public information all season).
- The remaining board in the draft board format, plus its own roster with
  prices and the budget arithmetic (spent, refundable per mon, ceiling).
- The rules above, stated neutrally. The prompt must present "no changes"
  as an ordinary outcome with identical framing weight to swapping —
  a window that reads as an invitation to act is a nudge and taints the
  measurement. Concretely: the instruction lists the two reply shapes in
  one sentence with no ordering emphasis, e.g. reply with
  `{"swaps": [{"drop": "<board-id>", "add": "<board-id>"}, ...], "reasoning": ..., "notebook": ...}`
  where `swaps` may be empty, and the empty list is shown in the schema
  example exactly as prominently as the populated one.

The reply's `notebook` replaces the seat's draft notebook for all subsequent
teambuilds, so a seat that swaps (or doesn't) carries its own rationale
forward. The window prompt gets its own policy object and hash, recorded in
`scaffold` alongside the draft and battle revisions; `DRAFT_PROMPT_POLICY`
itself is untouched so draft scaffolds stay comparable across variants.

## Scheduler barrier placement

The parallel round robin (`runDraftLeague`, the non-`sequentialWeeks` path)
currently schedules every RR series in one `mapLimit` pool, and each series
builds its teams at series start. The window adds exactly one barrier:

1. Schedule only the series with `plan.round <= K` in the first pool and
   await it. Weeks past the barrier must not start — a pre-built team or an
   early-started series would be built against pre-window rosters.
2. Run the window sequentially (one seat at a time, inverse standings from
   the completed weeks-≤K table). This is the only sequential segment; it is
   cheap (one decision per seat, plus retries).
3. Apply transactions: update rosters, write the transaction log, emit a
   draft-view event so the GUI shows the post-window rosters.
4. Schedule the remaining RR series (`plan.round > K`) in a second parallel
   pool. Playoffs are unchanged.

`sequentialWeeks` mode gets the same barrier trivially between week K and
K+1. `throughWeek` runs that stop at or before K never open the window.

## Persistence and resume

- New run artifact `window.json` in the run dir: the window order, each
  seat's transaction list (including empty lists), reasoning, notebook, and
  the resulting rosters. Written once, after all seats have resolved.
- `rosters.json` keeps the draft-time rosters untouched (the draft is the
  draft); post-window rosters live in `window.json`. Everything that reads
  a roster for scheduling, teambuild prompts, publish assets, or the GUI
  resolves through one accessor that overlays `window.json` when present
  and the series is post-window.
- Resume: if `window.json` exists, overlay and continue. If the run dies
  mid-window, completed seats' transactions are replayed from a
  `window.jsonl` decision log (same pattern as series decision replay) and
  the remaining seats run live.
- Run config gains `trade_window: { after_week: number } | null`. Null (the
  default) is the locked-roster baseline. The GUI run setup exposes it as an
  opt-in labeled variant, mirroring the battle-timer treatment.
- Results published from a window run carry the variant label so baseline
  and window standings are never pooled silently.

## Non-goals (v1)

- No coach-to-coach trades (no negotiation channel in parallel mode).
- No multiple windows, no waiver claims on a schedule, no transaction fees.
- No post-draft grace period (S1's 24-hour unlimited period exists to fix
  draft-night accidents; our drafts have no accidents worth amnesty).
