# Trade-window forks and the price of a message

The frozen circuit records trade offers, trade responses, and free agency as
first-class replayable byte receipts, so the same checkpoint-and-fork machinery
that grades a battle decision applies to a negotiation message. This document
defines what those forks measure and what they must not be read as.

## What exists

`src/eval/frozen-circuit-trade-forks.ts` provides:

- **Selection.** `selectFrozenCircuitTradeReceipts` lists every trade node in a
  replay transcript; `buildFrozenCircuitTradeCheckpoint` verifies a checkpoint
  immediately before one of them.
- **Canonical trade action identity.** `circuitTradeActionDigest` hashes the
  parsed content, so byte-layout variants of the same accept, offer, or swap
  are one action while any content change is a different one.
- **The matched-message contract.** `assertMatchedTradeOfferArms` requires
  every arm of a fork to propose the identical material trade — same
  counterparty, same give and get, byte-identical private rationale and
  notebook — so the public message is provably the only intervention.
- **Two declared horizons.** `runMatchedTradeOfferForks` measures the
  counterparty's single accept-or-reject under the regenerated response prompt
  at matched pre-offer state; with `horizon: 'terminal'` it continues each arm
  through the declared default-tolerant controller population to terminal
  league utility and reports both seats' returns.
- **A synthetic outcome-blind source.** `completeDefaultDrivenCircuit` plays
  every seat with the first authority-accepted command and null transactions,
  which makes every trade node reachable without any provider call.
- **A runnable seam.** `pnpm run trade-message-pilot` runs matched message arms
  against a scripted or real-provider responder and writes a private,
  digest-joined report.

The live league path (`runs/<id>/window.jsonl`) records parsed outcomes, not
byte receipts, and writes the offer and response as one combined row. It is not
a fork substrate; circuit receipts are.

## What a matched message fork measures

One fork answers a causal question existing deception evaluations do not: what
did this specific message *do*? Holding state, terms, private evidence, seeds,
responder policy, and continuation policy fixed, the arms differ only in
message bytes, so any difference in the responder decision — and, at the
terminal horizon, in either seat's league return — is attributable to the
message. That turns "the model wrote a persuasive or deceptive message" from a
label into a priced quantity: the utility a framing bought against a declared
responder.

Published work measures deception rates, detectability, or listener belief
shift; parallel-world forking has been used to detect contradictions
(arXiv:2603.07202) and counterfactual replay to attribute agent failures
(arXiv:2606.08275). Continuing matched message substitutions to
simulator-graded terminal utility, and relating a model's willingness to write
such messages to that causally measured incentive, is the uncovered
combination this machinery targets (survey recorded 2026-08-19).

## Interpretation constraints

- One node in one synthetic circuit is one cluster. Nothing here ranks models.
- The default-driver source and continuation are declared, degenerate
  policies. A message effect that exists only against them is a plumbing
  result; conclusions require crossed responder and continuation populations,
  exactly as the frontier pilot requires a changed downstream policy.
- The terminal horizon inherits the deterministic scenario seed. Provider-call
  variation of a model responder is the only stochastic layer and is a
  replication unit, not simulator randomness.
- Message arms are operator-authored treatments. Freeze them before reading
  any outcome; a byte change is a new treatment identity.
- Model-*written* offers (propensity measurement — does a model choose to
  deceive more when deceiving pays more?) are a separate future stage: it
  requires the pricing rectangle from this machinery first, then a
  deception-labeling rubric over freely written messages, and only then a
  propensity-versus-incentive analysis.

## Evidence fidelity notes

The circuit transaction layer now carries the proposer's parsed rationale,
public message, and evidence-supplied flags into `TransactionSummary`, so a
forked negotiation is comparable to its source at the evidence level, not only
at the byte level. Circuit trade windows remain single-offer per seat;
multi-offer sequences are representable only in the live path and are not
forkable there.
