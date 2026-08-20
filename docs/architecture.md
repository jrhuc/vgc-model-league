# Architecture

VGC Model League provides a headless CLI and a browser GUI. It does not provide
a terminal UI. The server is the authority for validation, files, and contextual
evidence. The Preact client renders typed API data and is not a scoring
authority.

## Application surfaces

`src/cli.ts` defines the commands. `src/gui/server.ts` owns HTTP security,
JSON routes, static assets, and server-sent event transport.
`src/gui/run-request.ts` validates launch requests, while
`src/gui/run-supervisor.ts` owns the active-run lifecycle and event projection.
`src/gui/client/` contains the client. Define shared API shapes in
`src/gui/api.ts`.

The local dynamic console provides the **Research** routes **Home**, **Method**,
and **Docs**, plus the **Workspace** routes **Draft leagues**, **Live**,
**Tournaments**, and **New run**. Home and Method render the same server-loaded
projection of the hash-bound selected artifact. Draft leagues provides an
exploratory season archive. It is not a connected evaluation circuit.

GitHub Pages is a separate zero-runtime documentation build. It does not compile
the Preact client or copy GUI assets and run archives. The local GUI remains an
operator/debug surface only.

Public league presentation belongs to
[ai-draft-league](https://github.com/jrhuc/ai-draft-league). That application
accepts only the versioned public projection described in
[Public publication](#public-publication).

## Local experiment protocols

Each result records its mode, protocol version, Showdown revision, and
model-visible `scaffold`. The scaffold includes prompts, renderers, tool schemas,
decision policy, and context policy. Record provider routing, sampling, execution
adapter, timer, and resume attempts as separate provenance. Change a protocol or
scaffold version when a model-visible condition changes. Do not change either
version for evidence-only logging.

`src/series.ts` implements the shared best-of-three flow. Experiment modes do not
change the battle engine or the Showdown boundary.

- **Rotation** (`src/rotation.ts`) mirrors model and team assignments. Treat its
  rows as controlled contextual outcomes, not as ratings.
- **Tournament** assigns each entrant one validated team for a
  single-elimination bracket. Seeded event pools retain their bracket slots,
  while models are shuffled across teams. A draw advances the higher seed but
  remains a draw in the result. Resume reconstructs the stored draw and adopts
  only valid recorded evidence.
- **Draft league** (`src/draft.ts`, `src/teambuild.ts`) uses a snake draft for
  species or formes under exclusivity, Species Clause, roster-size, and point
  constraints. Before each series, a coach selects six roster members and
  builds complete sets. Showdown validates format legality. League rules enforce
  draft-specific constraints such as Mega locks. The protocol includes weekly
  reviews, a schedule of transaction windows, and terminal season reviews. See
  [Weekly review](weekly-review.md), [Trade window](trade-window.md), and
  [Season review](season-review.md).
- **Exhibition** (`src/seat.ts`) exposes one seat through a loopback bearer-token
  bridge. Its owner-only workspace modes protect tokens from other users, but
  not from processes under the same UID. It provides no filesystem, process,
  credential, network, egress, or delegation isolation. Do not use it as a
  controlled comparison.

Within a draft league, a private full-replacement roster note persists across
picks and the transaction window. Each matchup plan starts a separate series
notebook. Round-robin builds do not receive other round-robin results. Playoff
coaches may receive their own previous builds, results, and final notes.
Franchise names are presentation metadata and do not appear in competitive
prompts.

By default, the round robin runs blind, concurrency-limited batches. Every
scheduled series through the configured transaction week completes before the
window, and the remaining series form the next batch. If the league has no
window, all round-robin series share one batch. `--sequential-weeks` is a
separate execution option, and `--through-week` implies it. Scheduling changes
the information and timing condition. Record this condition and do not pool it
silently with other scheduling conditions.

## Decision contract

A local `LLMEngine` seat receives only its authorized view:

- public field state and timers, exact state for its own Pokémon, and both open
  team sheets when the format uses them;
- its bounded private timeline and series notebook;
- numbered, request-derived joint-action candidates and matchup references;
- optional, bounded mechanics tools for dex data, exact format-aware stats, and
  damage calculations from the live request and visible sheets.

Tools calculate mechanics. They do not recommend choices or rely on a model to
provide hidden battle state. Draft, construction, transaction, battle
decision/reflection, and season-review roles use the same model-visible
format-authority notice. The neutral notice tells seats to treat the prompt and
pinned simulator as authoritative when Champions postdates their training data.
It contains no matchup strategy. Its exact bytes are part of each affected
scaffold identity.

The model returns one JSON object:

```json
{"choices":[0,2],"rationale":"optional evidence","notebook":"optional complete replacement"}
```

Only a legal `choices` array affects the referee. Rationale and notebook are
optional evidence. Malformed evidence does not invalidate an otherwise legal
action. Invalid choices follow the recorded decision retry/default policy.
Keep model-choice defaults, Showdown substitutions, and room-timer defaults
separate. Under a timer, a provider failure leaves the decision to Showdown. A
simulator, reference, or team-validation failure stops the run.

Each seat also writes an append-only authorized context stream. This stream
records observations and submissions, not accepted simulator transitions. Join
it with game and referee evidence when making legality or outcome claims.
Recovery appends a new attempt and reconstructs explicit state from evidence.
It does not preserve a provider session, hidden memory, or a concurrent-owner
lock. Do not resume the same run concurrently.

## Pokémon Showdown authority

The application directly loads the pinned Showdown battle stream, dex,
validator, and room timer. It does not run Showdown's HTTP server. Only Showdown
determines battle legality, randomness, accepted transitions, and results.
League validation covers only protocol rules that Showdown does not know.

`showdown.lock.json` accepts the official repository at a full commit SHA. Setup
installs upstream dependencies without lifecycle scripts, compiles them
explicitly, and retains only required runtime code. An update to the pin must
build and test the league before it is retained. Each result records the actual
revision.

Battles are untimed unless a run selects a timer scale. A separate wall-clock
guard stops runaway provider calls. Limits are failure guards, not the baseline
thinking budget.

## Fork and evaluation boundary

`src/fork.ts` is the authority for battle snapshots, forks, request-menu
candidate enumeration, and native Showdown acceptance filtering.
`src/serialization.ts` defines the canonical JSON bytes and digests that
artifact and evidence files bind to.

Experimental evaluations, the frozen circuit referee stack, and the
`vgc_circuit_v1` verifiers environment live in
[vgc-evals](https://github.com/jrhuc/vgc-evals), which consumes this
repository read-only as a built checkout at a pinned revision.

## State, evidence, and trust

Local evidence uses these files and directories:

- `runs/`: configuration, decisions, traces, games, and mode-specific logs;
- `records/results.jsonl`: one append-only row for each completed series;
- `teams/` and `boards/`: immutable input snapshots.

`status.json` is a best-effort mutable lifecycle marker with the values
`running`, `paused`, `done`, `failed`, and `stopped`. It is not an exclusive
lease or release approval. The first scheduler failure aborts queued and active
work, while completed evidence remains. Raw submissions, referee transitions,
and attempt and supersession events are append-only. Summaries are observational
projections and do not affect legality or reward.

The GUI server is the local operator console. It binds only to loopback, uses a
single trust level, and runs experiments in process. Executable inference is
limited to the fixed OpenRouter and Prime Inference endpoints and the random
baseline. Browser-supplied `OPENROUTER_API_KEY` and `PRIME_API_KEY` values remain
in server memory for the run. The server does not write them to state or
evidence.

## Public publication

`vgcleague export-season` projects one explicit release boundary into a
validated `season-bundle-v2` file and writes its JSON Schema beside it. `--run`
and `--through-week` are required. A value past the last regular-season week
releases playoff rounds. The exporter rejects an incomplete released week or a
completed match without verified replay evidence.

The public layer is the recorded evidence a spectator of the league would see:
draft order with each pick's stated rationale, the board, rosters with how each
Pokémon was acquired, matchup builds with their stated rationale, standings
ranked by the league's own table, released scores, structured battle events,
each submitted decision with its stated rationale, latency, reasoning-token
count and fallback flags, post-game reflections, transaction offers and
responses with their stated reasoning, the bracket, and season reviews once the
season is complete. Closed team sheets stay closed until the season is complete.

The private layer never leaves the run directory: prompt attempts, raw provider
responses, thought and trace logs, seat-context JSONL, notebooks carried between
decisions, grader state, and credentials. A stated rationale is the text a model
submitted as part of its decision; a notebook or trace is how it got there. The
projection accepts rich internal DTOs but selects each allowed field
structurally before validating the result, and the bundle carries the harness
and Showdown commits it was produced from.

GitHub Pages never serves the bundle. Operators pass it to the independent
spectator repository, which owns layout, release timing, and presentation. The
spectator does not run Showdown and cannot calculate legal actions, standings,
winners, or revealed information.

Publication remains an explicit operator action on terminal evidence, not a
side effect of play. See [Deployment](deployment.md) for the command and release
boundary.

See [Deployment](deployment.md) for the static-site pipeline and
[Usage](usage.md) for operator commands.
