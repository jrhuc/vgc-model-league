# Position corpus sizing v0

This memo defines the source-game, position, simulator-compute, and source-cost
parameters for `vgc-positions-v1`. It does not authorize pilot or candidate
corpus generation. It freezes the v0 target, per-game cap, excluded-pilot size,
yield rule, and decision not to require source-game mirroring. All other open
preregistration and release gates still apply.

## Current evidence boundary

The current admissible corpus contains **zero** games and **zero** positions.
The legacy inventory contains 184 series and 424 games, but the current corpus
loader rejects every legacy series because it lacks `attempt_id`. The legacy
positions cache also lacks the current manifest and schema. Do not use the
inventory or cache as evidence of current eligibility yield, balance, compute,
or cost.

The selector and exporter use the frozen v0 target of 500 positions and a hard
cap of two selected positions per source game. These values size a bounded
descriptive set. They do not validate its reference, eligibility policy, source
distribution, or use for model ranking.

## Numeric plan

Use these definitions:

- `N`: preregistered number of released evaluation positions.
- `c`: preregistered maximum number of selected positions from one source game.
- `G`: number of preregistered source-game opportunities, successful or failed,
  in the applicable generation schedule.
- `e_g`: number of positions from opportunity `g` that pass the frozen replay
  and per-position eligibility rules before applying `c` or global balance,
  duplicate-group, separation, and isolation rules. Set `e_g = 0` when an
  opportunity exhausts its frozen generation or replay policy.

Calculate the absolute game-count floor as:

```text
G_floor = ceil(N / c).
```

This floor assumes that every generated game supplies `c` usable positions and
that no balance, concentration, duplicate-group, split, or isolation rule
removes a position. For the frozen v0 values, `ceil(500 / 2) = 250`. This is an
arithmetic floor, not a yield estimate or generation authorization.

### Frozen v0 numeric addendum

The initial controlled set freezes:

```text
N = 500 released positions
c = 2 selected positions per source game
G_floor = 250 source games
G_pilot = 60 preregistered source-game opportunities
```

Count a source-game opportunity in the pilot denominator when its complete
model, team, side, seed, scaffold, and source-group assignment is committed to
the immutable pilot schedule, before generation starts. An opportunity that
exhausts the frozen generation or replay policy contributes zero usable
positions. A position that fails grading contributes none. Run only
preregistered retries within the same opportunity, and retain every attempt and
cost. Do not remove failed opportunities from the denominator or replace them
after observing the result. The pilot runner is not implemented. Implement this
accounting before authorizing a pilot.

The target specifies resolution for a descriptive bounded-reward set. For one
model, normalized legal-action reward is in `[0, 1]`. Under the deliberately
optimistic assumption of 500 independent tasks, the two-sided 95% Hoeffding
half-width is `sqrt(log(40) / (2 * 500)) = 0.061`. If tasks within a source game
are perfectly dependent, the two-task cap provides at least 250 game clusters
and a corresponding half-width of `0.086`.

Treat these values as planning sensitivities, not promised confidence intervals.
Fixed generators and teams, source-series and near-duplicate dependence,
stratified selection, measurement error, and an unvalidated source distribution
violate the simple sampling assumption. Pairwise model differences have the
wider range `[-1, 1]`. This design provides neither a minimum detectable ranking
difference nor a rank claim.

Leave-own exclusions can reduce a model's or pairwise comparison's common-task
view below the 500-position release. Reports must identify the effective task
count and must not apply the 500-task sensitivity to that smaller view. Cluster
reports by the frozen source group, show sensitivity to source-series
clustering, and do not divide uncertainty by 500 turns.

The cap of two:

- limits one game's share of the released set to `0.4%`;
- permits both seat views only when all duplicate, balance, and isolation rules
  allow them; and
- raises the arithmetic floor from the former implementation cap of three.

The 60-opportunity excluded pilot estimates only planning yield. For an
independent, bounded per-opportunity contribution in `[0, c]`, calculate the
one-sided 95% Hoeffding-scale deduction as:

```text
delta_pilot = c * sqrt(log(20) / (2 * G_pilot)) = 0.316 positions/game.
```

Sixty is the smallest ten-opportunity increment that puts this deduction below
one third of a position per game when `c = 2`. At the theoretical full yield,
this rule produces `y_L = 1.65` and `G_plan = 304` instead of treating the
arithmetic floor as attainable. This rationale sets planning resolution; it
does not claim that 60 observations can estimate a rare-event rate.

Apply every previously frozen replay, eligibility, duplicate-group, balance,
concentration, separation, and leave-own rule to the excluded pilot. Let
`E_BI,pilot` be the maximum remaining selectable supply, and calculate:

```text
y_BI = E_BI,pilot / G_pilot
y_L  = 0.05 * floor(max(0, y_BI - delta_pilot) / 0.05)
```

The floor ensures that the planning yield does not exceed the constrained
observed yield minus the preregistered bounded-yield deduction. Global maximum
selection couples games, so this is a conservative planning rule, not a
confidence bound for constrained yield. Because `E_BI,pilot` is calculated
after all exclusions, failures and balance or isolation losses directly reduce
`y_L`.

A zero `y_L` fails the planning gate. It does not allow pooled pilots,
replacement of failed opportunities, a lower deduction, or a relaxed corpus
rule. A positive value freezes `G_plan = ceil(500 / y_L)` before candidate
generation. Do not use this pilot to calibrate rare failures, qualification
thresholds, or balance tolerances; it is too small, and those inputs cannot be
selected from it.

For a realized set of source games, calculate capped supply as:

```text
E_cap = sum_g min(c, e_g).
```

Let `E_BI` be the maximum number selectable from that supply while satisfying
all preregistered balance, concentration, duplicate-group, separation, and
leave-own constraints. Report:

```text
D_BI     = E_cap - E_BI
D_target = max(0, N - E_BI).
```

`D_BI` is the balance and isolation loss relative to capped supply. `D_target`
is the remaining target shortfall. A large `E_cap` does not resolve either
shortfall. The current selector uses availability-weighted strata and a hard
per-game cap. It does not apply hard stratum caps or guarantee preregistered
balance.

For the excluded pilot, also report uncensored capped yield:

```text
y_c = (sum_g min(c, e_g)) / G_pilot
```

Report `y_c` with `y_BI`, `delta_pilot`, and the mechanically derived `y_L`. Use
the rule above rather than post-pilot analyst discretion to derive `y_L`. The
planned generation stop must fail closed if the frozen constraints leave
`D_target > 0`. Do not add games, relax a cap, or change a balance rule after
observing the candidate corpus.

## Exhaustive-panel compute

For one position, use these definitions:

- `A`: evaluated seat's Showdown-accepted action count.
- `O`: opponent action population.
- `K`: configured opponent-sample budget.
- `L`: luck replications per opponent slot.
- `S = min(K, O)` for a simultaneous request, or `S = 1` for a unilateral
  request.

The exact simulator-cell counts are:

```text
cells per panel             = A * S * L
cells per three-panel table = 3 * A * S * L
selected grade plus export  = 6 * A * S * L
```

The last line includes the grading pass and selected-position export rerun. Each
pass evaluates the two qualification panels and measurement panel under
separate seed namespaces. With the current implementation defaults, `K = 4`
and `L = 8`. One pass costs `96A` cells when `S = 4` and `24A` cells when `S = 1`.

For grading candidates `Q_grade` and selected exports `Q_export`, sum the
applicable `3 A_q S_q L` term over each pass. Cell count does not measure wall
or CPU time. A cell can continue at horizon 2 with a rollout limit of 60, and
action counts and continuation work vary by phase.

The pilot must record the full distributions, upper tails, and maxima of `A`,
`O`, `S`, cells, CPU time, and wall time. Report team preview separately because
a mean can hide the limiting preview cases. Record failed and retried tables;
do not price only successful cells.

## Source-generation cost

Provider cost is the cost of model calls that generate source games. It is
separate from local simulator panel compute. Do not estimate it from cell count.

For every source-generation call, retain:

- the exact configured generator;
- provider and route;
- stage;
- billable token categories; and
- the provider response's actual `usage.cost`, when present.

Sum observed call costs. Treat missing cost as **unknown**, not zero, and
reconcile the aggregate with provider invoices. If an API does not return cost,
freeze a dated, cited price table before generation. Apply the table only to its
named provider, route, model, and token categories. Distinguish every billed
category exposed by the route, such as input, output, cache read and write, or
reasoning tokens. Do not substitute total tokens without a billing rule.

Do not infer a Prime price from an OpenRouter route or an OpenRouter price from a
Prime route. This memo performs no provider lookup and provides no price or cost
estimate.

## Preregistration and provenance gates

The following table is the gate ledger. A frozen row does not compensate for an
open row. Freeze every remaining design and pilot input before pilot generation.
After the excluded pilot and before candidate generation, apply the
preregistered rule to derive and append numeric `y_L`.

| Input or rule | Required frozen content | Current status |
| --- | --- | --- |
| Evaluation target | `N` and its sample-size/precision rationale | Frozen v0: `N = 500`; bounded-reward resolution only, not ranking power |
| Corpus separation | Disjoint pilot, threshold-calibration, candidate, and held-out evaluation roles; source-group isolation across them | Unknown |
| Source generators | Exact configured model specs for both pids, provider/route identities, versions, and allocation | Unknown |
| Reasoning configuration | Per-generator reasoning mode/budget and any other sampling configuration | Unknown |
| Timer condition | Whether the opt-in battle timer is used and its exact condition | Unknown |
| Team distribution | Eligible team source, version, bundle identity, and allocation | Unknown |
| Matchup design | Allowed model-team matchups, blocks, weights, and exclusions | Unknown |
| Side and seed design | Blocked pid-orientation allocation and independent game-seed namespaces | v0 rule frozen; exact blocks and schedule remain unknown |
| Per-game cap | `c` and rationale | Frozen v0: `c = 2`; shared selector/exporter authority |
| Balance policy | Required balance or tolerances for declared strata and failure behavior on shortfall | Unknown |
| Concentration policy | Ceilings by exact configured spec, exact configured pair, provider/route, team, matchup, and source group | Unknown |
| Leave-own policy | Evaluated-model identity mapping, exclusions, and reporting under leave-own-out evaluation | Unknown |
| Duplicate policy | Exact and near-duplicate definitions, source-group construction, and group-level split rule | Unknown |
| Eligibility policy | Thresholds calibrated on evidence outside the candidate corpus and the frozen review/version | Unknown |
| Pilot exclusion | Pilot identifiers and a rule preventing their games, positions, and source groups from entering the candidate corpus | Unknown |
| Pilot and conservative yield | Pilot size; the estimator/bound and balance/isolation adjustment for `y_L`; then the numeric `y_L` | Design frozen: 60 opportunities and formula above; numeric `y_L` unavailable until an authorized excluded pilot |
| Cost stop | Currency, covered call stages, unknown-cost handling, budget ceiling, and fail-closed stop rule | Unknown |
| Mirror-pair design | Pair definition, schema, swap rule, paired seeds, failure handling, and selection/split behavior | Closed for v0: mandatory pairs not adopted; no pair schema |

The pilot can measure only these planning data:

- the distribution of capped eligibility yield;
- the distributions of own and opponent action counts;
- the distribution of panel cells;
- the distributions of CPU and wall time;
- replay, evaluation, and failure rates; and
- the distributions of source-call token and cost fields.

Do not use it to tune qualification thresholds or other inclusion rules against
candidate outcomes. Calibrate eligibility thresholds with separate evidence
outside the candidate corpus. Exclude pilot games and their duplicate and source
groups from the candidate corpus.

For leave-own-out evaluation, exclude every task for which the evaluated model
was either of the exact configured source generators. Compare identities using the
exact configured spec, not `modelKey` or another collapsed basename or alias.
Independently report and enforce concentration by exact configured spec, exact
configured pair, provider and route, team, matchup, and source group.

### Mirrored source games

Do not treat “mirrored rows” as a single concept. Simultaneous `p1` and `p2` task
rows from one game are two seat views of the same realized game. They do not
swap the source-generating assignments and are not a counterbalanced pair.

Mandatory paired source games are **not adopted for v0**. Replaying the same
configured model and team bundles with swapped pids and related seeds does not
hold the trajectory fixed: generated actions change visited states and RNG
consumption order. This approach would double source-generation exposure and
create a correlated pair, but v0 has no estimand that uses a paired source
outcome. The static evaluation already gives every evaluated model the same
frozen tasks. Source identity remains a private distribution and leave-own and
concentration variable, not the evaluated treatment.

Use a preregistered blocked side allocation for the later source schedule. Within
each unordered exact-generator-plus-team-bundle matchup block, the counts for
the two pid orientations must differ by no more than one. Commit the complete
orientation and independent game-seed namespaces before any source call. A
failed scheduled opportunity contributes zero pilot yield. Do not replace it to
repair realized side balance; the applicable balance gate can fail.

Continue to select and split the corpus using current source-series, source-game,
and calibrated duplicate groups. V0 has no `pair_id`, paired-seed rule,
whole-pair selection rule, or incomplete-pair recovery path.

This design does not support a causal side or battle-policy claim. A future
version can preregister paired source games for a named paired estimand, but it
must define a new source schema, seed rule, group and split semantics, and
failure policy. Do not add a compatibility field to current artifacts for that
purpose.

### Implemented provenance schema gate

The private generator-provenance gate is implemented. The grader and exporter
copy both exact configured specs from the authoritative source record into
`generating_models: {p1, p2}` instead of using acting-seat aliases. The grading
cache uses schema v3. Sealed rows and the candidate manifest use schema v2.
Selection rules use version 3. Strict validators reject old schemas and
malformed or non-pid-keyed generator maps.

Selection does not read generator identity. Public task rows and manifests do
not expose it. No current candidate artifact requires migration.

V0 adds no pair identity. A future paired design must version the source schema
and all dependent artifacts instead of adding an unused optional field.

## Decision status

The v0 target, cap, pilot-yield rule, and non-mirroring decision are frozen. The
program is not ready to run. Source generators, teams, allocation blocks,
eligibility and balance policy, cost stop, pilot runner and accounting, and the
other gate-ledger entries remain open. Do not run a pilot until these inputs
pass review and receive explicit resource approval. A later excluded pilot can
mechanically populate `y_L` and the planning distributions. It cannot authorize
release or pass the release gates in the
[evaluation plan](evaluation-plan.md).
