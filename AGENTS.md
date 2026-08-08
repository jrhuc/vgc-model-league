# Working principles

## North star

This repository asks one open-ended question: how well does a language model
*decide* when the substrate is a VGC game? It is a playground for models, not a
product. Enable models to play at their full ability rather than engineering
them into compliance with a constraint.

The unit is the decision, not the match. A critical hit can flip the one-bit
outcome. The distinctive evidence is a forkable simulator grading a choice
against alternatives, and a season that makes a model commit to a draft plan and
shows whether it used that plan. Standings are description, never the result.

Before building, ask whether the work answers the play-quality question or has
become an engineering problem in its own right. Machinery that shapes *how* a
model may think muddies the data. Prefer removing a constraint over compensating
for it. Keep constrained modes, including the battle timer, opt-in and labeled.

## Code

Agents wrote this code and agents change it. Treat implementations as mutable
unless they are core functionality. Refactor a design that no longer fits
instead of adding a workaround, and delete code made redundant by the change.

Comments document constraints the code cannot express. Write them as `/** doc
*/` blocks; `pnpm run check:comments` (part of `pnpm test`) rejects `//`
narration.

Use the canonical docs instead of repeating policy in code or new prose:

- [Measurement](docs/measurement.md): what evidence may mean and what models may see.
- [Evaluation plan](docs/evaluation-plan.md): artifact status, release gates, and next work.
- [Architecture](docs/architecture.md): authority and component boundaries.
- [Usage](docs/usage.md): current commands and operator workflows.
