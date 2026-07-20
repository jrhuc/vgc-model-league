# Deployment

Deploy the repository with its `Dockerfile` and attach one persistent Railway
volume at `/data`. Set:

```text
VGC_LEAGUE_PUBLIC_ORIGIN=https://<canonical-host>
```

The image already sets `VGC_LEAGUE_HOST=0.0.0.0`,
`VGC_LEAGUE_DATA_DIR=/data`, and
`VGC_LEAGUE_DB_PATH=/data/vgcleague.sqlite`. Railway supplies `PORT` and checks
`/readyz`. Put Cloudflare or another edge rate limiter and WAF in front of the
canonical host.

## Authentication

Without OAuth, hosted mode is read-only. To enable contributor access, create a
GitHub OAuth app with this callback:

```text
https://<canonical-host>/auth/github/callback
```

Set both OAuth credentials:

```text
GITHUB_CLIENT_ID=<oauth-app-client-id>
GITHUB_CLIENT_SECRET=<oauth-app-client-secret>
```

`VGC_LEAGUE_OPERATOR_GITHUB_IDS` optionally promotes a comma-separated list of
numeric GitHub subjects to operator. `VGC_LEAGUE_MAX_RUN_MINUTES` sets the run
deadline from 1 to 1,440 minutes and defaults to 240.

The OAuth flow requests no scopes and uses state and PKCE. SQLite stores session
hashes, roles, ownership, audit events, and experiment status. Cookies are
`HttpOnly`, `Secure`, and `SameSite=Lax`; mutations also require an exact-origin
CSRF token.

Do not set `VGC_LEAGUE_ENABLE_MUTATIONS=true` on a public deployment. It enables
unauthenticated mutations and is intended only for a private deployment behind
its own access control.

## Run admission and isolation

The service admits one run at a time. Hosted rotation runs accept up to four
models. Tournament and draft runs accept up to eight, subject to available
teams or board capacity. Rotation allows up to four series per pair, and all
hosted runs allow up to two concurrent series.

Runs execute in child processes with a 768 MiB V8 heap limit, a restricted
environment, and forced termination at the configured deadline. Hosted mode
does not accept arbitrary OpenAI-compatible endpoints.

Anonymous spectators use `/api/events/public` and `/api/battle/public`, which
contain only Showdown's public split-log data. Owners and operators can use the
private streams. Other authenticated users receive the public representation.

`/healthz` reports process liveness. `/readyz` checks static assets, writable
persistent paths, the authentication database, and the simulator.

## Backups

The image includes Litestream 0.5.14. Set `LITESTREAM_REPLICA_URL` and the
credential variables required by the object store to replicate SQLite and
restore it when the local database is missing.

Litestream retention is disabled in `litestream.yml`. Configure bucket
versioning and lifecycle retention, enable bucket-managed encryption or KMS,
and use credentials without object-deletion permission.

Configure Railway volume backups for `/data/teams`, `/data/runs`, and
`/data/records`, as well as fast whole-volume rollback. These backups remain in
the Railway project; Litestream provides the off-platform SQLite copy. Test
both restore paths with disposable state before relying on them.
