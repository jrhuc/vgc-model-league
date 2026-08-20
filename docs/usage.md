# Use the league

## Install

Install Node.js 24.18.1 and pnpm 11.22.0. Then install dependencies, set up
Showdown, build the project, and run the tests:

```sh
npm install --global pnpm@11.22.0 --ignore-scripts --no-audit --no-fund
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

A pin update is reviewed against the format rules in [CLAUDE.md](../CLAUDE.md)
before any candidate is accepted. Downstream consumers pin this repository by
commit; [vgc-evals](https://github.com/jrhuc/vgc-evals) reviews its own
Showdown-derived values when it adopts a revision.
## Run an experiment

Use one of these exact executable model spec formats:

- `openrouter:<model-id>`
- `prime:<model-id>`
- `gateway:<model-id>`
- `opencode-go:<model-id>`
- `opencode-zen:<model-id>`
- `random`, the legal-action baseline

OpenRouter uses `OPENROUTER_API_KEY` and the fixed
`https://openrouter.ai/api/v1` endpoint. Its GUI catalog lists current model
IDs. Prime Inference uses `PRIME_API_KEY` and the fixed
`https://api.pinference.ai/api/v1` endpoint; enter its model ID manually. The
Vercel AI Gateway uses `AI_GATEWAY_API_KEY` and the fixed
`https://ai-gateway.vercel.sh/v1` endpoint; enter its `creator/model` ID
manually. OpenCode uses `OPENCODE_API_KEY` for both of its fixed endpoints:
`https://opencode.ai/zen/go/v1` (`opencode-go`) and `https://opencode.ai/zen/v1`
(`opencode-zen`); both list current model IDs in the GUI catalog. Model specs do
not accept a base URL. GUI credentials entered in the browser remain
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
results. By default, the scheduler runs concurrency-limited blind batches: the
series up to each transaction window, then that barrier and window, then the
next batch. If you turn the windows off, the round robin uses one batch. Use
sequential weeks only as a labeled alternative.

Use these controls as needed:

```sh
pnpm run vgcleague draft --models <specs...> --draft-only
pnpm run vgcleague draft --resume <run-dir>
pnpm run vgcleague draft --models <specs...> --through-week <n>
pnpm run vgcleague draft --models <specs...> --sequential-weeks
pnpm run vgcleague draft --models <specs...> --closed-sheets
pnpm run vgcleague draft --models <specs...> --transactions off
```

`--draft-only` records rosters and stops. Resume the run later to play the
season. `--through-week` implies sequential weeks and stops cleanly after the
specified week. Champions Bo3 uses open team sheets by default and excludes
hidden stat points. `--closed-sheets` is a separate condition.

By default, a transaction window opens after each of round-robin weeks 1, 2,
and 3, and rosters lock after the last one. Use `--transactions <weeks>` with a
comma-separated list to choose the windows, or `off` for the labeled
locked-roster control. In each window a coach can make one one-for-one offer
before submitting up to six atomic free-agent drop/add swaps. See [Trade
window](trade-window.md) for the complete rules and evidence boundaries.

Private notes are explicitly reinjected state, not a persistent provider
conversation. A roster note persists through the draft and every transaction
window.
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
omits **Live** and **New run**.

Showdown remains authoritative. The
[Architecture](architecture.md#state-evidence-and-trust) defines browser and
anonymous evidence boundaries.

Decision and context logs record authorized observations and submitted model
evidence. These logs do not prove that Showdown accepted a transition. Join them
with game and referee logs to establish legality, substitutions, timer defaults,
and outcomes.

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

Build the technical documentation:

```sh
pnpm run build:docs
```

GitHub Actions deploys that output to Pages when documentation changes. The
documentation artifact contains no run data or GUI assets.

Export one spectator release after building the harness:

```sh
pnpm run export:season \
  --run <run-id> \
  --through-week 1 \
  --title "AI Draft League"
```

The release boundary is mandatory; export never infers it from the newest local
result. Use `--through-week 0` to publish a completed draft before any match
result, a value past the last regular-season week to release playoff rounds,
or `--out <file>` to choose the bundle destination.

The command fails if a named released week is incomplete or lacks verified
replay evidence. Its `season-bundle-v2` output contains the public evidence
layer: draft picks and their stated rationales, the board, rosters and how each
Pokémon was acquired, builds and their rationales, standings, results,
structured battle events, submitted decisions with rationale and latency,
reflections, transactions, the bracket, and season reviews at season end.
Notebooks, traces, prompts, provider responses, and future results are absent.

The [Architecture](architecture.md#public-publication) defines the authority
boundary. [Deployment](deployment.md) separates Pages documentation from the
spectator release.

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
