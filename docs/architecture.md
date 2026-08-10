# Architecture

VGC Model League has a headless CLI and a browser GUI; there is no terminal UI.
The server owns validation, files, and contextual evidence. The Preact client
renders typed API data and is never an alternate scoring authority.

## Application surfaces

`src/cli.ts` defines commands. `src/gui/server.ts` serves the JSON API, static
assets, and server-sent events; `src/gui/client/` contains the client. Shared API
shapes belong in `src/gui/api.ts`.

The **Research** routes are **Home**, **Method**, and **Docs**. Home and Method
render one server-loaded projection of the hash-bound selected artifact. The
**Workspace** routes are **Draft leagues**, **Live**, **Tournaments**, and **New
run**. Draft leagues is an exploratory season archive, not a connected
evaluation circuit.

Anonymous and authorized operational views are different API projections.
Private position scores, snapshots, opponent requests, and sealed panels remain
offline and are never browser data. Raw run evidence is available only in a
trusted local workspace or to an authorized owner/operator; the anonymous view
is the facts-only projection specified under [State, evidence, and
trust](#state-evidence-and-trust).

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
  constraints such as Mega locks. The protocol includes one
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

The default round robin runs blind, concurrency-limited batches: every scheduled
series through the configured transaction week completes before the window, and
the remaining series form the next batch. With no window, all round-robin series
share one batch. `--sequential-weeks` is a distinct execution option, and
`--through-week` implies it. Scheduling changes the information/timing condition
and must be recorded rather than pooled silently.

## Decision contract

A local `LLMEngine` seat receives only its authorized view:

- public field state and timers, exact own-Pokémon state, and both open team
  sheets when the format uses them;
- its bounded private timeline and series notebook;
- numbered request-derived joint-action candidates and matchup references;
- optional bounded mechanics tools for dex data, exact format-aware stats, and
  damage from the live request and visible sheets.

Tools calculate mechanics; they do not recommend choices or trust a model to
supply hidden battle state. A common model-visible format-authority notice also
appears in draft, construction, transaction, battle decision/reflection, and
season-review roles. It neutrally tells seats to treat the prompt and pinned
simulator as authoritative when Champions postdates their training data; it
contains no matchup strategy. Its bytes are part of each affected scaffold
identity.

The model returns one JSON object:

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

Position artifacts use exactly two physically separate roots:

1. **Public:** the v1 candidate manifest plus neutral point-of-view tasks and
   numbered Showdown-accepted candidate actions.
2. **Private:** score and qualification rows together with sealed snapshots,
   opponent requests, draws, and rectangular action-value matrices.

Model-facing and browser loaders accept only the public root. Candidate files are
immutable, and their release status is owned only by the
[Evaluation plan](evaluation-plan.md#program-status); constructing them does not
waive any release gate.

The TypeScript matchday task-source freezer is a separate private artifact
path. Its contract validates accepted constructions through the referee and
writes a private `manifest.json` plus `task-source.jsonl`. Publication requires
one trusted producer and an immutable repository, build, and runtime tree from
process start through publication. The authority snapshot detects changes only
after capture, loaded
JavaScript module bytes are not independently attested, the reviewed raw-byte
digest assumes the supported POSIX/LF build, and Node provides no portable
atomic directory `NOREPLACE` against a concurrent same-privilege writer.
Freezing is not source review or release approval.

For `circuit-trace-v1`, `manifest.json` binds the raw curated and full JSON bytes.
The clean-checkout checker verifies manifest paths and hashes and scans the raw
manifest, curated, and full bytes for credentials and private locators. The
runtime loader, not the generic checker, validates every field and cross-event
join rendered by Home and Method and refuses a hash mismatch. Artifact status
and source gaps belong in the [Evaluation plan](evaluation-plan.md#program-status).

## TypeScript, Python, and verifiers

TypeScript and the pinned Showdown bundle remain the domain and referee layer.
They validate teams and actions, advance state, reconstruct battles, calculate
reference rewards, and emit canonical evidence. TypeScript itself does not run
models, and Python must not duplicate its domain rules.

Keep three package boundaries distinct:

- `vgc-positions-v1` is specified as a static native-v1 Python `Taskset`.
  TypeScript exports frozen tables; Python strictly parses one action and performs
  a deterministic lookup, with no Node service at rollout time.
- `vgc-frozen-matchday-v0` is limited to a native-v1 `Taskset` plus `Env` adapter
  for the strict-construction-to-Bo3 matchday slice.
- `vgc-draft-circuit-v1` is specified as a connected multi-seat `Env` spanning
  the draft, schedule, regular season, playoffs, and a frozen circuit return.
  Matchday-only behavior cannot supply those connections or semantics.

Implementation, release, and compatibility status for all three belongs only in
the [Evaluation plan](evaluation-plan.md#program-status).

In a dynamic adapter, verifiers owns model calls, agents, runtimes, traces, and
episode control. It replaces the local `LLMEngine` and top-level orchestration,
not Showdown, replay, or the TypeScript referee. A verifiers `Agent` is neither a
Prime Agent nor an RLM subagent. The path is:

```text
verifiers Env -> provisioned runtime -> versioned JSON-lines referee
                                      -> TypeScript domain -> Pokémon Showdown
```

The frozen wire tuple is exactly JSONL protocol 1, matchday protocol 1, and
battle protocol 1. `src/frozen-battle-referee.ts` is the single-game authority.
`src/frozen-matchday-referee.ts` accepts two strict construction artifacts,
rejects noncanonical or illegal registrations, and runs up to three seeded
native Champions games. The registered six stay fixed for the Bo3 while native
team preview supplies a fresh bring four and lead two each game.

`src/frozen-matchday-protocol.ts` and `tools/frozen-matchday-referee.ts` expose
the matchday as JSON lines over stdio. The binding covers `episodeId`, an opaque
caller-supplied `conditionDigest`, all three protocol versions, the Showdown SHA,
and a `configDigest` committing to format, game seeds, seats, constructions, and
teams. The session is a trusted referee interface rather than seat
authentication; snapshots remain sealed referee state and private evidence stays
seat-private.

The [internal package README](../environments/vgc_frozen_matchday_v0/README.md)
owns the detailed role, runtime, notebook, trace, and failure contracts. The
[Evaluation plan](evaluation-plan.md#program-status) owns support and release
status.

## State, evidence, and trust

Local evidence is file-based:

- `runs/`: configuration, decisions, traces, games, and mode-specific logs;
- `records/results.jsonl`: one append-only row per completed series;
- `teams/` and `boards/`: immutable input snapshots.

`status.json` is a best-effort mutable lifecycle marker (`running`, `paused`,
`done`, `failed`, or `stopped`), not an exclusive lease or a release approval.
The first scheduler failure aborts queued and active work while completed
evidence remains. Raw submissions, referee transitions, and
attempt/supersession events are append-only; summaries are observational
projections and never feed legality or reward.

The GUI server is the local operator console. It binds to loopback only, has a
single trust level, and runs experiments in process. Executable inference is
limited to the fixed OpenRouter and Prime Inference endpoints plus the random
baseline. Browser-supplied `OPENROUTER_API_KEY` and `PRIME_API_KEY` values stay
in server memory for the run and are never written to state or evidence.

The public deployment is a static export, not a server. `vgcleague export-site`
projects terminal, non-test archives through the same DTO builders the console
uses and writes the result as committed JSON; GitHub Pages serves those files
unchanged. A live run is visible only on the local console and enters the
public export exclusively by finishing and being re-exported, so publication is
an explicit operator action on terminal evidence, never a side effect of play.

The exported archive carries result rows, game logs, decision rationales,
notebooks, reflections, season reviews, and league support assets — the
recorded evidence layer. It never carries prompt-attempt logs, raw provider
responses, thought/trace logs, seat-context JSONL, grader state, or API
credentials. The export builders read named, bounded artifact files that also
contain private fields and structurally project their output; this is a
response boundary, not a claim that the exporter never reads the source bytes.
A separately reviewed immutable bundle (the selected GUI trace) is a distinct
publication artifact and does not change this rule.

See [Deployment](deployment.md) for the static-site pipeline and
[Usage](usage.md) for operator commands.
