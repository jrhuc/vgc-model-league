# Visualisation plan

League runs produce draft, team build, decision, and battle evidence. The GUI
must make this evidence useful without mixing visitor pages with analysis.

Use two rules:

1. League and tournament pages tell the story of an event.
2. The data room compares model behavior across all modes.

Keep mode-specific values with their mode. Examples include rotation Elo,
draft budgets, and bracket placement.

## Information architecture

| Group | View | Content |
| --- | --- | --- |
| Run | New run | Fixtures and pools |
| Run | Live run | Arena and active draft room |
| Records | Draft leagues | Franchises, rosters, rationales, schedule, and results |
| Records | Tournaments | Brackets and placements |
| Records | Data | Model profiles, play patterns, ratings, latency, and reliability |

Use these hash routes:

```text
#leagues
#leagues/<run-id>
#leagues/<run-id>/<team>
#tournaments
#tournaments/<run-id>
#data
#data/<model-id>
```

Use `pushState` for drill-down navigation. Browser Back must return to the
previous archive page.

Keep league and tournament pages concise. Link detailed statistics to the
related model profile.

## Draft league archive

### League list

Show one card for each stored draft league. Each card shows the board, date,
coaches, and champion.

### League page

Show:

- board and date;
- current stage or champion;
- models, budget, format, duration, token use, and known API cost;
- one card for each franchise;
- round-robin standings;
- the weekly schedule and playoff results;
- the draft board with pick numbers and remaining entries.

A franchise card shows its name, model, record, finish, points spent, and
roster sprites. A sprite reveals the pick number and recorded rationale. The
card links to the team page.

A series entry shows game winners and turn counts. It links to the stored
series detail.

### Team page

Show the full draft in pick order. Include each rationale and mark fallback
picks. For each series, show the six selected Pokémon, built sets, result, and
changes from the previous series.

## Tournament archive

Show one card for each stored tournament. The tournament page uses the bracket
as its main view. Move the current tournament card out of the data room.

## Data room

Make Play the default view. Aggregate model behavior across rotation, draft,
tournament, and exhibition. Use mode and pool as filters.

A model profile shows:

- model ID, providers, first use, and last use;
- totals for series, games, decisions, and tokens;
- reasoning tokens per decision and outcome;
- latency, interquartile range, and token throughput;
- switch, Protect, spread move, ally target, and Mega timing rates;
- lead changes, bring changes, repeated actions, and threat conversion;
- fallbacks, parse failures, retries, and abandoned decisions;
- records for each mode with links to related archives.

Keep the rotation ladder, head-to-head results, and rating trajectory in the
data room. Keep brackets in the tournament archive.

## Model marks

Store checked-in pixel SVG files in:

```text
src/gui/client/public/logos/<slug>.svg
```

Use a 12 by 12 grid and crisp rectangular shapes. Resolve a mark in this
order:

1. exact model family;
2. provider or laboratory;
3. first-letter monogram.

Provide marks for Claude, GPT, Gemini, Grok, Kimi, DeepSeek, Qwen, GLM, Llama,
Muse, and Mistral. Use the marks in league cards, standings, arena headers, and
data tables.

## Data changes

Add these API routes:

- `GET /api/leagues` lists stored draft and tournament runs.
- `GET /api/league?run=` joins run configuration, rosters, draft records,
  results, and team build summaries.
- `GET /api/model?id=` returns global result and decision aggregates.

Guard every run identifier with the existing `SAFE_SEGMENT` rule.

Add `reasoning_tokens` to decision log rows and decision totals. Backfill old
decision logs from trace usage so runs 1 through 3 remain usable.

Request OpenRouter usage accounting and store reported cost with token usage.
Treat cost as optional. Mark a run total as partial when any provider omits
cost. Backfill known costs for runs 1 through 3 from account records.

Cache parsed result rows by file modification time. Do not parse the complete
results file for each request.

Extend publication bundles with draft rosters, draft rationales, and built
sets. Keep prompts and raw responses local.

## Visual rules

Keep the current broadsheet system:

- paper `#f4f7fb`;
- ink `#0b1b34`;
- blue `#1458e6`;
- thin borders and square corners;
- condensed display type and monospaced labels.

Use the card and drill-down structure from `wolfeydraftleague.com/teams`. Do
not copy its dark theme. Move chart colors from TypeScript constants to CSS
variables.

## Implementation order

Do not build or change generated files while a run is active.

1. Add the draft league and tournament archives.
2. Add the model marks.
3. Rework the data room and add model profiles.
4. Add reasoning-token and cost data.
5. Extend publication bundles and route history.
6. Remove obsolete views and data paths.

Use the league-page mockup from the 2026-07-27 session as the visual reference.
