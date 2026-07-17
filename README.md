# VGC Model League

VGC Model League measures how well general-purpose language models play
competitive Pokémon — full VGC best-of-three on Pokémon Showdown — when given a
practical game interface but no Pokémon-specific training. Each model gets open
team sheets, complete legal action menus, reference and damage tools, a private
series notebook, and a review step between games. Showdown decides legality,
timers, and outcomes. There is no fine-tuning, no search policy, and no
battle-log pretraining: the scaffold is domain-aware, the model is not
domain-trained.

The league exists to answer:

- How strong are current frontier models without task-specific policy training?
- Do models adapt between games in a best-of-three, or replay the same plan?
- How do reliability, latency, token use, and provider configuration trade off
  against competitive strength?
- Which tendencies — leads, brings, switching, Protect use, targeting,
  recovery after a loss — distinguish model families, and how do they change
  across model generations?

## Modes

**Rotation** is the implemented mode and produces the controlled league
rating: models rotate through immutable tournament-team pools, with
assignments mirrored in pairs to cancel side and team bias.

Two planned modes, **Draft League** (models draft rosters and build teams) and
**Tournament** (fixed teams, bracket play), will record their own results and
never enter the Rotation rating. Every result records `mode` and
`protocol_version`; older rows remain readable.

## Prior work

[VGC-Bench](https://arxiv.org/abs/2506.10326) is the closest prior work: a VGC
training environment, a large human battle-log corpus, behavior-cloned and
reinforcement-learned agents, and seen/unseen-team generalization protocols.
Its question is how specialized policies learn and generalize. This project
asks the complement: how capable, reliable, and behaviorally distinct are
hosted general-purpose models under one thin scaffold, across providers and
model generations. VGC-Bench policies could later serve as reference opponents
here — they would implement the same `BattleAgent` interface the league already
uses.

[PokéLLMon](https://arxiv.org/abs/2402.01118) and
[PokéChamp](https://arxiv.org/abs/2503.04094) are adjacent language-model
Pokémon agents; both add a learned or search component that this project
leaves out on purpose.

## Setup

```sh
npm install
npm run setup:showdown
npm run build
```

`setup:showdown` clones the simulator at the exact commit in
`showdown.lock.json` and builds it. Every project build verifies the pin. To
adopt a new upstream revision (for example when a new VGC regulation ships):

```sh
npm run check:showdown-update   # report whether upstream HEAD moved
npm run update:showdown         # build candidate, run full suite, advance the lock
```

`update:showdown` restores the previous pin if the candidate fails. Set
`VGC_LEAGUE_PS` only to use a different built checkout on purpose; its actual
commit is recorded with every result.

## Run

```sh
npm run vgcleague -- gui [--port 8484]   # browser control room on 127.0.0.1
npm run vgcleague -- selfcheck           # one random-vs-random series

npm run vgcleague -- rotation \
  --models anthropic:claude-sonnet-5 openai:gpt-5.2 \
  --reasoning medium \
  --series-per-pair 4 \
  --pool regmb-202607

npm run vgcleague -- standings --pool regmb-202607
npm run vgcleague -- report --pool regmb-202607
```

Two models produce one matchup; three or more produce a round robin.
`--series-per-pair` defaults to 2 so assignments stay mirrored; an odd count
warns. The reasoning level applies to every model and is rejected if a
selected provider does not support it.

A failed series aborts the whole run: queued series never start, in-flight
series are cancelled, and completed series are already persisted. A run
reported as failed is not still spending provider credits in the background.

**Standings scope.** `--pool` restricts standings and reports to one team-pool
epoch. Without it, both cover every pool except the disposable `test` pool, so
scratch runs never contaminate the record book; pass `--pool test` to inspect
them. The GUI record book has the same scoping.

**Keys.** GUI runs use only keys pasted into the browser: held in memory for
the run, never written to disk, never replaced by the server's environment
variables — a run missing a key fails instead of billing server credentials.
Provider environment variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …)
apply to CLI runs only.

## Teams

Team pools live at `teams/<pool>/pool.json`. Pools are immutable snapshots: a
metagame refresh is a new directory, never an edit, so old records stay
reproducible. `teams/regmb-202607` is the current Reg M-B snapshot (11
archetype-deduplicated tournament teams); `test` is disposable local data.

Two ways to build a pool, both validated by the pinned simulator and rejected
on duplicate species sets:

- `npm run build-pool -- teams/<pool>/sources.json` — from Pokepaste sources.
- The GUI pool builder — paste
  [Showdown teambuilder](https://play.pokemonshowdown.com/teambuilder)
  exports.

The manifest records the exact Showdown format; the runner has no separate
format switch.

## Model interface

At each decision the model receives the current field state and timers, exact
stats for its own Pokémon, both open team sheets, a compact private timeline
and durable notebook, numbered legal menus for the complete joint action, and
active-matchup references. Optional tools cover species, moves, items,
abilities, natures, type matchups, and level-50 damage ranges, using only
legally available information. The model returns one JSON object:

```json
{
  "threats": ["likely opposing joint actions or KO threats"],
  "candidates": ["2-3 joint lines considered"],
  "choices": [0, 2],
  "rationale": "brief final reason",
  "notebook": "durable private series notes"
}
```

Malformed decisions get one retry, then a recorded legal fallback. Empty
responses take the fallback directly. Provider, simulator, reference, and
team-validation failures stop the run.

After every game — including the last one of a series — both players write a
short result review, next-game adjustment, and updated notebook, outside the
battle clock. The closing review of a decided series no longer informs play;
it is kept as post-mortem evidence and marked `series_over` in the decision
log so analysis can separate the two.

## Evidence

`runs/` holds exact run configuration, series logs, compact decision timelines
(selected actions, rationales, notebook changes, fallbacks, reflections), and
technical traces (prompts, menus, raw responses, usage, tool calls).

`records/results.jsonl` holds one row per completed best-of-three: nested
games, protocol identity, assignments, seeds, model specs, Showdown commit,
and per-player decision statistics. Each row also records `scaffold`, a hash
of the system prompts, tool schemas, and sampling parameters, so longitudinal
comparisons can detect scaffold drift that a manual `protocol_version` bump
would miss. Tendency counters (lead and bring changes, Protect chains,
repeated actions, ally targeting, spread moves, Mega choices, tool lookups)
are recorded post-hoc and never alter model prompts.

Both directories are local and gitignored. See `docs/architecture.md` for the
client/server contract, trust model, and deployment plan.
