# VGC Model League

VGC Model League measures general-purpose language models in full VGC
best-of-three matches on Pokémon Showdown. Each model gets open team sheets,
legal action menus, reference and damage tools, a private series notebook, and
a review step between games. Showdown decides legality, timers, and outcomes.
The project adds no fine-tuning and no search policy. The scaffold knows the
domain, but it does not specialize the model.

The league asks these questions:

- How strong are current frontier models without task-specific policy training?
- Do models adapt between games in a best-of-three, or do they replay the same
  plan?
- What is the balance between reliability, latency, token use, provider
  configuration, and competitive strength?
- Which tendencies identify model families and generations? Tendencies include
  leads, brings, switches, Protect use, targeting, and recovery after a loss.

## Modes

| Mode | What occurs | Rates the ladder? |
| --- | --- | --- |
| **Match** | Two models and two teams (pasted or sampled) play one best-of-three. This is the default flow in the GUI. | No |
| **Tournament** | Models play a single-elimination best-of-three bracket. Each model keeps one assigned team through the bracket. Byes fill incomplete brackets. | No |
| **Draft League** | A recreation of the Wolfey Draft League on the current regulation. Coaches snake-draft ten Pokémon each inside a 100-point budget, name a franchise, then before every match pick six and build each set themselves. A weekly round robin, then playoffs. The league logs every draft rationale and team plan. | No |
| **Rotation** | Models rotate through immutable team pools with mirrored assignments. This cancels side bias and team bias, and produces the controlled league Elo. | Yes |
| **Exhibition** | One best-of-three where an external terminal agent plays one seat through a local bridge in place of a provider API. | No |

Every result records `mode` and `protocol_version`. Only rotation rows enter
the rating.

## Setup

```sh
npm install
npm run setup:showdown
npm run build
```

`setup:showdown` clones the simulator at the exact commit in
`showdown.lock.json` and builds it. Each project build makes sure that the pin
is correct. To adopt a new upstream revision:

```sh
npm run check:showdown-update   # report whether upstream HEAD moved
npm run update:showdown         # build the candidate, run the full suite, advance the lock
```

If the candidate fails, `update:showdown` restores the previous pin.

## Run

A model spec has the format `<provider>:<model-id>` (for example
`anthropic:...` or `openai:...`). Use `random` for a legal-move baseline. CLI
runs read provider API keys from environment variables. GUI runs use only the
keys that you paste into the browser. The server holds these keys in memory
and does not write them to disk.

```sh
npm run vgcleague -- gui                # browser control room on 127.0.0.1
npm run vgcleague -- selfcheck          # one random-vs-random series

npm run vgcleague -- rotation   --models <spec> <spec> --pool regmb-202607 --series-per-pair 4
npm run vgcleague -- tournament --models <spec> <spec> <spec> <spec> --pool regmb-202607
npm run vgcleague -- draft      --models <spec> <spec> <spec> <spec> --board wdl-regmb-202607
npm run vgcleague -- exhibition --opponent <spec>

npm run vgcleague -- standings --pool regmb-202607
npm run vgcleague -- report    --pool regmb-202607
npm run vgcleague -- publish   --to https://<deployment> --dry-run
```

All experiment commands accept `--seed` for reproducible runs. They accept
`--reasoning <level>` to set the provider reasoning effort. Rotation,
tournament, and draft also accept `--concurrency` for parallel series and
`--timer-scale <n|off>`. Battles are untimed by default: a model reasons as
long as it needs, bounded only by a generous per-decision token ceiling and
wall-clock cap that catch runaway reasoning loops. `--timer-scale` turns on
the Showdown battle timer to simulate human match conditions: `1` is the
standard VGC clock, values 0.5–4 multiply every clock, and `off` is the
untimed default. The scale is recorded in the run config and every series
row, so runs at different scales can be compared. The CLI rejects an
unsupported reasoning level before the run starts.

A failed series stops the full run. Queued series do not start. In-flight
series stop. Completed series stay on disk. A run that the league reports as
failed does not use provider credits in the background.

If you do not give `--pool`, standings and reports include every pool except
the disposable `test` pool, and they keep only rotation rows. Ratings never
mix battle speeds: each timer scale gets its own standings and head-to-head,
with untimed shown first as the primary data. Within a speed group, the same
model id reached through different providers or gateways rates as one player.
The GUI record book uses the same scope.

### Exhibition seats

The host process runs the battle, the opponent engine, and its API key. It
serves a token-authenticated bridge on `127.0.0.1`. It writes an agent
workspace (default `runs/<run>/agent/`) that contains a thin client
(`seat.mjs`), instructions (`SEAT.md`), and the connection token. Start the
terminal agent in that directory. The agent seat uses the same `LLMEngine`
scaffold as an API model. The move timer is off because agent turns take
minutes. The bridge logs every tool lookup for later audits.

## Teams and draft boards

Team pools are at `teams/<pool>/pool.json`. Pools are immutable snapshots. A
metagame refresh is a new directory, never an edit. Thus old records stay
reproducible. `teams/regmb-202607` is the current Reg M-B snapshot
(archetype-deduplicated tournament teams). `test` is disposable local data.

There are two ways to build a pool. The pinned simulator validates both, and
rejects duplicate species sets:

- From Pokepaste sources: `npm run build-pool -- teams/<pool>/sources.json`.
- In the GUI pool manager: paste Showdown teambuilder exports.

Draft boards are at `boards/<board>.json`. Each board contains fixed
competitive sets that come from a tournament-team pool. To regenerate a board,
run `npm run build-board -- <pool>`. Boards are immutable snapshots, the same
as team pools.

## Model interface

At each decision, the model receives the field state and timers, the exact
stats of its own Pokémon, the two open team sheets, a private timeline and
notebook, numbered legal menus for the complete joint action, and
active-matchup references. Optional tools cover species, moves, items,
abilities, natures, type matchups, and level-50 damage ranges. The tools use
only legally available information. The model returns one JSON object:

```json
{
  "threats": ["likely opposing joint actions or KO threats"],
  "candidates": ["2-3 joint lines considered"],
  "choices": [0, 2],
  "rationale": "brief final reason",
  "notebook": "durable private series notes"
}
```

A malformed decision gets one retry, then a recorded legal fallback. If a
provider fails during a timed decision, the engine records an abandoned
decision, and the Showdown timer acts. Simulator, reference, and
team-validation failures stop the run.

After every game, the two players write a short review, a next-game
adjustment, and an updated notebook. This occurs outside the battle clock. The
closing review of a decided series stays as post-mortem evidence. The decision
log marks it `series_over`.

## Evidence

`runs/` holds the run configuration, series logs, decision timelines,
technical traces (prompts, menus, raw responses, usage, and tool calls), and
per-model draft logs when applicable.

`records/results.jsonl` holds one row for each completed best-of-three. A row
contains the nested games, protocol identity, assignments, seeds, model specs,
Showdown commit, and per-player decision statistics. Each row also records
`scaffold`, a hash of the system prompts, tool schemas, and sampling
parameters. Thus longitudinal comparisons can find scaffold drift.

The two directories are local, and git ignores them.

## Publishing local runs

Local runs cost provider credits, so their evidence should not stay on one
laptop. `vgcleague publish` sends completed series to a deployment: the result
row, the per-seat decision logs that the data room reads, the run
configuration a bracket needs, and the team pool when the deployment does not
already have it. Prompts and raw model responses stay local.

```sh
export VGC_LEAGUE_PUBLISH_ORIGIN=https://<deployment>
export VGC_LEAGUE_IMPORT_TOKEN=<operator secret from the deployment>
npm run vgcleague -- publish --dry-run     # list what would go
npm run vgcleague -- publish               # send it
npm run vgcleague -- publish --pool regmb-202607
```

Publishing is idempotent: a deployment reports series it already holds and
appends nothing. Without `--pool` it sends every pool except the disposable
`test` pool; `--include-test` adds that pool too. Imported rows carry
`origin`, and the record book shows how many rows in scope arrived that way.
The deployment accepts the upload only when it runs with the matching
`VGC_LEAGUE_IMPORT_TOKEN`; without that variable the route does not exist.

## Deployment

The repository includes a multi-stage `Dockerfile` and `railway.toml` for
hosted deployment. Hosted mode has GitHub OAuth, public read-only spectating,
one isolated run at a time, and SQLite and volume backups. See
[docs/deployment.md](docs/deployment.md) for the deployment instructions. See
[docs/architecture.md](docs/architecture.md) for the client/server contract
and the trust model.

## Related work

[VGC-Bench](https://arxiv.org/abs/2506.10326) supplies a VGC training
environment, behavior-cloned and reinforcement-learned agents, and
team-generalization protocols. Its specialized policies could become reference
opponents through the `BattleAgent` interface.
[PokéLLMon](https://arxiv.org/abs/2402.01118) and
[PokéChamp](https://arxiv.org/abs/2503.04094) are language-model Pokémon
agents. They add learned or search components that this project does not use.
