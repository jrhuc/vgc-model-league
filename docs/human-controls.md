# Human controls

> **Status:** planned. No corpus has been ingested or released.
> **Source snapshot:** 2026-08-08.

This document owns the official-event source inventory and the versioned
reconstruction, admission, consented-human-reference, provenance, and release
protocol. [Measurement](measurement.md) owns how evidence may be interpreted;
this document does not define measurement policy or provide legal advice.

The North America International Championships (NAIC), held June 12–14, 2026,
used Pokémon Champions Regulation M-A and are available only for retrospective
calibration. The World Championships are scheduled for August 28–30, 2026 and
are the prospective post-NAIC official-event source. Assign Worlds data to
Regulation M-B only after retaining an official Worlds-specific rules source.
The bounded inventory below identified no official Regulation M-B match corpus
through 2026-08-08.

## Separate source products

Keep four products physically or logically separate, with independent
provenance, rights, vintages, manifests, and access controls:

| Product | What it may establish | What it does not establish |
| --- | --- | --- |
| Public broadcast observation/action trace | What the public feed showed at each timecode, including revealed or executed actions and targets where observable | A visibly locked choice unless the feed actually showed it, hidden state, unshown actions, complete coverage, or action quality |
| Public open team sheet (OTS)/team corpus | Fields actually published for a submitted team and event, and a game join when provenance supports it | Unpublished EVs or private fields, the creator's process, a battle state, team quality, or redistribution permission |
| Private-state/replay or reconstruction artifact | A verified private artifact may supply source state; a reconstruction may supply retained compatible states and public transitions | That a compatible witness is the original spread, seed, state, or official-software replay |
| Bracket, results, and outcomes | Event structure and terminal context, subject to the freeze rule below | Position eligibility, causal decision quality, an optimal action or team, or a population ranking |

A source action, entrant, or winner is a contextual reference, never an oracle.

## Admission and reconstruction

### Three graded levels

Apply these names consistently and record admission per game or item:

1. **`timecoded public-observation trace`:** preserves the public feed's
   observations with timecodes, declared coverage, gaps, and unknowns.
2. **`public-transition-reproduced`:** a Showdown-style log that reproduces all
   declared observed transitions within that coverage under the pinned Showdown
   Champions mod. The claim is relative only to the declared observed fields and
   coverage; missing or partial actions remain unknown.
3. **`counterfactual-fork eligible`:** additionally passes the applicable
   source-state, action, mechanics, qualification, and measurement gates needed
   to fork the position. Public-transition admission alone does not confer this
   status. A verified private source, unique recovery within declared
   assumptions, or a protocol that evaluates the retained compatible state set
   can be a path; unique private-state recovery is not the only path.

Build a `timecoded public-observation trace` from two independent annotations.
Preserve both transcriptions, source timecodes, coverage, and missingness, then
retain adjudication as a derived record. Label each derived field `observed`,
`inferred`, or `unknown`, and cite the observations and mechanics supporting an
inference. Broadcast footage can establish revealed or executed actions and
targets where observable; it does not necessarily show what was locked. Treat
caster claims as nonauthoritative annotations, not state facts.

A later reveal may constrain reconstruction only with its own timestamp and a
`later-observed` or `inferred` provenance marker. Never backfill it into the
acting prompt. Preserve rounded bars, displayed percentages, and uncertain
damage as intervals rather than invented point values.

A `public-transition-reproduced` artifact must reproduce each declared observed
transition against the revision and Champions mod pinned by
`showdown.lock.json`. Separately record the published official rules and build
when available, `unknown` when unavailable, and every known or suspected
deviation. Reproduction in Showdown is not replay through unavailable official
software and does not prove official-state identity.

### Hidden-state constraints and fork admission

Use a frozen, versioned constraint model. Its declared representable dimensions
must include, where relevant, nature, level, IVs, EVs, the stat system, HP and
damage or percentage rounding, damage rolls and critical-hit uncertainty,
priority and other order modifiers, and Speed-tie disjunctions. Move order
creates inequalities and may eliminate candidates after priority and modifiers
are applied. Damage and HP observations constrain ranges rather than supplying
unobserved point values.

Validate solver soundness and completeness on synthetic traces and traces with
known private state before solver output can support admission. Until then, use
only conservative outer bounds. An ambiguity set is complete only relative to
the frozen representable constraint model; unsupported dimensions remain
`unknown`. A unique result means unique within the recorded assumptions, never
unique original provenance without a private source. Retain compatible states
as reviewable witnesses, and call them witnesses rather than originals.

Source-specific fork admission follows the common-draw and independent
qualification/measurement gates in
[Measurement's counterfactual decision rules](measurement.md#counterfactual-decision-rules)
and the [evaluation plan](evaluation-plan.md#release-gates). It must not choose
one convenient witness or use a public-transition claim as a substitute for the
applicable fork gates.

## Outcomes, prompts, and interpretation

Bracket or outcome data may validate a terminal replay, but may not drive
position selection, thresholds, reconstruction repair, or tie-breaking. Where
feasible, join outcomes only after item selection and scoring are frozen.
Disclose the unavoidable Top 8 selection mechanism, broadcast coverage
mechanism, and missingness.

Public prompts include only information authorized at the acting timestamp by
the frozen task protocol. Exclude identity, event and outcome, source action,
subsequent observations or actions, caster information, and later-derived
private state. Follow [cross-stage evidence](measurement.md#cross-stage-evidence)
for temporal joins and [long-horizon claims](measurement.md#long-horizon-claims)
for any claim spanning stages or future conditions.

Human/model action agreement is descriptive. Interpret value differences and
**reference-relative opportunity loss** only under
[Measurement's counterfactual decision rules](measurement.md#counterfactual-decision-rules);
do not turn agreement, value, or event success into an optimality label.

## Consented human reference

A prospective collection may add an entrant with role `human_reference` only
with explicit consent. In a full-circuit comparison, the human receives the same
authorized information and action interface for draft, construction, preview,
battle, and between-game update as the compared condition. Record UI, input
method, timer, breaks, communication, tools, and assistance differences as
treatment fields. Do not require a model-style rationale.

Before collection, document consent, compensation, retention, withdrawal, and
publicity terms, including limits on removal from an immutable release. Freeze
or mirror the schedule, teams, sides, seeds, controllers, and information policy
where the comparison requires them. A human reference is a descriptive control,
never an oracle or rank.

## Rights, privacy, provenance, and release

As this repository's conservative policy, not as universal legal conclusions,
do not automate downloads or scraping and do not redistribute source or
derivative material without documented permission. Apply the relevant platform
terms and obtain counsel, ethics, and privacy review for the intended access,
retention, research, release, or training use.

Rights in audiovisual media, commentary, sheet layout, and database compilation
are distinct from the minimum factual annotations needed for review. Keeping
only minimum factual annotations does not waive source terms, privacy duties, or
permission requirements. Until cleared, avoid retaining or releasing raw video,
audio, stills, commentary, or sheet layouts and keep permitted annotations under
restricted access and a retention policy.

Record permissions for Twitch, YouTube, RK9, brackets/results, teams/OTS,
replay/private state, participants, and TPCi separately. Bind each permission to
the source, access method, fields, purpose, permitted transformations,
retention, release, and training use. New entrants always require explicit
consent.

As project privacy policy, identity-stripped event keys are pseudonyms, not
anonymity, and public Top 8 participants remain reidentifiable. Review any
release on that basis.

Every release needs a takedown path. Preserve its digest, publish a tombstone or
superseding manifest, disable controlled distribution where possible, and state
which immutable copies cannot be recalled.

## Source inventory at the snapshot

Tiers describe provenance, not permission or fitness. All pages below were
accessed 2026-08-08. The findings are bounded to this inventory and access date.

### Tier 1: official Pokémon/TPCi sources

- [Official 2026 NAIC event page](https://championships.pokemon.com/en-us/events/internationals/2026/new-orleans)
  — event identity, June 12–14 dates, venue, and published event information.
- [Official NAIC broadcast playlist](https://www.youtube.com/playlist?list=PLQWzKIaERirxvkGpNp7uVzY4hbkK3RQAH),
  [Day 2 broadcast](https://www.youtube.com/watch?v=aR1lTe328yQ), and
  [Sunday broadcast](https://www.youtube.com/watch?v=m3ICx0o5Fnc) — candidate
  public-observation sources; their coverage and timecodes require inventory.
- [Official NAIC results](https://www.pokemon.com/us/play-pokemon/internationals/2026/north-america/vgc-masters)
  — results and outcome source only.
- [Official 2026 Worlds page](https://worlds.pokemon.com/en-us/) — source for the
  scheduled August 28–30 event. It does not by itself assign Worlds to
  Regulation M-B.
- [Official Regulation M-B Pokémon HOME notice](https://champions-news.pokemon-home.com/en/page/776.html)
  — a ranked-battle format notice only; it does not establish the Worlds
  regulation.
- [Official Regulation M-A Pokémon HOME archive](https://news.pokemon-home.com/en/page/751.html)
  — a ranked-battle archive; it does not by itself establish the NAIC
  regulation.

### Tier 2: event-service index

- [RK9 NAIC event page](https://rk9.gg/tournament/NA02wgUPFDXKmQmqILwS)
  — separately states NAIC Regulation Set M-A. At the snapshot it did not
  publicly expose team lists, action logs, RNG seeds, or replays.

### Tier 3: third-party secondary source

- [Victory Road NAIC OTS/results](https://victoryroad.pro/2026-naic/) — a
  third-party aggregation of team-sheet and result information. Verify fields
  against a higher-tier source where possible and clear rights independently.
  It is not an official private-state, replay, or action-log source.

This snapshot-bounded inventory found no official action log, RNG seed, replay,
or Regulation M-B match corpus through 2026-08-08. It is not a claim that none
can later exist or be obtained privately.

## Admission and release checklist

- [ ] Retain an archived exact URL and access date for every source, plus a
      source hash only where acquisition and retention are permitted; bind each
      item to its rights record, access method, vintage, and manifest.
- [ ] Inventory the sampling frame, broadcast coverage, missing games, timecode
      coverage, and selection mechanism before choosing items.
- [ ] Meet frozen inter-annotator agreement and adjudication acceptance criteria
      while preserving both source transcriptions.
- [ ] Reproduce declared public transitions against the pinned Showdown mod;
      record official rules/build availability, deviations, and mechanics
      compatibility separately.
- [ ] Validate solver soundness and completeness; retain representable ambiguity
      sets, unsupported unknowns, and reviewed compatible witnesses.
- [ ] Keep Regulation M-A and M-B artifacts and estimates non-pooled; require a
      documented mechanics-compatibility argument for any cross-regulation
      comparison and a Worlds-specific official source before an M-B assignment.
- [ ] Apply the linked counterfactual fork, common-draw, qualification, and
      measurement gates without restating or weakening them here.
- [ ] Audit prompt leakage, source and near-duplicate split isolation, and known
      training contamination or exposure.
- [ ] Report statistical and mechanical uncertainty, reconstruction sensitivity,
      ambiguity, coverage gaps, and Top 8 selection bias.
- [ ] Freeze separate public-task, private-score, and sealed-state roots with
      complete manifests, digests, and access controls.
- [ ] Complete source-by-source and participant-by-participant rights, consent,
      privacy, and release review; exercise tombstone, supersession, and takedown.

Failure of the `counterfactual-fork eligible` gate may permit only a clearly
labeled, partial, rights-cleared observation corpus. Report its coverage,
missingness, and reconstruction limits without counterfactual-fork claims.
