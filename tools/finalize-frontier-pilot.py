from pathlib import Path


def insert_before(path: str, marker: str, addition: str) -> None:
    file = Path(path)
    text = file.read_text()
    if addition.strip() in text:
        raise RuntimeError(f"{path}: frontier pilot documentation already exists")
    if text.count(marker) != 1:
        raise RuntimeError(f"{path}: expected one insertion marker, found {text.count(marker)}")
    file.write_text(text.replace(marker, addition + marker, 1))


insert_before(
    "docs/usage.md",
    "### Resume a tournament\n",
    """### Run the frontier strategic pilot

Build once, then call an actual OpenRouter or Prime model through the same
provider layer used by the working Pokémon harness:

```sh
pnpm run build

OPENROUTER_API_KEY=<key> pnpm run strategic-pilot -- \\
  --models openrouter:<model-id> \\
  --pool test \\
  --draws 4 \\
  --reasoning high \\
  --out runs/strategic-pilot-smoke
```

Repeat `--models` to run the same source and common draws for multiple models.
Use `prime:<model-id>` with `PRIME_API_KEY` for Prime Inference. The command
rejects `random`: this pilot is specifically the real-provider seam. Run
`pnpm run strategic-pilot -- --help` for every option.

The v1 pilot is deliberately narrow. It constructs one deterministic source
matchday from two committed pool teams, finishes that source with the first
Showdown-accepted action policy, and verifies a checkpoint after Game 1. The
frontier model writes private between-game notebook bytes from only its
seat-authorized Game 1 history and the open team sheets. The same model then
plays the remaining matched continuations under two arms:

- **authentic:** inject the model-written notebook;
- **withheld:** inject empty notebook bytes.

The opposing seat uses a fixed first-legal policy. Future battle seeds are
common across arms, downstream controller identity is held fixed, arm order is
rotated by draw, invalid model output receives no fallback utility, and every
prompt, response, reasoning trace, usage value, reported cost, treatment,
checkpoint, plan, execution, and terminal artifact is content-addressed.

Provider APIs do not expose a portable sampling seed. The command therefore
uses temperature zero, disables OpenRouter fallback, records the returned
upstream provider, balances arm order, and labels residual provider randomness
instead of claiming exact model-call reproducibility. Reuse the exact source in
another run with:

```sh
pnpm run strategic-pilot -- \\
  --models openrouter:<model-id> \\
  --source runs/strategic-pilot-smoke/source.json \\
  --draws 8 \\
  --out runs/strategic-pilot-confirmation
```

Add preregistered negative and upper-bound controls with exact notebook files:

```sh
pnpm run strategic-pilot -- \\
  --models openrouter:<model-id> \\
  --source <source.json> \\
  --treatment stale=<stale.txt> \\
  --treatment false=<false.txt> \\
  --treatment placebo=<placebo.txt> \\
  --treatment oracle=<oracle.txt>
```

The output directory is private evidence. `source.json` contains exact private
source evidence; each model JSON contains prompts and raw provider responses;
`summary.json` is only a batch index. Do not publish these files through the
static-site exporter. One team pair is one uncertainty cluster, so one command
can establish plumbing and discover gross effects but cannot support a model
ranking.

Use this sequence before expanding the benchmark:

1. **Smoke:** one frontier model, one source, one draw. Require a complete run,
   strict JSON, accepted legal commands, and joined terminal evidence.
2. **Signal check:** two or three materially different frontier models, at
   least four independently chosen team-pair/source clusters, and at least
   eight common draws per arm. Keep prompts and controller policies frozen.
3. **Falsification:** add stale, false, placebo, and oracle notebooks. Authentic
   memory should beat withholding in the intended cases; false memory should
   harm more than placebo; oracle information should provide a visible upper
   bound.
4. **Replication:** rerun the preregistered sources under a new provider-call
   batch and require the direction of the source-cluster effect to survive.
5. **Only then scale:** build unbiased source selection, stronger fixed policy
   populations, and a native shard package.

Stop investing in this evaluation layer if protocol-valid and legal completion
is below 95%, authentic versus withheld has no stable source-cluster signal,
false information is not detectably worse than irrelevant information, effects
collapse under a second downstream policy, or provider cost makes the required
replication impractical. In that case the existing Pokémon harness remains the
product, and the most useful additions are likely model coaching/scouting
experiments, search-versus-model action proposals, draft-plan adherence forks,
or a curated expert disagreement and failure-mode corpus rather than another
headline benchmark.

""",
)

insert_before(
    "docs/evaluation-plan.md",
    "## Legacy diagnostic: `vgc-positions-v1`\n",
    """## Frontier-model validation milestone

The branch now includes a private, real-provider pilot command:

```sh
pnpm run build
OPENROUTER_API_KEY=<key> pnpm run strategic-pilot -- \\
  --models openrouter:<model-id> --pool test --draws 4 --reasoning high
```

This is the shortest path from the framework contracts to evidence that can
invalidate the research direction. It is not a benchmark package. One run
binds one deterministic Game 1 source, a verified between-game checkpoint, a
model-written authentic notebook, a withheld control, fixed downstream policy
identities, common future draws, and private provider-call evidence. The focal
frontier model plays the continuation; the opponent is a fixed first-legal
Showdown policy. The output reports protocol validity, legality, series return,
matched contrasts, prompts, responses, usage, cost, and all joining digests.

### Pilot matrix

Run the following stages in order and retain failed runs rather than silently
repairing them:

1. one-model/one-source/one-draw plumbing smoke;
2. two or three current frontier models across at least four independently
   selected source team pairs, with at least eight common draws per treatment;
3. authentic, withheld, stale, false, placebo, and oracle memory arms on the
   same sources;
4. a second fixed downstream opponent policy or policy population;
5. a fresh provider-call replication batch with unchanged source and fork
   identities.

Use source-team selection and intervention construction rules fixed before
reading treatment outcomes. Cluster uncertainty at the source case, never at
the individual future seed. Provider temperature is zero and OpenRouter
fallback is disabled, but provider calls do not expose a portable random seed;
record this residual randomness and balance arm execution order.

### Go/no-go criteria

Continue toward a public strategic-shard package only when all of these are
true on held-out source clusters:

- at least 95% of outcomes are protocol-valid and legal without fallback;
- authentic memory has a repeatable positive effect over withholding in cases
  selected without treatment outcomes;
- false memory harms more than placebo and oracle information gives a sensible
  positive upper bound;
- the effect survives at least one changed downstream opponent policy and a
  fresh provider-call batch;
- the measured difference is not explained only by invalid-output rate, model
  identity, or ordinary no-memory battle win rate; and
- the cost of enough independent source clusters and replications is practical.

Stop the benchmark work if these checks fail. Retain the already working
Pokémon harness and redirect effort to one of four directly useful overlays:

1. **Scouting and coaching:** measure whether model-written opponent reports or
   post-series reviews help a later, separate player model, including adversarial
   stale and false reports.
2. **Search/model hybrids:** let deterministic search or rollouts propose a
   small legal set, then measure whether a frontier model adds value in selecting
   or explaining the proposal without making search the hidden answer key.
3. **Draft-plan adherence:** fork draft picks, transactions, and matchup builds
   while measuring whether the model follows or productively revises its own
   earlier plan.
4. **Failure-mode corpus:** curate exact replayable positions where frontier
   models, heuristics, search, and blinded experts disagree, then study the
   mechanics, information, and planning error rather than publishing one score.

### Work after a positive pilot

A positive pilot authorizes implementation, not publication. The next code
milestones are:

- source-corpus selection independent of treatment outcomes;
- model/runtime controller support beyond the local provider adapter;
- fixed opponent and continuation policy populations rather than one first-legal
  policy;
- crossed team, source-policy, model-family, and scaffold holdouts;
- partial-draft option-value and stage-decomposition producers;
- a native private shard package only after the local evidence contract is
  stable; and
- known-intervention, expert, invariance, sensitivity, and incremental-value
  release gates from `strategic-evals.md`.

""",
)

insert_before(
    "docs/strategic-evals.md",
    "## Migration sequence\n",
    """## Runnable frontier-model pilot

`tools/run-strategic-pilot.ts` is the first real-provider seam for this kernel.
It reuses the repository's OpenRouter and Prime adapters rather than creating a
new model runtime. A deterministic first-legal source policy completes one
matchday, the adapter verifies the source and checkpoints after Game 1, and the
frontier model writes exact private notebook bytes. Authentic and withheld arms
then continue under the same focal model, fixed opponent policy, controller
identity, and common future battle seeds.

The command records whole-response strict JSON parsing, legal-action joins,
provider reasoning text when returned, token usage, reported cost, upstream
provider, treatment bytes, fork execution identities, and terminal evidence.
No rejected response receives a random or deterministic fallback utility. A
single run is one source cluster and cannot be interpreted as a ranking.

The pilot is a falsification milestone. Expand the evaluation only if authentic
memory beats withholding on independently selected source clusters, false
memory is worse than placebo, oracle memory supplies a sensible upper bound,
and the signal survives a changed downstream policy and a fresh provider-call
batch. Otherwise retain the Pokémon harness and redirect the simulator forks to
coaching/scouting, search/model hybrid, draft-plan adherence, or expert
failure-mode studies.

""",
)
