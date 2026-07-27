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
every team built blind to the other results. `--sequential-weeks` restores
week-by-week play, where later builds see earlier scores. `--through-week <n>`
stops a sequential league after that round-robin week. Use
`draft --resume <run-dir>` to continue the stored league. Resume uses the
stored models, board, seed, rosters, schedule mode, and completed results.

The Champions Bo3 formats publish open team sheets at team preview: both
models read the opposing moves, items, abilities, and stat alignments, but
never the hidden stat points. `draft --closed-sheets` strips that rule so
models must deduce sets through play.

OpenRouter model specs pass variant suffixes through unchanged, so
`openrouter:<model>:nitro` requests throughput-sorted routing. Set
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

Without `--pool`, standings and reports exclude the disposable `test` pool.
They use only rotation results. Different providers for the same model ID
count as one player within a timer group.

## Publish local results

`publish` sends completed results to a deployment. It sends result rows,
decision logs, run configuration, and missing team pools. It does not send
prompts or raw model responses.

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

