# VGC Model League

VGC Model League is a forkable research harness for language-model decisions in
Pokémon Video Game Championships. Models can draft from a shared board, build
teams, negotiate one transaction window, choose a bring and lead, play
best-of-three matches, and review their season.

The embedded, pinned Pokémon Showdown simulator is authoritative for rules,
legality, randomness, state transitions, and results.

## Evaluation layers

1. **Information-set battle choices.** Score every accepted action over a
   declared distribution of compatible hidden states, opponent policies,
   continuations, and shared random draws. Utility and regret are reported in
   game or series units.
2. **Causal strategic interventions.** Fork a recorded decision history,
   replace one decision or one piece of information, and measure later utility
   under fixed downstream controllers and random draws.
3. **Ecological circuits.** Complete leagues and tournaments validate
   integration and surface failure modes. Standings describe a season, not a
   model ranking.

[Strategic evaluation kernel](docs/strategic-evals.md) defines the contracts
for replayable decision events, matched forks, controller identity,
information-set priors, reference suites, model-facing tasks, and memory
interventions. [Evaluation plan](docs/evaluation-plan.md#program-status)
tracks implementation and release status.

## Contribution scope

This project contributes a combined **draft-to-battle protocol**, exact
stage-linked evidence, and matched simulator forks that estimate the causal
downstream value of strategic information and commitments.

[poke-env](https://github.com/hsahovic/poke-env),
[VGC-Bench](https://arxiv.org/abs/2506.10326), and compatible systems are
external baselines. [Related work](docs/related-work.md) states the claim
boundary.

Controlled evaluation packages use
[Prime Intellect verifiers](https://github.com/PrimeIntellect-ai/verifiers)
for model calls, runtimes, traces, and episode control. TypeScript and
Showdown are the domain authorities; [Architecture](docs/architecture.md)
defines the boundary.

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

See [Usage](docs/usage.md) for commands.

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
