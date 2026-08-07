# Working principles

## Research target

This repository studies how language models make and carry out decisions in
VGC. It has three roles:

1. the league records trajectories across drafting, team construction, trades,
   team preview, battles, and review;
2. the simulator replays and forks battle states for controlled diagnostics;
3. published environment adapters let other people run the same protocols on
   their own models and infrastructure.

A match result is evidence, but a small collection of wins is not a model
ranking. Comparisons between models require the same tasks and scaffold.
Counterfactual scores are always relative to their stated value function,
horizon, opponent policy, and sampling budget; do not present them as optimal
VGC play.

Before adding machinery, ask whether it improves the research protocol or only
constrains how a model can participate. The untimed, unmodified model is the
baseline. Timers, recursive harnesses, search policies, and other scaffolds are
separate, labelled conditions.

## Code

Treat every implementation as replaceable except the core rules boundary:
Pokémon Showdown decides legality and battle outcomes. Prefer one shared
referee over mode-specific copies. Delete superseded paths rather than keeping
parallel implementations.

Comments are for constraints the code cannot express, written as `/** doc */`
blocks. `pnpm run check:comments`, included in `pnpm test`, rejects `//`
narration.

Read:

- `docs/measurement.md` for measurement and reporting rules;
- `docs/evaluation-plan.md` for status, validation gates, and future work;
- `docs/architecture.md` for system boundaries;
- `docs/usage.md` for commands.
