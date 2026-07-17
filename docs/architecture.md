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

`ExperimentMode` currently contains only `rotation`. A new mode extends that type only when its real orchestrator
exists; Draft League and Tournament must not arrive as conditionals scattered through `rotation.ts`. Every new run
config, live snapshot, and completed series carries `mode` and `protocol_version`. Protocol versions change when an
evaluation rule changes enough to make unlike results incomparable.

Before another mode ships, records queries and ratings must be scoped by mode, protocol version, regulation, and pool
where applicable. Rotation Elo remains the default controlled rating; Draft League and Tournament results will have
their own views and cannot silently enter it.

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

## Trust model — today (localhost)

The server binds `127.0.0.1` only, but a localhost server is still reachable from any website the user's browser
visits, so it defends itself:

- **Host allowlist** (`127.0.0.1`, `localhost`, `[::1]`) on every request — blocks DNS-rebinding, where an attacker's
  domain resolves to 127.0.0.1 and the browser happily sends requests with an attacker Host header.
- **Origin check on POSTs** — a present, non-local `Origin` header is rejected (CSRF from web pages).
- **`application/json` content type required on POSTs** — blocks HTML-form CSRF, which can't set that header.
- **Path traversal guard** on static assets; only known extensions under `dist/gui` are served.
- **Keys**: provider API keys are held in browser memory and sent only for catalog lookup and the run; the server
  keeps them in memory for the run's duration, then wipes them. They are never written to records, logs, or state
  responses. Server-side env keys are never exposed to the client.
- Body size limit (2 MB) on JSON parsing.

## Trust model — deployed multi-user site (future, not built)

Before this runs anywhere but localhost, all of the following are required; none should be retrofitted in a hurry:

1. **Authentication, attribution, and run ownership.** Every mutable resource and active job gets an owner. Session
   auth (or OAuth) sits in front of every mutating route; the route table in `server.ts` is the middleware choke point.
   Published evidence belongs to the shared corpus, while contributor identity remains attached for provenance and
   moderation.
2. **Quotas and rate limits.** Runs consume the submitter's LLM credits and our CPU; per-user concurrency caps and
   run-length limits are load-bearing, not polish.
3. **Key handling.** Never store user provider keys at rest. Either keep the current pass-through model (keys live in
   the client, submitted per run, wiped after) or add a per-user encrypted vault with explicit consent. Redact keys
   from every error path (model-catalog already does this for discovery errors).
4. **Execution isolation.** Untrusted-input runs (team pastes, model specs, seeds) execute in a sandboxed worker with
   timeouts, not in the web server process. Validate specs/pastes exactly as now — `createPool`/`inspectTeam`/
   `parseSpec` are already the choke points.
5. **Transport and headers.** HTTPS, CSP, and replacing the localhost host allowlist with the real origin.
6. **Aggregation pipeline.** Central ingestion accepts `results.jsonl`-shaped rows. Requirements include
   `schema_version` (currently 1; bump on breaking change while keeping additive fields optional), `mode`,
   `protocol_version`, model identity, and provenance (Showdown commit, pool id, run seed, and engine seeds).
   Server-side re-validation happens before rows enter shared standings: client-submitted results are claims, not
   facts. Long-term, the server replays the seed and log to verify them. Ratings are recomputed from qualifying rows,
   never stored as authoritative values.

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

1. **Private deployment hardening.** Containerize the existing app; add `/healthz` and `/readyz`, graceful shutdown,
   a persistent data directory, automated encrypted backups plus a restore drill, structured logs with secret
   redaction, dependency/image updates, and a single configured public origin. Confirm the proxy does not buffer SSE.
2. **Identity and durable state.** Add GitHub OAuth, hashed sessions, the narrow role model, SQLite migrations, immutable
   versioned pools, experiment ownership, and an audit trail for every mutation. Public reads stay unauthenticated.
3. **Admission and execution isolation.** Replace the in-web-process scheduler with a bounded job queue and worker
   process. Enforce per-user queued/active limits, global concurrent-series limits, maximum models, series, teams, and
   run duration; cancellation must survive browser disconnects. A malformed or hung run must not take down the web
   process.
4. **Public security gate.** Add strict CSP, HSTS, `X-Content-Type-Options`, `Referrer-Policy`, and
   `Permissions-Policy`; CSRF protection; route and resource rate limits; generic external errors with correlation IDs;
   and tested backup/restore and rollback procedures. Disable arbitrary OpenAI-compatible base URLs in hosted mode or
   run them in a network-restricted worker with HTTPS-only allowlists, redirect revalidation, DNS/IP range rejection,
   response-size limits, and timeouts to close the SSRF path.
5. **Research corpus and scale.** Admit only server-produced or server-revalidated evidence to public ratings, retain
   simulator/model/prompt/pool/protocol provenance, expose reproducible exports, and add moderation workflows. Split
   workers or move from SQLite only after measured load requires it.

Provider keys remain bring-your-own and memory-only through these phases. Never include them in job configuration,
artifacts, logs, or database rows. A future encrypted vault is a separate opt-in feature with its own threat model, not
a prerequisite for public deployment.

## Records are the data currency

`records/results.jsonl` is append-only and backward compatible: readers tolerate unknown fields and missing optional
ones. New rows record `mode: "rotation"` and `protocol_version: 1`; the fields remain optional in the TypeScript reader
so pre-versioning rows still load. Anything worth analyzing later—decisions, token usage, latency, provider failures,
or behavioral opportunities—should be captured at run time as structured evidence. Backfilling from logs is possible
but expensive; additive schema fields are cheap.
