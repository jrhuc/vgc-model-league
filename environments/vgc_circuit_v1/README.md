# vgc-circuit-v1

This directory contains the internal native-v1 environment for whole VGC
circuits. The package, referee image, and Environment Hub entry are unpublished.
No hosted execution path has been validated.

## Native-v1 API

The package uses exact `verifiers==0.3.0` and exports exactly two public
classes:

- `VgcCircuitTaskset`, the only `Taskset`;
- `VgcCircuitEnv`, the only `Env`.

The import package is at the environment root, not under a `src/` directory.
The CI upload-boundary smoke copies this directory without its local `.venv` or
`dist` output and verifies native-v1 discovery from that flat layout.

The finite built-in taskset accepts `scenario`, `seed_start`, and `num_blocks`.
`scenario` selects exactly one lifecycle for an evaluation; it never mixes the
league and tournament in one taskset. It defaults to `draft-league-v1` for
native plugin discovery, and `victory-road-top8-v1` must be selected explicitly.
Task data contains only its index, scenario ID, a seed-unique `case_id`, seed,
and condition digest. It does not contain a private source path, referee
options, prompt, or system prompt.

The condition digest hashes the case identity together with the substrate pin:
the format ID, the pinned Showdown revision, and the five protocol versions. A
pin change therefore produces different digests for the same scenario and seed,
so results from two substrate revisions cannot pool under one condition. The
digest does not cover the TypeScript referee's own configuration, which fixes
the seat permutation, draft board, team pool, schedule, and series seeds; see
the referee content pins below.

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

`VgcCircuitEnvConfig` exposes configurable `seat1` through `seat8` player
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

`observe` results are validated and discarded. A seat's prompt comes from
`pending_turns`, so `observe` acts only as a tripwire that the referee's
per-seat view agrees with the pending decision. Seat isolation itself is a
TypeScript authority that Python cannot check; Python sees no seat's private
state.

### Referee content pins

The Python constants pin the format, Showdown revision, and protocol versions,
and the start binding must match them exactly. They do not pin the referee's
own configuration. `expected_config_digest` and `expected_prompt_revision` pin
that half: when set, the referee's `configDigest` and `promptRevision` must
match at `start` and again at every trace join, or the Episode fails before
scoring. The referee's config digest covers the protocol versions, Showdown
revision, scenario, format, prompt revision, fixture digests, seed, seat
permutation, pool, board, schedule, and series seeds, so pinning it detects a
referee image that changed content behind a mutable tag. Both default to
unset, which pins nothing.

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

Both formulas are frozen. The eight seat returns therefore sum to exactly zero
in every complete Episode, because every series win is another seat's loss and
the denominator is a constant.

The environment also records game results, game differential, pre-window and
post-window splits, game-one-loss conversion, standings, playoff qualification,
champion status, transactions, invalid turns, and defaults. These values are
diagnostics only. They do not provide game, semantic, transaction, adaptation,
standing, champion, invalid-output, or default shaping.

`circuit_seat_decisions_v1` records how many decision traces a seat produced.
It exists so a consumer can undo the trace weighting described under
publication blockers: weighting each trace by the reciprocal of this metric
recovers a per-seat mean from a trace-level export.

## Evaluation and training targets

The primary evaluation uses heterogeneous frontier-model fields with model
allocations counterbalanced across seats and declared seed blocks. Construct and
preregister those allocations outside the package; the taskset does not claim
to generate a complete counterbalancing design. Treat one complete scenario as
the replication and uncertainty block. Run and report the league and tournament
as separate evaluations because their lifecycles, starting resources, rewards,
and estimands are not interchangeable.

Configuring the same model for all eight roles is a supported symmetric
self-play target. The trainable roles also make multi-agent `prime-rl` a target.
These paths are not hosted-validated, and same-model self-play is not a frontier
comparison or evidence of model strength.

## Build and test

From the repository root, run the commands used by the package and CI:

```console
pnpm test
pnpm run test:circuit-package
pnpm run build:circuit-package
```

To run the standalone package steps directly:

```console
cd environments/vgc_circuit_v1
uv sync --locked --group test
uv run --locked --group test pytest
uv run --locked --group test eval vgc-circuit-v1 \
  --env.taskset.scenario draft-league-v1 \
  -n 1 -r 1 --dry-run --no-push --rich false \
  -o /tmp/vgc-circuit-dry-run
uv build --wheel --clear
```

The dry run validates discovery and configuration only. It does not provision
nine runtimes or play either scenario.

## Publication blockers

The package classifier prevents an accidental public Python upload. Hub
visibility is a separate flag and must be set at `prime env push`. The
repository contains a referee Dockerfile and image workflow, but no reviewed,
published image digest is recorded. The default referee image tag
`ghcr.io/jrhuc/vgc-circuit-referee:0.1.0` and the default player image tag
`python:3.11-slim` are mutable and unpublished as hosted contracts.

Before a Docker, Prime runtime, Hub, Hosted Evaluation, or Hosted Training run:

1. publish and review the exact referee image;
2. configure reviewed immutable digests for the referee and player runtime
   images instead of mutable tags;
3. record the reviewed image's `configDigest` and `promptRevision` in
   `expected_config_digest` and `expected_prompt_revision`, so a later push to
   the same tag fails the Episode instead of scoring under different content;
4. provide runtime authentication that can pull the referee image;
5. publish and load the exact environment package; and
6. validate that execution path independently.

Until these steps pass, local source and dry-run evidence does not establish
hosted support.

Do not treat a Hub mean as a model ranking. The eight seat returns in one
Episode partition one zero-sum series ledger, so their mean is zero whatever
the field played. The environment writes the same seat return onto every
decision trace for that seat, so a trace-weighted mean drifts off zero only
because seats that play more games, usually playoff seats, contribute more
traces. Compare seats or assigned models, and reweight a trace-level export by
`circuit_seat_decisions_v1`. Same-model self-play validates machinery; its
expected seat return is zero by construction, so it cannot rank anything.

One provider, runtime, or protocol failure fails the whole eight-seat Episode
before scoring. The default `draft-league-v1` task provisions nine runtimes and
plays a full 31-series league. Use `victory-road-top8-v1` for a shorter
seven-series smoke after the referee image exists. The native dry run does not
provision runtimes or play either scenario.

## License and attribution

The code uses the MIT License. Pokémon and all respective names are trademarks
of Nintendo, Creatures Inc., and GAME FREAK inc. The Victory Road scenario uses
reconstructed stat spreads, not unpublished human spreads from the source event.
