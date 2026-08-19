# Frontier pilot preregistration — 2026-08-19 batch-1

Completed copy of the source preregistration manifest, frozen before any
provider call. The blank template is
[frontier-pilot-source-manifest.md](frontier-pilot-source-manifest.md).

## Reviewed code condition

```text
repository: jrhuc/vgc-model-league
branch: agent/strategic-evals-refactor
commit: 183a99ea7d6dc76813a9a2134bf55b5c163c92c5
frontier pilot protocol: 2
matchday checkpoint protocol: 2
utility: series-return
focal model decisions: 1
focal downstream policy: first-showdown-accepted-action-v1
opponent policy: first-showdown-accepted-action-v1
```

## Source selection rule

```text
pool: vr-aug26-top8
selection population: the pool's eight teams in committed placement order
selection seed: source-1 through source-4 (fixed literal seeds)
number of source clusters: 4
exclusions fixed in advance: adjacent-placement pairing is excluded because
  1st/2nd share a Raichu/Staraptor core and 4th/5th share a
  Charizard/Floette core; near-mirror sources confound notebook value with
  mirror-specific structure. Pairing is top half versus bottom half by
  placement: case k pairs team k with team k+4.
side counterbalancing: focal is always the higher placement and always p1;
  reversed-side replication is deferred to a later crossed condition rather
  than mixed into this four-cluster batch.
```

## Cases

| Case | Pool | Focal team | Opponent team | Source seed | Focal side | Selection reason fixed before outcomes |
| --- | --- | --- | --- | --- | --- | --- |
| source-1 | vr-aug26-top8 | 1st-ogushi-raichu-staraptor | 5th-koh-charizard-floette | source-1 | p1 | placement k vs k+4 rule |
| source-2 | vr-aug26-top8 | 2nd-kaieda-raichu-staraptor | 6th-markl-floette-sneasler | source-2 | p1 | placement k vs k+4 rule |
| source-3 | vr-aug26-top8 | 3rd-zuniga-froslass-scovillain | 7th-alarcon-delphox-blastoise | source-3 | p1 | placement k vs k+4 rule |
| source-4 | vr-aug26-top8 | 4th-yang-charizard-floette | 8th-endo-gengar-swampert | source-4 | p1 | placement k vs k+4 rule |

Source artifact digests are recorded beside each case after
`--prepare-source-only` and before any provider call:

| Case | sourceArtifactDigest |
| --- | --- |
| source-1 | d7cfb073bdfeacf07cf663018b3cde1f797224eb8697f690b1adc87a2f049bc9 |
| source-2 | 01904128b92dab70a0ed03297040cc3acf5a15c2aaab2a4c0fd63abcd0faa462 |
| source-3 | 9773dc539b239049dc7e2d4fa335e5c52aab27fe2b03fb9234b9fd3ef09bab20 |
| source-4 | 8cc068ccae2d8aa20baa5560b8cb5d7264c64aa1969f994bece57a43b1b7a963 |

## Model and provider conditions

| Condition | Model spec | Reasoning | Routing/upstream rule | Max tokens | Timeout | Provider-call batch |
| --- | --- | --- | --- | --- | --- | --- |
| model-a | openrouter:openai/gpt-5.6-sol | high | fallback disabled | 16384 | 600s | batch-1 |
| model-b | openrouter:anthropic/claude-sonnet-5 | high | fallback disabled | 16384 | 600s | batch-1 |

Both models run against every source with eight common draws per treatment,
`--model-decisions 1`, temperature zero, rotated arm order.

## Treatment files

Batch-1 runs authentic versus withheld only. Stale, false, placebo, and
oracle control files are not constructed in this batch; they are authorized as
a follow-up only after batch-1 outcomes are read, and therefore form a new
condition identity rather than a pooled extension of this batch.

## Staged decision budgets

Batch-1 runs only `--model-decisions 1`. Short-chain and full-policy budgets
are separate later conditions.

## Analysis commitment

Aggregate with `summarize-strategic-pilots` over the four batch-1
directories. Average repeated provider-call runs inside source first, then
compute uncertainty across source-cluster means. Fewer than four valid source
clusters is insufficient evidence. No ranking is produced.
