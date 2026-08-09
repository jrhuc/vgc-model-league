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

Implementation and release status changes independently of the measurement
contract. The [Evaluation plan](docs/evaluation-plan.md#program-status) is the
only status inventory; no other document or GUI page should be read as one.

## Contribution boundary

Pokémon agents, doubles play, simulator search, drafting, negotiation, and
evaluation infrastructure all have prior art. This project targets the combined
**draft-to-battle protocol**, its linked evidence, and a forkable battle
diagnostic. It reuses Pokémon Showdown as referee and treats
[poke-env](https://github.com/hsahovic/poke-env),
[VGC-Bench](https://arxiv.org/abs/2506.10326), and other compatible systems as
external baselines rather than copying generic clients or policies. See
[Related work](docs/related-work.md) for the claim boundary.

Controlled evaluation packages use
[Prime Intellect verifiers](https://github.com/PrimeIntellect-ai/verifiers) for
model calls, runtimes, traces, and episode control while TypeScript and Showdown
remain the domain authorities. [Architecture](docs/architecture.md) owns that
boundary; the [Evaluation plan](docs/evaluation-plan.md#program-status) alone
owns implementation and release status.

## Run locally

Requires Node.js 24.18.1 and pnpm 11.11.0. Executable model specs are exactly
`openrouter:<model-id>`, `prime:<model-id>`, and `random`. Set
`OPENROUTER_API_KEY` or `PRIME_API_KEY` for CLI runs that use that provider; the
GUI accepts the same credentials as run-only browser input.

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
- [Internal frozen matchday package](environments/vgc_frozen_matchday_v0/README.md)
- [Deployment](docs/deployment.md)
- [Trade window](docs/trade-window.md)
- [Season review](docs/season-review.md)
- [Related work](docs/related-work.md)
