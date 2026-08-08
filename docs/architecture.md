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
reference rewards, and emit canonical evidence. Python must not duplicate those
rules.

No public verifiers package exists yet. The planned static
`vgc-positions-v1` package is a thin native-v1 Python `Taskset`: TypeScript
exports frozen tables; Python strictly parses one action and performs a
deterministic lookup. It needs no Node service at rollout time.

The later dynamic `vgc-draft-circuit-v1` will be a Python `Env` adapter over the
same TypeScript referee. Verifiers will own model calls, agents, runtimes,
traces, evaluation, and training integration; in that adapter it replaces the
local `LLMEngine` and top-level comparative orchestration, not Showdown, replay,
or the domain referee. A verifiers `Agent` is neither a Prime Agent nor an RLM
subagent.

The concise target path is:

```text
verifiers Env -> provisioned runtime -> versioned JSON-lines referee
                                      -> TypeScript domain -> Pokémon Showdown
```

The adapter provisions each role through the verified `Agent.provision(task)`
boundary and starts the compiled TypeScript referee with
`Runtime.open_process`. The runtime image must contain Node and the pinned
bundle. HTTP is only an optional runtime transport; MCP is only for model-facing
mechanics tools. Local source verification does not substitute for separate
Docker, Hub, and hosted compatibility smokes.

`src/frozen-battle-referee.ts` remains the single-game authority. The
`src/frozen-matchday-referee.ts` layer accepts two already accepted strict
construction artifacts, rejects noncanonical or illegal registrations, and
runs up to three seeded native Champions games. The same registered six are
used throughout; native team preview supplies a fresh bring-four and lead choice
each game, and the pinned format supplies forced open team sheets. An explicit
private notebook replacement is available between games as evidence only.

`src/frozen-matchday-protocol.ts` and `tools/frozen-matchday-referee.ts` expose
that matchday as JSON lines over stdio, with a 32 MiB limit per request line. The
protocol binds `episodeId`, an opaque caller-supplied `conditionDigest`, the
JSON-lines, matchday, and battle protocol versions, the Showdown SHA, and a
`configDigest` that commits to the format, game seeds, seat names, and
construction and team digests. The JSON-lines session is a trusted referee
interface, not seat authentication. The future adapter will mediate role access;
snapshots remain sealed referee state and private evidence remains seat-private.
Snapshots restore the nested native battle and replay completed games to validate
their terminal evidence. Process tests drive both the single-game and matchday
binaries over stdio. This slice still does not draft, run a model, compute
circuit reward, or provide a verifiers package.

The three named, non-comparable rollout profiles and their isolation rules are
canonical in [Measurement](measurement.md). None is implemented as a published
Draft Circuit today.

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
