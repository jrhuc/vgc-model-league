# VGC Model League

VGC Model League evaluates general-purpose language models in full VGC
best-of-three games on Pokémon Showdown. Each model receives open team sheets,
legal action menus, reference and damage tools, a private series notebook, and
a review step between games. Showdown determines legality, timers, and
outcomes. The project adds no fine-tuning or search policy; its scaffold is
domain-aware, but it does not specialize the model.

The league asks:

- How strong are current frontier models without task-specific policy training?
- Do models adapt between games in a best-of-three, or replay the same plan?
- How do reliability, latency, token use, and provider configuration trade off
  against competitive strength?
- Which tendencies in leads, brings, switching, Protect use, targeting, and
  recovery after a loss distinguish model families and generations?

## Modes

| Mode | What happens | Rates the ladder? |
| --- | --- | --- |
| **Match** | Two models, two teams (pasted or sampled), one best-of-three. The GUI's default flow. | No |
| **Tournament** | Single-elimination best-of-three bracket. Each model keeps one assigned team through the bracket; byes fill incomplete brackets. | No |
| **Draft League** | Models snake-draft rosters from a fixed board, then play a round robin and playoffs. Draft rationale is logged. | No |
| **Rotation** | Models rotate through immutable team pools with mirrored assignments to cancel side and team bias. Produces the controlled league Elo. | Yes |
| **Exhibition** | One best-of-three where a seat is played by an external terminal agent over a local bridge instead of a provider API. | No |

Every result records `mode` and `protocol_version`. Only rotation rows enter
the rating.

## Setup

```sh
npm install
npm run setup:showdown
npm run build
```

`setup:showdown` clones the simulator at the exact commit in
`showdown.lock.json` and builds it; every project build verifies the pin. To
adopt a new upstream revision:

```sh
npm run check:showdown-update   # report whether upstream HEAD moved
npm run update:showdown         # build candidate, run full suite, advance the lock
```

`update:showdown` restores the previous pin if the candidate fails.

## Run

Model specs are `<provider>:<model-id>` (for example `anthropic:...`,
`openai:...`), or `random` for a legal-move baseline. Provider API keys come
from environment variables for CLI runs; GUI runs use only keys pasted into
the browser, held in memory and never written to disk.

```sh
npm run vgcleague -- gui                # browser control room on 127.0.0.1
npm run vgcleague -- selfcheck          # one random-vs-random series

npm run vgcleague -- rotation   --models <spec> <spec> --pool regmb-202607 --series-per-pair 4
npm run vgcleague -- tournament --models <spec> <spec> <spec> <spec> --pool regmb-202607
npm run vgcleague -- draft      --models <spec> <spec> <spec> <spec> --board regmb-202607
npm run vgcleague -- exhibition --opponent <spec>

npm run vgcleague -- standings --pool regmb-202607
npm run vgcleague -- report    --pool regmb-202607
```

All experiment commands accept `--seed` for reproducibility and
`--reasoning <level>` for provider reasoning effort. Rotation, tournament, and
draft also accept `--concurrency` for parallel series. Unsupported reasoning
levels are rejected before the run starts.

A failed series aborts the whole run: queued series never start, in-flight
series are cancelled, and completed series are already persisted. A run
reported as failed is not still spending provider credits in the background.

Without `--pool`, standings and reports cover every pool except the disposable
`test` pool and keep only rotation rows. The GUI record book has the same
scoping.

### Exhibition seats

The host process runs the battle, the opponent engine, and its API key. It
serves a token-authenticated bridge on `127.0.0.1` and writes an agent workspace
(default `runs/<run>/agent/`) with a thin client (`seat.mjs`), instructions
(`SEAT.md`), and the connection token. Start the terminal agent in that
directory. The agent seat uses the same `LLMEngine` scaffold as an API model.
The move timer is disabled because agent turns take minutes. The bridge logs
every tool lookup for later auditing.

## Teams and draft boards

Team pools live at `teams/<pool>/pool.json`. Pools are immutable snapshots: a
metagame refresh is a new directory, never an edit, so old records stay
reproducible. `teams/regmb-202607` is the current Reg M-B snapshot
(archetype-deduplicated tournament teams); `test` is disposable local data.

Two ways to build a pool, both validated by the pinned simulator and rejected
on duplicate species sets:

- From Pokepaste sources: `npm run build-pool -- teams/<pool>/sources.json`.
- In the GUI pool manager, paste Showdown teambuilder exports.

Draft boards live at `boards/<board>.json`. Each board contains fixed
competitive sets derived from a tournament-team pool. Regenerate a board with
`npm run build-board -- <pool>`. Boards are immutable snapshots like team
pools.

## Model interface

At each decision the model receives the field state and timers, exact stats
for its own Pokémon, both open team sheets, a private timeline and notebook,
numbered legal menus for the complete joint action, and active-matchup
references. Optional tools cover species, moves, items, abilities, natures,
type matchups, and level-50 damage ranges, using only legally available
information. The model returns one JSON object:

```json
{
  "threats": ["likely opposing joint actions or KO threats"],
  "candidates": ["2-3 joint lines considered"],
  "choices": [0, 2],
  "rationale": "brief final reason",
  "notebook": "durable private series notes"
}
```

Malformed decisions get one retry, then a recorded legal fallback. Provider,
simulator, reference, and team-validation failures stop the run.

After every game both players write a short review, next-game adjustment, and
updated notebook, outside the battle clock. The closing review of a decided
series is kept as post-mortem evidence and marked `series_over` in the
decision log.

## Evidence

`runs/` holds run configuration, series logs, decision timelines, technical
traces (prompts, menus, raw responses, usage, and tool calls), and per-model
draft logs when applicable.

`records/results.jsonl` holds one row per completed best-of-three: nested
games, protocol identity, assignments, seeds, model specs, Showdown commit,
and per-player decision statistics. Each row also records `scaffold`, a hash
of the system prompts, tool schemas, and sampling parameters, so longitudinal
comparisons can detect scaffold drift.

Both directories are local and gitignored.

## Deployment

The repository includes a multi-stage `Dockerfile` and `railway.toml` for
hosted deployment with GitHub OAuth, public read-only spectating, one isolated
run at a time, and SQLite and volume backups. See
[docs/deployment.md](docs/deployment.md) for deployment instructions and
[docs/architecture.md](docs/architecture.md) for the client/server contract
and trust model.

## Related work

[VGC-Bench](https://arxiv.org/abs/2506.10326) provides a VGC training
environment, behavior-cloned and reinforcement-learned agents, and
team-generalization protocols. Its specialized policies could serve as
reference opponents through the `BattleAgent` interface.
[PokéLLMon](https://arxiv.org/abs/2402.01118) and
[PokéChamp](https://arxiv.org/abs/2503.04094) are language-model Pokémon agents
that add learned or search components not used here.
