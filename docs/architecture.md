# Architecture

VGC Model League has two user surfaces. The CLI runs headless experiments and
reports. The GUI manages experiments and displays live and stored evidence.
There is no terminal UI.

## Application surfaces

`src/cli.ts` defines the CLI commands. `src/gui/server.ts` provides the GUI
server, JSON API, static assets, and server-sent events. The Preact client is in
`src/gui/client/`.

The server is authoritative. It owns game rules, validation, file access, and
contextual run evidence. The client only renders API data.

Declare all client and server data shapes in `src/gui/api.ts`. Both sides
import these types. Keep one file for each top-level view. Extract a shared
component only when more than one view uses it.

## Experiment protocols

`ExperimentMode` contains `rotation`, `tournament`, `draft`, and `exhibition`.
Each run configuration, live snapshot, and result row records its mode and
protocol version. Change the protocol version when evaluation rules make old
and new results incompatible.

Each result also records `scaffold`. This value identifies the prompts, tool
schemas, and sampling parameters that shaped model behavior.

`src/series.ts` runs the common best-of-three flow for rotation, tournament,
and draft modes. Battle engines and the Showdown integration do not depend on
an experiment mode.

### Rotation

`src/rotation.ts` owns the schedule, mirrored assignments, run configuration,
events, and result persistence. Rotation rows remain contextual outcomes; they
are not combined into a public rating.

### Tournament

Tournament entrants receive different teams from a pool or provide validated
team pastes. An entrant keeps the same team through the bracket. Ready matches
run up to the selected concurrency. A draw advances the higher seed but keeps
`winner: null` in the result.

A bracket resumes like a league: the run's seed rebuilds the same draw, the
stored config's entrants are its seat-to-team identity, recorded results settle
their matches and advance their winners, and each series carries its schedule
slot into `src/series.ts` so an interrupted one adopts its directory and
replays what it already played.

A pool may reproduce a real event. Its manifest carries the event and gives
each team a seed and the finish it earned, and `tools/build-event-pool.ts`
builds it. Seeded teams hold their bracket positions instead of drawing at
random, so the field meets in the pairings it earned; the models are still
shuffled across the teams. `--provenance disclosed`, the default, tells each
seat which event this is and that both teams in the match came out of that cut,
and says outright when the stat points were rebuilt rather than published. It
withholds the finishing order: holding the team that lost the final is a fact
about a game these models did not play, and it would steer play rather than
inform it. `blind` withholds all of it and is the control arm. Player names
never enter a competitive prompt; they appear only in the GUI and the pool
manifest.

### Draft League

`src/draft.ts` owns the draft. `src/teambuild.ts` owns team construction. A
board entry represents a species or forme, not a complete set. The `base`
field enforces Species Clause. Mega formes are separate entries and lock their
Mega Stones.

Pick validation enforces exclusivity, one entry for each base species, and the
point budget. It also reserves enough points to fill the remaining roster
slots.

Each drafter maintains a private, full-replacement roster note across its own
picks. The current note is supplied to every matchup build as revisable
context; a transaction-window decision replaces it for later builds.

Once every pick is complete, each non-random coach gets one isolated naming
turn over its finished roster. The playful franchise name is stored separately
from the draft transcript and is presentation metadata for the GUI, CLI,
records, and archive. It never enters a competitive prompt or private note;
draft, teambuild, trade, battle, reflection, and review context identify seats
by their model specifications instead. Historical drafts that recorded a name
on the first pick still load without exposing that name to later decisions.

Before each series, a coach selects six roster members and builds their sets.
Showdown validates format rules. The league validates rules that Showdown does
not know, such as the Mega lock. A failed team build gets another attempt. The
league makes a minimal repair after the final failed attempt and records each
repair.

The draft and team builder use the same bounded dex tools as the battle engine.
The league records each lookup. The stat tool delegates exact spread
calculation to the selected Showdown format, including Champions Stat Points
and fixed IVs.

Round-robin matchups are built blind and may run concurrently. A matchup's
teambuild plan initializes its private battle notebook and persists across the
games in that series. Round-robin builds, sets, results, and final battle notes
are stored in `coaching.jsonl`, but enter model context only for coaches that
reach the playoffs. Later playoff rounds also receive earlier playoff context.

### Exhibition

`src/seat.ts` exposes one `LLMEngine` seat through a token-authenticated local
bridge. The bridge API returns only that seat's view, but the external process is
not sandboxed from the host filesystem or network. Exhibition is therefore a
trusted manual integration mode, not a controlled agent comparison. Its result
records distinct execution-harness descriptors for the bridge and opponent.

Exhibition results are not controlled evidence. A research comparison must instead
launch the external harness in a least-privilege sandbox that mounts only its
workspace and reaches only the authorized seat endpoint.

## Model decision path

For each decision, `LLMEngine` sends the model:

- the public field state and timers;
- the exact state of its own Pokémon;
- both open team sheets;
- its private timeline and series notebook;
- numbered menus for each legal joint action;
- references for the active matchup.

Optional tools provide species, move, item, ability, nature, type, exact
format-aware stats, and damage information. In battle, damage calls are bound
to the live request and open team sheets rather than trusting model-supplied
state. Explicit item and ability lookups return the simulator's full mechanics
descriptions. The tools expose only information that is legal in the match.

The model returns one JSON object:

```json
{
  "choices": [0, 2],
  "rationale": "short reason for the final choice",
  "notebook": "private notes for this series"
}
```

Malformed decisions are retried according to the decision policy; an exhausted
untimed decision produces a recorded model-choice default. Game evidence keeps
model-choice defaults, simulator substitutions, and timer autodefaults
separate. Provider failure during a timed decision abandons that decision and
lets the Showdown timer act. Simulator, reference, and team validation failures
stop the run.

After each game, both models review the game and record an adjustment. This
step occurs outside the battle clock. The final review remains in the evidence
and has `series_over` set. In draft leagues the final review also receives the
full ten-Pokémon roster with the registered six marked, and its instructions
extend to the preparation itself: whether the six registered fit the opponent
and whether anything left behind would have.

Reference opponents implement `BattleAgent`. They do not use model notebooks,
reflections, or tools.

## Pokémon Showdown boundary

The league loads Showdown's compiled battle stream, dex, validator, and room
timer in the application process. It does not run the Showdown HTTP server.
Showdown remains the authority for legality and results.

`showdown.lock.json` accepts only the official repository and a full commit
SHA. Setup rejects non-registry or non-SHA-512 entries in the upstream npm
lock, installs it with lifecycle scripts disabled, explicitly runs the
compiler, and retains only `ts-chacha20`, the simulator's sole external runtime
package. The update path builds and runs the league test suite before keeping a
new pin.

The Showdown room timer starts only when a run selects a timer scale. Decision
token limits follow the active clock. A separate wall-clock limit stops
runaway model calls in every mode.

Each result records the actual Showdown revision.

## Evaluation boundary

The live league and an external evaluation framework share the rules layer, not
the inference client.

`src/eval/corpus.ts` reconstructs games recorded with the current provenance
contract. A private `series.json` stores exact packed teams, while the result row
binds them by SHA-256; unbound legacy games are reported but are not grading
sources. `src/eval/fork.ts` owns replay,
snapshots, and action enumeration. Counterfactual settings, action encoding, executed evaluator digest, source
corpus digest, and Showdown SHA are resume-validated in the grading manifest. A
released set becomes immutable only when its content-addressed artifacts are
frozen.

The freeze stage first separates public point-of-view inputs from private
snapshots, opponent requests, and provenance. The panel exporter then writes
three physically separate artifact types: model-visible frozen prompts and
numbered joint-action maps; private deterministic score tables; and sealed
snapshots, draw identities, and rectangular action-value matrices. Exact file
bytes and the executed evaluator are hashed. Code that loads model tasks must
not accept either private type.

Every candidate action is measured on two stability panels and an untouched
measurement panel. Common opponent slots, battle seeds, and continuation seeds
are shared across all actions within a panel. The current exporter is explicitly
a pilot artifact until eligibility thresholds, near-duplicate clustering, and
immutable train/eval splits are frozen.

The first verifiers integration is a static v1 `Taskset`: TypeScript exports a
frozen value table and Python performs strict response parsing and lookup. It
needs no service. A later dynamic draft-to-battle `Env` will drive the same
TypeScript referee through a versioned JSON-lines child process. HTTP is an
optional transport if a hosted runtime requires it. MCP is used only for
model-facing reference tools.

verifiers owns external task loading, harnesses, model traffic, traces, rollout
retries, evaluation outputs, and training integration. `LLMEngine` remains the
local interactive client and is bypassed by the adapter; verifiers resume is not
a replacement for replaying an interrupted battle.

## Dependency boundary

The root install uses the exact pnpm version declared in `package.json`, exact
direct versions, and an integrity-bearing frozen lock. Project policy disables
dependency lifecycle scripts, rejects exotic transitive sources, distrusts
lockfile metadata until packages are checked, forbids version downgrades, and
holds ordinary new releases for seven days. A narrowly versioned release-age
exception may admit a security fix sooner; it does not admit a package range.

Explicit project scripts remain runnable. That distinction lets the repository
compile its own code and the pinned Showdown source without granting install,
preinstall, or postinstall hooks to downloaded packages.

## Run state and evidence

Each run directory contains `status.json`. A running marker includes the owner
process ID. Terminal states are `done`, `failed`, and `stopped`. A running
marker with a dead process ID identifies an interrupted run.

The scheduler uses one shared abort signal. The first failed series stops
queued and active work. Completed series remain on disk before the scheduler
reports the failure.

`records/results.jsonl` is append-only. Readers accept unknown fields and
missing optional fields. Public readers expose contextual per-series outcomes
and observational summaries without deriving an Elo or total order.

Local evidence uses files:

- `runs/` stores configuration, decisions, traces, and mode-specific logs.
- `records/results.jsonl` stores one row for each completed series.
- `teams/` and `boards/` store immutable input snapshots.

`src/records.ts` caches parsed result rows by file modification time.
`src/evidence.ts` derives data-room views and `src/archive.ts` derives the
draft-league archive (`/api/leagues`, `/api/league`) and model profiles
(`/api/model`) from result rows joined with run files. Decision log rows carry
`total_tokens`, `reasoning_tokens`, and metered `cost` where the provider
reports them.

Hosted SQLite stores users, sessions, OAuth flows, ownership, experiments, and
audit events. Series, game, and decision evidence remains in append-only files.
Use PostgreSQL only if multiple application instances need concurrent writes.

The import path validates identifiers and evidence before it writes data. It
writes supporting files before the result row. The pair of `run_id` and
`series_id` makes imports idempotent. Imported rows record their origin.

## Trust boundaries

Local mode binds to loopback and permits operator changes. Hosted mode accepts
one configured public origin. Anonymous hosted users have read-only access.
GitHub OAuth grants contributor and operator permissions.

The server applies these controls at the HTTP boundary:

- exact host and origin checks;
- JSON-only mutation requests;
- path guards and bounded request bodies;
- content security and transport headers;
- bounded model-catalog requests and SSE clients.

The browser supplies provider keys for GUI runs. The server keeps these keys in
memory only for the run. It does not include keys in state, evidence, logs, or
database rows. GUI runs do not fall back to server credentials.

Hosted runs execute in a separate, heap-bounded process. A worker failure does
not terminate the web server.

Public spectators receive the public split-log branch from Showdown. Only the
run owner and operators can receive private battle data.

Public evidence may come from deployment runs or imports authorized by the
operator token. Provenance remains attached; client submissions are not treated
as verified model evidence because replay cannot prove which model made the
choices.

See [Deployment](deployment.md) for service configuration, limits, and backup
procedures. See [Use the league](usage.md) for local commands and evidence
publication.
