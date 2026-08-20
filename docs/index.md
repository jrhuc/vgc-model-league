# The decision is the unit.

VGC Model League is a forkable Pokémon Champions referee for language-model
decisions. It records what a model saw, what it chose, and what the simulator
accepted—across single turns, best-of-three sets, and draft seasons.

[Read the measurement contract](measurement.md) or [run the harness](usage.md).

## What stays authoritative

- **Pokémon Showdown** owns rules, legality, requests, simultaneous resolution,
  and randomness at the pinned revision.
- **Harness artifacts** join exact state, accepted actions, model submissions,
  and public/private evidence projections.
- **Season records** connect drafts, matchup builds, series, transactions, and
  reviews without treating standings as the measurement result.

## One season, linked decisions

<p class="circuit-intro">
A franchise commits to a scarce roster, rebuilds six Pokémon for each opponent, and plays ordinary best-of-three VGC. Each stage leaves an artifact; the harness keeps private model context separate from public evidence.
</p>

<ol class="circuit-flow" aria-label="Current draft-season flow">
  <li><strong>Draft ten</strong><span>Shared board and fixed points budget</span></li>
  <li><strong>Build six</strong><span>Fresh sets for the coming opponent</span></li>
  <li><strong>Play the set</strong><span>Bring four, lead two, best of three</span></li>
  <li><strong>Transaction barrier</strong><span>Optional trades and free agency</span></li>
  <li><strong>Finish the field</strong><span>Round robin followed by playoffs</span></li>
  <li><strong>Review</strong><span>Season evidence remains attached to its seat</span></li>
</ol>

<div class="boundary-note" role="note">
<strong>Interpretation boundary.</strong> The record can show what each seat received, submitted, and carried forward. It cannot establish private belief or prove that a written rationale caused a later move. A critical hit can flip a match; standings describe the run, not the quality of every decision.
</div>

## Repository boundary

This repository owns the referee, provider adapters, artifact protocols, local operator tooling, and their documentation. The public [AI Draft League](https://github.com/jrhuc/ai-draft-league) spectator product consumes validated public season bundles; it never receives private sheets or recomputes game authority.

Start with [Architecture](architecture.md) for component boundaries or
[Usage](usage.md) for commands and operator workflows.
