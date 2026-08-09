# vgc-frozen-matchday-v0

**Internal, unpublished, evaluation-only.** This package is the
`verifiers==0.3.0` adapter for the repository's pinned frozen matchday referee.
It is not a training environment, season, standings, or ranking implementation.

## Boundary

TypeScript owns construction acceptance, Pokémon/Showdown mechanics, legal
menus, transitions, score, result, and terminal evidence. Python owns only:

1. loading canonical freezer JSONL and keeping its private `options` out of
   `TaskData`;
2. one bound JSONL referee process;
3. seat-private prompt projections and remote model-reply parsing;
4. the three-role v0.3 lifecycle; and
5. joining completed one-turn traces to TypeScript action and notebook receipts.

Python does not replay a battle, fold game outcomes, inspect seeds, rebuild
commands, or infer a winner. Prompts retain the neutral format-authority notice:
models must follow the pinned Champions simulator rather than import mechanics
from another Pokémon game or format.

## Episode topology

A matchday provisions distinct entrant, opponent, and referee runtimes. The
referee runtime hosts one live process for the episode. Every playing decision
and every between-game notebook opportunity opens a fresh, one-turn
`agent.interaction(..., runtime=seat_runtime)`. This prevents the v0.3 null
harness resume path from replaying prior private prompts. Authorized seat POV
history and that seat's current notebook are projected explicitly instead.

All roles use the built-in null harness, zero retries, and nontrainable standing.
Self-play inherits the run's model and `EvalClientConfig` for both competing
roles. A pinned opponent must declare both explicitly. Client endpoints must be
HTTP(S), have no URL credentials/query/fragment, use an environment-variable
name for the API key, and have empty headers. These are syntactic safe-config
gates, not inspection of URL or environment-variable contents; the operator is
responsible for what accepted URLs and named environment variables contain.

Subprocess runtimes are debug-only and require
`debug_allow_subprocess=true`; their trace label is `debug-subprocess`.
Non-subprocess execution is labeled `runtime-process`. The three live runtime
objects and `runtime.info.id` values must be distinct, and the referee runtime
must support `open_process`.

## Task source

`FrozenMatchdayTasksetConfig.source` is the resolved path of UTF-8, canonical,
newline-terminated JSONL emitted by the repository freezer. JSON arrays and
noncanonical rows are not supported. Each row contains:

- `case_id`, `condition_digest`, and `expected_config_digest`;
- the exact pinned revision, format, and protocol versions; and
- a private `options` object.

The serialized task config binds the absolute path and raw-byte SHA-256. Public
`TaskData` contains the row index and public fields only. `task.options()`
reloads the file, checks the SHA and every public field at that index, and
returns a newly parsed private object. There is no process registry or options
cache. An unbound taskset config (no `source`) is constructible so the native
CLI can narrow the plugin config before `--env.taskset.source` binds it;
loading tasks without a bound source fails.

## Protocol

`FrozenMatchdayProtocolClient` is the only process client. It enforces the ready
envelope, encoded-line cap, strict UTF-8 JSONL framing across arbitrary chunks,
monotonic request ids, exact episode binding on every response, a bounded
per-request timeout so a live but silent referee poisons the client instead of
hanging the episode, a bounded stderr
tail, and poison after an ambiguous/cancelled write. EOF or process exit before
controller close fails the episode, as do queued unsolicited records. With
cooperative runtime process operations, cleanup completes despite caller
cancellation: close requests terminate, then uses kill if the process does not
exit within the configured timeout.

The public surface is `start` plus the fixed matchday calls. Snapshot, restore,
and an unbound generic transport surface are deliberately absent.

## Trace evidence and rewards

Every entrant/opponent trace has one `info["matchday_v0"]` object containing its
pid, decision kind, referee binding, transport label, three runtime ids, and one
accepted join. Notebook traces may carry the fixed malformed-evidence
diagnostic. Remote playing replies fail closed unless they contain exactly one
valid menu choice. Malformed or over-limit optional notebook evidence is model
output and is retained as an omission and diagnosed rather than failing the
episode.

Exactly one action trace per seat is a reward carrier. Only those two traces
receive the common allowlisted terminal summary and their own seat's allowlisted
accepted-action/notebook joins. The summary contains protocol/revision/format/
config identity, the TypeScript score and result, and game count. It excludes
registrations, constructions, teams, seeds, logs, raw notebooks, and the other
seat's receipt partition.

Finalization validates every trace and both complete role partitions, then
requires exact `Counter` equality between trace joins and TypeScript terminal
joins. No reward or metric call occurs before all validation succeeds. The two
carriers then receive `matchday_outcome_v0`, `matchday_games_v0`, and
`matchday_result_v0`; every other trace remains unscored. Finally the entrant
carrier alone is marked trainable as the evaluation policy view: v0.3
aggregates rewards over trainable traces and falls back to all traces when
none are, so one flagged trace per episode makes the native run metric the
entrant's outcome, weighted per episode, while the opponent's mirrored outcome
stays retained, headline-excluded evidence. The flag is an aggregation label;
every role remains nontrainable and the package remains evaluation-only.

## Development

From a repository root whose TypeScript and pinned Showdown artifacts have been
built:

```console
cd environments/vgc_frozen_matchday_v0
uv sync --locked --group test
uv run --locked --group test pytest
uv build --clear
```

The boundary tests include one required three-game full smoke:
freezer -> real v0.3 `EnvServer` -> three runtimes -> scripted OpenAI-compatible
provider -> compiled TypeScript referee -> rewarded episode -> process/runtime
cleanup. Missing root build artifacts fail that test rather than skip it. A
clean wheel build remains the packaging smoke.
