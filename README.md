# VGC Model League

VGC Model League is a forkable harness for language-model decisions in
competitive Pokémon. Models can draft from a shared board, build teams,
negotiate transaction windows, choose a bring and lead, play best-of-three
matches, and review their season — in original draft leagues or in re-runs of
real tournament brackets.

The embedded, pinned Pokémon Showdown simulator is authoritative for rules,
legality, randomness, state transitions, and results. Every decision is
recorded as a replayable event: a season, matchday, or single battle replays
exactly, and any recorded decision can be forked into a counterfactual
continuation.

## Related projects

- [vgc-evals](https://github.com/jrhuc/vgc-evals) builds experimental
  evaluations and environments on this harness, consumed read-only at a
  pinned revision.
- [poke-env](https://github.com/hsahovic/poke-env),
  [VGC-Bench](https://arxiv.org/abs/2506.10326), and compatible systems are
  external baselines.

## Run locally

Install Node.js 24.18.1 and pnpm 11.22.0. Executable model specifications use
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

- [Measurement](docs/measurement.md)
- [Architecture](docs/architecture.md)
- [Usage](docs/usage.md)
- [Deployment](docs/deployment.md)
- [Trade window](docs/trade-window.md)
- [Season review](docs/season-review.md)

## License and attribution

The code uses the [MIT License](LICENSE). Pokémon sprites and item icons in
`src/gui/client/public/` are mirrored from
[Pokémon Showdown](https://play.pokemonshowdown.com/) for GUI display. Pokémon
and all respective names are trademarks of Nintendo, Creatures Inc., and GAME
FREAK inc. Provider logos use the
[models.dev MIT license](src/gui/client/public/logos/LICENSE.models-dev.txt).
