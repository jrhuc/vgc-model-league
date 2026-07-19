# Deployment

The repository includes a multi-stage `Dockerfile` and `railway.toml`. Mount one
persistent Railway volume at `/data`, configure
`VGC_LEAGUE_PUBLIC_ORIGIN=https://<canonical-host>`, and keep Cloudflare or
another edge rate-limit/WAF layer in front of the service. The image sets
`VGC_LEAGUE_HOST=0.0.0.0`, `VGC_LEAGUE_DATA_DIR=/data`, and
`VGC_LEAGUE_DB_PATH=/data/vgcleague.sqlite`; Railway supplies `PORT`.

## Authentication

Hosted mode is read-only when OAuth is absent. For contributor access, register
a GitHub OAuth app with callback `https://<canonical-host>/auth/github/callback`,
then configure:

```text
GITHUB_CLIENT_ID=<oauth-app-client-id>
GITHUB_CLIENT_SECRET=<oauth-app-client-secret>
VGC_LEAGUE_OPERATOR_GITHUB_IDS=<comma-separated-numeric-GitHub-ids>
VGC_LEAGUE_MAX_RUN_MINUTES=240
```

The OAuth flow requests no scopes and uses state plus PKCE. Session hashes,
roles, pool/run ownership, mutation audit events, and experiment status live in
SQLite. Browser cookies are `HttpOnly`, `Secure`, and `SameSite=Lax`; mutations
also require an exact-origin CSRF token. The unsafe
`VGC_LEAGUE_ENABLE_MUTATIONS=true` escape hatch remains only for a separately
protected private deployment without OAuth.

## Run admission and isolation

Hosted admission has one global worker, which also guarantees at most one
active run per account. Each run is capped in models, series per pair,
concurrent series, and duration. Route-specific user limits cover model
discovery, validation, pool publication, and run admission. Runs execute in a
memory-bounded child process with a secret-minimized environment and forced
termination after the duration limit. Arbitrary OpenAI-compatible endpoints are
unavailable in hosted mode.

Anonymous spectators receive `/api/events/public` and `/api/battle/public`.
Those endpoints are built only from Showdown's public split-log branch, so
exact HP and player-private protocol lines never enter the public battle state.
Owners and operators receive the private stream; other authenticated users
automatically fall back to the public representation.

`/healthz` reports liveness; `/readyz` checks assets, writable persistence, the
auth database, and the simulator.

## Backups

The image bundles Litestream. Set `LITESTREAM_REPLICA_URL` plus the credential
variables required by the selected object store to enable continuous SQLite
replication and restore-if-missing startup. Remote deletion is disabled in
`litestream.yml`; enforce retention with a versioned bucket lifecycle policy,
bucket-managed encryption or KMS, and credentials without object-deletion
permission.

This complements Railway's managed volume backups: enable daily, weekly, and
monthly schedules so `/data/teams`, `/data/runs`, and `/data/records` are
captured with SQLite. Railway restores a backup as a staged replacement volume
and redeploys the service.

The two layers cover different failures. Railway snapshots provide simple
whole-volume rollback but remain tied to the same project and environment;
wiping the volume also deletes those backups. Litestream continuously copies
SQLite to a separately controlled bucket and provides the lower-RPO,
off-platform recovery path. Exercise both restore paths against disposable
state before treating the deployment as durable.
