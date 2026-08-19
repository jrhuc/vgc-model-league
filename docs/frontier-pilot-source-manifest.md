# Frontier pilot source preregistration manifest

Freeze this manifest before any provider call or treatment outcome. Store the
completed copy outside generated `runs/` directories so source selection cannot
be rewritten while preserving the private result tree.

## Reviewed code condition

```text
repository: jrhuc/vgc-model-league
branch: agent/strategic-evals-refactor
commit: <reviewed commit SHA>
frontier pilot protocol: 2
matchday checkpoint protocol: 2
utility: series-return
focal model decisions: 1
focal downstream policy: first-showdown-accepted-action-v1
opponent policy: first-showdown-accepted-action-v1
```

Changing the focal decision budget, downstream policy, opponent policy, prompt,
model routing, treatment construction, or utility creates a different condition
and must not be pooled silently.

## Source selection rule

Write the rule before listing individual cases. It should be reproducible from
committed pool data and must not use authentic, withheld, false, placebo, or
oracle outcomes.

```text
pool: <pool id>
selection population: <all eligible ordered team pairs and source seeds>
selection seed: <seed>
number of source clusters: <at least 4 for the first signal check>
exclusions fixed in advance: <structural exclusions only>
side counterbalancing: <rule for reversed focal/opponent assignments>
```

## Cases

| Case | Pool | Focal team | Opponent team | Source seed | Focal side | Selection reason fixed before outcomes |
| --- | --- | --- | --- | --- | --- | --- |
| source-1 |  |  |  |  | p1 |  |
| source-2 |  |  |  |  | p1 |  |
| source-3 |  |  |  |  | p1 |  |
| source-4 |  |  |  |  | p1 |  |

Prepare every case before provider calls:

```sh
pnpm run strategic-pilot \
  --prepare-source-only \
  --pool <pool> \
  --focal-team <focal-team> \
  --opponent-team <opponent-team> \
  --seed <source-seed> \
  --out runs/<case>
```

Record the emitted `sourceArtifactDigest` beside each case. Reusing the exact
`source.json` is required for model comparisons and provider-call replications.

## Model and provider conditions

| Condition | Model spec | Reasoning | Routing/upstream rule | Max tokens | Timeout | Provider-call batch |
| --- | --- | --- | --- | --- | --- | --- |
| model-a |  |  | fallback disabled |  |  | batch-1 |
| model-b |  |  | fallback disabled |  |  | batch-1 |

Provider APIs do not expose a portable model-sampling seed. Use temperature
zero, retain the returned upstream provider, rotate arm order, and treat a fresh
provider-call batch as a replication rather than simulator randomness.

## Treatment files

| Treatment | Construction rule fixed before outcomes | File/digest |
| --- | --- | --- |
| authentic | focal model writes from its bound Game 1 POV and open sheets | generated per model/source |
| withheld | exact empty notebook | protocol constant |
| stale | real notebook from a fixed incompatible earlier state |  |
| false | plausible but materially incorrect claims and recommendations |  |
| placebo | matched style/length without decision-relevant information |  |
| oracle | accurate privileged diagnostic upper bound |  |

Do not edit a control file after reading any arm result. A byte change creates a
new treatment identity.

## Staged decision budgets

Run these as separate conditions, not as extra replications of one condition:

1. `--model-decisions 1`: first non-forced Game 2 choice, normally preview;
2. `--model-decisions 4`: short intervention chain;
3. `--model-decisions all`: ecological focal policy through the remaining
   series.

The one-decision condition is the primary go/no-go shard because it is cheapest
and most attributable. A signal visible only in `all` is weaker evidence and
may reflect an endogenous policy cascade or provider-call accumulation.

## Analysis commitment

Aggregate with:

```sh
pnpm run summarize-strategic-pilots \
  --out runs/frontier-pilot-aggregate.json \
  runs/source-1/<batch> \
  runs/source-2/<batch> \
  runs/source-3/<batch> \
  runs/source-4/<batch>
```

Average repeated provider-call runs inside source first, then compute
uncertainty across source-cluster means. Do not treat future battle seeds or
individual model calls as independent source units. Fewer than four valid
source clusters remains insufficient evidence.

## Go/no-go decision

Proceed only if protocol-valid and legal completion is at least 95%, authentic
memory has a repeatable positive source-cluster effect, false memory harms more
than placebo, oracle memory supplies a sensible upper bound, and the direction
survives both a changed downstream policy and a fresh provider-call batch.

Otherwise retain the existing Pokémon harness and redirect the replay/fork
machinery to scouting/coaching transfer, search/model hybrids, draft-plan
adherence, or a replayable expert/model/search disagreement corpus.
