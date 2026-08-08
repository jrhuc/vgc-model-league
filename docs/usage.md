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
pnpm run vgcleague gui
pnpm run vgcleague selfcheck

pnpm run vgcleague rotation   --models <spec> <spec> --pool regmb-202607 --series-per-pair 4
pnpm run vgcleague tournament --models <spec> <spec> <spec> <spec> --pool regmb-202607
pnpm run vgcleague tournament --models <8 specs> --pool vr-aug26-top8
pnpm run vgcleague draft      --models <spec> <spec> <spec> <spec> --board regmb-202607
pnpm run vgcleague exhibition --opponent <spec>
```

The GUI provides the default flow for one match. `selfcheck` runs one
random-versus-random series.

| Mode | Purpose | Comparison role |
| --- | --- | --- |
| Match | Play one best-of-three series. | Contextual only |
| Tournament | Play a single-elimination bracket. | Contextual only |
| Draft League | Draft rosters, build teams, and play a season. | Contextual only |
| Rotation | Mirror team assignments across a fixed pool. | Controlled and mirrored; no rating |
| Exhibition | Give one seat to an external terminal agent. | Uncontrolled; no rating |

Each experiment command accepts `--seed` and `--reasoning <level>`. Rotation,
tournament, and draft also accept `--concurrency` and
`--timer-scale <n|off>`.

`vr-aug26-top8` holds the eight teams from the top cut of Victory Road's
August 2026 Challenge #1, each seeded by where it finished, so eight models
play that bracket in its real pairings with one team apiece. Tournaments on
such a pool take `--provenance disclosed` (the default), which identifies the
event and field without revealing finishing order, or `--provenance blind`,
which omits that context. Treat replicated runs as separate provenance
conditions, not as a causal estimate from one pair. Build a pool like it
with `pnpm run build-event-pool -- teams/<pool>/sources.json`.

A bracket that stopped continues with `tournament --resume <run-dir>`. Resume
uses the stored models, pool or inline teams, seed, provenance, reasoning, and
clock, rebuilds the same draw, and stands on completed series and games. An
interrupted game replays recorded decisions without provider calls only when
both seats and timer evidence are replayable and the reconstructed requests
continue to match; otherwise that game continues live or restarts. A seat
rewired in `config.json` plays future calls under its new spec; retained evidence
keeps its original provenance and must not be attributed to the replacement. A
changed draw refuses to resume.

Resume is logical continuity from recorded state, notebook, and replay, not a
persistent provider chat or process. The append-only series-attempt ledger marks
start, completion, abort, and serial supersession, but it is not concurrency
isolation: stop the old owner and do not resume one run from multiple processes.

Battles are untimed by default. `--timer-scale 1` uses the standard VGC clock.
Values from 0.5 through 4 scale every Showdown clock. Each run records the
selected scale. Outcomes from different clock or scaffold conditions remain separate contexts and are not pooled into a rating.

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
Each matchup's teambuild plan carries into its own best-of-three. “Carry” means
the league records and reinjects explicit notes into independent calls; it does
not preserve a provider conversation. The battle timeline is game-scoped and
the notebook is series-scoped. Round-robin matchups do not otherwise share notes
or results; playoff coaches receive their own earlier builds, results, and final
battle notes.

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
so skip it when slower seats set the pace anyway.

Set `VGC_OPENROUTER_PIN=deepinfra` to restrict every OpenRouter request in
the process to that upstream provider and disable fallback. The pin accepts one
provider only; a comma-separated allowed set is rejected because it is not a
controlled route. `VGC_OPENROUTER_PROVIDER` accepts a full JSON routing
object such as `{"order":["deepinfra"],"ignore":["novita"]}`; the pin overrides
its `order` and `allow_fallbacks` fields. Decision and trace rows record the
upstream provider and reported cost when OpenRouter returns them.

## Manage teams and draft boards

Team pools are immutable snapshots in `teams/<pool>/pool.json`. Create a new
pool directory for each metagame update. Do not change a pool that has recorded
results.

Build a pool from Poképaste sources:

```sh
pnpm run build-pool teams/<pool>/sources.json
```

You can also paste Showdown teambuilder exports into the GUI pool manager. The
pinned simulator validates both inputs and rejects duplicate species sets.

Draft boards are immutable snapshots in `boards/<board>.json`. The current
builder reads its fixed Regulation MB source-cost manifest; it does not accept a
team-pool argument.

```sh
pnpm run build-board
```

## Inspect evidence

```sh
pnpm run vgcleague outcomes --pool regmb-202607
pnpm run vgcleague report   --pool regmb-202607
```

The GUI opens on **Overview**. **Position Lab** combines public position
artifacts, provenance, release gates, and contextual model evidence. The
**Draft Circuit** entry currently opens the **Draft leagues** archive; Overview
describes the proposed circuit, not a separate runnable environment. **Live
run**, **Tournaments**, and **New run** retain their operational roles. There is
no separate Artifacts & provenance route.

Treat the GUI as a viewer of public artifacts and recorded decision evidence.
Pokémon Showdown and the versioned evaluator remain the scoring authorities.
Private scores, snapshots, opponent requests, and sealed panels must never be
served to the browser; inspect them only through offline operator tooling.

Decision logs record `reasoning_tokens` and metered cost when the provider
reports them. Per-seat context JSONL records authorized observations, submitted
decisions, notebook snapshots, and reviews. It is model evidence, not a ledger
of Showdown-accepted transitions; join game logs and simulator error,
substitution, and timer fields for referee claims.

Without `--pool`, outcomes and reports exclude the disposable `test` pool. They
show contextual per-series rows across experiment modes, including the pool,
clock, scaffold, opponents, and sample size. They do not merge model aliases or
compute an aggregate order. Within-run league tables and tournament brackets
remain descriptions of those individual runs.

## Grade recorded battle positions

`grade-positions` is an experimental offline diagnostic. It attempts to replay
candidate games exactly, grades eligible non-fallback choices at simultaneous
turns and one-sided replacement requests under the reference recorded in its
manifest, and writes explicit completion, exclusion, and failure rows. It is not a model-comparison runner.

```sh
pnpm run grade-positions --workers 4 --restart
pnpm run freeze-positions --size 500 --seed set-1
pnpm run export-position-panels --horizon 2 --luck 8 --opponents 4 --seed panels-1
pnpm run summarize-position-pilot records/private/position-panels/scores.pilot.jsonl
pnpm run freeze-position-splits --policy path/to/reviewed-policy.json \
  --calibration-manifest path/to/calibration-manifest.json
```

Grading is CPU-bound and defaults to a third of the machine's cores. Use
`--records <results.jsonl> --runs-dir <runs-root>` on both grading and freezing
to pilot an isolated corpus without modifying the repository-wide record set.
Resume is allowed only when the Showdown revision and complete counterfactual protocol
match `<output>.manifest.json`; use `--restart` or another `--out` after changing
settings. Scores use the realized hidden state and remain exploratory. See
[Measurement principles](measurement.md) for their limits.

`freeze-positions` is preliminary corpus selection. It writes
`position-set.json` with standardized point-of-view inputs and, by default,
`private/position-set.json` with simulator snapshots, opponent requests, source
identities, and source actions. Never pass the private file to a model. The
command aborts rather than silently writing a smaller or unreplayable set, but
it does not create the immutable train/evaluation candidate split.

`export-position-panels` evaluates every non-concession joint action on two
independently seeded qualification panels and a third untouched measurement
panel. Common opponent slots, battle RNG seeds, and continuation seeds keep each
panel rectangular and paired; one failed cell rejects the position. It writes
schema-v2 frozen prompts under `position-panels/`, with scores and full draw
matrices in a physically separate `private/position-panels` root. The canonical
candidate manifest binds every file and says `release_ready: false`.

Private score rows report qualification span and uncertainty, rank and extrema
agreement, and cross-qualification-panel reward drift. Eligibility never reads
the measurement values; measurement supplies final rewards.
`summarize-position-pilot` reports empirical distributions but does not choose
thresholds.

`freeze-position-splits` is the immutable candidate-split stage. It requires a
canonical candidate manifest, a separate canonical calibration manifest, and a
reviewed schema-v2 frozen policy whose calibration digest matches that file. The policy declares qualification limits,
evaluation fraction and seed, near-duplicate threshold, and total and
per-stratum balance tolerances. A different calibration manifest does not by
itself prove the two corpora are disjoint; review their sources and similarity
evidence as well.

The freezer clusters normalized visible-position trigrams, unions those clusters
with whole source-series groups, and assigns connected components using seeded
deterministic greedy stratification. It records balance and aborts outside the
reviewed tolerances; it does not claim a globally optimal partition. If
qualification admits any position whose measurement panel is unusable, the
whole candidate freeze fails rather than excluding it after looking at
measurement.

Public and private candidate outputs use physically separate roots with
immutable target files. A complete identical rerun is a no-op; different bytes
require new target roots. The verified manifest remains non-release-ready.
Freezing does not waive horizon, hidden-information, criterion, or package-smoke
gates. No
command on this branch runs a model over these tasks.

## Archive a run

Run directories hold every trace, thought log, and game log. They are the full
record of a season but only the published subset is ever queried, so cold runs
do not belong on the production volume.

```sh
pnpm run archive-run <run-id> [<run-id>...]
```

Each run packs into `$VGC_RUN_ARCHIVE_DIR` (default `~/vgc-run-archive`) as a
verified tarball with a checksum manifest. The source run is never deleted;
remove it by hand after the archive lands wherever it is going. Sync the
archive directory offsite with your own tooling, for example
`rclone copy ~/vgc-run-archive <remote>:vgc-run-archive`.

## Publish local results

`publish` sends completed results to a deployment. It sends result rows,
decision logs, game logs, run configuration, draft league assets, and missing
team pools. Rotation, tournament, and draft runs all travel the same route. It
does not send prompts, raw model responses, trace logs, or `*-context.jsonl`.
The published scaffold/config is therefore not a substitute for local execution
and context evidence. Re-publishing a series the deployment already holds
backfills any game logs it is missing.

```sh
export VGC_LEAGUE_PUBLISH_ORIGIN=https://<deployment>
export VGC_LEAGUE_IMPORT_TOKEN=<operator-secret>

pnpm run vgcleague publish --dry-run
pnpm run vgcleague publish
pnpm run vgcleague publish --pool regmb-202607
pnpm run vgcleague publish --run 20260805T175336.037000Z-0f155186
```

The command does not add a series that the deployment already has. Without
`--pool`, it excludes the `test` pool. Use `--include-test` to include that
pool. `--run` publishes exactly the named runs whatever their mode or pool, and
is the only way to name a draft league, whose rows carry no pool; repeat it to
send several. The deployment must use the same import token. See
[Deployment](deployment.md).

## Use an exhibition seat

The host creates a fresh agent workspace in `runs/<run>/agent/` by default.
It contains `seat.mjs`, `SEAT.md`, and the connection token. On POSIX hosts the
directory is owner-only (`0700`) and its files are `0600`. Start the terminal
agent in that directory.

This is trusted same-UID, unrated manual integration. The host binds the bridge
to loopback and checks its bearer token, but it does not launch or sandbox the
external process. Workspace modes do not protect against another process under
the same UID. There is no filesystem, process, network, credential, egress, or
delegation isolation; the operator is responsible for token and workspace
hygiene.

Do not use Exhibition as a controlled model, adapter, or scaffold comparison. A
controlled adapter must enforce and record mounts, process tools, credentials,
egress, delegation, and its model-visible code and harness identity. Logging an
execution descriptor is evidence provenance, not isolation, and mounting only
this workspace is insufficient.

During the current Exhibition process,
`node seat.mjs context '{"after":"ctx-00000010","limit":50}'` pages authorized
seat-history evidence omitted from the compact prompt. Exhibition has no resume
path for recovered external-seat memory, and `/context` does not restore hidden
state from a prior agent or provider session.
