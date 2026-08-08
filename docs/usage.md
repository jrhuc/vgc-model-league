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

## Run an experiment

A model spec is `<provider>:<model-id>`; `random` is the legal-action baseline.
CLI runs read provider credentials from the environment. GUI credentials entered
in the browser remain in server memory only for that run.

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

All experiment commands accept `--seed` and `--reasoning`. Rotation, tournament,
and draft accept `--concurrency` and `--timer-scale <n|off>`. Battles are untimed
by default. `--timer-scale 1` uses the standard VGC clock; 0.5 through 4 scales
Showdown's clocks. Never pool different clocks or scaffolds.

Transient provider outages and rate/quota errors pause and retry; credential and
invalid-request errors fail fast. For OpenRouter, `--nitro` adds the `:nitro`
throughput route to specs without another routing variant.
`VGC_OPENROUTER_PIN=<provider>` selects one upstream and disables fallback;
`VGC_OPENROUTER_PROVIDER` accepts a full routing JSON object. The pin overrides
its order/fallback fields. Evidence records returned upstream and cost data.

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
per matchup. Round-robin builds run blind to other round-robin results and may
run concurrently. Useful controls include:

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
completed results, and authorized playoff context. A draft-only run chooses its
window when season play begins because it has not held one yet.

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

The GUI **Overview** describes program status. **Position Lab** displays public
artifacts and gates. **Draft Circuit** currently opens the exploratory draft
archive, not a runnable environment. The GUI is a viewer: Showdown and the
versioned offline evaluator remain authorities, and private scores, opponent
requests, snapshots, and sealed panels are offline-only.

Decision/context logs record authorized observations and submitted model
evidence. They do not prove Showdown accepted a transition; join game/referee
logs to establish legality, substitutions, timer defaults, and outcomes.

## Grade and freeze positions

The current pipeline is experimental offline tooling, not a model-comparison
runner:

```sh
pnpm run grade-positions --workers 4 --restart
pnpm run freeze-positions --size 500 --seed set-1
pnpm run export-position-panels   --horizon 2 --luck 8 --opponents 4 --seed panels-1
pnpm run summarize-position-pilot   records/private/position-panels/scores.pilot.jsonl
pnpm run freeze-position-splits   --policy path/to/reviewed-policy.json   --calibration-manifest path/to/calibration-manifest.json
```

`grade-positions` exactly replays eligible games and measures recorded choices.
Use matching `--records` and `--runs-dir` options to isolate a pilot. Resume
requires the same Showdown revision and full reference protocol; use `--restart`
or a new output path after changing settings.

`freeze-positions` performs preliminary seeded selection and writes public
point-of-view inputs separately from private snapshots, opponent requests,
source identity, and source action. Never expose the private file.

`export-position-panels` evaluates every non-concession joint action on two
qualification panels and one untouched measurement panel. It writes public tasks
separately from private scores/sealed matrices and binds them in a canonical
schema-v2 candidate manifest marked `release_ready: false`.
`summarize-position-pilot` reports distributions but chooses no thresholds.

`freeze-position-splits` requires that candidate manifest, a distinct canonical
calibration manifest, and a reviewed policy. It keeps source-series and
near-duplicate components intact, applies deterministic greedy stratification,
and fails closed on missing measurement data or balance tolerances. Outputs are
immutable and still not release-ready. No current command runs a new model over
the tasks. See [Evaluation plan](evaluation-plan.md) for every remaining gate.

## Archive and publish

Archive full run directories to verified tarballs without deleting their source:

```sh
pnpm run archive-run <run-id> [<run-id>...]
```

The destination is `$VGC_RUN_ARCHIVE_DIR` or `~/vgc-run-archive`. Copy it
offsite with operator-managed tooling, then remove source runs manually if
wanted.

Publish completed result rows and the allowed support evidence to a deployment:

```sh
export VGC_LEAGUE_PUBLISH_ORIGIN=https://<deployment>
export VGC_LEAGUE_IMPORT_TOKEN=<operator-secret>
pnpm run vgcleague publish --dry-run
pnpm run vgcleague publish
pnpm run vgcleague publish --pool regmb-202607
pnpm run vgcleague publish --run <run-id>
```

Publishing is idempotent. Without filters it excludes `test`; `--include-test`
overrides that. Repeat `--run` for exact runs, including draft leagues whose rows
have no pool. The command sends results, decision/game logs, run configuration,
draft assets, and missing pools. It does not send prompts, raw model responses,
trace logs, or seat-context JSONL, so published config is not full execution
evidence. See [Deployment](deployment.md).

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
