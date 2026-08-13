# vgc-draft-circuit-v1

This directory contains the internal native-v1 environment for whole VGC
circuits. The package, referee image, and Environment Hub entry are unpublished.
No hosted execution path has been validated.

## Native-v1 API

The package uses exact `verifiers==0.3.0` and exports exactly two public
classes:

- `VgcDraftCircuitTaskset`, the only `Taskset`;
- `VgcDraftCircuitEnv`, the only `Env`.

The import package is at the environment root, not under a `src/` directory.
The CI upload-boundary smoke copies this directory without its local `.venv` or
`dist` output and verifies native-v1 discovery from that flat layout.

The finite built-in taskset accepts `scenario`, `seed_start`, and `num_blocks`.
The default produces one task for each implemented scenario at seed 0. Selecting
`all` produces both scenarios for every seed block. Task data contains only its
index, scenario and case IDs, seed, and condition digest. It does not contain a
private source path, referee options, prompt, or system prompt.

## Scenarios

Both scenarios are implemented and unpublished.

### `victory-road-top8-v1`

This scenario runs a fixed, seeded top-eight bracket with seven conditional
series. The eight slots use the committed reconstructed teams in
`teams/vr-aug26-top8`. The source event published team details but not the human
stat spreads, so the committed teams use documented reconstructed spreads.

This is not a replay of the players' actions, the full Swiss event, or the exact
unpublished human spreads. A model's choices determine each simulated series and
therefore the conditional bracket path.

### `draft-league-v1`

This scenario runs:

1. an eight-seat, 80-pick snake draft that gives each seat ten roster entries;
2. a seven-week round robin containing all 28 seat pairings;
3. blind construction batches separated by a barrier after week 3;
4. one coach-trade opportunity and an atomic free-agency decision for each seat
   at the barrier;
5. a new matchup construction for every series; and
6. a top-four playoff with two semifinals and one final.

The pre-window and post-window round-robin construction blocks are blind to
results inside the same block. Series run through the existing frozen matchday
referee. A registered six remains fixed for the series, and every game starts a
fresh bring-four and lead-two preview. An elimination series tied after the
three regulation games uses deterministic extra-game seeds until it has a
winner, with a nine-game limit.

## Roles and interactions

`VgcDraftCircuitEnvConfig` exposes configurable `seat1` through `seat8` player
roles and one `referee` role. All nine roles require the built-in null harness,
zero verifiers retries, and distinct runtimes. The eight player roles are
trainable. The referee is nontrainable, never receives a model turn, and must
support `Runtime.open_process`. `max_concurrent_agents` must be at least eight.

The environment provisions all nine runtimes for one Episode. For every pending
decision, it starts a fresh, one-turn
`agent.interaction(..., runtime=seat_runtime)`. Concurrent pending decisions run
together. The package does not preserve a provider conversation between turns.
Instead, the TypeScript referee renders the complete authorized seat prompt,
including that seat's explicit notebook when applicable.

Subprocess runtimes are debug-only. They require
`debug_allow_subprocess=true` and receive the `debug-subprocess` transport
label. Other executions receive the `runtime-process` label. Debug subprocess
execution does not establish runtime isolation.

## Authority and protocol

TypeScript owns prompts, draft legality and fallback, construction, scheduling,
transactions, native action acceptance, battle state, bracket advancement,
terminal evidence, and terminal returns. Python owns verifiers lifecycle,
runtime provisioning, the bounded process client, trace joins, and strict
terminal validation. Python does not implement a second command parser or infer
outcomes from model messages.

The circuit uses JSONL protocol 1, circuit protocol 2, prompt protocol 2,
matchday protocol 1, battle protocol 1, and the pinned Showdown revision. The
client exposes only `observe`, `pending_turns`, `submit`, and `terminal` after
`start`. Every response must carry the exact Episode binding.

`src/frozen-circuit-referee.ts` reuses the repository's existing draft,
strict-construction, round-robin, playoff, and transaction authorities. It
creates a `FrozenMatchdayReferee` for each series, which reuses the
`FrozenBattleReferee` and pinned Showdown simulator for each game.

The Python process client validates the ready envelope, protocol tuple,
Showdown revision, line framing and size, request IDs, response binding, timeouts,
process exit, and shutdown. A protocol, provider, runtime, or trace-join failure
fails the Episode before scoring.

```text
TypeScript pending turns + authorized observations
  -> Python Env
  -> fresh one-turn seat interactions
  -> raw replies
  -> TypeScript submit
  -> accepted/defaulted receipts
  -> per-Trace receipt joins
  -> repeat until terminal

TypeScript terminal evidence
  -> exact Python binding/schema/coverage validation
  -> terminal receipt Counter == Trace join Counter
  -> per-seat terminal reward + diagnostic metrics on joined Traces
```

## Terminal rewards and diagnostics

The referee emits one scenario-specific terminal return for each seat. Python
recomputes and validates the return from the terminal series evidence. Only
after the complete Episode and all receipt joins validate does it record the
same seat return on that seat's decision traces.

For `draft-league-v1`:

```text
reward = ((round-robin series wins - round-robin series losses)
          + (playoff series wins - playoff series losses)) / 9
name   = draft_league_series_return_v1
```

The nine opportunities are seven round-robin series and up to two playoff
series for one seat. A recorded round-robin draw or a playoff opportunity that
the seat does not reach contributes zero to the numerator.

For `victory-road-top8-v1`:

```text
reward = (top-cut series wins - top-cut series losses) / 3
name   = tournament_series_return_v1
```

The three opportunities are the possible quarterfinal, semifinal, and final for
one seat. An opportunity that the seat does not reach contributes zero to the
numerator.

The environment also records game results, game differential, pre-window and
post-window splits, game-one-loss conversion, standings, playoff qualification,
champion status, transactions, invalid turns, and defaults. These values are
diagnostics only. They do not provide game, semantic, transaction, adaptation,
standing, champion, invalid-output, or default shaping.

## Evaluation and training targets

The primary evaluation uses heterogeneous frontier-model fields with model
allocations counterbalanced across seats and declared seed blocks. Construct and
preregister those allocations outside the package; the taskset does not claim
to generate a complete counterbalancing design. Treat a whole circuit as the
replication and uncertainty block.

Configuring the same model for all eight roles is a supported symmetric
self-play target. The trainable roles also make multi-agent `prime-rl` a target.
These paths are not hosted-validated, and same-model self-play is not a frontier
comparison or evidence of model strength.

## Build and test

From the repository root, run the commands used by the package and CI:

```console
pnpm test
pnpm run test:draft-circuit-package
pnpm run build:draft-circuit-package
```

To run the standalone package steps directly:

```console
cd environments/vgc_draft_circuit_v1
uv sync --locked --group test
uv run --locked --group test pytest
uv run --locked --group test eval vgc-draft-circuit-v1 \
  -n 1 -r 1 --dry-run --no-push --rich false \
  -o /tmp/vgc-draft-circuit-dry-run
uv build --wheel --clear
```

The dry run validates discovery and configuration only. It does not provision
nine runtimes or play either scenario.

## Publication blockers

The package classifier prevents an accidental public Python upload. The
repository contains a referee Dockerfile and image workflow, but no reviewed,
published image digest is recorded. The default referee image reference is not
proof that the image is available.

Before a Docker, Prime runtime, Hub, Hosted Evaluation, or Hosted Training run:

1. publish and review the exact referee image;
2. configure reviewed immutable digests for the referee and player runtime
   images instead of mutable tags;
3. provide runtime authentication that can pull the referee image;
4. publish and load the exact environment package; and
5. validate that execution path independently.

Until these steps pass, local source and dry-run evidence does not establish
hosted support.
