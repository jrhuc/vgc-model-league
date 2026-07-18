# Architecture

## Surfaces

- **CLI** (`src/cli.ts`) — headless entry point for agents and scripts: `rotation`, `selfcheck`, `standings`,
  `report`, and `gui`.
- **GUI** (`src/gui/`) — the human interface. A `node:http` server (`server.ts`) exposes a JSON API and serves a
  Preact single-page client; live run state streams over SSE (`/api/events`).

There is intentionally no terminal UI. Agents use the stable CLI; humans use the GUI. Keeping one interface for each
audience avoids duplicating setup, catalog, live-view, and validation behavior.

## GUI structure

```
src/gui/
  api.ts        typed client/server contract — the only shared module, no runtime deps
  server.ts     node:http server: JSON API, SSE, static assets, security gate
  client/       Preact + TSX app, built by Vite into dist/gui
    app.tsx     state root: /api/state boot, SSE subscription, navigation
    views/      one file per nav view (fixtures, arena, results, pools)
    components/ shared widgets (dropdown)
```

Rules that keep this from rotting:

- **The server is authoritative.** All game logic, validation, standings/Elo math, and file access live in `src/`
  outside the client. The client renders API responses; it never recomputes domain results.
- **Every request/response shape is declared in `src/gui/api.ts`** and imported by both sides (`import type` only on
  the client). Change the contract file first; the compiler finds the rest.
- **One view = one file.** Extract shared components only when actually used twice.
- Build: `tsc` (server) → `tsc -p tsconfig.client.json --noEmit` (client typecheck) → `vite build` → `dist/gui`.
  `npm run dev:gui` rebuilds on change; the server serves whatever is in `dist/gui`, no dev server involved.
- Tests: `tests/gui.test.ts` covers the API surface; `tests/gui-dom.test.ts` boots the built bundle in happy-dom
  against a live server and asserts the app renders. Add a DOM smoke case per new view.

## Experiment boundaries

`src/rotation.ts` is the current experiment orchestrator. It owns Rotation planning, mirrored assignments, run
configuration, event emission, and result persistence. Shared battle engines and Showdown integration stay outside it
so future modes can reuse execution without inheriting Rotation scheduling.

`ExperimentMode` contains `rotation` and `exhibition`. A new mode extends that type only when its real orchestrator
exists; Draft League and Tournament must not arrive as conditionals scattered through `rotation.ts`. Every new run
config, live snapshot, and completed series carries `mode` and `protocol_version`. Protocol versions change when an
evaluation rule changes enough to make unlike results incomparable. Because that bump is manual discipline, every row
and run config also records `scaffold` — a hash of the decision/reflection system prompts, tool schemas, and sampling
parameters — so unintentional scaffold drift is detectable after the fact even when `protocol_version` did not move.

Reference opponents (for example VGC-Bench's behavior-cloned or reinforcement-learned policies) integrate by
implementing `BattleAgent` (`act`/`observe`/`abandonDecision`). That interface is the interop seam: reference agents
never acquire `LLMEngine`'s notebook, reflection, or tool machinery, and the league scaffold never leaks into them.

Exhibition mode (`src/exhibition.ts`) is the opposite integration: an external terminal agent plays one seat
*through* the full `LLMEngine` scaffold. The engine's provider calls are surfaced by `src/seat.ts` as exchanges on a
token-authenticated localhost bridge, so the agent answers exactly the prompts an API model would receive — the
information surface is identical by construction, not by auditing. Hidden-information containment relies on process
separation: the host process owns the battle (both `|split|` halves), the opponent engine, and any opponent API key;
the agent's workspace contains only the thin client, instructions, and its token, and the bridge has no endpoint
that serializes anything beyond that seat's own view. The Showdown move timer is disabled for these series because
agent turns take minutes. Rows record `mode: "exhibition"` and the seat side, and unscoped standings drop them, so
agent seats never rate the Rotation ladder. The seat's decision/trace logs plus the bridge's tool-lookup log make
post-hoc audits possible, including checking whether a player acted on information its seat view never contained.

Run failure semantics are part of the protocol: the first failed series aborts the scheduler's shared signal, so
queued series never start and in-flight series stop consuming provider credits; the failure is reported only after
every worker has settled. Completed series are already persisted. A user-initiated stop behaves the same way but
resolves with the completed results instead of an error.

Records queries and ratings are scoped by pool and partially by mode today: unscoped standings, reports, and the GUI
record book exclude the disposable `test` pool and drop `exhibition` rows, and any single pool — including `test` —
can be selected explicitly. Before Draft League or Tournament ships, that scoping must extend to full mode and
protocol-version selection. Rotation Elo remains the default controlled rating;
Draft League and Tournament results will have their own views and cannot silently enter it. The sequential Elo shown
in standings is a provisional display rating recomputed from qualifying rows on every read — never stored — so a
paired-comparison model (Bradley–Terry or similar) can replace it later without any schema change.

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

## Trust model — local operator and deployment gate

Local mode remains the default: the server binds `127.0.0.1`, accepts only loopback `Host` values, and permits the
operator UI to mutate state. Hosted mode binds the configured interface and accepts exactly
`VGC_LEAGUE_PUBLIC_ORIGIN` as both canonical `Host` and mutation `Origin`. Without GitHub OAuth it is read-only by
default; `VGC_LEAGUE_ENABLE_MUTATIONS=true` remains an unauthenticated override suitable only behind a separately
enforced private access layer. With OAuth configured, authenticated contributors and operators may mutate within the
ownership gates below. Public multi-user runs remain blocked on rate limits and execution isolation.

Both modes defend themselves:

- **Host allowlist** on every application request — loopback names locally or the one configured public origin when
  hosted. This blocks DNS rebinding and direct access through an unintended Railway hostname.
- **Exact Origin check on mutations** — hosted mutations require the configured origin; a present local origin must
  match the request host exactly.
- **`application/json` required on mutations** — blocks HTML-form CSRF, which cannot set that header.
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

## Trust model — deployed multi-user site prerequisites

Before public multi-user runs ship, the following gates apply. Implemented controls are marked; remaining gates still
block a general public mutation surface:

1. **Authentication, attribution, and run ownership — implemented.** GitHub OAuth and server-side sessions protect
   every mutating route at the `server.ts` choke point. Pools and active experiments get owners; completed records
   retain the stable GitHub subject and login for provenance. Anonymous access remains read-only.
2. **Quotas and rate limits.** Because provider keys are bring-your-own, token spend lands on the submitter, not the
   site; the economic abuse surface is CPU and egress. Per-user active-run caps and run-duration limits therefore
   cover it — the quota system should stay that simple until measured abuse says otherwise.
3. **Key handling.** Never store user provider keys at rest. Keep the current pass-through model: keys live in the
   client, are submitted per run, and are wiped after. This constrains scheduling (see admission control below) —
   that constraint is accepted, not worked around. A per-user encrypted vault is the named prerequisite for anything
   that would require holding a key beyond one run. Redact keys from every error path (model-catalog already does
   this for discovery errors).
4. **Execution isolation.** Untrusted-input runs (team pastes, model specs, seeds) execute in a sandboxed worker with
   timeouts, not in the web server process. Validate specs/pastes exactly as now — `createPool`/`inspectTeam`/
   `parseSpec` are already the choke points.
5. **Transport and headers — implemented.** Hosted mode requires one exact origin and HTTPS is enforced operationally.
6. **Evidence admission.** Public ratings admit server-produced evidence only, from day one. Client-submitted
   `results.jsonl`-shaped rows may be accepted as unverified exhibits with full provenance (`schema_version`, `mode`,
   `protocol_version`, `scaffold`, model identity, Showdown commit, pool id, run seed, engine seeds), but they never
   enter shared standings. Replay can verify only outcome integrity — that the recorded choices under the recorded
   seed produce the recorded result — not that a hosted model actually produced those choices, and that second claim
   is the one a leaderboard rests on. So replay verification is not a promotion path from exhibit to rating; it is a
   spot-check. Ratings are recomputed from qualifying rows, never stored as authoritative values.
7. **Spectating uses the public stream — private containment implemented, public stream pending.** The live feed is
   omniscient, so hosted `/api/events` and `/api/battle` are restricted to the run owner and operators. Spectating
   another user's live run remains disabled until it can use a public log stream where exact HP and request internals
   stay private to the players.

### Recorded deployment decisions

The public product is a shared research commons, not a set of private user silos. Anonymous visitors may read model
profiles, published pools, standings, and verified evidence. Authentication establishes contribution provenance and
operational authority: authenticated contributors may submit pools and, within quotas, runs; operators may moderate
invalid evidence and control jobs. Models are measured subjects, never user accounts. Deleting an account may detach
or pseudonymize attribution, but does not rewrite immutable non-personal experimental evidence.

Use GitHub OAuth first, through an authorization-code flow with `state` and PKCE and no scopes beyond identity. Store
the stable provider subject, not the mutable username, as the account key. Sessions are opaque random tokens whose
hashes live server-side; rotate them after login and sensitive actions, expire them, and send only `HttpOnly`, `Secure`,
`SameSite=Lax` cookies. Keep authorization to three roles initially: reader, contributor, and operator. Exact-origin
checks remain mandatory; cookie-authenticated mutations also require a CSRF token.

The first durable store is SQLite on one persistent volume. Use transactions for pool publication, job admission, and
result ingestion. The schema separates users/sessions, immutable pool versions, experiments/jobs, series/games,
decisions, derived observations, and artifact references. Ownership and contributor attribution are columns on shared
entities, not tenancy boundaries. Elo and other summaries remain derived views. Move to Postgres only when multiple
application instances need concurrent writes; do not introduce it speculatively.

Initial hosting target:

```text
Browser -> Cloudflare DNS/TLS/WAF -> Railway Docker service -> SQLite + artifacts on /data
                                      |
                                      +-> bounded benchmark worker process
Encrypted scheduled backup -------------------------------> object storage
```

Cloudflare terminates public TLS, applies coarse DDoS/WAF and edge rate limits, and proxies one canonical origin.
Railway runs the conventional long-lived Node service because the application needs SSE, a persistent filesystem, and
long benchmark jobs. Start with one instance and a persistent `/data` volume; add object storage for encrypted backups
and large artifacts before the volume becomes the only copy. Do not move the stateful application into an ephemeral
edge/container runtime merely to reduce hosting cost.

### Delivery sequence

0. **Static public results site.** The research-commons goal does not need auth, quotas, or SSRF hardening to start
   existing. `writeReport` already produces a self-contained HTML record book; publish that plus exported replay
   logs as a static site with zero attack surface. Run submission stays local. Later phases stop being blockers for
   being public at all.
1. **Private deployment hardening.** Containerize the existing app; add `/healthz` and `/readyz`, graceful shutdown,
   a persistent data directory, structured logs with secret redaction, dependency/image updates, and a single
   configured public origin. Back up SQLite with continuous replication to object storage (Litestream-style) rather
   than scheduled dumps — near-free, and the restore drill becomes point-in-time recovery. SSE through the proxy
   works but idles out (Cloudflare ≈100s): send heartbeat comments on `/api/events` roughly every 25 seconds.

The code-owned part of step 1 is implemented: `Dockerfile` runs as a non-root user, `railway.toml` points Railway at
`/readyz`, `PORT`/host/public-origin configuration is supported, SIGTERM triggers bounded graceful shutdown, and
`VGC_LEAGUE_DATA_DIR=/data` seeds the bundled pools then keeps pools, runs, and records on the mounted volume.
Hosted mode emits structured request/lifecycle logs without bodies or credentials. A volume is not a backup:
deployment is not operationally complete until `/data`, including `vgcleague.sqlite`, has encrypted off-volume
continuous backup and a tested point-in-time restore.
2. **Identity and durable state — implemented.** GitHub OAuth, hashed sessions, the narrow role model, SQLite
   migrations, immutable pool ownership, experiment ownership, and mutation audit events are live. Public reads stay
   unauthenticated.

The code-owned part of step 2 is implemented. GitHub's authorization-code flow uses one-time `state`, an
`HttpOnly` state cookie, PKCE S256, an exact redirect URI, and no requested scopes; the returned access token is used
once to resolve the stable numeric GitHub subject and is never stored. Opaque session tokens are hashed in SQLite,
expire after seven days, rotate at login, and travel in `HttpOnly`, `Secure`, `SameSite=Lax` cookies. Exact-origin
checks and per-session CSRF tokens protect every mutation. Roles are reader/contributor/operator; new users are
contributors and `VGC_LEAGUE_OPERATOR_GITHUB_IDS` bootstraps operators by stable subject.

SQLite migration 1 creates users, sessions, OAuth flows, immutable pool ownership, experiments, and audit events.
Pool publication and experiment admission/finalization use transactions; failed ownership registration removes the
new filesystem artifact. Run configs and result rows carry contributor provenance. Series/game/decision evidence
remains in append-only files for now rather than being falsely duplicated into incomplete relational tables.
3. **Admission control and execution isolation.** Move runs into a bounded worker process, admitted only when a
   worker slot is free — no durable server-side queue. A durably queued job would need its provider key when it
   eventually starts, which conflicts with memory-only keys; admission control resolves that honestly, and runs are
   minutes to hours, not days. The browser retries when slots are full. Enforce per-user active limits, global
   concurrent-series limits, maximum models, series, teams, and run duration; cancellation must survive browser
   disconnects. A malformed or hung run must not take down the web process.
4. **Public security gate — partial.** CSP, HSTS, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`,
   exact-origin CSRF protection, generic external errors, correlation IDs, and hosted-mode SSRF removal are in place.
   Route/resource rate limits and tested backup/restore and rollback procedures remain before public launch.
5. **Research corpus and scale.** Server-produced evidence feeds public ratings; client submissions remain unverified
   exhibits (see trust model item 6). Retain simulator/model/scaffold/pool/protocol provenance, expose reproducible
   exports, and add moderation workflows. Split workers or move from SQLite only after measured load requires it.

Provider keys remain bring-your-own and memory-only through these phases. Never include them in job configuration,
artifacts, logs, or database rows. A future encrypted vault is a separate opt-in feature with its own threat model, not
a prerequisite for public deployment.

## Records are the data currency

`records/results.jsonl` is append-only and backward compatible: readers tolerate unknown fields, missing optional
ones, and malformed rows (a row without players is skipped by ratings rather than crashing the reader). New rows
record `mode: "rotation"`, `protocol_version: 1`, and `scaffold`; the fields remain optional in the TypeScript reader
so pre-versioning rows still load, and legacy rows without a `pool` field stay in unscoped views. Anything worth
analyzing later—decisions, token usage, latency, provider failures, or behavioral opportunities—should be captured at
run time as structured evidence (post-game reflections carry `series_over` for exactly this reason). Backfilling from
logs is possible but expensive; additive schema fields are cheap.
