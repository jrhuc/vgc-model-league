# Use the league

## Install

Use Node.js 22.13 or later.

```sh
npm install
npm run setup:showdown
npm run build
```

`setup:showdown` installs the Pokémon Showdown revision in
`showdown.lock.json`. Each build checks this revision.

Use these commands to review or update the pinned revision:

```sh
npm run check:showdown-update
npm run update:showdown
```

The update command builds and tests the candidate revision. It restores the
current revision if a check fails.

## Run an experiment

A model specification has the form `<provider>:<model-id>`. Use `random` for a
legal-action baseline. CLI runs read provider keys from environment variables.
GUI runs use the keys that you enter in the browser.

```sh
npm run vgcleague -- gui
npm run vgcleague -- selfcheck

npm run vgcleague -- rotation   --models <spec> <spec> --pool regmb-202607 --series-per-pair 4
npm run vgcleague -- tournament --models <spec> <spec> <spec> <spec> --pool regmb-202607
npm run vgcleague -- draft      --models <spec> <spec> <spec> <spec> --board regmb-202607
npm run vgcleague -- exhibition --opponent <spec>
```

The GUI provides the default flow for one match. `selfcheck` runs one
random-versus-random series.

| Mode | Purpose | Rated |
| --- | --- | --- |
| Match | Play one best-of-three series. | No |
| Tournament | Play a single-elimination bracket. | No |
| Draft League | Draft rosters, build teams, and play a season. | No |
| Rotation | Mirror team assignments across a fixed pool. | Yes |
| Exhibition | Give one seat to an external terminal agent. | No |

Each experiment command accepts `--seed` and `--reasoning <level>`. Rotation,
tournament, and draft also accept `--concurrency` and
`--timer-scale <n|off>`.

Battles are untimed by default. `--timer-scale 1` uses the standard VGC clock.
Values from 0.5 through 4 scale every Showdown clock. Each run records the
selected scale. Ratings do not mix results from different scales.

Draft-league round-robin series run concurrently under `--concurrency`, with
every matchup built blind to the other round-robin results. `--sequential-weeks`
serializes the schedule without adding cross-match coaching context;
`--through-week <n>` stops a sequential league after that round-robin week. Use
`draft --resume <run-dir>` to continue the stored league. Resume uses the
stored models, board, seed, rosters, schedule mode, trade-window state,
completed results, and private playoff coaching context.

Draft leagues open a free-agent window after week 3 by default, or after the
final round-robin week when a shorter league has fewer than three weeks.
Lowest seed chooses first; each coach atomically submits zero to six
drop-and-add swaps from the undrafted board while keeping the original roster
size and budget. Earlier drops become available to later coaches. Use
`--trade-window <week>` to move the barrier or `--trade-window off` for the
locked-roster control. Coach-to-coach offers are not part of this mode.

The Champions Bo3 formats publish open team sheets at team preview: both
models read the opposing moves, items, abilities, and stat alignments, but
never the hidden stat points. `draft --closed-sheets` strips that rule so
models must deduce sets through play.

Draft coaches carry a private roster note across their picks. Each matchup's
teambuild plan carries into its own best-of-three. Round-robin matchups do not
share notes or results; playoff coaches receive their own earlier builds,
results, and final battle notes.

OpenRouter model specs pass variant suffixes through unchanged, so
`openrouter:<model>:nitro` requests throughput-sorted routing. `--nitro` (or
the OpenRouter routing select in the GUI) applies that variant to every
OpenRouter spec that does not already carry one — faster and usually pricier,
so skip it when slower seats set the pace anyway. Set
`VGC_OPENROUTER_PROVIDER` to a JSON routing object (for example
`{"order":["deepinfra"],"ignore":["novita"]}`) to pin or exclude upstream
providers. Every OpenRouter response also records its upstream provider and
reported cost in the run's decision traces.

## Manage teams and draft boards

Team pools are immutable snapshots in `teams/<pool>/pool.json`. Create a new
pool directory for each metagame update. Do not change a pool that has recorded
results.

Build a pool from Poképaste sources:

```sh
npm run build-pool -- teams/<pool>/sources.json
```

You can also paste Showdown teambuilder exports into the GUI pool manager. The
pinned simulator validates both inputs and rejects duplicate species sets.

Draft boards are immutable snapshots in `boards/<board>.json`. Build a board
from a team pool:

```sh
npm run build-board -- <pool>
```

## Inspect evidence

```sh
npm run vgcleague -- standings --pool regmb-202607
npm run vgcleague -- report    --pool regmb-202607
```

The GUI archives finished runs: draft leagues under **Draft leagues** (rosters,
pick rationales, per-series builds, schedule, and the board), brackets under
**Tournaments**, and cross-mode model profiles under **Data room**.

Decision logs record `reasoning_tokens` and metered cost when the provider
reports them.

Without `--pool`, standings and reports exclude the disposable `test` pool.
They use only rotation results. Different providers for the same model ID
count as one player within a timer group.

## Archive a run

Run directories hold every trace, thought log, and game log. They are the full
record of a season but only the published subset is ever queried, so cold runs
do not belong on the production volume.

```sh
npm run archive-run -- <run-id> [<run-id>...]
```

Each run packs into `$VGC_RUN_ARCHIVE_DIR` (default `~/vgc-run-archive`) as a
verified tarball with a checksum manifest. The source run is never deleted;
remove it by hand after the archive lands wherever it is going. Sync the
archive directory offsite with your own tooling, for example
`rclone copy ~/vgc-run-archive <remote>:vgc-run-archive`.

## Publish local results

`publish` sends completed results to a deployment. It sends result rows,
decision logs, game logs, run configuration, and missing team pools. It does
not send prompts or raw model responses. Re-publishing a series the deployment
already holds backfills any game logs it is missing.

```sh
export VGC_LEAGUE_PUBLISH_ORIGIN=https://<deployment>
export VGC_LEAGUE_IMPORT_TOKEN=<operator-secret>

npm run vgcleague -- publish --dry-run
npm run vgcleague -- publish
npm run vgcleague -- publish --pool regmb-202607
```

The command does not add a series that the deployment already has. Without
`--pool`, it excludes the `test` pool. Use `--include-test` to include that
pool. The deployment must use the same import token. See
[Deployment](deployment.md).

## Use an exhibition seat

The host creates an agent workspace in `runs/<run>/agent/` by default. The
workspace contains `seat.mjs`, `SEAT.md`, and a connection token. Start the
terminal agent in that directory.

