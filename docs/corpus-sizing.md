# Position corpus sizing v0

This memo parameterizes source-game, position, simulator-compute, and source-cost
requirements for `vgc-positions-v1`. It is a planning design, not permission to
generate a pilot or candidate corpus. The v0 target, per-game cap, excluded-pilot
size and yield rule are frozen below, and mandatory source-game mirroring is not
adopted for v0. Every other open preregistration and release gate still applies.

## Current evidence boundary

The strict current admissible corpus contains **zero** games and **zero**
positions. The legacy inventory has 184 series and 424 games, but every legacy
series lacks `attempt_id` and is rejected by the current corpus loader. The
legacy positions cache also lacks the current manifest and schema. Neither the
inventory nor that cache is evidence about current eligibility yield, balance,
compute, or cost.

The selector and exporter now share the frozen v0 target of 500 positions and
hard cap of 2 selected positions per source game. These values size a bounded
descriptive set; they do not validate its reference, eligibility policy, source
distribution, or use for model ranking.

## Numeric plan

Let:

- `N` be the preregistered number of released evaluation positions;
- `c` be the preregistered maximum selected positions from one source game;
- `G` be the number of preregistered source-game opportunities, successful or
  failed, in the applicable generation schedule;
- `e_g` be the number of positions from opportunity `g` that pass the frozen
  replay and per-position eligibility rules, before applying `c` or global
  balance, duplicate-group, separation, and isolation rules. An opportunity
  that exhausts its frozen generation or replay policy has `e_g = 0`.

The absolute game-count floor is

```text
G_floor = ceil(N / c).
```

It assumes every generated game supplies `c` usable positions and that no
balance, concentration, duplicate-group, split, or isolation rule removes one.
For the frozen v0 values, `ceil(500 / 2) = 250`. This is still an arithmetic
floor, not a yield estimate or a generation authorization.

### Frozen v0 numeric addendum

The initial controlled set freezes:

```text
N = 500 released positions
c = 2 selected positions per source game
G_floor = 250 source games
G_pilot = 60 preregistered source-game opportunities
```

A source-game opportunity enters the pilot denominator when its complete model,
team, side, seed, scaffold, and source-group assignment is committed to the
immutable pilot schedule, before generation begins. An opportunity that exhausts
the frozen generation or replay policy contributes zero usable positions; a
position that fails grading contributes none. Only preregistered retries may run
inside the same opportunity, with every attempt and cost retained. Failed
opportunities are never dropped from the denominator or replaced after their
result is known. The still-missing pilot runner must implement that accounting
before a pilot can be authorized.

The target is a resolution choice for a descriptive bounded-reward set. For one
model, normalized legal-action reward lies in `[0, 1]`. Under the deliberately
optimistic abstraction of 500 independent tasks, the two-sided 95% Hoeffding
half-width is `sqrt(log(40) / (2 * 500)) = 0.061`. With at most two tasks from
one source game, treating within-game tasks as perfectly dependent gives at
least 250 game clusters and a corresponding half-width of `0.086`. These are
planning sensitivities, not promised confidence intervals: fixed generators and
teams, source-series and near-duplicate dependence, stratified selection,
measurement error, and an unvalidated source distribution violate the simple
sampling abstraction. Pairwise model differences have a wider `[-1, 1]` range,
and this design supplies no minimum detectable ranking difference or rank claim.
Leave-own exclusions can also make a model or pairwise common-task view smaller
than the 500-position release; reports must name that effective task count and
must not reuse the 500-task sensitivity for it. Reports must cluster by the
frozen source group and show sensitivity to source-series clustering rather than
divide uncertainty by 500 turns.

The cap of two limits one game's share of the released set to `0.4%`, permits
both seat views only when all duplicate, balance, and isolation rules admit them,
and raises the arithmetic floor from the former implementation cap of three.
The 60-opportunity excluded pilot estimates planning yield only. For an
independent bounded per-opportunity contribution in `[0, c]`, the one-sided 95%
Hoeffding-scale deduction is

```text
delta_pilot = c * sqrt(log(20) / (2 * G_pilot)) = 0.316 positions/game.
```

Sixty is the smallest ten-opportunity increment that puts this deduction below
one third of a position per game at `c = 2`. At the theoretical full yield it
would therefore produce `y_L = 1.65` and `G_plan = 304`, rather than treat the
arithmetic floor as attainable. This is a planning-resolution rationale, not a
claim that 60 observations estimate a rare-event rate.

After applying every already-frozen replay, eligibility, duplicate-group,
balance, concentration, separation, and leave-own rule to the excluded pilot,
let `E_BI,pilot` be the maximum remaining selectable supply and define

```text
y_BI = E_BI,pilot / G_pilot
y_L  = 0.05 * floor(max(0, y_BI - delta_pilot) / 0.05)
```

The floor makes the planning yield no larger than the constrained observed yield
minus the preregistered bounded-yield deduction. Because the global maximum
selection couples games, this is a conservative planning rule, not a confidence
bound for constrained yield. Because `E_BI,pilot` is after all exclusions,
failures and balance/isolation loss reduce `y_L` directly. A zero `y_L` fails the
planning gate; it does not permit pooling pilots, replacing
failed opportunities, lowering the deduction, or relaxing a corpus rule. A
positive value freezes `G_plan = ceil(500 / y_L)` before candidate generation.
The pilot is too small to calibrate rare failures, qualification thresholds, or
balance tolerances, and none may be chosen from it.

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

On the excluded pilot, also report uncensored capped yield

```text
y_c = (sum_g min(c, e_g)) / G_pilot
```

beside `y_BI`, `delta_pilot`, and the mechanically derived `y_L`. The rule above,
not analyst discretion after the pilot, owns the derivation. The planned
generation stop must still fail closed if the frozen constraints leave
`D_target > 0`; it must not add games, relax a cap, or change a balance rule after
seeing the candidate corpus.

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

The table is the gate ledger. Frozen rows do not compensate for open ones: every
remaining design and pilot input must be frozen before pilot generation. The
preregistered rule, not a post-pilot judgment, derives the numeric `y_L`; that
value is appended after the excluded pilot and before candidate generation.

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

Mandatory paired source games are **not adopted for v0**. Replaying the same
configured model-team bundles with swapped pids and related seeds would not hold
the trajectory fixed: generated actions change the visited states and the order
of RNG consumption. It would double source-generation exposure and create a
correlated pair without a v0 estimand that consumes a paired source outcome. The
static evaluation already presents every evaluated model with the same frozen
tasks; source identity remains a private distribution and leave-own/concentration
variable, not the evaluated treatment.

Instead, the later source schedule must use a preregistered blocked side
allocation. Within each unordered exact-generator-plus-team-bundle matchup block,
the counts of its two pid orientations may differ by at most one. The complete
orientation and independent game-seed namespaces are committed before any source
call. A failed scheduled opportunity contributes zero pilot yield and is not
replaced to repair realized side balance; the applicable balance gate may fail.
Selection and corpus splits continue to operate on current source-series,
source-game, and calibrated duplicate groups. There is no `pair_id`, paired-seed
rule, whole-pair selection rule, or incomplete-pair recovery path in v0.

This choice does not support a causal side or battle-policy claim. A future
version may preregister paired source games for a named paired estimand, but that
would require a new source schema, seed rule, group/split semantics, and failure
policy rather than a compatibility field in current artifacts.

### Implemented provenance schema gate

The private generator-provenance gate is implemented. The grader and exporter
copy both exact configured specs from the authoritative source record into
`generating_models: {p1, p2}` instead of acting-seat aliases. The grading cache is
schema v3, sealed rows and the candidate manifest are schema v2, and selection
rules are version 3. Strict validators reject old schemas and malformed or
non-pid-keyed generator maps. Selection does not read generator identity, and
public task rows and manifests expose none. There is no current candidate artifact
requiring migration.

No pair identity is added for v0. A future paired design must version the source
schema and all dependent artifacts rather than add an unused optional field.

## Decision status

The v0 target, cap, pilot-yield rule, and non-mirroring decision are now frozen.
They do not make the program actionable: source generators, teams, allocation
blocks, eligibility and balance policy, cost stop, pilot runner/accounting, and
the other table entries remain open. No pilot may run until those inputs pass
review and explicit resource approval. A later excluded pilot may mechanically
populate `y_L` and planning distributions; it cannot authorize release or pass
the release gates in the [evaluation plan](evaluation-plan.md).
