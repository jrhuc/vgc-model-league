# Architecture

## How to change this system

Agents wrote this architecture, and agents change it. The architecture is
mutable, not sacred. If a change does not fit the current design, challenge
the design and change it. Do not add a hacky workaround on top of it. When you
add a feature, find the code that the feature makes redundant, and delete that
code in the same change. Deletion is as important as addition.

## Surfaces

- **CLI** (`src/cli.ts`): headless commands for `gui`, `restart`, `stop`,
  `selfcheck`, `rotation`, `tournament`, `draft`, `exhibition`, `standings`,
  `report`, and `publish`. `restart` rebuilds and swaps the detached GUI
  process in one step; both it and `stop` refuse to interrupt an active run
  without `--force`.
- **GUI** (`src/gui/`): a `node:http` server (`server.ts`) exposes a JSON API,
  serves a Preact single-page client, and streams live run state over SSE.

There is no terminal UI. Agents use the CLI, and humans use the GUI. This
prevents duplicate setup, catalog, live-view, and validation behavior.

## GUI structure

```
src/gui/
  api.ts        typed client/server contract; the only shared module, no runtime deps
  server.ts     node:http server: JSON API, SSE, static assets, security gate
  client/       Preact + TSX app, built by Vite into dist/gui
    app.tsx     state root: /api/state boot, SSE subscription, navigation
    views/      one file per nav view (fixtures, arena, league, dataroom, pools)
    components/ shared widgets (dropdown, chartkit)
```

The nav has four views: run setup, the live run, the draft league, and the
data room. The draft league view owns the board browser, the franchises and
their rosters, the weekly table, every teambuild with its repairs, and the
pick feed. Every recorded result reads from the data room, which splits into
a ladder section (Elo, head to head, trajectory), a play section
(deliberation, action mix, luck), and a brackets section (tournament archives
and placements). Sections
are hash routes (`#results`, `#results/play`, `#results/brackets`), and the
older `#tournaments` link opens the brackets section.

Constraints:

- **The server is authoritative.** All game logic, validation, standings and
  Elo math, and file access are in `src/`, outside the client. The client
  renders API responses. It does not compute domain results again.
- **Declare every request and response shape in `src/gui/api.ts`.** The two
  sides import it (`import type` only on the client). Change the contract file
  first. The compiler then finds the other locations.
- **One view is one file.** Extract a shared component only when two views use
  it.
- Build: `tsc -p tsconfig.json` (server), then `tsc -p tsconfig.client.json`
  (client), then `vite build` into `dist/gui`. `npm run dev:gui` builds again
  on each change. The server serves `dist/gui` without a Vite dev server.
- Tests: `tests/gui.test.ts` covers the API surface. `tests/gui-dom.test.ts`
  starts the built bundle in happy-dom against a live server and makes sure
  that the app renders.

## Experiment boundaries

`src/rotation.ts` owns Rotation planning, mirrored assignments, run
configuration, event emission, and result persistence. Shared battle engines
and the Showdown integration stay outside each experiment orchestrator.

`ExperimentMode` contains `rotation`, `exhibition`, `tournament`, and `draft`.
Each run configuration, live snapshot, and completed series carries `mode` and
`protocol_version`. The protocol version changes when a change to the
evaluation rules makes results incomparable. Rows and run configurations also
record `scaffold`, a hash of the battle decision and reflection prompts, the
tool schemas, and the sampling parameters.

The reasoning capability rules are in `providers.ts`. The server reports the
supported levels for each model. The GUI then selects one shared level, or
sends a validated per-model map.

Tournament mode (`src/tournament.ts`) runs a single-elimination best-of-three
bracket. Entrants receive teams drawn without replacement from a pool, or
supplied as validated pastes. They keep those teams through the bracket. Byes
fill incomplete brackets. Dependency-ready matches run up to the configured
concurrency. A drawn series advances the higher seed, and its record keeps
`winner: null`. Rows use `mode: "tournament"` and include the round.
Inline-team rows have no pool. Tournament rows are not rated.

Draft League mode (`src/draftleague.ts`, drafting in `src/draft.ts`,
teambuilding in `src/teambuild.ts`) has eight coaches snake-draft ten Pokémon
each from an immutable `boards/<id>.json` board inside a hundred-point budget,
name a franchise, then keep that roster all season.

A board entry is a species, not a set: `{id, name, species, forme?, item?,
base, types, cost}`. Megas are separate, separately priced entries from their
base forme, following the tournament sheet convention — the entry registers
the base forme and locks the Mega Stone, while drafting the base forme forbids
any stone. `base` is the species-clause key, and a roster holds at most one
entry per base species, so any six of the ten are a legal team. Board costs
come from a prior Regulation M-A draft board, extended to the Reg M-B additions
and re-fitted against Reg M-B ladder usage; `boards/sources/` holds both local
inputs, and each adjusted entry keeps its `listed` price and the `usage` that
moved it.

Because a pick is a species and not a set, pick legality is only exclusivity,
one entry per base species, and affordability: a pick is legal when the
cheapest remaining entry per base species can still fill the rest of the
roster. That replaces the combinatorial roster search the fixed-set board
needed.

Before every series each coach picks six of its ten and builds every set —
item, ability, nature, moves, EVs — knowing the opponent's full roster and its
own results so far. `src/teambuild.ts` states the league rules that Showdown
does not know (the Mega lock) itself, and delegates format legality to
Showdown's `TeamValidator` so the model is corrected with the simulator's own
messages. Movepools in the prompt come from `getMovePool`, so the prompt can
never offer a move the validator then rejects. A rejected team is retried;
after the attempts run out the model's own last team is repaired minimally
rather than replaced, and each repair is recorded per set.

Drafting and teambuilding run with the same Showdown dex tools the battle
engine uses (`DEX_TOOLS`, driven by the shared bounded loop in
`src/dex-lookups.ts`): a coach counter-picking can look up what a Mega becomes,
read a matchup, or estimate damage, and a coach building spreads can check what
an item does here and what a spread outruns. Reusing the battle tools keeps one
source of simulator truth instead of a second, weaker one, which matters most
for a game that postdates every model's training data. Lookups are bounded per
round and recorded as `tool_lookups` in the per-model logs. A tool round is not
an attempt.

Each model gets three attempts per pick and five per teambuild, then a fallback.
Transient upstream failures never spend one of those attempts: they retry with
backoff, and pause on the `RecoveryGate` when one is supplied, so a rate limit
cannot push a coach toward a random pick or a repaired team. Credential and
request errors still fail fast.

The round robin runs as weeks — a circle-method schedule where every coach
plays once per week — so standings and each coach's season history are
well-defined as the league proceeds. The top four then play semifinals and a
final. Per-model logs hold prompts and responses, `draft/draft.jsonl` the
shared pick transcript, and `teambuild/teambuild.jsonl` every team brought.
Configurations and rows carry `draft_scaffold` and `teambuild_scaffold`.
Draft rows use `mode: "draft"`, include the stage, round and board id, and are
not rated. Rotation, tournament, and draft use `src/series.ts`. Exhibition uses
the lower-level best-of-three loop with the external seat bridge.

Reference opponents implement `BattleAgent`
(`act`/`observe`/`abandonDecision`). They do not use `LLMEngine` notebooks,
reflections, or tools.

Exhibition mode (`src/exhibition.ts`) lets an external terminal agent play one
seat through the `LLMEngine` scaffold. `src/seat.ts` exposes the provider
exchanges through a token-authenticated localhost bridge. Thus the agent
receives the same prompts as an API model. The host process owns the two
`|split|` battle-log halves, the opponent engine, and each opponent API key.
The agent workspace contains only the thin client, the instructions, and its
token. The bridge exposes only the view of that seat. The Showdown move timer
is off because agent turns take minutes. Rows use `mode: "exhibition"` and
include the seat side. They are not rated. Decision, trace, and bridge tool
logs make later audits possible.

Every run directory carries a `status.json` marker: `running` with the owning
pid at start, then a terminal state (`done`, `failed`, `stopped`) written by
the CLI wrapper or the GUI server on exit, failure, or SIGINT/SIGTERM. A stale
`running` marker whose pid is dead means the run was killed outright.

Run failure semantics are part of the protocol. The first failed series aborts
the shared signal of the scheduler. Queued series do not start, and in-flight
series stop the use of provider credits. The league reports the failure only
after every worker settles. Completed series are already on disk. A user stop
keeps those rows and ends in the explicit, non-resumable `stopped` state. If a
stopped or timed-out run does not shut down in the grace period, the server
detaches it, records its status, and accepts new runs. Timeouts and server
interruptions stay failures.

Unscoped record queries exclude the disposable `test` pool and keep only
`rotation` rows. If you select a pool, `test` included, the record list shows
its non-rotation rows. Standings and head-to-head calculations still use only
rotation rows. Protocol-version selection is not implemented. Standings
compute sequential Elo again from qualifying rows on every read. Elo is not
stored.

## Pokémon Showdown boundary

The league loads the compiled `BattleStream`, dex, team validator, and room
timer of Pokémon Showdown directly in process. Battles are untimed by default:
the room timer never starts, and each decision call is bounded only by a token
ceiling and a per-call wall clock that catch runaway reasoning. An opt-in
run-level timer scale starts the room timer with its settings (starting bank,
grace, per-turn caps) multiplied; engines then see the scaled clocks in their
requests, and decision token budgets follow the clock automatically. Hosted
deployments behave the same: runs use visitor-supplied keys, so untimed
reasoning spend is the run starter's own choice, and the per-call wall clock,
single-run limit, and stop controls keep a public box bounded. It does not run
the full
HTTP/WebSocket server, and it does not expose a `--no-security` listener. This
prevents ports, subprocess lifecycle, network protocol overhead, and one more
authentication boundary. Showdown stays the authority on legality and
outcomes.

`showdown.lock.json` pins the upstream commit. `npm run setup:showdown`
installs that revision. Every project build checks the revision and the
required compiled entry points. `npm run check:showdown-update` reports
whether upstream `HEAD` moved. `npm run update:showdown` builds the candidate,
advances the lock, and runs the full suite. If verification fails, it restores
the old revision. New regulations become available through the format catalog
of Showdown, but each team pool stays versioned against its exact format.
`VGC_LEAGUE_PS` is an explicit compatibility escape hatch. Custom checkouts do
not have to match the pin, but result provenance captures their actual commit.
Simulator faults still share the application process today. Production job
isolation must put the complete run in its worker boundary, not only a
networked Showdown server.

## Local and hosted access

Local mode is the default. The server binds `127.0.0.1`, accepts only loopback
`Host` values, and permits the operator UI to mutate state. Hosted mode binds
the configured interface. It accepts exactly `VGC_LEAGUE_PUBLIC_ORIGIN` as the
canonical `Host` and as the mutation `Origin`. Without GitHub OAuth, hosted
mode is read-only by default. `VGC_LEAGUE_ENABLE_MUTATIONS=true` enables
unauthenticated mutations. Use it only behind a separate private-access layer.
With OAuth, contributors and operators can mutate state inside the ownership
gates below. Public deployment also requires the operational controls in
[`deployment.md`](deployment.md).

Security controls:

- **Host allowlist:** each request must use a loopback host locally, or the
  configured public origin when hosted. This blocks DNS rebinding and direct
  access through an unintended Railway hostname.
- **Origin check:** hosted mutations require the configured origin. A local
  origin, when present, must be equal to the request host.
- **JSON mutations:** mutating requests require `application/json`. HTML forms
  cannot set this content type.
- **Path traversal guards:** static assets and pool manifests have path
  guards. The server reads only known asset extensions and regular team files
  inside their pool directory.
- **Keys:** the browser holds provider API keys in memory and sends them only
  for catalog lookup and the run. The server keeps them in memory for the
  duration of the run, then wipes them. The server does not write them to
  records, logs, or state responses. Server-side environment keys are not
  exposed to the client, and GUI runs do not fall back to them. If a
  key-carrying run misses a key for a hosted model, the server rejects the run
  up front. It does not bill the credentials of the server without notice.
  Provider errors and structured server errors redact submitted keys.
- Request bodies have a 2 MB limit. Team pastes and pool and model counts have
  tighter resource bounds. Model-catalog calls time out and have a 1 MB
  response limit. SSE clients are bounded.
- Every response gets a script-restricting CSP, `X-Content-Type-Options`,
  `Referrer-Policy`, and `Permissions-Policy`. HTTPS hosted origins also get
  HSTS. Hosted mode removes arbitrary OpenAI-compatible endpoints. This closes
  the SSRF path until a network-restricted worker exists.
- `/healthz` is a process liveness check. `/readyz` makes sure of the assets,
  the writable persistent paths, the configured authentication database, and
  the pinned Showdown runtime. SSE sends proxy heartbeats every 25 seconds.

## Hosted deployment

The application implements the controls below. Public deployment also
requires the operational work in [`deployment.md`](deployment.md).

1. **Authentication, attribution, and run ownership:** GitHub OAuth and
   server-side sessions protect every mutating route. Pools and active
   experiments have owners. Completed records keep the stable GitHub subject
   and login of the contributor. Anonymous access is read-only.
2. **Quotas and rate limits:** one global worker, hosted run limits, a
   configurable run deadline, and route-specific per-user limits bound the
   application resource use. Each user supplies their own provider keys.
3. **Key handling:** keys stay in browser memory, cross IPC once, leave the
   web process after worker admission, and are cleared in the worker on exit.
4. **Execution isolation:** hosted runs use a separate, heap-bounded child
   process with a hard deadline and a bounded abort grace. A worker failure
   becomes a failed experiment. It does not terminate the HTTP process. Inputs
   pass through the normal validators before admission.
5. **Transport and headers:** hosted mode accepts one exact origin. HTTPS is a
   deployment requirement.
6. **Evidence admission:** evidence enters public ratings from two channels
   only: runs the deployment executed itself, and imports through
   `POST /api/import`, which requires the operator secret in
   `VGC_LEAGUE_IMPORT_TOKEN` and does not exist without it. Imported rows
   carry `origin`, so every view can separate them, and they rate because the
   operator holds the same trust as the server process. Unauthenticated
   submissions never rate. Replay can make sure only that the recorded choices
   reproduce the outcome. It cannot make sure which model produced those
   choices, so replayed exhibits stay exhibits.
7. **Public spectating:** `/api/events/public` and `/api/battle/public` use
   the public split-log branch of Showdown. Exact HP and player-private
   protocol lines are available only to the owner or an operator. A stream
   opened as public stays public for its lifetime.

### Data and hosting decisions

Anonymous visitors can read model profiles, published pools, standings, and
verified evidence. Authentication records contribution provenance and grants
operational permissions. Contributors can publish pools and start runs inside
the configured limits. Operators can control any active run. Models are
measured subjects, not accounts.

GitHub OAuth uses an authorization-code flow with state, PKCE, and no
requested scopes. The stable numeric GitHub subject is the account key.
Sessions use opaque random tokens. SQLite stores the token hashes. Sessions
expire after seven days and travel in `HttpOnly`, `Secure`, `SameSite=Lax`
cookies. Authorization has reader, contributor, and operator roles. Mutations
require exact-origin and CSRF checks.

SQLite stores users, sessions, OAuth flows, immutable pool ownership,
experiments, and audit events on one persistent volume. Pool publication and
experiment state changes use transactions. Series, game, and decision
evidence stays in append-only files. Elo and other summaries are derived.
Move to Postgres only if multiple application instances need concurrent
writes.

Initial hosting target:

```text
Browser -> Cloudflare DNS/TLS/WAF -> Railway Docker service -> SQLite + artifacts on /data
                                      |
                                      +-> bounded benchmark worker process
SQLite continuous replica -------------------------------> object storage
```

Cloudflare terminates TLS, applies edge rate limits and WAF policy, and
proxies one canonical origin. Railway runs one long-lived Node service
because the application uses SSE, persistent files, and long benchmark jobs.
Mount one persistent volume at `/data`. Keep the application out of ephemeral
edge runtimes.

### Implementation status

- **Static reports:** `writeReport` produces a self-contained HTML record
  book. You can publish it with exported replay logs while run submission
  stays local.
- **Deployment hardening:** the container runs as a non-root user.
  `railway.toml` checks `/readyz`. SIGTERM starts a bounded graceful
  shutdown, and the process exits when the shutdown completes.
  `VGC_LEAGUE_DATA_DIR=/data` keeps pools, runs, and records on the mounted
  volume. Hosted logs omit request bodies and credentials. Litestream
  restores a missing SQLite database and continuously replicates it when
  `LITESTREAM_REPLICA_URL` is set.
- **Identity and durable state:** GitHub OAuth, hashed sessions, roles,
  SQLite migrations, pool and experiment ownership, and mutation audit events
  are implemented. Public reads stay unauthenticated.
- **Admission and isolation:** there is one worker slot and no durable queue.
  Hosted limits and `VGC_LEAGUE_MAX_RUN_MINUTES` bound each run. Runs execute
  in a child process with a 768 MiB V8 heap, a restricted environment,
  IPC-only key transfer, an abort grace period, and a hard-kill fallback.
  Startup marks interrupted experiments as failed.
- **Public deployment:** the application controls are implemented. Launch
  also requires edge policy, Railway volume backups, an encrypted and
  versioned Litestream destination, restore drills for the two backup layers,
  and a tested image rollback.
- **Research corpus:** server-produced evidence can feed public ratings.
  Client submissions stay unverified exhibits. Split the workers or replace
  SQLite only after measured load requires it.

Provider keys stay bring-your-own and memory-only through these phases. Do
not include them in job configuration, artifacts, logs, or database rows. A
future encrypted vault is a separate opt-in feature with its own threat
model. It is not a prerequisite for public deployment.

## Records

`records/results.jsonl` is append-only and backward compatible. Readers
accept unknown fields and missing optional fields. `vgcleague publish`
(`src/publish.ts`) sends completed local series to a deployment's import
route, one series per request, with the decision logs, the run configuration,
and the team pool when it is missing there. `src/import.ts` validates each
bundle, refuses path-unsafe identifiers, writes the pool and the evidence
before the row, and skips series the deployment already holds, keyed on
`run_id` and `series_id`. Prompts and raw provider responses stay on the
machine that ran the battle. Ratings skip malformed
rows without players. New rows record `mode`, `protocol_version`, and
`scaffold`. The TypeScript reader keeps these fields optional for older rows.
Legacy rows without `pool` stay in unscoped views. The league records
decisions, token use, latency, provider failures, and behavior counters as
structured evidence at run time. Post-game reflections include `series_over`.
