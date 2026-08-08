# Architecture

VGC Model League has a headless CLI and a browser GUI; there is no terminal UI.
The server owns validation, files, and contextual evidence. The Preact client
renders typed API data and is never an alternate scoring authority.

## Application surfaces

`src/cli.ts` defines commands. `src/gui/server.ts` serves the JSON API, static
assets, and server-sent events; `src/gui/client/` contains the client. Shared API
shapes belong in `src/gui/api.ts`.

The GUI opens on **Overview**, which states the position method, the draft
circuit stages, and what the server actually holds. **Position Lab** shows
validated public position artifacts, provenance, gates, and decision evidence.
**Draft leagues** is the exploratory season archive; there is no runnable Draft
Circuit. **Live run**, **Tournaments**, and **New run** are operational paths.
Private scores, snapshots, opponent requests, or sealed panels must never be
served to a model or browser.

## Local experiment protocols

Every result records its mode, protocol version, Showdown revision, and the
model-visible `scaffold`: prompts, renderers, tool schemas, decision policy, and
context policy. Provider routing, sampling, execution adapter, timer, and resume
attempts are separate provenance. Change a protocol or scaffold version when a
model-visible condition changes, not for evidence-only logging.

`src/series.ts` runs the shared best-of-three flow. Experiment modes do not alter
the battle engine or Showdown boundary.

- **Rotation** (`src/rotation.ts`) mirrors model/team assignments. Its rows are
  controlled contextual outcomes, not a rating.
- **Tournament** gives each entrant one validated team for a single-elimination
  bracket. Seeded event pools preserve their bracket slots; models are shuffled
  across teams. A draw advances the higher seed while remaining a draw in the
  result. Resume reconstructs the stored draw and adopts only valid recorded
  evidence.
- **Draft league** (`src/draft.ts`, `src/teambuild.ts`) snake-drafts species or
  formes under exclusivity, Species Clause, roster-size, and point constraints.
  Before every series a coach selects six roster members and builds complete
  sets. Showdown validates format legality; league rules enforce draft-specific
  constraints such as Mega locks. The current league also supports one
  mid-season transaction window and terminal season reviews; see
  [Trade window](trade-window.md) and [Season review](season-review.md).
- **Exhibition** (`src/seat.ts`) exposes one seat over a loopback bearer-token
  bridge. Its owner-only workspace modes protect tokens from other users, not
  processes under the same UID. It provides no filesystem, process, credential,
  network, egress, or delegation isolation and is never a controlled comparison.

Within a draft league, a private full-replacement roster note carries across
picks and the transaction window. Each matchup plan initializes a separate
series notebook. Round-robin builds are blind to other round-robin results;
playoff coaches may receive their own prior builds, results, and final notes.
Franchise names are presentation metadata and never enter competitive prompts.

## Decision contract

A local `LLMEngine` seat receives only its authorized view:

- public field state and timers, exact own-Pokémon state, and both open team
  sheets when the format uses them;
- its bounded private timeline and series notebook;
- numbered request-derived joint-action candidates and matchup references;
- optional bounded mechanics tools for dex data, exact format-aware stats, and
  damage from the live request and visible sheets.

Tools calculate mechanics; they do not recommend choices or trust a model to
supply hidden battle state. The model returns one JSON object:

```json
{"choices":[0,2],"rationale":"optional evidence","notebook":"optional complete replacement"}
```

Only a legal `choices` array affects the referee. Rationale and notebook are
optional evidence; malformed evidence cannot invalidate an otherwise legal
action. Invalid choices follow the recorded decision retry/default policy.
Model-choice defaults, Showdown substitutions, and room-timer defaults remain
distinct. Provider failure under a timer leaves the decision to Showdown;
simulator, reference, or team-validation failure stops the run.

Each seat also writes an append-only authorized context stream. That stream
records observations and submissions, not accepted simulator transitions; join
it with game/referee evidence for legality or outcome claims. Recovery appends a
new attempt and reconstructs explicit state from evidence. It does not preserve
a provider session, hidden memory, or concurrent-owner lock. Operators must not
resume the same run concurrently.

## Pokémon Showdown authority

The application loads the pinned Showdown battle stream, dex, validator, and
room timer directly; it does not run Showdown's HTTP server. Showdown alone
decides battle legality, randomness, accepted transitions, and results. League
validation covers only protocol rules Showdown does not know.

`showdown.lock.json` accepts the official repository at a full commit SHA. Setup
installs upstream dependencies without lifecycle scripts, compiles explicitly,
and retains only required runtime code. Updating the pin builds and tests the
league before keeping it. Every result records the actual revision.

Battles are untimed unless a run selects a timer scale. A separate wall-clock
guard stops runaway provider calls; limits are failure guards, not the baseline
thinking budget.

## Evaluation and artifact boundary

The local league generates exploratory trajectories. The evaluator replays only
games bound to exact teams and current provenance, and refuses any source that
does not reproduce its stored log. `src/eval/fork.ts` owns snapshots, forks,
request-menu candidate enumeration, and native Showdown acceptance filtering.
Evaluation manifests bind the Showdown SHA, reference
configuration, action encoding, source corpus, executed evaluator, seeds, and
content digests.

Position artifacts have three physically separate classes:

1. **Public tasks:** neutral point-of-view prompts and numbered
   Showdown-accepted candidate actions.
2. **Private scores:** qualification evidence and frozen action values.
3. **Sealed grader state:** snapshots, opponent requests, draws, and rectangular
   action-value matrices.

Model-facing and browser loaders accept only public tasks. Candidate files are
immutable and remain `release_ready: false`; freezing a candidate does not waive
the release gates in [Evaluation plan](evaluation-plan.md).

## TypeScript, Python, and verifiers

TypeScript and the pinned Showdown bundle remain the domain and referee layer.
They validate teams and actions, advance state, reconstruct battles, calculate
reference rewards, and emit canonical evidence. TypeScript itself does not run
models, and Python must not duplicate its domain rules.

Keep three package boundaries distinct:

- The planned public `vgc-positions-v1` package is a static native-v1 Python
  `Taskset`. TypeScript will export frozen tables; Python will strictly parse one
  action and perform a deterministic lookup, with no Node service at rollout
  time. It is not implemented or released.
- The implemented `vgc-frozen-matchday-v0` package is internal and unpublished.
  Its native-v1 `Taskset` plus `Env` adapts only the already accepted
  strict-construction-to-Bo3 matchday slice.
- The future `vgc-draft-circuit-v1` is a connected multi-seat `Env` spanning the
  draft, schedule, regular season, playoffs, and a frozen circuit return. Those
  connections and semantics are absent from the internal matchday package.

In a dynamic adapter, verifiers owns model calls, agents, runtimes, traces, and
episode control. It replaces the local `LLMEngine` and top-level orchestration,
not Showdown, replay, or the TypeScript referee. A verifiers `Agent` is neither a
Prime Agent nor an RLM subagent. The path is:

```text
verifiers Env -> provisioned runtime -> versioned JSON-lines referee
                                      -> TypeScript domain -> Pokémon Showdown
```

The frozen wire tuple is exactly JSONL protocol 1, matchday protocol 2, and
battle protocol 2. `src/frozen-battle-referee.ts` is the single-game authority.
`src/frozen-matchday-referee.ts` accepts two strict construction artifacts,
rejects noncanonical or illegal registrations, and runs up to three seeded
native Champions games. The registered six stay fixed for the Bo3 while native
team preview supplies a fresh bring four and lead two each game.

Matchday-v2 observations have seat-specific top-level `povLines` queues. When a
game ends, each seat's unread final native POV delta enters its own queue; an
observation drains only that seat's queue, so one seat cannot consume the
other's final lines. Snapshot restoration replays completed games, validates
that each stored completed-game POV cursor was an observable cursor, and checks
the remaining per-seat queues against valid native suffixes. Nested battle
observations continue to carry the live game's seat-specific deltas.

`src/frozen-matchday-protocol.ts` and `tools/frozen-matchday-referee.ts` expose
the matchday as JSON lines over stdio. The binding covers `episodeId`, an opaque
caller-supplied `conditionDigest`, all three protocol versions, the Showdown SHA,
and a `configDigest` committing to format, game seeds, seats, constructions, and
teams. The session is a trusted referee interface rather than seat
authentication; snapshots remain sealed referee state and private evidence stays
seat-private.

The internal Python adapter provisions entrant, opponent, and referee roles with
three distinct nonempty live runtime IDs and one homogeneous runtime type. It
forces all roles nontrainable, opens the compiled TypeScript referee in the
referee role through `Runtime.open_process`, and uses a fresh one-turn
interaction for every requested action and between-game notebook opportunity.
Authorized POV history and the referee-retained current notebook are explicitly
reinserted into each fresh seat prompt; the notebook can mediate later choices
but never directly changes referee state, legality, RNG, score, or outcome.
Python produces only matchday traces, joins, and the descriptive terminal
`matchday_outcome_v0`; it implements no draft, connected circuit, circuit return,
or training policy.

See the [internal package README](../environments/vgc_frozen_matchday_v0/README.md)
for its detailed construction, runtime, failure, and evidence contracts. Local
source and subprocess verification do not establish isolated-image, provider,
Docker, Hub, hosted, or training support. The three named, non-comparable rollout
profiles and their isolation rules remain canonical in
[Measurement](measurement.md).

## State, evidence, and trust

Local evidence is file-based:

- `runs/`: configuration, decisions, traces, games, and mode-specific logs;
- `records/results.jsonl`: one append-only row per completed series;
- `teams/` and `boards/`: immutable input snapshots.

`status.json` is a best-effort lifecycle marker (`done`, `failed`, `stopped`, or
a running owner PID), not an exclusive lease. The first scheduler failure aborts
queued and active work while completed evidence remains. Raw submissions,
referee transitions, and attempt/supersession events are append-only; summaries
are observational projections and never feed legality or reward.

Hosted SQLite stores users, sessions, OAuth flows, ownership, experiments, and
audit events. Series/game/decision evidence remains in files. Imports validate
before writing, write support files before result rows, and are idempotent by
`run_id` plus `series_id`.

Local mode binds to loopback. Hosted mode accepts one configured public origin;
anonymous users are read-only and GitHub OAuth grants contributor/operator
roles. Browser-supplied provider keys stay in server memory for the run and are
never written to state or evidence. Hosted runs use a separate heap-bounded
process. Public spectators receive only Showdown's public split-log branch;
private battle data is owner/operator-only.

See [Deployment](deployment.md) for service configuration and
[Usage](usage.md) for operator commands.
