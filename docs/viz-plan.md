# Visualisation plan

A league run produces on the order of tens of millions of tokens of evidence —
draft rationales, teambuild reasoning, per-decision traces, protocol-joined
turn logs — and the GUI currently surfaces almost none of it. This plan
reorganises the site around two ideas:

1. **Leagues are stories.** A finished draft league deserves an archive page a
   person can browse: the franchises, who drafted what and why, the matchups,
   the bracket. Inspiration is wolfeydraftleague.com/teams (card grid → roster
   detail), adapted to our broadsheet design language, not copied.
2. **Models are the through-line.** Stats that describe *how a model plays* —
   reasoning tokens per decision vs outcomes, latency, switch/Protect/spread
   tendencies, tool use, reliability — are mode-agnostic and should aggregate
   across every game in every mode. Stats that only mean something inside a
   mode (rotation Elo, draft budgets, bracket placements) stay under their
   mode. Today's data room conflates the two by scoping everything to a pool.

## Site information architecture

The records side splits by **audience**, not by data shape: draft leagues and
tournaments are the visitor-facing visualisations (teams, brackets, stories);
the data room is the analyst layer where every detailed or mathematical
insight lands.

| Group | View | Content |
| --- | --- | --- |
| Run | **New run** | unchanged (fixtures + pools) |
| Run | **Live run** | unchanged arena; the draft room remains the live-league view during a draft run |
| Records | **Draft leagues** | NEW — archive of draft leagues: team cards, rosters, rationales, standings, schedule |
| Records | **Tournaments** | NEW — bracket visualisations and placements (TournamentCard moves here from the data room) |
| Records | **Data** | the analyst room. Default tab is **Play** (per-model tendencies, aggregated across all modes); model drill-down profiles, the rotation ladder, latency/reliability all live here |

Routing stays hash-based: `#leagues`, `#leagues/<run-id>`,
`#leagues/<run-id>/<team>`, `#tournaments`, `#tournaments/<run-id>`, `#data`,
`#data/<model-id>`. `navigate()` should switch to `pushState` so back
navigates the archive drill-down.

League and tournament pages stay deliberately stat-light — records, rosters,
results, rationales — with "full stats →" links into `#data/<model-id>` so
charts don't creep back into the visitor pages.

## Draft leagues archive

**Landing (`#leagues`)** — one row/card per archived draft league: board,
date, coaches with logos, champion. Tournaments get the same treatment on
their own `#tournaments` landing, with the bracket as the flagship visual.

**League page (`#leagues/<run-id>`)** — the flagship view (see mockup):

- Header: league name (board + date), stage/champion banner, and a run-facts
  strip for visitors who want to run their own: models, board, budget/points
  params, series format, wall-clock duration, total tokens, and **total API
  spend** where known.
- **Team cards**, one per franchise: pixel model logo, franchise name, model
  id, W-L record and finish, budget spent, roster as a sprite grid with point
  costs. Hovering a sprite reveals the pick number and the coach's recorded
  draft rationale for that pick (from `draft/draft.jsonl`, which stores full
  rationale text per pick). Click-through → team page.
- **Standings** for the round robin (game diff as tiebreak display).
- **Schedule & results**: RR weeks then playoffs, each series showing per-game
  winners/turn counts, linking to the archived series detail.
- **Draft board tab**: the board grid with drafted picks overlaid (pick number
  + franchise), undrafted mons dimmed — the "what was left on the board" view.

**Team page (`#leagues/<run-id>/<team>`)** — the full draft in pick order with
complete rationales (fallback picks flagged), then per-series entries: the six
brought, the built sets (from `teambuild/*.jsonl`), result, and how the sheet
changed series to series — data Wolfey's league can't have.

## Data room

**Play is the default tab.** Landing on `#data` shows the per-model play
tendencies (the current Play section, promoted), aggregated across all games
in all modes with mode/pool as *filters*. Clicking a model opens its profile.

**Model profiles (`#data/<model-id>`)** aggregate every decision the model
has made across all modes (rotation, draft, tournament, exhibition):

- Identity: pixel logo, model id, providers seen, first/last played, totals
  (series, games, decisions, tokens).
- **Reasoning depth vs outcome**: reasoning tokens per decision against win
  rate / decision quality proxies. Requires the plumbing change below.
- Latency & throughput: median/IQR wall-clock, tokens/sec (already in traces).
- **Play fingerprint**: the decision_stats counters that exist in every result
  row but are never surfaced — switch %, Protect % (+ consecutive-Protect),
  spread-move %, ally-target %, mega timing, lead/bring changes between games,
  repeated joint actions, threat conversion. Rendered as a compact per-model
  bar profile, comparable across models.
- Reliability: fallbacks, parse failures, retries, abandoned decisions
  (today's collapsed "scaffold health" table moves here).
- Mode ledger: per-mode records with links into Leagues / ladder.

Beyond Play and profiles, the data room keeps the rotation ladder (Elo, H2H,
trajectory — the only rated, controlled comparison) and any future
cross-cutting analytics. Brackets leave for `#tournaments`; everything
detailed or mathematical arrives here.

## Pixel logos

Every model gets a pixel-art mark in the same visual register as the gen-5
sprites. Checked-in SVGs (crisp-edged rects on a 12×12 grid) at
`src/gui/client/public/logos/<slug>.svg`, resolved from the model spec.

- **Model-family marks first, lab marks second**: claude (sunburst), gpt
  (blossom), gemini (spark), grok, kimi, deepseek (whale), qwen, glm, llama /
  muse (Meta infinity until Muse has its own mark), mistral. Moonshot and xAI
  are in the drawn set — the monogram fallback is only for genuinely unseen
  providers.
- Resolution: exact model-family match on the model id → family mark; else
  provider/lab mark; else monogram (first letter, ink on paper).
- Used everywhere a model appears: league cards, standings, arena headers,
  data room tables.

## Data plumbing

- **`GET /api/leagues`** — scan results.jsonl for draft/tournament run_ids,
  join `runs/<id>/config.json` (already read by `configEntrants`) for names.
- **`GET /api/league?run=`** — config.json + rosters.json + draft.jsonl +
  results rows for the run + teambuild summaries. All reads guarded by the
  existing `SAFE_SEGMENT` pattern in evidence.ts.
- **`GET /api/model?id=`** — global aggregate over results.jsonl rows +
  per-decision points (readLatencyPoints, extended).
- **Reasoning tokens**: today they exist only in `p*-trace.jsonl` /
  `drafter-*.jsonl` / teambuild logs (`usage.reasoning_tokens`, only when >0).
  Two-part fix: (a) write `reasoning_tokens` into `p*-decisions.jsonl` rows at
  the llm-engine decision-log writer and add a total to `decision_stats`;
  (b) a one-off backfill script that reads traces and patches existing
  decisions files so run 1–3 data is usable.
- **API spend capture**: OpenRouter's usage accounting (`usage: {include:
  true}` on the request) returns per-request cost in credits; record it
  alongside token usage in traces/decision logs and sum into a per-run
  `spend` figure (results rows or run summary). Optional per provider —
  free-tier/keyless providers report nothing, so the league header labels
  partial sums as such. Backfill runs 1–3 from the known account deltas
  (run 3 ≈ the $23.78→final credits window).
- **Caching**: `loadRows()` re-reads and re-parses all of results.jsonl on
  every request; add an mtime-keyed cache before fan-out grows.
- **Publish gap**: `vgcleague publish` currently ships result rows + decision
  logs only. League archives on a deployment need rosters.json, draft.jsonl
  (rationales, no prompts), and built sets from teambuild logs added to the
  payload. Prompts and raw responses stay local as before.

## Design language

Keep the existing broadsheet system (paper `#f4f7fb`, ink `#0b1b34`, blue
`#1458e6`, hairline borders, square corners, condensed display + mono labels).
Wolfey's dark-zinc theme is not adopted; what we take is the structure — card
grid, sprite tiles, drill-down hierarchy. Chart colors should move from the
hardcoded constants in dataroom.tsx to CSS variables while we're in there.

## Phasing (all after the current run exits — no dist builds while live)

1. Draft-league archive: endpoints + landing + league page + team page.
   Tournaments page (brackets move out of the data room). Pixel logo set.
2. Data room re-cut: Play as default tab, model profile drill-downs,
   reasoning-token plumbing and backfill.
3. Publish-payload extension, `pushState` routing, residual cleanup.

Mockup of the league page (real run-3 data): see the published artifact from
the 2026-07-27 session; iterate there before building.
