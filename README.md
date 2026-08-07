# VGC Model League

VGC Model League is a research harness for language-model decisions in Pokémon
Video Game Championships. Models can draft from a shared board, construct teams,
negotiate trades, choose a bring and lead at team preview, play best-of-three
matches, and review the season. Pokémon Showdown is embedded in the process and
remains the authority for rules, legality, randomness, and results.

The project is a playground and data generator, not a public model ladder. It
records standings, but small and uncontrolled sets of matches do not support a
ranking claim.

## Research design

The repository supports two complementary protocols.

### Controlled battle positions

A completed game can be replayed from its seed, teams, and recorded actions. A
verified position can then be reopened and alternative legal actions simulated.
The current grader estimates short-horizon, reference-relative opportunity loss.
Its reference is deliberately explicit: material value, a uniform distribution
over legal opponent actions, uniform-random continuations, and a fixed Monte
Carlo budget.

That number is a diagnostic, not an oracle for optimal play. It changes when the
reference or compute budget changes, and the estimator is still being validated.
Model comparisons will use a frozen position set and one frozen prompt/tool
scaffold; natural league games are not a benchmark sample.

### Draft-to-battle trajectories

The less duplicated part of the project is the chain above the battle:

```text
shared draft -> team construction -> bring and lead -> battle -> review
```

A model has to make a plan under scarcity, respond to other drafters, turn its
roster into legal sets, select four for a matchup, and then use them. This makes
observable questions possible that a battle-only environment cannot ask:

- Did a declared draft plan appear in the constructed team?
- Did the matchup plan determine the bring and lead?
- Did the named interaction occur in battle?
- Does the review agree with the simulator log?

Simple edges can be checked from structured logs. Semantic claims require a
published rubric, judge agreement checks, and human audit; an explanation is not
proof of a model's private belief.

## What is and is not new

“Language models play Pokémon” and “two agents play doubles” are prior work.
This repository should not reproduce those layers when an existing project can
serve as a baseline or adapter.

- [poke-env](https://github.com/hsahovic/poke-env) provides a Showdown client,
  battle abstractions, teambuilding support, baseline players, and PettingZoo
  environments. It is the default comparison for client-side battle agents.
  This project embeds the simulator instead because counterfactual replay needs
  the authoritative state rather than a state reconstructed from a server
  protocol stream.
- [VGC-Bench](https://arxiv.org/abs/2506.10326) studies trained VGC battle
  policies and population evaluation. Its policies and corpus are relevant
  baselines where their interfaces and licences permit reuse.
- [PokéLLMon](https://arxiv.org/abs/2402.01118) and
  [PokéChamp](https://arxiv.org/abs/2503.04094) build stronger language-model
  battle agents with retrieval, learning, or search. This project instead
  records an unmodified model under a declared scaffold.
- [Prime Intellect verifiers](https://github.com/PrimeIntellect-ai/verifiers)
  supplies tasksets, harnesses, runtimes, traces, multi-agent control flow,
  hosted evaluation, and training integration. The planned adapter will use
  those facilities rather than building another evaluation orchestrator.

The intended contribution is the combined **draft-to-battle protocol** and its
stage-linked evidence, plus a forkable battle diagnostic. The multi-agent API,
the Pokémon battle client, ratings, and generic inference plumbing are not
contributions.

## Prime Intellect integration

The first public artifact will be a small controlled position taskset, used to
validate packaging and scoring. TypeScript will score its legal actions offline;
the native verifiers v1 package can then be a deterministic parse-and-lookup
`Taskset` with no required grading service. The multi-agent artifact will later
expose a complete draft-to-battle episode: drafting is the start of the delayed
decision problem, not a cheap draft-only proxy with an invented reward.

For that dynamic circuit, TypeScript and Pokémon Showdown remain the referee. A
thin Python `Env` will use a versioned local protocol while verifiers owns model
calls, agent traces, runtimes, evaluation, and training integration. The local
league client remains available for interactive runs, but it is not copied into
the adapter.

See [the evaluation plan](docs/evaluation-plan.md) for validation gates and the
package boundary.

## Run locally

Prerequisites: Node.js 24.18, pnpm 11.11, and provider credentials for the models
you select.

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm run vgcleague -- --help
```

Custom pools, favourite models, and one-off tournaments are supported. They are
useful exploratory runs as long as they are reported as such.

## Documentation

- [Usage](docs/usage.md)
- [Measurement principles](docs/measurement.md)
- [Evaluation plan](docs/evaluation-plan.md)
- [Related work](docs/related-work.md)
- [System architecture](docs/architecture.md)
- [Deployment](docs/deployment.md)
