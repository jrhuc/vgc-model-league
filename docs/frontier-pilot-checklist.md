# Frontier strategic pilot checklist

This checklist is the shortest route from the current branch to a decision about
whether the strategic-evaluation program deserves more engineering. It is an
operator protocol, not a benchmark specification.

## 1. Freeze the code and source rule

Use one reviewed commit for the full pilot batch. Do not edit prompts,
controller policies, treatment construction, source selection, or utility after
reading any treatment result.

Choose source team pairs and source seeds before provider calls. Record the
selection rule outside the private result directories. A convenient first
matrix is four distinct team-pair or source-seed cases from an existing pool.
Do not select cases because authentic memory happened to help.

## 2. Build and run one plumbing smoke

```sh
pnpm install --frozen-lockfile
pnpm run setup:showdown
pnpm run build

OPENROUTER_API_KEY=<key> pnpm run strategic-pilot -- \
  --models openrouter:<model-id> \
  --pool test \
  --seed smoke-1 \
  --draws 1 \
  --reasoning high \
  --max-tokens 4096 \
  --out runs/strategic-pilot-smoke-1
```

Prime Inference uses `prime:<model-id>` and `PRIME_API_KEY`. The output path
must be new or empty. A failed run is evidence and should not be overwritten.

The smoke passes only when:

- an authentic notebook is produced as exact JSON;
- both authentic and withheld arms finish without fallback;
- every submitted action joins the frozen referee's accepted action set;
- source, checkpoint, plan, treatment, execution, call, and terminal digests
  validate; and
- prompt, response, token, cost, upstream-provider, and latency evidence are
  present in the private model report.

## 3. Run the first signal matrix

For each preregistered source, run the same two or three frontier models with at
least eight common draws per treatment. Reuse a `source.json` when comparing
models or provider-call replications so every model starts from the exact same
Game 1 evidence.

```sh
OPENROUTER_API_KEY=<key> pnpm run strategic-pilot -- \
  --models openrouter:<model-a> \
  --models openrouter:<model-b> \
  --source runs/source-1/source.json \
  --draws 8 \
  --reasoning high \
  --out runs/source-1/frontier-batch-1
```

Provider APIs do not expose a portable sampling seed. The pilot uses
temperature zero, disables OpenRouter fallback, records the returned upstream,
and rotates arm order. Treat provider-call variation as a replication layer,
not as simulator randomness.

## 4. Aggregate at the source unit

```sh
pnpm run summarize-strategic-pilots -- \
  --out runs/frontier-pilot-aggregate-1.json \
  runs/source-1/frontier-batch-1 \
  runs/source-2/frontier-batch-1 \
  runs/source-3/frontier-batch-1 \
  runs/source-4/frontier-batch-1
```

The aggregator validates every private report join, rejects duplicate report
bytes and copied run evidence, averages repeated provider-call runs within a
source, and computes uncertainty across source means. Fewer than four valid
source clusters is explicitly insufficient. The output is never a ranking.

## 5. Run falsification controls

Construct control files without reading their outcomes:

- **stale:** a real notebook from an earlier incompatible state;
- **false:** plausible but materially incorrect claims and recommendations;
- **placebo:** similar length and style without decision-relevant information;
- **oracle:** accurate privileged information used only as a diagnostic upper
  bound.

```sh
OPENROUTER_API_KEY=<key> pnpm run strategic-pilot -- \
  --models openrouter:<model-id> \
  --source runs/source-1/source.json \
  --draws 8 \
  --treatment stale=controls/source-1-stale.txt \
  --treatment false=controls/source-1-false.txt \
  --treatment placebo=controls/source-1-placebo.txt \
  --treatment oracle=controls/source-1-oracle.txt \
  --out runs/source-1/falsification-1
```

A useful construct should produce more than an authentic-versus-withheld
number. False information should generally be worse than irrelevant placebo,
and oracle information should provide a visible positive upper bound on cases
where information can matter.

## 6. Change the downstream policy

The current runnable pilot uses a fixed first-legal opponent. Treat that only as
a plumbing and initial signal policy. Before extending the benchmark, repeat
the preregistered source matrix with at least one stronger fixed opponent policy
or a declared policy population. A memory effect that exists only against one
pathological continuation is not a strategic capability result.

## 7. Make the go/no-go decision

Proceed to a native strategic-shard package only when all of the following hold
on held-out source clusters:

- at least 95% of outcomes are protocol-valid and legal without fallback;
- authentic memory has a repeatable positive source-cluster effect over
  withholding;
- false memory harms more than placebo and oracle memory gives a sensible upper
  bound;
- the effect survives a changed downstream policy and a fresh provider-call
  batch;
- the result is not explained only by invalid-output rate, ordinary no-memory
  battle strength, or one model family; and
- enough source clusters and replications are affordable.

Stop benchmark work when these checks fail. Keep the working Pokémon harness and
redirect the same replay machinery to one of these directly useful overlays:

1. scouting and coaching reports transferred to a separate player model;
2. deterministic search proposals with a model selecting or critiquing them;
3. draft-plan adherence and productive plan-revision forks; or
4. a replayable expert, model, heuristic, and search disagreement corpus focused
   on failure mechanisms rather than one headline score.

## 8. Work authorized by a positive pilot

A positive pilot authorizes only the next implementation stage:

- unbiased source-corpus selection independent of treatment outcomes;
- stronger opponent and continuation policy populations;
- crossed team, source-policy, model-family, and scaffold holdouts;
- partial-draft option-value and stage-decomposition producers;
- a private native shard environment after the local evidence contract stops
  changing; and
- the full invariance, sensitivity, expert, intervention, holdout, and
  incremental-value release gates.

Do not publish a benchmark ranking from the pilot artifacts.
