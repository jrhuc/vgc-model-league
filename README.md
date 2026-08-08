# VGC Model League

VGC Model League is a research harness for language-model decisions in Pokémon
Video Game Championships. Models can draft from a shared board, build teams,
negotiate one transaction window, choose a bring and lead, play best-of-three
matches, and review their season. The embedded, pinned Pokémon Showdown simulator
remains authoritative for rules, legality, randomness, state transitions, and
results.

This is a playground and data generator, not a public ladder. Match outcomes and
standings describe one league or bracket; the heterogeneous natural corpus is
never aggregated into a model ranking.

## Research program

The project separates two questions:

1. **Controlled battle positions.** Exact replays can be forked to estimate the
   short-horizon value of alternative Showdown-accepted actions under a declared
   candidate protocol and reference. The current reference uses material value,
   uniform accepted candidate opponent actions, uniform-random continuations,
   and a fixed Monte Carlo budget. These experimental values are
   reference-relative realized-state diagnostics, not labels of optimal play.
2. **Draft-to-battle trajectories.** A model must carry a plan through a scarce
   shared draft, legal construction, bring and lead, battle, and review. Logs can
   test deterministic links such as drafted-to-built or built-to-brought.
   Semantic plan-fidelity claims require a published rubric, agreement checks,
   and human audit; generated explanations are not private beliefs.

The working local league already produces exploratory trajectories and the
TypeScript prototype can replay, fork, and export position panels. No public
position package, validated benchmark, whole-regulation build comparison, or
multi-agent Draft Circuit environment has been released. The current artifact
status and mandatory release gates live in the
[evaluation plan](docs/evaluation-plan.md).

## Contribution boundary

Pokémon agents, doubles play, simulator search, drafting, negotiation, and
evaluation infrastructure all have prior art. This project targets the combined
**draft-to-battle protocol**, its linked evidence, and a forkable battle
diagnostic. It reuses Pokémon Showdown as referee and treats
[poke-env](https://github.com/hsahovic/poke-env),
[VGC-Bench](https://arxiv.org/abs/2506.10326), and other compatible systems as
external baselines rather than copying generic clients or policies. See
[Related work](docs/related-work.md) for the claim boundary.

The planned controlled release path uses
[Prime Intellect verifiers](https://github.com/PrimeIntellect-ai/verifiers).
For static positions, TypeScript exports frozen public tasks and private value
tables; a thin Python `Taskset` will parse one choice and look up its score. A
later dynamic `Env` will drive the same TypeScript/Showdown referee through a
versioned protocol. Verifiers owns model calls, runtimes, traces, evaluation,
and training integration; it never becomes the VGC rules or scoring authority.

## Run locally

Requires Node.js 24.18.1, pnpm 11.11.0, and credentials for selected providers.

```sh
pnpm install --frozen-lockfile
pnpm run setup:showdown
pnpm test
pnpm run vgcleague --help
```

Custom pools, model sets, and one-off tournaments are exploratory conditions and
must be reported as such. See [Usage](docs/usage.md) for commands.

## Documentation

- [Measurement principles](docs/measurement.md)
- [Evaluation plan](docs/evaluation-plan.md)
- [Architecture](docs/architecture.md)
- [Usage](docs/usage.md)
- [Deployment](docs/deployment.md)
- [Trade window](docs/trade-window.md)
- [Season review](docs/season-review.md)
- [Human controls](docs/human-controls.md) (planned official-event source,
  reconstruction, and release protocol)
- [Related work](docs/related-work.md)
