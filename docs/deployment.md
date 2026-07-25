# Deployment

Deploy the repository with its `Dockerfile`. Attach one persistent Railway
volume at `/data`. Set:

```text
VGC_LEAGUE_PUBLIC_ORIGIN=https://<canonical-host>
```

The image already sets `VGC_LEAGUE_HOST=0.0.0.0`,
`VGC_LEAGUE_DATA_DIR=/data`, and
`VGC_LEAGUE_DB_PATH=/data/vgcleague.sqlite`. Railway supplies `PORT` and
checks `/readyz`. Put Cloudflare or a different edge rate limiter and WAF in
front of the canonical host.

## Authentication

Without OAuth, hosted mode is read-only. To enable contributor access, create
a GitHub OAuth app with this callback:

```text
https://<canonical-host>/auth/github/callback
```

Set the two OAuth credentials:

```text
GITHUB_CLIENT_ID=<oauth-app-client-id>
GITHUB_CLIENT_SECRET=<oauth-app-client-secret>
```

`VGC_LEAGUE_OPERATOR_GITHUB_IDS` is optional. It promotes a comma-separated
list of numeric GitHub subjects to operator. `VGC_LEAGUE_MAX_RUN_MINUTES` sets
the run deadline. The range is 1 to 1,440 minutes, and the default is 240.

`VGC_LEAGUE_IMPORT_TOKEN` is optional. It is a shared operator secret that
enables `POST /api/import`, the route `vgcleague publish` uses to send
completed local series to the deployment. Without the variable the route
answers 404. Set the same value in the shell that runs `publish`. Rotate it by
changing the variable; nothing else stores it.

The OAuth flow requests no scopes and uses state and PKCE. SQLite stores the
session hashes, roles, ownership, audit events, and experiment status.
Cookies are `HttpOnly`, `Secure`, and `SameSite=Lax`. Mutations also require
an exact-origin CSRF token.

Do not set `VGC_LEAGUE_ENABLE_MUTATIONS=true` on a public deployment. It
enables unauthenticated mutations. Use it only for a private deployment
behind its own access control.

## Run admission and isolation

The service admits one run at a time. Hosted rotation runs accept a maximum
of four models. Tournament and draft runs accept a maximum of eight models,
inside the limits of the available teams or board capacity. Rotation permits
a maximum of four series for each pair. All hosted runs permit a maximum of
two concurrent series.

Runs execute in child processes with a 768 MiB V8 heap limit and a restricted
environment. The server terminates a run at the configured deadline. Hosted
mode does not accept arbitrary OpenAI-compatible endpoints.

Anonymous spectators use `/api/events/public` and `/api/battle/public`. These
routes contain only the public split-log data of Showdown. Owners and
operators can use the private streams. Other authenticated users receive the
public representation.

`/healthz` reports process liveness. `/readyz` checks the static assets, the
writable persistent paths, the authentication database, and the simulator.

## Backups

The image includes Litestream 0.5.14. Set `LITESTREAM_REPLICA_URL` and the
credential variables that the object store requires. Litestream then
replicates SQLite, and restores it when the local database is missing.

Litestream retention is off in `litestream.yml`. Configure bucket versioning
and lifecycle retention. Enable bucket-managed encryption or KMS. Use
credentials without object-deletion permission.

Configure Railway volume backups for `/data/teams`, `/data/runs`, and
`/data/records`, and also fast whole-volume rollback. These backups stay in
the Railway project. Litestream supplies the off-platform SQLite copy. Test
the two restore paths with disposable state before you rely on them.
