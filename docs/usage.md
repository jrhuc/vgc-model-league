# Use the league

## Install

Use Node.js 24.18.1 and pnpm 11.11.0. If pnpm is not installed yet, bootstrap
that exact version without lifecycle scripts:

```sh
npm install --global pnpm@11.11.0 --ignore-scripts --no-audit --no-fund
pnpm install --frozen-lockfile
pnpm run setup:showdown
pnpm run build
```

`setup:showdown` installs the Pokémon Showdown revision in
`showdown.lock.json`. Each build checks this revision and its compiled output.
The project configuration requires exact dependencies, verifies lockfile and
store content, waits seven days before admitting ordinary new releases, blocks
exotic transitive sources, and disables dependency lifecycle scripts. The one
release-age exception is an exact security-patched PostCSS version.

Showdown is the deliberate special case: setup fetches only its official,
full-commit pin, installs its upstream npm lock with lifecycle scripts disabled,
runs its named build script explicitly, then removes everything except the one
external package the simulator and room timer need at runtime. This project
does not install or run Showdown's HTTP server dependencies.

Use these commands to review or update the pinned revision:

```sh
pnpm run check:showdown-update
pnpm run update:showdown
```

The update command builds and tests the candidate revision. It restores the
current revision if a check fails.

## Run an experiment

A model specification has the form `<provider>:<model-id>`. Use `random` for a
legal-action baseline. CLI runs read provider keys from environment variables.
GUI runs use the keys that you enter in the browser.

```sh
pnpm run vgcleague -- gui
pnpm run vgcleague -- selfcheck

pnpm run vgcleague -- rotation   --models <spec> <spec> --pool regmb-202607 --series-per-pair 4
pnpm run vgcleague -- tournament --models <spec> <spec> <spec> <spec> --pool regmb-202607
pnpm run vgcleague -- tournament --models <8 specs> --pool vr-aug26-top8
pnpm run vgcleague -- draft      --models <spec> <spec> <spec> <spec> --board regmb-202607
pnpm run vgcleague -- exhibition --opponent <spec>
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

`vr-aug26-top8` holds the eight teams from the top cut of Victory Road's
August 2026 Challenge #1, each seeded by where it finished, so eight models
play that bracket in its real pairings with one team apiece. Tournaments on
such a pool take `--provenance disclosed` (the default), which tells each seat
the event and both teams' finishes, or `--provenance blind`, which tells it
nothing — run the pair to measure what knowing is worth. Build a pool like it
with `node dist/tools/build-event-pool.js teams/<pool>/sources.json`.

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

`draft --draft-only` stops the run once every roster is drafted and plays no
games, for when the draft itself is what you are measuring. The run writes its
rosters and finishes; the archive lists it as a draft-only league. Resume it
later with `draft --resume <run-dir>` to play the season from those rosters,
which picks its free-agency window from `--trade-window` like a fresh league
because a draft-only run never held one. The GUI offers the same choice as the
run scope on the draft form.

Draft leagues open a trade window after week 3 by default, or after the
final round-robin week when a shorter league has fewer than three weeks.
Lowest seed chooses first. Each coach may make one 1-for-1 offer to another
coach, resolved immediately by that counterparty, before atomically submitting
zero to six drop-and-add swaps from the undrafted board. Unequal-price trades
are legal when both resulting rosters remain within budget; earlier trades and
drops are visible to later coaches. Use
`--trade-window <week>` to move the barrier or `--trade-window off` for the
locked-roster control. See
[Trade window](trade-window.md) for the full rules and provenance.

When a coach's season ends — missing the playoff cut, losing a semifinal or the
final, or winning it — it writes one retrospective over its own draft, its
free-agency decision, and every series it played. Reviews are stored in
`season.jsonl` and shown on the team page. See
[Season review](season-review.md).

The Champions Bo3 formats publish open team sheets at team preview: both
models read the opposing moves, items, abilities, and stat alignments, but
never the hidden stat points. `draft --closed-sheets` strips that rule so
models must deduce sets through play.

The draft board is published price-descending, as real draft leagues publish
one. Coaches also get `search_board` during the draft and the free-agent
window, which filters and re-sorts it by type, price range, ability, base stat
total, or which entries legally learn a given move.

Draft coaches carry a private roster note across their picks. A transaction
window replaces that note with the coach's updated plan for later matchups.
Each matchup's teambuild plan carries into its own best-of-three. Round-robin
matchups do not otherwise share notes or results; playoff coaches receive
their own earlier builds, results, and final battle notes.

After the last draft pick, each model names its finished franchise in a
separate presentation-only turn. These names appear in the GUI, CLI, records,
and archive, but models see coach/model identities—not franchise names—during
drafting, matchup preparation, trades, battles, reflections, and season
reviews. Naming writes `draft/franchise-names.jsonl`; completed names replay on
resume without another model call. Older runs whose first picks contain
`team_name` remain readable.

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
pnpm run build-pool -- teams/<pool>/sources.json
```

You can also paste Showdown teambuilder exports into the GUI pool manager. The
pinned simulator validates both inputs and rejects duplicate species sets.

Draft boards are immutable snapshots in `boards/<board>.json`. Build a board
from a team pool:

```sh
pnpm run build-board -- <pool>
```

## Inspect evidence

```sh
pnpm run vgcleague -- standings --pool regmb-202607
pnpm run vgcleague -- report    --pool regmb-202607
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
pnpm run archive-run -- <run-id> [<run-id>...]
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

pnpm run vgcleague -- publish --dry-run
pnpm run vgcleague -- publish
pnpm run vgcleague -- publish --pool regmb-202607
```

The command does not add a series that the deployment already has. Without
`--pool`, it excludes the `test` pool. Use `--include-test` to include that
pool. The deployment must use the same import token. See
[Deployment](deployment.md).

## Use an exhibition seat

The host creates an agent workspace in `runs/<run>/agent/` by default. The
workspace contains `seat.mjs`, `SEAT.md`, and a connection token. Start the
terminal agent in that directory.
