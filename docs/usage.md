# Use the league

## Install

Install Node.js 24.18.1 and pnpm 11.11.0. Then install dependencies, set up
Showdown, build the project, and run the tests:

```sh
npm install --global pnpm@11.11.0 --ignore-scripts --no-audit --no-fund
pnpm install --frozen-lockfile
pnpm run setup:showdown
pnpm run build
pnpm test
```

`setup:showdown` installs and checks the official full-commit pin in
`showdown.lock.json`. The application embeds the simulator, not its HTTP server.
To review or update the pin, run:

```sh
pnpm run check:showdown-update
pnpm run update:showdown
```

The update command builds and tests the candidate. If either step fails, the
command restores the previous revision.

A pin update also moves three reviewed values that the test suite checks
against the lock: the runtime digest map in `src/eval/producer.ts` (the new
digest appears in the mismatch error after the candidate builds), the
`SHOWDOWN_REVISION` substrate pin in
`environments/vgc_circuit_v1/vgc_circuit_v1/protocol.py`, and the pinned
permalinks in `docs/related-work.md`. Record them before the update's test
phase, or it rolls the build back. Review the upstream diff against the
format rules in [CLAUDE.md](../CLAUDE.md) before accepting any candidate.

## Validate the internal VGC Circuit package

Build and test the TypeScript circuit bundle and root integration first. Then
run the standalone Python package tests and build its wheel:

```sh
pnpm test
pnpm run test:circuit-package
pnpm run build:circuit-package
```

The root CI uses the same circuit build and copies
`environments/vgc_circuit_v1/` to a standalone upload boundary before it
runs the Python suite. To reproduce the package-local steps directly, run:

```sh
cd environments/vgc_circuit_v1
uv sync --locked --group test
uv run --locked --group test pytest
uv run --locked --group test eval vgc-circuit-v1 \
  --env.taskset.scenario draft-league-v1 \
  -n 1 -r 1 --dry-run --no-push --rich false \
  -o /tmp/vgc-circuit-dry-run
uv build --wheel --clear
```

Select `victory-road-top8-v1` instead to configure the tournament. One taskset
never combines the two scenarios. The dry run checks native-v1 discovery and
configuration. It does not execute a
circuit or validate a provider, player runtime, referee image, or hosted path.
The [evaluation support table](evaluation-plan.md#verifiers-boundary-and-support)
tracks current evidence. The
[package README](../environments/vgc_circuit_v1/README.md) defines the
runtime and scenario contract.

The package, referee image, and Environment Hub entry are unpublished. A remote
run also requires authenticated access to a published referee image and a
reviewed immutable referee and player runtime image digests. The current
repository does not satisfy those runtime prerequisites.

## Run an experiment

Use one of these exact executable model spec formats:

- `openrouter:<model-id>`
- `prime:<model-id>`
- `random`, the legal-action baseline

OpenRouter uses `OPENROUTER_API_KEY` and the fixed
`https://openrouter.ai/api/v1` endpoint. Its GUI catalog lists current model
IDs. Prime Inference uses `PRIME_API_KEY` and the fixed
`https://api.pinference.ai/api/v1` endpoint; enter its model ID manually. Model
specs do not accept a base URL. GUI credentials entered in the browser remain
in server memory only for that run.

Run the GUI, a self-check, or an experiment:

```sh
pnpm run vgcleague gui
pnpm run vgcleague selfcheck

pnpm run vgcleague rotation   --models <spec> <spec> --pool regmb-202607 --series-per-pair 4
pnpm run vgcleague tournament   --models <spec> <spec> <spec> <spec> --pool regmb-202607
pnpm run vgcleague draft   --models <spec> <spec> <spec> <spec> --board regmb-202607
pnpm run vgcleague exhibition --opponent <spec>
```

`selfcheck` runs one random-versus-random series. Run `pnpm run vgcleague
--help` for the complete current option list.

| Mode | Purpose | Comparison role |
| --- | --- | --- |
| GUI match | one best-of-three | contextual only |
| Tournament | single-elimination bracket, one team per entrant | contextual only |
| Draft | shared draft, matchup builds, round robin, playoffs | contextual only |
| Rotation | mirrored assignments across a fixed pool | controlled/contextual; no rating |
| Exhibition | one external terminal-agent seat | uncontrolled; no rating |

All experiment commands accept `--seed`. Rotation, tournament, and draft accept
`--concurrency` and `--timer-scale <n|off>`. Battles are untimed by default.
`--timer-scale 1` uses the standard VGC clock. Values from 0.5 through 4 scale
Showdown's clocks. Do not pool results from different clocks or scaffolds.

If you omit reasoning configuration, the provider uses its default. No setting
claims to disable reasoning. The CLI can send `minimal`, `low`, `medium`,
`high`, or `xhigh` to an explicit OpenRouter model and reports any upstream
rejection unchanged. The GUI offers those levels for an OpenRouter catalog
model only if its `supported_parameters` includes `reasoning`. Prime model IDs
are entered manually and do not advertise configurable levels because their
capabilities are unknown.

Transient provider outages and rate or quota errors pause and retry. Credential
and invalid-request errors fail immediately. Each call uses the recorded seat's
exact model spec. For OpenRouter, `--nitro` adds the `:nitro` throughput route to
specs without adding another routing variant. Fallback is always disabled. Set
`VGC_OPENROUTER_PIN=<provider>` to supply the only upstream order entry as
routing metadata. Without this variable, OpenRouter selects an upstream. The
application records the returned provider with cost data.

### Run the frontier strategic pilot

Build once, then call an actual OpenRouter or Prime model through the same
provider layer used by the working Pokémon harness:

```sh
pnpm run build

OPENROUTER_API_KEY=<key> pnpm run strategic-pilot \
  --models openrouter:<model-id> \
  --pool test \
  --draws 4 \
  --model-decisions 1 \
  --reasoning high \
  --out runs/strategic-pilot-smoke
```


Freeze each source before any provider call:

```sh
pnpm run strategic-pilot \
  --prepare-source-only \
  --pool test \
  --focal-team <team-id> \
  --opponent-team <team-id> \
  --seed source-1 \
  --out runs/source-1
```

Add `--sensitivity-screen` to a provider-free invocation to fill the complete
scripted action-by-draw rectangle under the declared first-legal continuation.
The screen is outcome-blind, so it may inform source selection before
preregistration; a `flat` verdict means no focal choice can move the terminal
series result and the source cannot test an information effect in this unit.

Repeat `--models` to run the same source and common draws for multiple models.
Use `prime:<model-id>` with `PRIME_API_KEY` for Prime Inference. The command
rejects `random`: this pilot is specifically the real-provider seam. Reasoning
models that can spend the whole `--max-tokens` budget thinking should also set
`--reasoning-max-tokens` to guarantee visible-text headroom. Run
`pnpm run strategic-pilot --help` for every option.

The v2 pilot is deliberately narrow. It constructs one deterministic source
matchday from two committed pool teams, finishes that source with the first
Showdown-accepted action policy, and verifies a checkpoint after Game 1. The
frontier model writes private between-game notebook bytes from only its
seat-authorized Game 1 history and the open team sheets. The checkpoint binds
that exact authorized source POV and drains it before Game 2, so the
continuation receives source-game information only through the declared
treatment bytes. By default the same model makes the first non-forced Game 2
choice, usually team preview, and a declared first-legal policy completes the
series. This is the cheapest attributable shard. Increase `--model-decisions`
for a short intervention chain or use `all` for the ecological full-policy
follow-up. The matched arms are:

- **authentic:** inject the model-written notebook;
- **withheld:** inject empty notebook bytes.

The opposing seat uses a fixed first-legal policy. Future battle seeds are
common across arms, downstream controller identity is held fixed, arm order is
rotated by draw, invalid model output receives no fallback utility, and every
prompt, response, reasoning trace, usage value, reported cost, treatment,
checkpoint, plan, execution, and terminal artifact is content-addressed.

Provider APIs do not expose a portable sampling seed. The command therefore
uses temperature zero, disables OpenRouter fallback, records the returned
upstream provider, balances arm order, and labels residual provider randomness
instead of claiming exact model-call reproducibility. Reuse the exact source in
another run with:

```sh
pnpm run strategic-pilot \
  --models openrouter:<model-id> \
  --source runs/strategic-pilot-smoke/source.json \
  --draws 8 \
  --out runs/strategic-pilot-confirmation
```

After collecting independent source directories, validate every digest and
aggregate at the source-cluster level:

```sh
pnpm run summarize-strategic-pilots \
  --out runs/strategic-pilot-aggregate.json \
  runs/source-1 runs/source-2 runs/source-3 runs/source-4
```

The summarizer scans model report JSON recursively, rejects broken plan, call,
treatment, execution, analysis, or report joins, averages repeated provider-call
runs inside each source first, and computes uncertainty across source means. It
marks fewer than four valid source clusters as insufficient and never emits a
ranking.

Add preregistered negative and upper-bound controls with exact notebook files:

```sh
pnpm run strategic-pilot \
  --models openrouter:<model-id> \
  --source <source.json> \
  --treatment stale=<stale.txt> \
  --treatment false=<false.txt> \
  --treatment placebo=<placebo.txt> \
  --treatment oracle=<oracle.txt>
```

The output directory is private evidence and must be new or empty. Every
artifact is written create-only; reruns require a new directory rather than
silently replacing evidence. `source.json` contains exact private source
evidence; each model JSON contains prompts and raw provider responses;
`summary.json` is only a batch index. Do not publish these files through the
static-site exporter. One team pair is one uncertainty cluster, so one command
can establish plumbing and discover gross effects but cannot support a model
ranking.

## Trade message forks

Fork one trade-offer node of a deterministic synthetic circuit into matched
offers that differ only in the public message, and measure the counterparty's
decision at fixed pre-offer state ([design](trade-forks.md)):

```sh
pnpm run trade-message-pilot \
  --message honest=controls/honest.txt \
  --message deceptive=controls/deceptive.txt \
  --models openrouter:<model-id> \
  --reasoning high \
  --horizon terminal \
  --out runs/trade-message-1
```

Every arm binds identical terms, rationale, and notebook bytes; only the
message varies. `--scripted accept|reject` replaces the model responder for
provider-free plumbing checks, and `--horizon terminal` continues each arm to
terminal league utility under the declared default-tolerant controllers. One
node is one cluster and is never a ranking.

Use this sequence before expanding the benchmark:

1. **Smoke:** one frontier model, one source, one draw. Require a complete run,
   strict JSON, accepted legal commands, and joined terminal evidence.
2. **Signal check:** two or three materially different frontier models, at
   least four independently chosen team-pair/source clusters, and at least
   eight common draws per arm. Keep prompts and controller policies frozen.
3. **Falsification:** add stale, false, placebo, and oracle notebooks. Authentic
   memory should beat withholding in the intended cases; false memory should
   harm more than placebo; oracle information should provide a visible upper
   bound.
4. **Replication:** rerun the preregistered sources under a new provider-call
   batch and require the direction of the source-cluster effect to survive.
5. **Only then scale:** build unbiased source selection, stronger fixed policy
   populations, and a native shard package.

Stop investing in this evaluation layer if protocol-valid and legal completion
is below 95%, authentic versus withheld has no stable source-cluster signal,
false information is not detectably worse than irrelevant information, effects
collapse under a second downstream policy, or provider cost makes the required
replication impractical. In that case the existing Pokémon harness remains the
product, and the most useful additions are likely model coaching/scouting
experiments, search-versus-model action proposals, draft-plan adherence forks,
or a curated expert disagreement and failure-mode corpus rather than another
headline benchmark.

### Resume a tournament

A seeded event pool keeps its actual bracket positions while models are shuffled
across teams. `--provenance disclosed`, the default, names the event and field,
but the competitive prompt omits finishing order. `blind` omits the event
context. Competitive prompts never include player names.

Resume a stopped bracket:

```sh
pnpm run vgcleague tournament --resume <run-dir>
```

The stored entrants, pool and teams, seed, provenance, reasoning, timer, draw,
and completed evidence define the continuation. The application replays
recorded decisions without provider calls only when reconstruction remains
eligible and requests match. Otherwise, it continues the unfinished game live
or restarts it. Resume reconstructs explicit state and notes; it does not
restore a provider process or chat. Stop the previous owner before resuming. Do
not resume the same run concurrently.

### Run a draft league

Drafts select ten roster entries within 100 points and then build six complete
sets for each matchup. Round-robin builds cannot access other round-robin
results. By default, the scheduler runs concurrency-limited blind batches: all
scheduled series through the transaction week, then the barrier and window,
then the remaining series. If you turn off the window, the round robin uses one
batch. Use sequential weeks only as a labeled alternative.

Use these controls as needed:

```sh
pnpm run vgcleague draft --models <specs...> --draft-only
pnpm run vgcleague draft --resume <run-dir>
pnpm run vgcleague draft --models <specs...> --through-week <n>
pnpm run vgcleague draft --models <specs...> --sequential-weeks
pnpm run vgcleague draft --models <specs...> --closed-sheets
pnpm run vgcleague draft --models <specs...> --trade-window off
```

`--draft-only` records rosters and stops. Resume the run later to play the
season. `--through-week` implies sequential weeks and stops cleanly after the
specified week. Champions Bo3 uses open team sheets by default and excludes
hidden stat points. `--closed-sheets` is a separate condition.

By default, one transaction window opens after week 3, or after the last
round-robin week in a shorter league. Use `--trade-window <week>` to move it.
Use `off` for the labeled locked-roster control. Each coach can make one
one-for-one offer before submitting up to six atomic free-agent drop/add swaps.
See [Trade window](trade-window.md) for the complete rules and evidence
boundaries.

Private notes are explicitly reinjected state, not a persistent provider
conversation. A roster note persists through the draft and transaction window.
A matchup plan and battle notebook apply only to their series. Playoff coaches
can receive their own earlier builds, results, and final notes. Franchise names
are spectator metadata and do not enter competitive or review prompts. The
application records a terminal [Season review](season-review.md) when each
coach's season ends.

Resume uses the stored board, models, seed, rosters, schedule, transaction state,
completed results, and authorized playoff context. It stops if transaction,
result, playoff, or roster evidence is inconsistent. A draft-only run selects
its transaction window when season play begins because the run has not held a
window yet.

## Manage immutable inputs

Team pools are stored at `teams/<pool>/pool.json`. Draft boards are stored at
`boards/<board>.json`. Do not modify an input after it has recorded results.

```sh
pnpm run build-pool teams/<pool>/sources.json
pnpm run build-event-pool teams/<pool>/sources.json
pnpm run build-board
```

`build-pool` reads Poképaste sources. The GUI pool manager also accepts Showdown
teambuilder exports. The pinned simulator validates both input types. The
current board builder uses its fixed Regulation MB cost source and does not
accept a pool.

## Inspect evidence

```sh
pnpm run vgcleague outcomes
pnpm run vgcleague outcomes --pool regmb-202607
pnpm run vgcleague report --pool regmb-202607
```

Without `--pool`, outcomes and reports exclude only the disposable `test` pool.
They show contextual per-series rows with mode, pool, clock, scaffold,
opponents, and sample size. They do not merge aliases or calculate an aggregate
order. Standings and brackets describe only their individual run.

The local dynamic GUI uses these canonical routes: **Home**, **Method**,
**Docs**, **Draft leagues**, **Live**, **Tournaments**, and **New run**. Home and
Method render the committed, hash-checked selected artifact. The static GitHub
Pages build is archive-only: it retains the research and archive routes and
omits **Live** and **New run**. Only the
[Evaluation plan](evaluation-plan.md#program-status) defines release status.

Showdown and the versioned offline evaluator remain authoritative. The
[Architecture](architecture.md#state-evidence-and-trust) defines browser and
anonymous evidence boundaries.

Decision and context logs record authorized observations and submitted model
evidence. These logs do not prove that Showdown accepted a transition. Join them
with game and referee logs to establish legality, substitutions, timer defaults,
and outcomes.

## Export experimental position evidence

The supported offline commands are experimental and do not run a comparison
model:

```sh
pnpm run grade-positions --workers 4 --restart
pnpm run export-position-panels --horizon 2 --luck 8 --opponents 4 --seed panels-1
```

`grade-positions` replays eligible games exactly and evaluates every legal
action once with the canonical three-panel exhaustive estimator. Its schema-v3
cache stores source joins with private, exact, pid-keyed generating-model
provenance; the recorded action; state value; canonical protocol and seed; and
versioned qualification metrics. It does not store action-value matrices. Use
`--restart` if an older grading cache exists.

`export-position-panels` requires the same `--horizon`, `--luck`, and
`--opponents` budgets as the grading manifest. It selects positions only from
the manifest's grade-time qualification metrics and generates fresh panels in
the exporter seed namespace. It writes one public candidate root and one
private root that contains score and sealed-panel files.

Neither command releases a position package. Only the
[Evaluation plan](evaluation-plan.md#program-status) defines status, and its
`vgc-positions-v1` section defines the remaining gates.

## Archive and publish

The selected GUI evidence uses a committed, immutable three-file bundle. Run
its clean-checkout integrity and privacy check:

```sh
pnpm run check:artifacts
```

There is no supported reconstruction or promotion command.

Archive full run directories to verified tarballs without deleting the source
directories:

```sh
pnpm run archive-run <run-id> [<run-id>...]
```

The command writes to `$VGC_RUN_ARCHIVE_DIR` or `~/vgc-run-archive`. Use
operator-managed tooling to copy the archive offsite. You can then remove source
runs manually.

Publish completed result rows and allowed support evidence to the public static
site:

```sh
pnpm run publish:site
```

This command builds the project, re-exports `artifacts/public/site` from local
records, and lands the commit on `main` through a self-merged pull request. The
`main` ruleset rejects direct pushes. The Pages workflow then redeploys the
site. To control the selection first, run the exporter and inspect its output
before committing:

```sh
pnpm run export-site
pnpm run export-site -- --pool regmb-202607
pnpm run export-site -- --run <run-id>
```

Without filters, the export excludes `test`. Use `--include-test` to include it.
Repeat `--run` to select exact runs. The export contains result rows, decision
and game logs, and league support assets already defined as public archive
evidence. It does not contain prompt-attempt logs, raw provider responses, trace
logs, or seat-context JSONL.

Exporting does not release traces. The
[Architecture](architecture.md#state-evidence-and-trust) defines the exact
public boundaries. [Deployment](deployment.md) defines site deployment.

## Use the Exhibition seat

Exhibition creates `runs/<run>/agent/` with `seat.mjs`, `SEAT.md`, and a token.
Start the external terminal agent in that directory. The loopback bearer bridge
and POSIX owner-only modes provide token hygiene but not a sandbox.
Same-UID processes can read the workspace. The system does not enforce
filesystem, process, credential, network, egress, or delegation isolation.

Use Exhibition only for trusted, manual, unrated runs. It cannot support
controlled model or scaffold claims. During a live process, page authorized
history omitted from the compact prompt with:

```sh
node seat.mjs context '{"after":"ctx-00000010","limit":50}'
```

This command does not recover the memory of an earlier external process.
