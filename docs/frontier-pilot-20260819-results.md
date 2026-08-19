# Frontier pilot batch-1 results — 2026-08-19

Outcome record for the batch preregistered in
[frontier-pilot-20260819-prereg.md](frontier-pilot-20260819-prereg.md). Written
after reading treatment outcomes; nothing here alters the frozen batch-1
identity. Private artifacts live under `runs/frontier-pilot-20260819/`
(unversioned).

## Aggregate

| Model | Valid source clusters | Valid pairs | Mean authentic−withheld (series return) | SE across sources | Cost |
| --- | --- | --- | --- | --- | --- |
| openai/gpt-5.6-sol | 4/4 | 32/32 | +0.0625 | 0.0625 | $7.88 |
| anthropic/claude-sonnet-5 | 2/4 | 2/32 | insufficient | — | $9.73 |

The sol estimate is one source at +0.25 and three at exactly zero: consistent
with no effect at this sample. Readiness labels from the aggregator:
`pilot-estimate-only` (sol) and `insufficient-source-clusters` (sonnet).

## The endpoint was nearly insensitive, not the decisions

Paired arms chose a **different** canonical preview action in 32 of 32 sol
pairs, yet terminal series return differed in only 1 of 32. Under the
first-legal downstream policy, sources 3 and 4 were focal wins on every draw in
both arms and source 1 was a focal loss on every draw in both arms: the
matchup, not the measured decision, determined the endpoint. This is the
degenerate-continuation case the checklist's step 6 anticipates, on the null
side: a flat utility channel cannot falsify or confirm the memory construct.

Within-arm behavior carried the real signal. Across 8 temperature-zero
provider resamples per arm, authentic arms produced 1–3 distinct preview
choices per source while withheld arms produced 6–8. The notebook pinned the
decision; withholding left the model unstable under provider nondeterminism.
Decision convergence is measurable at this shard's price point even where the
series-return channel is saturated.

## Sonnet-5 fails the format contract, not the task

48 of 64 sonnet battle-action calls were protocol-invalid, but 40 of those 48
end in a valid, in-set `{"action_id":"..."}` preceded by prose the
whole-response strict parser rejects. 6 more spent the entire 16384-token cap
on reasoning and returned no text. Qualitatively the prose uses Game 1
evidence (e.g. benching a liability the notebook flagged). As measured, the
strict-JSON contract is a model-family compliance filter that removed one of
two families from the construct entirely — the north-star failure mode of
engineering models into compliance rather than letting them decide.

## Batch-2 implications

1. Rerun with a stronger downstream policy (checklist step 6) before reading
   the sol null as evidence against the construct; prefer sources whose
   first-legal outcome is not constant across arms, or a continuation policy
   with variance.
2. Decide the format contract explicitly: either a declared
   trailing-JSON-tolerant parse revision (new condition identity) or a
   model-side retry, but not silent per-family attrition.
3. Raise or uncap `--max-tokens` headroom above reasoning budgets for
   Anthropic routes.
4. Consider decision convergence across provider resamples as a first-class
   secondary endpoint; it discriminated treatments in this batch when utility
   did not.
