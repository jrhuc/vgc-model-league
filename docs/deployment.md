# Deployment

Deploy the repository with its `Dockerfile`. Use one long-running Railway
service. Attach one persistent volume at `/data`.

## Configure the service

Set the public origin:

```text
VGC_LEAGUE_PUBLIC_ORIGIN=https://<canonical-host>
```

The image sets these values:

```text
VGC_LEAGUE_HOST=0.0.0.0
VGC_LEAGUE_DATA_DIR=/data
VGC_LEAGUE_DB_PATH=/data/vgcleague.sqlite
```

Railway supplies `PORT`. Put Cloudflare or another edge rate limiter and web
application firewall in front of the service. Proxy one canonical host.

## Configure authentication

Without OAuth, a hosted service is read-only. Create a GitHub OAuth app to
enable contributor access. Use this callback:

```text
https://<canonical-host>/auth/github/callback
```

Set the OAuth credentials:

```text
GITHUB_CLIENT_ID=<oauth-app-client-id>
GITHUB_CLIENT_SECRET=<oauth-app-client-secret>
```

Set `VGC_LEAGUE_OPERATOR_GITHUB_IDS` to a comma-separated list of numeric
GitHub account IDs. These accounts receive the operator role. The variable is
optional. The list is authoritative at service startup: removing an ID demotes
that account's existing sessions to contributor, while adding it promotes them.

Do not set `VGC_LEAGUE_ENABLE_MUTATIONS=true` on a public service. This setting
permits unauthenticated changes. Use it only behind separate private access
control.

## Configure runs and imports

`VGC_LEAGUE_MAX_RUN_MINUTES` sets the run deadline. The valid range is 1 through
1,440 minutes. The default is 240 minutes.

`VGC_LEAGUE_IMPORT_TOKEN` enables `POST /api/import`. Set a long random value.
Give the same value to operators who publish local results. The route returns
404 when the variable is not set. Change the variable to rotate the token.

The service admits one run at a time. It applies these limits:

| Mode | Maximum models | Other limit |
| --- | ---: | --- |
| Rotation | 4 | 4 series for each pair |
| Tournament | 8 | Available pool teams |
| Draft League | 8 | Draft board capacity |

Each hosted run can use at most two concurrent series. Each run uses a child
process with a 768 MiB V8 heap limit and a restricted environment. The server
terminates the process when the run deadline expires. Hosted mode rejects
arbitrary OpenAI-compatible endpoints.

## Monitor the service

Railway checks `/readyz`. This endpoint checks static assets, writable data
paths, SQLite, and the pinned simulator. Use `/healthz` only for process
liveness.

The application sends an SSE heartbeat every 25 seconds. Configure the proxy
timeout to keep these connections open.

## Configure backups

The image includes Litestream 0.5.14. Set `LITESTREAM_REPLICA_URL` and the
credential variables for the object store. Litestream restores a missing
SQLite database and then replicates changes.

`litestream.yml` does not set retention. Configure object versioning and
lifecycle retention. Enable bucket-managed encryption or KMS. Use credentials
that cannot delete objects.

Enable Railway volume backups for these paths:

```text
/data/teams
/data/runs
/data/records
```

Also enable whole-volume rollback. Railway backups remain in the Railway
project. Litestream provides the separate SQLite copy. Test both restore paths
with disposable data.

See [Architecture](architecture.md) for the access and evidence trust model.
See [Use the league](usage.md) for publication commands.
