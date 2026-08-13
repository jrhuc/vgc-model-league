# VGC Model League

VGC Model League evaluates language-model decisions in Pokémon Video Game
Championships. Models draft from a shared board, build teams, negotiate one
transaction window, choose a bring and lead, play best-of-three matches, and
review their season.

The embedded, pinned Pokémon Showdown simulator is authoritative for rules,
legality, randomness, state transitions, and results.

## Research questions

The project addresses two questions:

1. **Controlled battle positions.** Fork exact replays to estimate the
   short-horizon value of alternative Showdown-accepted actions under a declared
   candidate protocol and reference. The current reference uses material value,
   uniform accepted candidate opponent actions, uniform-random continuations,
   and a fixed Monte Carlo budget. These experimental values are
   reference-relative realized-state diagnostics, not optimal-play labels.
2. **Draft-to-battle trajectories.** Require a model to carry a plan through a
   scarce shared draft, legal construction, bring and lead, battle, and review.
   Logs support deterministic links such as drafted-to-built and
   built-to-brought. Semantic plan-fidelity claims require a published rubric,
   agreement checks, and human audit. Generated explanations do not provide
   direct evidence of private beliefs.

Implementation and release status can change independently from the measurement
contract. The [Evaluation plan](docs/evaluation-plan.md#program-status) is the
only status inventory. Do not infer status from other documentation or the GUI.

## Contribution scope

Prior work covers Pokémon agents, doubles play, simulator search, drafting,
negotiation, and evaluation infrastructure. This project contributes a combined
**draft-to-battle protocol**, linked evidence across its stages, and a forkable
battle diagnostic.

The project treats
[poke-env](https://github.com/hsahovic/poke-env),
[VGC-Bench](https://arxiv.org/abs/2506.10326), and compatible systems as
external baselines instead of copying generic clients or policies. See
[Related work](docs/related-work.md) for the full claim boundary.

Controlled evaluation packages use
[Prime Intellect verifiers](https://github.com/PrimeIntellect-ai/verifiers) for
model calls, runtimes, traces, and episode control. TypeScript and Showdown
remain the domain authorities. [Architecture](docs/architecture.md) defines this
boundary.

## Run locally

Install Node.js 24.18.1 and pnpm 11.11.0. Executable model specifications use
one of these exact forms:

- `openrouter:<model-id>`
- `prime:<model-id>`
- `random`

Set `OPENROUTER_API_KEY` or `PRIME_API_KEY` for CLI runs that use the
corresponding provider. For GUI runs, enter the same credentials as run-only
browser input.

```sh
pnpm install --frozen-lockfile
pnpm run setup:showdown
pnpm test
pnpm run vgcleague --help
```

Report custom pools, model sets, and one-off tournaments as exploratory
conditions. See [Usage](docs/usage.md) for commands.

## Documentation

- [Measurement](docs/measurement.md)
- [Evaluation plan](docs/evaluation-plan.md)
- [Architecture](docs/architecture.md)
- [Usage](docs/usage.md)
- [Internal Draft Circuit package](environments/vgc_draft_circuit_v1/README.md)
- [Deployment](docs/deployment.md)
- [Trade window](docs/trade-window.md)
- [Season review](docs/season-review.md)
- [Related work](docs/related-work.md)

## License and attribution

The code uses the [MIT License](LICENSE). Pokémon sprites and item icons in
`src/gui/client/public/` are mirrored from
[Pokémon Showdown](https://play.pokemonshowdown.com/) for GUI display. Pokémon
and all respective names are trademarks of Nintendo, Creatures Inc., and GAME
FREAK inc. Provider logos use the
[models.dev MIT license](src/gui/client/public/logos/LICENSE.models-dev.txt).
