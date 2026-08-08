# Deployment

Deploy the browser/API results service with the repository `Dockerfile`. Use one
long-running Railway service and attach one persistent volume at `/data`. This
is the results-service image, not a matchday referee or model-runtime image.

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

Without OAuth, a hosted service is read-only for browser and contributor
mutation requests, except for separately token-authenticated import API `POST`
endpoints when configured. Create a GitHub OAuth app to enable contributor
access. Use this callback:

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

`VGC_LEAGUE_IMPORT_TOKEN` enables `POST /api/import` and
`POST /api/import/remove`. Set a long random value. Give the same value to
operators who publish or remove local results. Both routes return 404 when the
variable is not set. Change the variable to rotate the token.

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

## Eight-seat study topology (planning only)

This is not a supported Draft Circuit deployment. Eight logical, isolated seat
roles do not require eight weight servers. Provide one inference endpoint per
distinct served model stack, not per treatment. Scaffold or context arms using
the same served stack can share a stateless weight endpoint, while seat runtimes
and context roots remain separately authorized and isolated.

Begin serially, with one draft turn and one matchday active at a time. Add
concurrency only after capacity tests and role-isolation evidence. An
RTX 4080 (16 GB VRAM) host with 128 GB RAM is a candidate for
orchestration, Showdown, the referee, and a single served model, subject to
benchmarking. The same control stack can instead use cloud APIs; do not plan
eight model replicas. All
7–9B and 12–14B planning ranges assume suitable ~4-bit quantization, bounded
context, sufficient KV-cache headroom, and a compatible backend; each stack
must be benchmarked, and neither range is a categorical fit promise. Larger
models with offload are slow and must also be benchmarked. Record hardware,
backend, context length, concurrency, throughput, latency, memory headroom, and
failures for each capacity test.

A CPU VPS is useful for uptime, queueing, the control plane, and controlled
provider egress, not for model capability. Prime services, cloud services, and
rented GPUs are generic future compute options; mentioning them does not prove
support for a native Environment, Environment Hub, or Hosted workflow.

Keep referee JSONL private and never expose it through a public tunnel. Permit
only controlled provider egress or a private, authenticated path to a weight
server.

Use [Measurement](measurement.md#scaffolds-and-rollout-profiles) for condition,
profile, and treatment identity. Comparison, counterbalancing, return, release,
and rank policy belong to the
[Draft Circuit release gates](evaluation-plan.md#draft-circuit-release-gates);
its [Draft Circuit status](evaluation-plan.md#program-status) records that the
connected circuit and circuit return are absent.

## Monitor the service

Railway checks `/readyz`. This endpoint checks static assets, writable roots,
installed draft boards, and the pinned simulator. It checks SQLite readiness
only when OAuth has configured `AuthService`; without OAuth, SQLite is not part
of readiness. Use `/healthz` only for process liveness.

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
