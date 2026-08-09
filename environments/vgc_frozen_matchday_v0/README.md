# vgc-frozen-matchday-v0

**Internal, unpublished, evaluation-only.** This package is the native
`verifiers==0.3.0` control-flow adapter for the repository's pinned frozen
matchday referee. It is not a training environment, circuit, season, standings,
or ranking implementation, and it is not supported on the Environments Hub or
Hosted Training.

Python mediates the entrant (`p1`), opponent (`p2`), and non-agent referee
roles. The TypeScript executable remains authoritative for construction
acceptance, Pokémon/Showdown mechanics and state, legal action menus, submission
tokens, scores, and terminal evidence. Python reconstructs only a strict minimal
terminal identity from exact TypeScript envelopes and checks redundant per-game,
score, game-count, and top-result agreement. It never infers a Pokémon outcome,
recomputes mechanics, rebuilds an action, or recomputes a simulator digest.

## Trace and episode topology

One matchday is one `Episode`, one referee process, and one provisioned runtime
per role. Every playing decision opens a fresh
`agent.interaction(task, runtime=seat_runtime)`, takes exactly one model turn,
and closes it. Every between-game notebook opportunity uses a separate fresh
one-turn interaction. Only entrant and opponent interactions receive framework
Trace runtime stamps. The referee has no interaction or Trace; its live identity,
runtime id, and runtime type are checked before launch and again in `finally`.

This topology is intentional. The v0.3 `NullHarness.resume` path replays an
interaction's accumulated messages, so a persistent interaction would leak old
prompts, replies, rationales, and notebook evidence into later provider
requests. Authorized current-game history is instead written explicitly into
each fresh prompt from that seat's native POV deltas. Consequently a matchday
contains multiple entrant and opponent traces and must be analyzed as a whole
Episode. Per-trace aggregation is not a valid matchday statistic.

All three roles are forced nontrainable. After validating the complete Episode,
the controller records `matchday_outcome_v0` and the matchday metrics on exactly
one designated action Trace per seat. Notebook traces and all other action
traces receive no reward. There is deliberately no token-credit, training,
circuit, or ranking support.

## Conditions and evidence

The default `opponent_condition="self_play"` requires the opponent model and
client to inherit the run's model and client. For a pinned comparison, set
`opponent_condition="pinned_opponent"` and explicitly configure both the
opponent model and client. Construction seals the complete environment policy,
including the pin, rather than retaining a live nested configuration as expected
evidence. Every run revalidates that seal before provisioning, captures the
actual resolved v0.3 model/client identity of all three roles before any call,
and requires equal competing identities for self-play or the actual opponent to
match the constructor pin. It rechecks the same captured identities and live
referee role/runtime evidence before leaving the run.

Seals are domain-separated HMAC-SHA256 values under a random 256-bit key private
to the `FrozenMatchdayEnv`. Inputs use UTF-8 JSON with sorted object keys,
compact separators, Unicode preserved, and non-finite numbers refused. Per-role
identity inputs contain only the resolved model string and exact v0.3 client
JSON; the constructor policy seal covers the exact environment configuration.
Only exact built-in v0.3 `AgentConfig`, `EvalClientConfig`, `ModelContext`,
`Trace`, and `Episode` concrete types are accepted at the controller boundary,
and the custom environment and task types must also be exact. Subclass dump,
grouping, or private-state overrides are not trusted.

Client configuration may contain only an HTTP(S) `base_url` without URL userinfo,
query, or fragment, an environment-variable-shaped name in `api_key_var`, and
empty `headers`. Provider credentials must come from that documented
environment/secret mechanism and are not serialized into `Trace.agent.config`.
These environment-variable-name and URL-path restrictions are syntactic policy
gates, not proof that arbitrary accepted strings contain no secret; operators
remain responsible for supplying nonsecret endpoint paths and variable names.
Embedded URL credentials, nonempty endpoint headers, and custom authenticated
endpoint schemes are unsupported in v0; there is no safe custom-header
authentication path in the exact v0.3 trace schema.

At finalization, every competing Trace's independent framework-stamped agent
configuration is re-HMACed and must equal its original pre-rollout role stamp;
all traces must share one authenticated condition and role-stamp bundle. The
referee deliberately has no Trace, so its stamp has only common controller
evidence. Its live identity and runtime placement are revalidated before `run`
exits. Thus only entrant and opponent identities and runtime placements have
independent framework Trace stamps.

Playing prompts contain only the public phase, game number and score, the
accumulated seat POV history, that seat's native request, the exact numbered
referee labels, and that seat's current notebook. Between-game prompts label the
completed game (the outer upcoming game number minus one), include its final
seat POV deltas, and state the native 20,000-character replacement limit.
Notebook text is never truncated or repaired: omission retains it and an empty
string clears it. Malformed returned notebook evidence, including JSON structural
exhaustion, is recorded with the declared diagnostic and treated as omission
after the referee confirms the retained raw value and receipt. It does not affect
the match. Required action parsing remains fail-closed.

There is one exact v0.3 infrastructure limitation: a provider/runtime failure
during an optional notebook interaction still fails the whole Episode because
v0.3 unconditionally retains the failed interaction Trace. It cannot be treated
as a clean omission or represented by a valid Episode/receipt. The controller
collects peer turns and exits entered peer interaction contexts normally when it
can, then raises without submitting either notebook acknowledgement. Action and
provider failures also fail closed; there are no retries, restored states,
default actions, or legal-action fallbacks. There is no Showdown or battle timer.
If framework Env/Agent setup, rollout, finalize, or scoring timeouts are accepted,
they are constructor-policy-bound infrastructure failure guards, not a thinking
budget or a measurement of decision quality.

After terminal evidence and every fresh interaction join exist, the controller
builds and HMACs one deterministic complete-episode manifest under the separate
`complete-episode-evidence` domain. Its exact top-level fields are `version`,
`referee_episode_id`, `task`, `protocol_binding`, `opponent`, `runtime`,
`outcome`, `authoritative_partitions`, `traces`, and `designated_carriers`.
`task` binds idx, case id, condition/config digests, revision, format, and all
three protocol versions. `opponent` binds the condition, three opaque role
identity stamps, their identity-evidence seal, and the opaque complete
controller-policy seal. `runtime` binds all three
runtime ids and types plus transport. `outcome` contains only protocol/revision/
format/config identity, minimal score/result, game count, and numbered minimal
per-game results. Each authoritative pid partition contains only that pid's
accepted action keys `(game, pid, battle_revision, battle_state_hash, command)`
and notebook receipt keys `(pid, game, supplied, notebook_sha256)`. Sorted Trace
records bind exact Trace id, role, an opaque HMAC stamp of the complete safe
framework AgentConfig, pid, kind, authoritative join, framework runtime stamp,
carrier flag, and optional fixed notebook diagnostic; the carrier map binds the
designated Trace identities.

Only the seal, common public outcome/binding/runtime/opaque-identity evidence,
and the receiving pid's authorized partition are stored on a Trace. No p1 Trace
contains p2 authoritative commands or notebook receipt hashes, and vice versa.
The manifest and Trace info never include options, teams, constructions, seeds,
logs, headers, tokens, or raw notebooks. Finalization may structurally aggregate
the two private partitions and check exact action/receipt join coverage while
reconstructing the manifest, then authenticates the complete manifest HMAC. No
reward, metric, or episode consumption occurs before that authentication.
Afterward the two designated carriers receive fresh exact reward/metric dicts;
writes use the trusted exact v0.3 `Trace` class methods and roll both carriers
back to fresh empty dicts if any write fails. A fresh TypeScript-bound
`refereeEpisodeId`, not a case id, is consumed only after both carriers are fully
written; the same environment instance cannot reward signed evidence for that
episode twice.

## Task source

`FrozenMatchdayTasksetConfig.source` names a UTF-8 JSON file containing either a
JSON array of rows or JSON Lines (one row per nonempty line). Each row has:

- `case_id`, `condition_digest`, and `expected_config_digest`;
- the exact pinned `showdown_revision`, `format`, `jsonl_protocol_version`,
  `matchday_protocol_version`, and `battle_protocol_version`; and
- an `options` JSON object sealed from `TaskData` and passed to the referee.

The package is deliberately not bundled with matchday rows or constructions.
The source boundary is exact: the resolved absolute source path, raw-byte
SHA-256, row `idx`, and every public field bind retrieval of `options`; `options`
are excluded from `TaskData`, `Trace`, and `RunRequest`, and the exact local v0.3
`EnvServer` reconstruction path is tested.

## Runtime policy

The exact built-in tool-less `null` harness and zero retries are mandatory for
all roles. The three roles must provision distinct runtimes with distinct,
nonempty `runtime.info.id` values and live-process support. This controlled v0
also requires one homogeneous concrete runtime type across all three roles, so
`debug-subprocess` and `distinct-non-subprocess-runtime` are truthful global
labels. A future heterogeneous topology requires an explicit versioned policy
change. The controller starts one `/usr/local/bin/vgc-frozen-matchday-referee`
process in the referee runtime. At finalization each controller runtime-id/type
copy is checked against the entrant or opponent framework Trace runtime id,
type, borrowed flag, pre-rollout identity stamp, nontrainable standing, and null
harness. The referee runtime is live/finally checked because it has no Trace.
Local subprocess runtimes are refused unless `debug_allow_subprocess=true`; that
mode is labeled `debug-subprocess` and makes no isolation or provider claim.

Per-run identity captures are immutable local values, so concurrent episodes do
not share mutable expected identity state. The environment HMAC key, constructor
seals, and consumed referee-episode set live for the environment lifetime. The
trusted-host boundary assumes remote model seats cannot mutate controller
objects. Configuration mutations visible at pre-call, post-provision,
end-of-run, or finalization checks fail closed, but a mutate-and-restore wholly
inside one provider call is outside the contract. The HMAC protects persisted
Trace evidence and historical configuration against later coherent mutation,
copying, and replay; it is not a defense against malicious arbitrary host code
that can read the environment-private HMAC key.

Operators must pin the required runtimes and a source file in their run
configuration. Compiled coverage includes both the direct referee protocol
smoke and a full debug-subprocess lifecycle smoke. The latter invokes the compiled TypeScript
fixture and private task-source freezer, reconstructs its emitted rows through a
real v0.3 `EnvServer`, and runs complete two- and three-game Episodes against a
local scripted OpenAI-compatible chat-completions server. It exercises and
verifies one deterministic local full-Episode/controller/framework/referee-process
path using a scripted endpoint and debug subprocess runtimes. It does **not** prove a real provider or
model, process isolation, Docker or image behavior, Prime VM, Hosted, Hub, or
training compatibility, model quality, or benchmark/ranking validity. No
provider credential is used, and all roles remain nontrainable.

## Development

From a clean repository root, run the complete development sequence in order:

```console
pnpm test
pnpm run test:frozen-matchday-package
pnpm run build:frozen-matchday-package
```

`pnpm test` produces both the root
`dist/tests/fixtures/frozen-matchday.js` fixture and the isolated
`dist-matchday` bundle before the package suite requires its compiled smoke. The
final command performs `uv build --clear`.

For package-only iteration, `uv sync --locked --group test` and
`uv run --locked --group test pytest` are useful, but the compiled-process smoke
is skipped when its required root artifacts are absent unless
`VGC_REQUIRE_COMPILED_SMOKE=1` turns that absence into a failure. Package-only
pytest does not replace the clean-root sequence above.
