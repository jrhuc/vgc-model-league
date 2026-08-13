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

The static GitHub Pages build is an archive-only view. Its navigation retains
the research and archive routes but omits **Live** and **New run**, and those
hashes resolve to Home. Build-time capability and loader selection also excludes
the operational module graph. This is not a hidden or disabled control.

The browser API does not serve private position scores, snapshots, opponent
requests, or sealed panels. Raw run evidence stays in the trusted local
workspace. Published archives use the facts-only projection defined in
[State, evidence, and trust](#state-evidence-and-trust).

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
  draft-specific constraints such as Mega locks. The protocol includes one
  mid-season transaction window and terminal season reviews. See [Trade
  window](trade-window.md) and [Season review](season-review.md).
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

## Evaluation and artifact boundary

The local league generates exploratory trajectories. The evaluator replays only
games bound to exact teams and current provenance. It rejects a source if the
stored log cannot be reproduced. `src/eval/fork.ts` is the authority for
snapshots, forks, request-menu candidate enumeration, and native Showdown
acceptance filtering.
Evaluation manifests bind the Showdown SHA, reference configuration, action
encoding, source corpus, executed evaluator, seeds, and content digests.

Position artifacts use exactly two physically separate roots:

1. **Public:** the v1 candidate manifest, neutral point-of-view tasks, and
   numbered Showdown-accepted candidate actions.
2. **Private:** score and qualification rows, sealed snapshots, opponent
   requests, draws, and rectangular action-value matrices.

The exporter keeps these roots physically separate and writes immutable
candidate files. A future native package reader must accept only the public root
and verify its complete manifest and layout. That maintained reader is not
connected today. Creating a candidate file does not satisfy the release gates
in the [Evaluation plan](evaluation-plan.md#program-status).

For `circuit-trace-v1`, `manifest.json` binds the raw curated and full JSON
bytes. The clean-checkout checker verifies manifest paths and hashes and scans
the raw manifest, curated, and full bytes for credentials and private locators.
The runtime loader, not the generic checker, validates every field and
cross-event join rendered by Home and Method and rejects hash mismatches. The
[Evaluation plan](evaluation-plan.md#program-status) records artifact status and
source gaps.

## TypeScript, Python, and verifiers

TypeScript and the pinned Showdown bundle provide the domain and referee layer.
They validate teams and actions, advance state, reconstruct battles, calculate
terminal returns, and emit canonical evidence. TypeScript does not run models.
Python must not duplicate the TypeScript domain rules.

Keep these package boundaries separate:

- `vgc-positions-v1` is specified as a static native-v1 Python `Taskset`.
  TypeScript exports frozen tables. At rollout time, Python strictly parses one
  action and performs a deterministic lookup without a Node service.
- `vgc-circuit-v1` provides exactly one native-v1 `Taskset` and one
  native-v1 `Env`. Its finite taskset selects exactly one implemented scenario
  per evaluation. The environment connects eight configurable player roles and
  one non-playing referee role for a complete league or tournament.

Only the [Evaluation plan](evaluation-plan.md#program-status) defines
implementation, release, compatibility, and support status for these packages.

Verifiers manages model calls, agents, runtimes, traces, and episode control. It
replaces the local `LLMEngine` and top-level orchestration. It does not replace
Showdown or the TypeScript referee. A verifiers `Agent` is not a Prime Agent or
an RLM subagent.

```text
Python / verifiers v1: routing, lifecycle, and trace joins

  native-v1 Taskset ---> Env ---> seat1 ... seat8 runtimes
                           |          ^
                           |          | fresh one-turn prompt / reply
                           |          v
                           +---- JSONL RuntimeProcess ----+
                                                        |
TypeScript / Showdown: domain authority                 v

  circuit protocol -> circuit referee coordinator
                        |-- draft / construction
                        |-- trade / schedule / bracket
                        |-- receipts / terminal evidence
                        `-- each series
                              `-- matchday referee
                                    `-- battle referee
                                          `-- pinned Showdown
```

The Python package keeps this routing boundary explicit: `taskset.py` supplies
the finite tasks, `env.py` manages the nine roles and trace lifecycle,
`protocol.py` owns the bounded process client, and `_wire.py` validates the
exact referee evidence schema.

Each pending player decision starts a fresh, one-turn verifiers interaction in
that player's runtime. The TypeScript referee supplies the complete authorized
prompt for that turn, accepts the raw response, applies its retry or default
policy, and returns a receipt. Python transports these messages, checks the
binding and terminal joins, and attaches the TypeScript-defined terminal return
after full validation. It does not parse a parallel draft, construction,
transaction, or battle command language.

`src/frozen-circuit-referee.ts` coordinates the circuit state machine. The
`frozen-circuit-model.ts`, `frozen-circuit-setup.ts`,
`frozen-circuit-transactions.ts`, `frozen-circuit-ledger.ts`, and
`frozen-circuit-evidence.ts` modules separate its protocol model, scenario
setup, transaction phase, decision ledger, and terminal evidence. They reuse the
existing draft, strict-construction, round-robin, playoff, and transaction
authorities. Each series reuses `src/frozen-matchday-referee.ts`, which in turn
uses `src/frozen-battle-referee.ts` and the pinned Showdown authority. A registered
six remains fixed for the series, and each game starts a fresh native team
preview. Elimination series that remain tied after the three regulation games
use deterministic extra-game seeds, with a nine-game limit.

`src/frozen-circuit-protocol.ts` and `tools/frozen-circuit-referee.ts` expose the
circuit as JSON lines over standard input and output. The wire tuple is JSONL 1,
circuit 2, prompt 2, matchday 1, and battle 1. The binding covers the episode,
task condition, scenario and seed, all protocol versions, the Showdown SHA, the
prompt revision, and a configuration digest. The session is a trusted referee
interface, not seat authentication.

The [internal package
README](../environments/vgc_circuit_v1/README.md) defines the detailed
scenario, role, runtime, trace, reward, and failure contracts.

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

The public deployment is a static export, not a server. `vgcleague export-site`
uses the same DTO builders as the console to project terminal, non-test archives
and writes the output as committed JSON. Historical team-build projection uses
`decodeArchivedTeamBuildJournalRow` from `src/teambuild.ts`; current resume uses
the strict `{artifact}` journal decoder from the same module. Archive projection
is not a second resume authority. GitHub Pages serves these files
unchanged. A live run appears only in the local console. It enters the public
export only after it finishes and an operator exports the site again. Therefore,
publication is an explicit operator action on terminal evidence, not a side
effect of play.

The exported archive contains result rows, game logs, decision rationales,
notebooks, reflections, season reviews, and league support assets. These files
form the recorded evidence layer. The export does not contain prompt-attempt
logs, raw provider responses, thought or trace logs, seat-context JSONL, grader
state, or API credentials. Export builders read named, bounded artifact files
that also contain private fields and structurally project their output. This is
a response boundary; it does not mean that the exporter never reads the source
bytes. A separately reviewed immutable bundle, the selected GUI trace, is a
distinct publication artifact and does not change this rule.

See [Deployment](deployment.md) for the static-site pipeline and
[Usage](usage.md) for operator commands.
