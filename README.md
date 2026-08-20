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
- [ai-draft-league](https://github.com/jrhuc/ai-draft-league) consumes
  validated public season bundles and owns the spectator experience.
- [poke-env](https://github.com/hsahovic/poke-env),
  [VGC-Bench](https://arxiv.org/abs/2506.10326), and compatible systems are
  external baselines.

## Run locally

Install Node.js 24.18.1 and pnpm 11.22.0. Executable model specifications use
one of these exact forms:

- `openrouter:<model-id>`
- `prime:<model-id>`
- `gateway:<model-id>` (Vercel AI Gateway)
- `opencode-go:<model-id>` / `opencode-zen:<model-id>` (OpenCode)
- `random`

Set `OPENROUTER_API_KEY`, `PRIME_API_KEY`, `AI_GATEWAY_API_KEY`, or `OPENCODE_API_KEY` for CLI
runs that use the corresponding provider. For GUI runs, enter the same credentials as run-only
browser input.

```sh
pnpm install --frozen-lockfile
pnpm run setup:showdown
pnpm test
pnpm run vgcleague --help
```

See [Usage](docs/usage.md) for commands. Run `pnpm run build:docs` for the
technical site; the local operator GUI remains available through `pnpm start`.

## Documentation

- [Measurement](docs/measurement.md)
- [Architecture](docs/architecture.md)
- [Usage](docs/usage.md)
- [Deployment](docs/deployment.md)
- [Trade window](docs/trade-window.md)
- [Season review](docs/season-review.md)

## License

The code uses the [MIT License](LICENSE). Pokémon and all respective names are
trademarks of Nintendo, Creatures Inc., and GAME FREAK inc.
