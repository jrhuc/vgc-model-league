# Working principles

## North star

This repository exists to answer one open-ended question: how well does a
language model *decide*, when the substrate is a VGC game? It is a playground
for models, not a product. Every line of code serves that question — enable
models to play at their full ability rather than engineering them into
compliance with a constraint.

The unit is the decision, not the match. Who won is one bit that a critical hit
can flip, and it is the part of this any other repository could reproduce.
What cannot be reproduced elsewhere is a forkable simulator grading a choice
against its alternatives, and a season that makes a model commit to a plan in
the draft and then shows whether it ever cashed it out. Standings are
description; they are never the result.

Drift check before building anything: is this solving the play-quality
question, or has it become an engineering problem in its own right (timers,
pacing, budgets, workarounds)? Machinery that shapes *how* a model is allowed
to think muddies the data it was meant to collect. Prefer removing a
constraint over compensating for it, and keep constrained modes (like the
battle timer) opt-in and labeled, never the baseline.

## Code

Agents wrote this code and agents change it. Treat every implementation as
mutable unless it is obviously core functionality. The current code is not
gospel: if a change does not fit the existing design, refactor the design
instead of bolting a workaround on top. When new code makes old code
redundant, delete the old code in the same change — deletion is as important
as addition.

Comments are for constraints the code cannot express, written as `/** doc */`
blocks; `pnpm run check:comments` (part of `pnpm test`) rejects `//` narration.

See `docs/measurement.md` for what the harness may and may not surface to
models, `docs/evaluation-plan.md` for what is being measured and what is being
built next, `docs/architecture.md` for the system design, and `docs/usage.md` for
usage.
