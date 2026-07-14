# vgcbench

`vgcbench` runs language models against each other in fixed-team, open-team-sheet
VGC best-of-three matches using Pokémon Showdown.

Each player makes one joint decision for both active Pokémon. The two players can
think concurrently, and each keeps its private transcript and notebook for the
whole series. Battle state is rebuilt from that player's Showdown protocol stream;
the simulator remains the authority on legality and outcomes.

## Setup

```sh
uv venv --python 3.12
uv pip install -e '.[dev]'
```

A built Pokémon Showdown checkout is expected at `../pokemon-showdown`. Override
it with `VGCBENCH_PS`; override Node with `VGCBENCH_NODE`.

## Run

```sh
vgcbench selfcheck

vgcbench run \
  --models anthropic:claude-sonnet-5 openai:gpt-5.2 \
  --reasoning medium \
  --series-per-pair 4

vgcbench run \
  --models anthropic:claude-sonnet-5 openai:gpt-5.2 meta:muse-spark-1.1 \
  --reasoning medium \
  --series-per-pair 2

vgcbench standings
vgcbench report
```

Two models produce one matchup. Three or more produce a round robin. The reasoning
setting applies to every model in the run and is rejected if a selected provider
does not support it.

## Teams

Team pools live at `teams/<pool>/pool.json`; `--pool` selects one. The current
default is `test`, a disposable set used while the benchmark is being developed.
It is not a claim about the metagame.

A later snapshot only needs its own directory, packed teams, and manifest. The
manifest owns the exact Showdown format, so there is no separate format switch in
the runner.

## Model input

At each decision the model receives:

- its private match transcript and current notebook;
- current field, side conditions, HP, status, boosts, revealed information, and
  exact stats for its own Pokémon;
- both open team sheets;
- relevant move, item, ability, forme, and Speed facts from the configured
  Showdown checkout;
- numbered legal menus for the complete joint action.

It returns one JSON object:

```json
{"choices":[0,2],"notes":"private observations to retain"}
```

Malformed decisions get one retry and then a recorded legal fallback. Provider,
reference, simulator, and team-validation failures stop the run.

## Output

`runs/` contains series logs, decision traces, and run configuration.
`records/results.jsonl` contains one rated row per completed BO3, with its games
nested inside. Both directories are local and gitignored.

Captured Showdown requests used by parser tests live under
`tests/data/showdown_requests/`. They are protocol samples, not preferred plays or
runtime inputs.
