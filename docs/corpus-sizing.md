# Position corpus sizing v0

This memo parameterizes source-game, position, simulator-compute, and source-cost
requirements for `vgc-positions-v1`. It is a planning equation, not a numeric
sample-size justification or permission to generate a pilot or candidate corpus.
The numeric addendum and design gates below remain open.

## Current evidence boundary

The strict current admissible corpus contains **zero** games and **zero**
positions. The legacy inventory has 184 series and 424 games, but every legacy
series lacks `attempt_id` and is rejected by the current corpus loader. The
legacy positions cache also lacks the current manifest and schema. Neither the
inventory nor that cache is evidence about current eligibility yield, balance,
compute, or cost.

The software currently defaults to a requested position count of 500 and a
per-game cap of 3. Those are implementation defaults, not benchmark-design
choices. No target or cap is preregistered.

## Numeric plan

Let:

- `N` be the preregistered number of released evaluation positions;
- `c` be the preregistered maximum selected positions from one source game;
- `e_g` be the number of positions observed in source game `g` that pass the
  frozen replay and per-position eligibility rules, before applying `c` or
  global balance, duplicate-group, separation, and isolation rules.

The absolute game-count floor is

```text
G_floor = ceil(N / c).
```

It assumes every generated game supplies `c` usable positions and that no
balance, concentration, duplicate-group, split, or isolation rule removes one.
For the current software defaults only, `ceil(500 / 3) = 167`; 167 is an
arithmetic lower bound, not a recommendation or a yield estimate.

For a realized set of source games, capped supply is

```text
E_cap = sum_g min(c, e_g).
```

Let `E_BI` be the maximum number selectable from that supply while satisfying
all preregistered balance, concentration, duplicate-group, separation, and
leave-own constraints. Report both

```text
D_BI     = E_cap - E_BI
D_target = max(0, N - E_BI).
```

`D_BI` is the balance/isolation loss relative to capped supply; `D_target` is
the remaining target shortfall. A large `E_cap` does not cure either shortfall.
The current selector uses availability-weighted strata and a hard per-game cap;
it does **not** impose hard stratum caps or guarantee a preregistered balance.

On an excluded pilot of `G_pilot` games, estimate capped yield as

```text
y_c = (sum_g min(c, e_g)) / G_pilot.
```

Before candidate generation, freeze a conservative positive planning yield
`y_L`, including its derivation from the pilot and its treatment of failures and
balance/isolation losses. Then

```text
G_plan = ceil(N / y_L).
```

The planned generation stop must still fail closed if the frozen constraints
leave `D_target > 0`; it must not relax a cap or balance rule after seeing the
candidate corpus.

## Exhaustive-panel compute

For one position, define:

- `A`: evaluated seat's Showdown-accepted action count;
- `O`: opponent action population;
- `K`: configured opponent-sample budget;
- `L`: luck replications per opponent slot;
- `S = min(K, O)` for a simultaneous request, and `S = 1` for a unilateral
  request.

The exact simulator-cell counts are

```text
cells per panel             = A * S * L
cells per three-panel table = 3 * A * S * L
selected grade plus export  = 6 * A * S * L
```

The last line includes the grading pass and the selected-position export rerun,
each of which evaluates the two qualification panels and the measurement panel
under separate seed namespaces. With the current implementation defaults
`K = 4` and `L = 8`, one pass costs `96A` cells when `S = 4` and `24A` cells
when `S = 1`.

For a set of grading candidates `Q_grade` and selected exports `Q_export`, the
cell plan is the sum of the applicable `3 A_q S_q L` term over each pass. Cell
count is not wall time or CPU time. A cell can continue at horizon 2 with a
rollout limit of 60, and action counts and continuation work vary by phase. The
pilot must record the full distributions, upper tails, and maxima of `A`, `O`,
`S`, cells, CPU time, and wall time, with team preview reported separately; a
mean alone can hide the limiting preview cases. It must also record failed and
retried tables rather than pricing only successful cells.

## Source-generation cost

Provider cost here means the cost of model calls used to generate source games.
It is separate from local simulator panel compute and must not be estimated from
cell count.

For every source-generation call, retain the exact configured generator,
provider and route, stage, billable token categories, and the provider response's
actual `usage.cost` when present. Sum observed call costs, but treat a missing
cost as **unknown**, never zero, and reconcile the aggregate against provider
invoices. If an API does not return cost, freeze a dated, cited price table before
generation and apply it only to its named provider, route, model, and token
categories. The table must distinguish every billed category exposed by that
route, such as input, output, cache read/write, or reasoning tokens, rather than
substituting total tokens without a billing rule.

No Prime price may be inferred from an OpenRouter route or vice versa. This memo
performs no provider lookup and supplies no price or cost estimate.

## Preregistration and provenance gates

Every value in this table is currently unknown or unfrozen. A reviewed
pre-pilot addendum must freeze every design and pilot input before pilot
generation. It must also freeze the rule for deriving `y_L`; the resulting
numeric `y_L` is appended after the excluded pilot and before candidate
generation.

| Input or rule | Required frozen content | Current status |
| --- | --- | --- |
| Evaluation target | `N` and its sample-size/precision rationale | Unknown |
| Corpus separation | Disjoint pilot, threshold-calibration, candidate, and held-out evaluation roles; source-group isolation across them | Unknown |
| Source generators | Exact configured model specs for both pids, provider/route identities, versions, and allocation | Unknown |
| Reasoning configuration | Per-generator reasoning mode/budget and any other sampling configuration | Unknown |
| Timer condition | Whether the opt-in battle timer is used and its exact condition | Unknown |
| Team distribution | Eligible team source, version, bundle identity, and allocation | Unknown |
| Matchup design | Allowed model-team matchups, blocks, weights, and exclusions | Unknown |
| Side and seed design | Pid allocation, battle-side counterbalance, seed namespaces, and paired-seed rule | Unknown |
| Per-game cap | `c` and rationale | Unknown |
| Balance policy | Required balance or tolerances for declared strata and failure behavior on shortfall | Unknown |
| Concentration policy | Ceilings by exact configured spec, exact configured pair, provider/route, team, matchup, and source group | Unknown |
| Leave-own policy | Evaluated-model identity mapping, exclusions, and reporting under leave-own-out evaluation | Unknown |
| Duplicate policy | Exact and near-duplicate definitions, source-group construction, and group-level split rule | Unknown |
| Eligibility policy | Thresholds calibrated on evidence outside the candidate corpus and the frozen review/version | Unknown |
| Pilot exclusion | Pilot identifiers and a rule preventing their games, positions, and source groups from entering the candidate corpus | Unknown |
| Pilot and conservative yield | Pilot size; the estimator/bound and balance/isolation adjustment for `y_L`; then the numeric `y_L` | Unknown |
| Cost stop | Currency, covered call stages, unknown-cost handling, budget ceiling, and fail-closed stop rule | Unknown |
| Mirror-pair design | Pair definition, schema, swap rule, paired seeds, failure handling, and selection/split behavior | Unknown |

The pilot may learn only the distributions of capped eligibility yield, own and
opponent action counts, panel cells, CPU and wall time, replay/evaluation/failure
rates, and source-call token and cost fields. It may not tune qualification
thresholds or other inclusion rules against candidate outcomes. Eligibility
thresholds require separate calibration evidence outside the candidate corpus.
Pilot games and their duplicate/source groups remain excluded from the candidate
corpus.

Leave-own-out evaluation must exclude every task whose evaluated model was
either exact configured source generator. Identity comparisons use the exact
configured spec, not `modelKey` or another basename/alias collapse. Independently
report and enforce concentration by exact configured spec, exact configured
pair, provider/route, team, matchup, and source group.

### Mirrored source games

“Mirrored rows” is ambiguous. The simultaneous `p1` and `p2` task rows extracted
from one game are two seat views of one realized game; they do not swap the
source-generating assignments and are not a counterbalanced pair.

If side mirroring is adopted, use source-game pairs: keep the same configured
model-team bundles, swap their pids in the paired game, and apply a declared
paired-seed rule. Freeze what randomness is paired, how failures and incomplete
pairs are handled, and whether selection and splitting operate on whole pairs.
The pair schema and rules are a preregistration gate before the pilot. No mirror
schema or rule is implemented or frozen by this memo.

### Implemented provenance schema gate

The private generator-provenance gate is implemented. The grader and exporter
copy both exact configured specs from the authoritative source record into
`generating_models: {p1, p2}` instead of acting-seat aliases. The grading cache is
schema v3, sealed rows and the candidate manifest are schema v2, and selection
rules are version 3. Strict validators reject old schemas and malformed or
non-pid-keyed generator maps. Selection does not read generator identity, and
public task rows and manifests expose none. There is no current candidate artifact
requiring migration.

Add optional pair identity only after mirror rules are frozen; no mirror schema
or rule is implemented by this gate.

## Decision status

This parameterization becomes actionable only after the numeric addendum and
mirror-pair design pass review. The implemented provenance schema does not itself
authorize generation or a pilot. A later pilot may populate planning
distributions; it cannot authorize release or pass the release gates in the
[evaluation plan](evaluation-plan.md).
