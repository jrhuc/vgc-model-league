# VGC Model League

VGC Model League is a live, longitudinal evaluation of frontier language models
as strategic agents in competitive Pokémon. It asks how capable general-purpose
models are at full VGC best-of-three play when given a practical game interface,
but no VGC-specific fine-tuning, reinforcement learning, search policy, or
pretrained battle agent.

The scaffold is deliberately domain-aware rather than domain-trained. Each model
gets open team sheets, a rules-aware battle view, complete legal joint-action
menus, compact reference and damage tools, a private series notebook, and time to
adapt between games. Pokémon Showdown remains the authority on legality, timers,
and outcomes. The model still has to form a plan, choose both active Pokémon's
actions, manage hidden information, adapt across a series, and recover from its
own mistakes.

The project is intended to become a public, multi-provider league and shared
evidence corpus. Its primary questions are:

- How strong are current frontier models without task-specific policy training?
- Which models adapt between games in a best-of-three rather than replaying the
  same plan?
- How do reliability, latency, token use, and provider configuration trade off
  against competitive strength?
- Which stable behavioral tendencies—leads, brings, switching, protection,
  targeting, aggression, and recovery after a loss—distinguish model families?
- How do those capabilities change across model generations and team contexts?

## Evaluation modes

**Rotation** is the implemented primary mode. Models rotate through immutable
tournament-team pools; assignments are mirrored in pairs to reduce side and team
bias. Rotation produces the controlled league rating and the broadest behavioral
evidence.

Two future modes extend the same evidence model without mixing unlike results
into the Rotation rating:

- **Draft League** — each model drafts a persistent roster, builds teams, and
  plays a season. This measures drafting, construction, adaptation, and battle
  play as a combined capability.
- **Tournament** — each model receives a fixed team and advances through a
  bracket. This measures event performance under assigned-team and bracket-path
  conditions.

Every new result records `mode` and `protocol_version`. Current Rotation records
use `mode: "rotation"` and protocol version 1; existing older JSONL rows remain
readable.

## Relationship to prior work

[VGC-Bench](https://arxiv.org/abs/2506.10326) is the closest and most important
prior work. It provides a Pokémon VGC multi-agent training environment, a large
human-play corpus, behavior-cloned and reinforcement-learned agents, cross-play
evaluation, and seen-team/unseen-team generalization protocols. Its core question
is how specialized policies learn and generalize across diverse teams.

VGC Model League asks a complementary question: how capable, reliable, adaptive,
and behaviorally distinct are general-purpose frontier models under a common,
thin VGC scaffold? It emphasizes hosted models from multiple providers, full
best-of-three series with explicit cross-game memory and reflection, immutable
team rotation, longitudinal model/version evidence, and eventually
model-authored drafting. The goal is not to replace VGC-Bench. Future
interoperability with its trained policies as reference opponents and comparison
against its [human battle-log dataset](https://huggingface.co/datasets/cameronangliss/vgc-battle-logs)
would make both lines of work more useful.

Adjacent language-model Pokémon agents include
[PokéLLMon](https://arxiv.org/abs/2402.01118), which studies in-context learning
and knowledge-augmented generation in Pokémon battles, and
[PokéChamp](https://arxiv.org/abs/2503.04094), which combines an LLM with minimax
search. VGC Model League differs by isolating the current model's own strategic
capability under common scaffolding rather than adding a learned VGC policy or
search controller.

## Setup

```sh
npm install
npm run setup:showdown
npm run build
```

`setup:showdown` clones the upstream simulator, checks out the exact revision in
`showdown.lock.json`, installs its dependencies, and builds the simulator and
timer modules used by the league. Every build verifies that the default checkout
still matches that pin. Set `VGC_LEAGUE_PS` only to use another compatible built
checkout intentionally; its actual commit is recorded with every result.

When upstream Showdown adds a VGC regulation, check and apply it explicitly:

```sh
npm run check:showdown-update
npm run update:showdown
```

The check fetches upstream `HEAD` without changing the checkout or lock. The
update checks out that commit, rebuilds Showdown, updates `showdown.lock.json`,
and runs the complete project test suite. If the candidate fails, the script
restores the previous pin and build. Pass a specific branch, tag, or commit with
`npm run update:showdown -- <git-ref>`. Once verified, create a versioned team
pool using the new regulation's exact Showdown format; the GUI discovers the
new Champions format from the updated simulator.

## Run

The CLI is the headless interface for agents, scripts, and repeatable batch
runs. `npm run vgcleague -- gui [--port 8484]` serves the human control room on
127.0.0.1. It supports provider connection, Rotation setup and cost review, a
live per-game view over SSE, standings and head-to-head results, and immutable
team-pool creation from Showdown teambuilder exports. The client is a Preact app
built by Vite into `dist/gui`; `npm run dev:gui` rebuilds it on change. See
`docs/architecture.md` for the client/server contract, trust model, and
public-deployment roadmap.

Keys pasted into the browser are kept only for the current run and are
never written to disk. Existing provider environment variables are detected
automatically. Providers without a reliable catalog, private deployments, and
OpenAI-compatible endpoints retain exact manual model-spec entry.

```sh
npm run vgcleague -- selfcheck

npm run vgcleague -- rotation \
  --models anthropic:claude-sonnet-5 openai:gpt-5.2 \
  --reasoning medium \
  --series-per-pair 4 \
  --pool regmb-202607

npm run vgcleague -- rotation \
  --models anthropic:claude-sonnet-5 openai:gpt-5.2 meta:muse-spark-1.1 \
  --reasoning medium \
  --series-per-pair 2 \
  --pool regmb-202607

npm run vgcleague -- standings --pool regmb-202607
npm run vgcleague -- report --pool regmb-202607
```

Two models produce one matchup. Three or more produce a round robin. The
reasoning setting applies to every model in the run and is rejected if a selected
provider does not support it. `--pool` on `standings` and `report` keeps ratings
from mixing team-pool epochs.

## Teams

Team pools live at `teams/<pool>/pool.json`; `--pool` selects one. Pools are
immutable snapshots: refreshing the metagame means a new directory, never editing
an existing one, so old records stay reproducible. `teams/regmb-202607` is the
current Reg M-B snapshot with 11 archetype-deduplicated tournament teams. `test`
is disposable local test data.

`npm run build-pool -- teams/<pool>/sources.json` builds a snapshot from
Pokepaste sources. It packs and validates every team against the manifest format
and rejects duplicate species sets. The manifest owns the exact Showdown format,
so the runner has no separate format switch.

The GUI pool builder covers the hand-built path: create teams in the
[Showdown teambuilder](https://play.pokemonshowdown.com/teambuilder), copy each
Import/Export paste, validate, and write a new immutable pool directory.

## Model interface

At each decision the model receives:

- current field and side timers, HP, status, boosts, revealed information, and
  exact stats for its own Pokémon;
- both open team sheets, using species rather than nicknames in prompts;
- a compact private battle timeline and durable series notebook;
- numbered legal menus for the complete joint action, with ally-spread and
  Protect-odds hints;
- compact active matchup and bench references;
- optional native tools for species, moves, items, abilities, natures, type
  matchups, and level-50 damage ranges using only legally available information.

The model returns one JSON object:

```json
{
  "threats": ["likely opposing joint actions or KO threats"],
  "candidates": ["2-3 joint lines considered"],
  "choices": [0, 2],
  "rationale": "brief final reason",
  "notebook": "durable private series notes"
}
```

After each game, both players concurrently write a short result review,
next-game adjustment, and updated notebook. These reviews are outside the
Showdown battle clock and add one model request per player per completed game.

Malformed decisions get one retry and then a recorded legal fallback. Empty
responses take the recorded fallback directly. Provider failures while choosing,
reference failures, simulator failures, and team-validation failures stop the run;
completed series are already persisted. A failed post-game review is recorded as
a reflection fallback and does not discard a completed battle.

## Evidence

`runs/` contains exact run configuration, series logs, compact decision
timelines, and technical traces. Decision timelines retain selected labels,
actions, short rationales, notebook changes, fallbacks, and game reflections.
Technical traces retain prompts, complete menus, raw responses, usage, and tool
arguments and outputs for auditability.

`records/results.jsonl` contains one row per completed best-of-three with nested
games, protocol identity, assignments, seeds, model specs, Showdown revision, and
per-player decision statistics. Current tendency signals include lead and bring
adaptation, Protect chains, repeated actions, switches, ally targeting, spread
moves, Mega choices, and mechanics lookups. They do not alter model prompts.

Both directories are local and gitignored. Captured Showdown requests under
`tests/data/showdown_requests/` are parser fixtures, not preferred plays or
runtime inputs.
