# Use the league

## Install

Use Node.js 24.18.1 and pnpm 11.11.0.

```sh
npm install --global pnpm@11.11.0 --ignore-scripts --no-audit --no-fund
pnpm install --frozen-lockfile
pnpm run setup:showdown
pnpm run build
pnpm test
```

`setup:showdown` installs and checks the official full-commit pin in
`showdown.lock.json`; the application embeds the simulator, not its HTTP server.
To review or update the pin:

```sh
pnpm run check:showdown-update
pnpm run update:showdown
```

The update command builds and tests the candidate and restores the old revision
on failure.

## Check the internal matchday package

For internal contributor validation, build and test both the root TypeScript
fixture at `dist/tests/fixtures/frozen-matchday.js` and the isolated
`dist-matchday` bundle before entering the Python package workflow. Run these
commands in order:

```sh
pnpm test
pnpm run test:frozen-matchday-package
pnpm run build:frozen-matchday-package
```

The package workflow and its current evidence are tracked only in the
[evaluation support table](evaluation-plan.md#verifiers-boundary-and-target-architecture).
The [package README](../environments/vgc_frozen_matchday_v0/README.md) owns its
runtime contract.

After `pnpm test` has built the CLI, freeze a reviewed private matchday source
only into an absent private output root:

```sh
pnpm run freeze-frozen-matchday-task-source \
  --input /absolute/path/private-source.json \
  --out /absolute/path/absent-private-output-root
```

The command writes a private `manifest.json` and `task-source.jsonl`. It is safe
only under the command's trusted-single-producer,
immutable-repository/build/runtime-tree precondition;
run `pnpm run freeze-frozen-matchday-task-source --help` for the byte,
attestation, portability, concurrency, and identical-rerun limits. Do not treat
this output as reviewed or release-approved.

## Run an experiment

Executable model specs are exactly `openrouter:<model-id>`, `prime:<model-id>`,
and `random`, the legal-action baseline. OpenRouter uses the fixed
`https://openrouter.ai/api/v1` endpoint and `OPENROUTER_API_KEY`; its GUI catalog
lists current model IDs. Prime Inference uses the fixed
`https://api.pinference.ai/api/v1` endpoint and `PRIME_API_KEY`; enter its model ID
manually. Model specs never accept a base URL. GUI credentials entered in the
browser remain in server memory only for that run.

```sh
pnpm run vgcleague gui
pnpm run vgcleague selfcheck

pnpm run vgcleague rotation   --models <spec> <spec> --pool regmb-202607 --series-per-pair 4
pnpm run vgcleague tournament   --models <spec> <spec> <spec> <spec> --pool regmb-202607
pnpm run vgcleague draft   --models <spec> <spec> <spec> <spec> --board regmb-202607
pnpm run vgcleague exhibition --opponent <spec>
```

`selfcheck` runs one random-versus-random series. Use `pnpm run vgcleague
--help` for the complete current option list.

| Mode | Purpose | Comparison role |
| --- | --- | --- |
| GUI match | one best-of-three | contextual only |
| Tournament | single-elimination bracket, one team per entrant | contextual only |
| Draft | shared draft, matchup builds, round robin, playoffs | contextual only |
| Rotation | mirrored assignments across a fixed pool | controlled/contextual; no rating |
| Exhibition | one external terminal-agent seat | uncontrolled; no rating |

All experiment commands accept `--seed`. Rotation, tournament, and draft
accept `--concurrency` and `--timer-scale <n|off>`. Battles are untimed by
default. `--timer-scale 1` uses the standard VGC clock; 0.5 through 4 scales
Showdown's clocks. Never pool different clocks or scaffolds.

Omitting reasoning configuration means provider default; there is no setting that
claims to disable reasoning. The CLI may send `minimal`, `low`, `medium`, `high`,
or `xhigh` to an explicit OpenRouter model and report any upstream rejection
unchanged. The GUI offers those levels for an OpenRouter catalog model only when
its `supported_parameters` includes `reasoning`. Prime's manually entered model
IDs advertise no configurable levels because their capability is unknown.

Transient provider outages and rate/quota errors pause and retry; credential and
invalid-request errors fail fast. Each call executes the recorded seat's exact
model spec. For OpenRouter, `--nitro` adds the `:nitro` throughput route to specs
without another routing variant. Fallback is always disabled.
`VGC_OPENROUTER_PIN=<provider>` optionally supplies the sole upstream order entry
as routing metadata; without it OpenRouter chooses one upstream. The returned
provider is recorded with cost data.

### Tournaments and resume

A seeded event pool preserves its real bracket positions while models are
shuffled across teams. `--provenance disclosed` (default) names the event and
field but the competitive prompt withholds finishing order; `blind` withholds
the event context. Player names never enter competitive prompts.

Resume a stopped bracket with:

```sh
pnpm run vgcleague tournament --resume <run-dir>
```

The stored entrants, pool/teams, seed, provenance, reasoning, timer, draw, and
completed evidence define the continuation. Recorded decisions replay without
provider calls only while reconstruction remains eligible and requests match;
otherwise the unfinished game continues live or restarts. Resume reconstructs
explicit state and notes, not a provider process or chat. Stop the old owner and
never resume one run concurrently.

### Draft leagues

Drafts select ten roster entries within 100 points, then build six complete sets
per matchup. Round-robin builds are blind to other round-robin results. By
default the scheduler runs concurrency-limited blind batches: all scheduled
series through the transaction week, the barrier/window, then the remaining
series. With the window off, the round robin is one batch. Use sequential weeks
only as a labeled alternative. Useful controls include:

```sh
pnpm run vgcleague draft --models <specs...> --draft-only
pnpm run vgcleague draft --resume <run-dir>
pnpm run vgcleague draft --models <specs...> --through-week <n>
pnpm run vgcleague draft --models <specs...> --sequential-weeks
pnpm run vgcleague draft --models <specs...> --closed-sheets
pnpm run vgcleague draft --models <specs...> --trade-window off
```

`--draft-only` records rosters and stops; resume later to play the season.
`--through-week` implies sequential weeks and stops cleanly after that week.
Champions Bo3 uses open team sheets by default, excluding hidden stat points;
`--closed-sheets` is a distinct condition.

One transaction window opens after week 3 by default, or the last round-robin
week in a shorter league. `--trade-window <week>` moves it; `off` is the labeled
locked-roster control. Each coach may make one one-for-one offer before submitting
up to six atomic free-agent drop/add swaps. Full rules and evidence boundaries
are in [Trade window](trade-window.md).

Private notes are explicit reinjected state, not a persistent provider
conversation. A roster note carries through the draft and transaction window; a
matchup plan and battle notebook are series-scoped. Playoff coaches may receive
their own earlier builds/results/final notes. Franchise names are spectator
metadata and never enter competitive or review prompts. A terminal
[Season review](season-review.md) is recorded when each coach's season ends.

Resume uses the stored board, models, seed, rosters, schedule, transaction state,
completed results, and authorized playoff context. Inconsistent transaction,
result, playoff, or roster evidence stops the resume. A draft-only run chooses
its window when season play begins because it has not held one yet.

## Manage immutable inputs

Team pools live at `teams/<pool>/pool.json`; draft boards live at
`boards/<board>.json`. Never mutate an input after it has recorded results.

```sh
pnpm run build-pool teams/<pool>/sources.json
pnpm run build-event-pool teams/<pool>/sources.json
pnpm run build-board
```

`build-pool` consumes Poképaste sources. The GUI pool manager also accepts
Showdown teambuilder exports. The pinned simulator validates both. The current
board builder uses its fixed Regulation MB cost source; it does not take a pool.

## Inspect evidence

```sh
pnpm run vgcleague outcomes
pnpm run vgcleague outcomes --pool regmb-202607
pnpm run vgcleague report --pool regmb-202607
```

Without `--pool`, outcomes and reports exclude only the disposable `test` pool.
They show contextual per-series rows with mode, pool, clock, scaffold, opponents,
and sample size; they never merge aliases or calculate an aggregate order.
Within-run standings and brackets remain descriptions of that run.

The GUI's canonical routes are **Home**, **Method**, **Docs**, **Draft
leagues**, **Live**, **Tournaments**, and **New run**. Home and Method render the
committed hash-checked selected artifact. Release status belongs only in the
[Evaluation plan](evaluation-plan.md#program-status).

Showdown and the versioned offline evaluator remain authorities. Browser and
anonymous evidence boundaries are defined once in
[Architecture](architecture.md#state-evidence-and-trust).

Decision/context logs record authorized observations and submitted model
evidence. They do not prove Showdown accepted a transition; join game/referee
logs to establish legality, substitutions, timer defaults, and outcomes.

## Export experimental position evidence

The supported offline commands remain experimental and run no comparison model:

```sh
pnpm run grade-positions --workers 4 --restart
pnpm run export-position-panels --horizon 2 --luck 8 --opponents 4 --seed panels-1
```

`grade-positions` exactly replays eligible games and evaluates every legal action
once through the canonical three-panel exhaustive estimator. Its schema-v3 cache
stores source joins with private exact pid-keyed generating-model provenance, the
recorded action, state value, canonical protocol and seed, and versioned
qualification metrics; it stores no action-value matrices.
Pass `--restart` when an older grading cache exists. `export-position-panels`
requires the same `--horizon`, `--luck`, and `--opponents` budgets as the grading
manifest, selects only from its grade-time qualification metrics, then generates
fresh panels under the exporter seed namespace. It writes one public candidate
root and one private root containing both score and sealed-panel files. Neither
command releases a position package. The [Evaluation plan](evaluation-plan.md#program-status)
alone owns status; its `vgc-positions-v1` section owns the remaining gates.

## Archive and publish

The selected GUI evidence uses a committed immutable three-file bundle.
Run its clean-checkout integrity and privacy check with `pnpm run
check:artifacts`; there is no supported reconstruction or promotion command.

Archive full run directories to verified tarballs without deleting their source:

```sh
pnpm run archive-run <run-id> [<run-id>...]
```

The destination is `$VGC_RUN_ARCHIVE_DIR` or `~/vgc-run-archive`. Copy it
offsite with operator-managed tooling, then remove source runs manually if
wanted.

Publish completed result rows and the allowed support evidence to the public
static site:

```sh
pnpm run publish:site
```

This builds, re-exports `artifacts/public/site` from local records, commits it,
and pushes; the Pages workflow then redeploys. To control the selection first,
run the exporter directly and inspect the output before committing:

```sh
pnpm run export-site
pnpm run export-site -- --pool regmb-202607
pnpm run export-site -- --run <run-id>
```

Without filters the export excludes `test`; `--include-test` overrides that.
Repeat `--run` for exact runs. The export contains result rows, decision/game
logs, and league support assets already defined as public archive evidence. It
never contains prompt-attempt logs, raw provider responses, trace logs, or
seat-context JSONL.

Export is not trace release. The exact public boundaries live in
[Architecture](architecture.md#state-evidence-and-trust); site deployment lives
in [Deployment](deployment.md).

## Exhibition seat

Exhibition creates `runs/<run>/agent/` with `seat.mjs`, `SEAT.md`, and a token.
Start the external terminal agent there. The loopback bearer bridge and POSIX
owner-only modes provide token hygiene, not a sandbox: same-UID processes can
read the workspace, and no filesystem, process, credential, network, egress, or
delegation isolation is enforced.

Treat Exhibition as trusted, manual, and unrated. It cannot support controlled
model/scaffold claims. During the live process, `node seat.mjs context
'{"after":"ctx-00000010","limit":50}'` pages authorized history omitted from the
compact prompt. It does not recover an earlier external process's memory.
