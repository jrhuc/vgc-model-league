# vgcbench

`vgcbench` runs language models against each other in fixed-team, open-team-sheet
VGC best-of-three matches using Pokémon Showdown.

Each player makes one joint decision for both active Pokémon. The two players can
think concurrently, and each keeps its private transcript and notebook for the
whole series. Battle state is rebuilt from that player's Showdown protocol stream;
the simulator remains the authority on legality and outcomes.

## Setup

```sh
git clone https://github.com/smogon/pokemon-showdown.git
cd pokemon-showdown
npm install
npm run build-npm
cd ..
npm install
npm run build
```

A built Pokémon Showdown checkout is expected at `./pokemon-showdown`. Override it
with `VGCBENCH_PS`. The benchmark loads the configured checkout directly (by path, with
its types mapped through `tsconfig.json`)

## Run

Running `npm run vgcbench` with no command in a terminal opens an interactive
TUI for composing runs: model selection (curated list, recently used specs, and
free-form spec entry), pool/reasoning/series/concurrency/seed options, API-key
presence checks, a live series dashboard while the benchmark runs, and a
standings browser. Batch commands:

```sh
npm run vgcbench -- selfcheck

npm run vgcbench -- run \
  --models anthropic:claude-sonnet-5 openai:gpt-5.2 \
  --reasoning medium \
  --series-per-pair 4 \
  --pool regmb-202607

npm run vgcbench -- run \
  --models anthropic:claude-sonnet-5 openai:gpt-5.2 meta:muse-spark-1.1 \
  --reasoning medium \
  --series-per-pair 2 \
  --pool regmb-202607

npm run vgcbench -- standings --pool regmb-202607
npm run vgcbench -- report --pool regmb-202607
```

Two models produce one matchup. Three or more produce a round robin. The reasoning
setting applies to every model in the run and is rejected if a selected provider
does not support it. `--pool` on `standings` and `report` keeps ratings from
mixing team-pool epochs.

## Teams

Team pools live at `teams/<pool>/pool.json`; `--pool` selects one. Pools are
immutable snapshots: refreshing the meta means a new directory, never editing an
existing one, so old records stay reproducible. `teams/regmb-202607` is the
current Reg M-B snapshot (11 archetype-deduped tournament teams). `test` is a
disposable set used while the benchmark was being developed.

`npm run build-pool -- teams/<pool>/sources.json` builds a snapshot from
pokepaste sources: it packs and validates every team against the manifest format
and refuses two teams with the same species set. The manifest owns the exact
Showdown format, so there is no separate format switch in the runner.

## Model input

At each decision the model receives:

- its private match transcript (compacted after each decision) and current notebook;
- current field, side conditions, HP, status, boosts, revealed information, and
  exact stats for its own Pokémon;
- both open team sheets;
- numbered legal menus for the complete joint action;
- optional native tool calls to look up move, species, item, ability, and nature
  facts from the configured Showdown checkout.

It returns one JSON object:

```json
{"choices":[0,2],"notes":"private observations to retain"}
```

Malformed decisions get one retry and then a recorded legal fallback. Empty
responses take the recorded fallback directly. Provider, reference, simulator,
and team-validation failures stop the run; completed series are already persisted
when that happens.

The pool's Showdown BO3 format is the authority for timer rules, tiebreaks,
legality, and battle outcomes. Native timer budgets are included in each model
prompt; Showdown auto-chooses when a turn expires and forfeits a player whose
clock bank is exhausted. The benchmark does not override its result.

## Output

`runs/` contains series logs, decision traces, and run configuration.
`records/results.jsonl` contains one rated row per completed BO3, with its games
nested inside. Both directories are local and gitignored.

Captured Showdown requests used by parser tests live under
`tests/data/showdown_requests/`. They are protocol samples, not preferred plays or
runtime inputs.
