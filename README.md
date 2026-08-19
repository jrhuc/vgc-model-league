# VGC Model League

VGC Model League is a forkable research harness for language-model decisions in
Pokémon Video Game Championships. Models can draft from a shared board, build
teams, negotiate one transaction window, choose a bring and lead, play
best-of-three matches, and review their season.

The embedded, pinned Pokémon Showdown simulator is authoritative for rules,
legality, randomness, state transitions, and results.

## Research questions

The evaluation program now separates three layers:

1. **Information-set battle choices.** Evaluate every accepted action over a
   declared distribution of compatible hidden states, opponent policies,
   continuations, and common random draws. Report utility and regret in game or
   series units rather than treating one realized short-horizon reference as an
   optimal-play label.
2. **Causal strategic interventions.** Fork exact decision histories to test
   whether authentic memory, draft commitments, transactions, construction, or
   schedule information improve later utility while downstream controllers and
   random draws remain fixed.
3. **Ecological circuits.** Run complete leagues and tournaments to validate
   integration, discover failure modes, and test whether controlled findings
   survive long trajectories. Natural standings and championships are not model
   rankings.

The framework-agnostic contracts for replayable decision events, matched forks,
controller identity, information-set priors, reference suites, randomized
model-facing tasks, and best-of-three memory interventions are defined in
[Strategic evaluation kernel](docs/strategic-evals.md).

Implementation and release status can change independently from the measurement
contract. The [Evaluation plan](docs/evaluation-plan.md#program-status) remains
the status inventory until the strategic tracks replace the legacy release
plan. Do not infer release status from the GUI.

## Contribution scope

Prior work covers Pokémon agents, doubles play, simulator search, drafting,
negotiation, and evaluation infrastructure. This project contributes a combined
**draft-to-battle protocol**, exact stage-linked evidence, and matched simulator
forks that can estimate the causal downstream value of strategic information
and commitments.

The project treats
[poke-env](https://github.com/hsahovic/poke-env),
[VGC-Bench](https://arxiv.org/abs/2506.10326), and compatible systems as
external baselines instead of copying generic clients or policies. See
[Related work](docs/related-work.md) for the full claim boundary.

Controlled evaluation packages use
[Prime Intellect verifiers](https://github.com/PrimeIntellect-ai/verifiers) for
model calls, runtimes, traces, and episode control when that adapter fits the
measurement unit. TypeScript and Showdown remain the domain authorities.
[Architecture](docs/architecture.md) defines this boundary.

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

Report custom pools, model sets, scaffolds, and one-off tournaments as
exploratory conditions. See [Usage](docs/usage.md) for commands.

## Documentation

- [Strategic evaluation kernel](docs/strategic-evals.md)
- [Measurement](docs/measurement.md)
- [Evaluation plan](docs/evaluation-plan.md)
- [Architecture](docs/architecture.md)
- [Usage](docs/usage.md)
- [Internal VGC Circuit package](environments/vgc_circuit_v1/README.md)
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
