# Architecture

## Surfaces

- **CLI** (`src/cli.ts`): headless commands for `gui`, `selfcheck`,
  `rotation`, `tournament`, `draft`, `exhibition`, `standings`, and `report`.
- **GUI** (`src/gui/`): a `node:http` server (`server.ts`) exposes a JSON API,
  serves a Preact single-page client, and streams live run state over SSE.

There is no terminal UI. Agents use the CLI; humans use the GUI. This avoids
duplicating setup, catalog, live-view, and validation behavior.

## GUI structure

```
src/gui/
  api.ts        typed client/server contract; the only shared module, no runtime deps
  server.ts     node:http server: JSON API, SSE, static assets, security gate
  client/       Preact + TSX app, built by Vite into dist/gui
    app.tsx     state root: /api/state boot, SSE subscription, navigation
    views/      one file per nav view (fixtures, arena, results, pools)
    components/ shared widgets (dropdown)
```

Constraints:

- **The server is authoritative.** All game logic, validation, standings/Elo math, and file access live in `src/`
  outside the client. The client renders API responses; it never recomputes domain results.
- **Every request/response shape is declared in `src/gui/api.ts`** and imported by both sides (`import type` only on
  the client). Change the contract file first; the compiler finds the rest.
- **One view = one file.** Extract shared components only when actually used twice.
- Build: `tsc -p tsconfig.json` (server) → `tsc -p tsconfig.client.json` (client) → `vite build` → `dist/gui`.
  `npm run dev:gui` rebuilds on change; the server serves `dist/gui` without a Vite dev server.
- Tests: `tests/gui.test.ts` covers the API surface; `tests/gui-dom.test.ts` boots the built bundle in happy-dom
  against a live server and asserts the app renders. Add a DOM smoke case per new view.

## Experiment boundaries

`src/rotation.ts` owns Rotation planning, mirrored assignments, run
configuration, event emission, and result persistence. Shared battle engines
and Showdown integration remain outside each experiment orchestrator.

`ExperimentMode` contains `rotation`, `exhibition`, `tournament`, and `draft`.
Each run config, live snapshot, and completed series carries `mode` and
`protocol_version`. Protocol versions change when evaluation rules make results
incomparable. Rows and run configs also record `scaffold`, a hash of the battle
decision and reflection prompts, tool schemas, and sampling parameters.

Reasoning capability rules live in `providers.ts`. The server reports supported
levels for each model, and the GUI either selects a shared level or sends a
validated per-model map.

Tournament mode (`src/tournament.ts`) runs a single-elimination best-of-three
bracket. Entrants receive teams drawn without replacement from a pool or
supplied as validated pastes, and keep those teams through the bracket. Byes
fill incomplete brackets. Dependency-ready matches run up to the configured
concurrency. A drawn series advances the higher seed while its record keeps
`winner: null`. Rows use `mode: "tournament"` and include the round; inline-team
rows have no pool. Tournament rows are not rated.

Draft League mode (`src/draftleague.ts`, with drafting in `src/draft.ts`) starts
with a snake draft from an immutable `boards/<id>.json` board. The board holds
fixed sets with tier prices and a points budget. The format validator checks
each partial roster while ignoring only the incomplete-team-size error.

Each model gets up to three attempts per pick before a uniform random legal
fallback. Per-model logs contain prompts and responses; `draft/draft.jsonl`
contains the shared pick transcript. Draft configs and rows include
`draft_scaffold`, a hash of the draft prompt and execution policy. Drafted
rosters play a round robin followed by top-four or top-two playoffs. Draft rows
use `mode: "draft"`, include the stage and board id, and are not rated.
Rotation, tournament, and draft use `src/series.ts`; exhibition uses the
lower-level best-of-three loop with the external seat bridge.

Reference opponents implement `BattleAgent`
(`act`/`observe`/`abandonDecision`). They do not use `LLMEngine` notebooks,
reflections, or tools.

Exhibition mode (`src/exhibition.ts`) lets an external terminal agent play one
seat through the `LLMEngine` scaffold. `src/seat.ts` exposes provider exchanges
through a token-authenticated localhost bridge, so the agent receives the same
prompts as an API model. The host process owns both `|split|` battle-log halves,
the opponent engine, and any opponent API key. The agent workspace contains
only the thin client, instructions, and its token. The bridge exposes only that
seat's view. The Showdown move timer is disabled because agent turns take
minutes. Rows use `mode: "exhibition"` and include the seat side. They are not
rated. Decision, trace, and bridge tool logs support later audits.

Run failure semantics are part of the protocol: the first failed series aborts the scheduler's shared signal, so
queued series never start and in-flight series stop consuming provider credits; the failure is reported only after
every worker has settled. Completed series are already persisted. A user stop preserves those rows and ends in the
explicit, non-resumable `stopped` state; timeouts and server interruptions remain failures.

Unscoped record queries exclude the disposable `test` pool and keep only
`rotation` rows. Selecting a pool, including `test`, shows its non-rotation rows
in the record list, but standings and head-to-head calculations still use only
rotation rows. Protocol-version selection is not implemented. Standings
recompute sequential Elo from qualifying rows on every read; Elo is not stored.

## Pokémon Showdown boundary

The league loads Pokémon Showdown's compiled `BattleStream`, dex, team validator, and room timer directly in process.
It does not run the full HTTP/WebSocket server or expose a `--no-security` listener. This avoids ports, subprocess
lifecycle, network protocol overhead, and another authentication boundary while preserving Showdown as the authority
on legality and outcomes.

`showdown.lock.json` pins the upstream commit. `npm run setup:showdown` installs that revision, and every project build
checks both its revision and required compiled entry points. `npm run check:showdown-update` reports whether upstream
`HEAD` moved; `npm run update:showdown` builds the candidate, advances the lock, and runs the full suite, restoring the
old revision if verification fails. New regulations become available through Showdown's format catalog, but each team
pool remains versioned against its exact format. `VGC_LEAGUE_PS` is an explicit compatibility escape hatch; custom
checkouts are not claimed to match the pin, but their actual commit is still captured in result provenance. Simulator
faults still share the application process today; production job isolation should place the complete run, not a
networked Showdown server alone, in its worker boundary.

## Local and hosted access

Local mode remains the default: the server binds `127.0.0.1`, accepts only loopback `Host` values, and permits the
operator UI to mutate state. Hosted mode binds the configured interface and accepts exactly
`VGC_LEAGUE_PUBLIC_ORIGIN` as both canonical `Host` and mutation `Origin`.
Without GitHub OAuth it is read-only by default.
`VGC_LEAGUE_ENABLE_MUTATIONS=true` enables unauthenticated mutations and is
appropriate only behind a separate private-access layer. With OAuth,
contributors and operators may mutate within the ownership gates below. Public
deployment still requires the operational controls in
[`deployment.md`](deployment.md).

Security controls:

- **Host allowlist:** every request must use a loopback host locally or the
  configured public origin when hosted. This blocks DNS rebinding and direct
  access through an unintended Railway hostname.
- **Origin check:** hosted mutations require the configured origin; a present
  local origin must match the request host.
- **JSON mutations:** mutating requests require `application/json`, which HTML
  forms cannot set.
- **Path traversal guards** on static assets and pool manifests; only known asset extensions and regular team files
  inside their pool directory are read.
- **Keys**: provider API keys are held in browser memory and sent only for catalog lookup and the run; the server
  keeps them in memory for the run's duration, then wipes them. They are never written to records, logs, or state
  responses. Server-side env keys are never exposed to the client, and GUI runs never fall back to them: a
  key-carrying run that is missing a key for any hosted model is rejected up front rather than silently billed to
  the server's credentials. Provider errors and structured server errors redact submitted keys.
- Request bodies are capped at 2 MB, team pastes and pool/model counts have tighter resource bounds, model-catalog
  calls time out and cap responses at 1 MB, and SSE clients are bounded.
- Every response gets a script-restricting CSP, `X-Content-Type-Options`, `Referrer-Policy`, and `Permissions-Policy`;
  HTTPS hosted origins also get HSTS. Hosted mode removes arbitrary OpenAI-compatible endpoints to close the SSRF
  path until a network-restricted worker exists.
- `/healthz` is a process liveness check. `/readyz` verifies assets, writable persistent paths, the configured
  authentication database, and the pinned Showdown runtime. SSE sends proxy heartbeats every 25 seconds.

## Hosted deployment

The application implements the following controls. Public deployment also
requires the operational work in [`deployment.md`](deployment.md).

1. **Authentication, attribution, and run ownership:** GitHub OAuth and
   server-side sessions protect every mutating route. Pools and active
   experiments have owners; completed records retain the contributor's stable
   GitHub subject and login. Anonymous access is read-only.
2. **Quotas and rate limits:** one global worker, hosted run limits, a
   configurable run deadline, and route-specific per-user limits bound
   application resource use. Provider keys are supplied by each user.
3. **Key handling:** keys remain in browser memory, cross IPC once, leave the
   web process after worker admission, and are cleared in the worker on exit.
4. **Execution isolation:** hosted runs use a separate, heap-bounded child
   process with a hard deadline and bounded abort grace. Worker failures become
   failed experiments without terminating the HTTP process. Inputs still pass
   through the normal validators before admission.
5. **Transport and headers:** hosted mode accepts one exact origin. HTTPS is a
   deployment requirement.
6. **Evidence admission:** only server-produced evidence enters public
   ratings. Client-submitted result rows may be retained as unverified
   exhibits, but replay can verify only that recorded choices reproduce the
   outcome. It cannot verify which model produced those choices. Replayed
   exhibits therefore do not enter ratings.
7. **Public spectating:** `/api/events/public` and `/api/battle/public` use
   Showdown's public split-log branch. Exact HP and player-private protocol
   lines are available only to the owner or operator. A stream opened as public
   remains public for its lifetime.

### Data and hosting decisions

Anonymous visitors may read model profiles, published pools, standings, and
verified evidence. Authentication records contribution provenance and grants
operational permissions. Contributors may publish pools and start runs within
configured limits; operators may control any active run. Models are measured
subjects, not accounts.

GitHub OAuth uses an authorization-code flow with state, PKCE, and no requested
scopes. The stable numeric GitHub subject is the account key. Sessions use
opaque random tokens whose hashes are stored in SQLite. They expire after seven
days and travel in `HttpOnly`, `Secure`, `SameSite=Lax` cookies. Authorization
has reader, contributor, and operator roles. Mutations require exact-origin and
CSRF checks.

SQLite stores users, sessions, OAuth flows, immutable pool ownership,
experiments, and audit events on one persistent volume. Pool publication and
experiment state changes use transactions. Series, game, and decision evidence
remains in append-only files. Elo and other summaries are derived. Move to
Postgres only if multiple application instances need concurrent writes.

Initial hosting target:

```text
Browser -> Cloudflare DNS/TLS/WAF -> Railway Docker service -> SQLite + artifacts on /data
                                      |
                                      +-> bounded benchmark worker process
SQLite continuous replica -------------------------------> object storage
```

Cloudflare terminates TLS, applies edge rate limits and WAF policy, and proxies
one canonical origin. Railway runs one long-lived Node service because the
application uses SSE, persistent files, and long benchmark jobs. Mount one
persistent volume at `/data` and keep the application out of ephemeral edge
runtimes.

### Implementation status

- **Static reports:** `writeReport` produces a self-contained HTML record book
  that can be published with exported replay logs while run submission stays
  local.
- **Deployment hardening:** the container runs as a non-root user,
  `railway.toml` checks `/readyz`, SIGTERM triggers bounded graceful shutdown,
  and `VGC_LEAGUE_DATA_DIR=/data` keeps pools, runs, and records on the mounted
  volume. Hosted logs omit request bodies and credentials. Litestream restores
  a missing SQLite database and continuously replicates it when
  `LITESTREAM_REPLICA_URL` is set.
- **Identity and durable state:** GitHub OAuth, hashed sessions, roles, SQLite
  migrations, pool and experiment ownership, and mutation audit events are
  implemented. Public reads remain unauthenticated.
- **Admission and isolation:** there is one worker slot and no durable queue.
  Hosted limits and `VGC_LEAGUE_MAX_RUN_MINUTES` bound each run. Runs execute
  in a child process with a 768 MiB V8 heap, restricted environment, IPC-only
  key transfer, abort grace period, and hard-kill fallback. Startup marks
  interrupted experiments as failed.
- **Public deployment:** application controls are implemented. Launch still
  requires edge policy, Railway volume backups, an encrypted and versioned
  Litestream destination, restore drills for both backup layers, and a tested
  image rollback.
- **Research corpus:** server-produced evidence can feed public ratings.
  Client submissions remain unverified exhibits. Split workers or replace
  SQLite only after measured load requires it.

Provider keys remain bring-your-own and memory-only through these phases. Never include them in job configuration,
artifacts, logs, or database rows. A future encrypted vault is a separate opt-in feature with its own threat model, not
a prerequisite for public deployment.

## Records

`records/results.jsonl` is append-only and backward compatible. Readers
tolerate unknown fields and missing optional fields; ratings skip malformed
rows without players. New rows record `mode`, `protocol_version`, and
`scaffold`, while the TypeScript reader keeps these fields optional for older
rows. Legacy rows without `pool` remain in unscoped views. Decisions, token
usage, latency, provider failures, and behavior counters are recorded as
structured evidence at run time. Post-game reflections include `series_over`.
