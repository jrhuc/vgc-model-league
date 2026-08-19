import path from 'node:path';

import { canonicalJsonDigest } from './eval/serialization.js';
import {
  type CircuitSeat,
  FrozenCircuitRefereeError,
  type FrozenCircuitSeatId,
  type TransactionSummary,
} from './frozen-circuit-model.js';
import { FROZEN_CIRCUIT_PROMPT_POLICY } from './frozen-circuit-setup.js';
import { REPO_ROOT } from './paths.js';
import {
  applyFreeAgency,
  applyTradeOffer,
  DEFAULT_TRADE_WINDOW,
  MAX_TRADE_SWAPS,
  type ParsedTradeOffer,
  parseTradeDecision,
  parseTradeOffer,
  parseTradeResponse,
  renderFreeAgencyPrompt,
  renderTradeOfferPrompt,
  renderTradeResponsePrompt,
  type TradeOffer,
  type TradeWindowDecision,
  type TradeWindowState,
  tradeWindowOrder,
  validateLeagueRosterState,
} from './trade-window.js';

export type CircuitTransactionKind = 'trade_offer' | 'trade_response' | 'free_agency';

export interface CircuitTransactionPending {
  seatId: FrozenCircuitSeatId;
  kind: CircuitTransactionKind;
  entrant: number;
  key: string;
  prompt: string;
  attempt: number;
  problems: string[];
}

export interface CircuitTransactionSubmission {
  accepted: boolean;
  advanced: boolean;
  defaulted: boolean;
  diagnostic: string | null;
  problems?: string[];
  key: string;
  retryAttempt?: number;
  defaultSelection?: string;
}

export class FrozenCircuitTransactions {
  state: TradeWindowState;
  readonly order: number[];
  phase: 'offers' | 'response' | 'free-agency' | null = 'offers';
  cursor = 0;
  private offer: {
    from: number;
    value: NonNullable<ParsedTradeOffer['offer']>;
    proposerDefaulted: boolean;
    reasoning: string;
    evidenceSupplied: ParsedTradeOffer['evidence']['supplied'];
  } | null = null;
  private readonly offers: TradeOffer[] = [];
  private readonly decisions: TradeWindowDecision[] = [];

  constructor(
    state: TradeWindowState,
    private readonly seats: readonly CircuitSeat[],
  ) {
    validateLeagueRosterState(state);
    this.state = state;
    this.order = tradeWindowOrder(state.standings);
  }

  pending(
    attempts: ReadonlyMap<string, number>,
    retryProblems: ReadonlyMap<string, string[]>,
    maximumAttempts: number,
  ): CircuitTransactionPending | null {
    if (this.phase === 'response') {
      const current = this.offer;
      if (!current) throw new Error('trade response phase has no offer');
      const entrant = current.value.to;
      const key = `trade-response:${current.from}:${entrant}`;
      const attempt = attempts.get(key) ?? 1;
      const problems = retryProblems.get(key) ?? [];
      return {
        seatId: this.seats[entrant]!.seatId,
        kind: 'trade_response',
        entrant,
        key,
        attempt,
        problems,
        prompt: withRetry(
          renderTradeResponsePrompt(this.state, current.value, current.from, path.join(REPO_ROOT, 'pokemon-showdown'), {
            mechanicsTools: FROZEN_CIRCUIT_PROMPT_POLICY.mechanicsTools,
          }),
          attempt,
          maximumAttempts,
          problems,
        ),
      };
    }
    const entrant = this.order[this.cursor];
    if (entrant === undefined) {
      if (this.phase === 'offers') {
        this.phase = 'free-agency';
        this.cursor = 0;
        return this.pending(attempts, retryProblems, maximumAttempts);
      }
      return null;
    }
    if (this.phase === null) throw new Error('transaction window is closed');
    const kind = this.phase === 'offers' ? 'trade_offer' : 'free_agency';
    const key = `${kind}:${entrant}`;
    const attempt = attempts.get(key) ?? 1;
    const problems = retryProblems.get(key) ?? [];
    const prompt =
      kind === 'trade_offer'
        ? renderTradeOfferPrompt(this.state, entrant, path.join(REPO_ROOT, 'pokemon-showdown'), {
            mechanicsTools: FROZEN_CIRCUIT_PROMPT_POLICY.mechanicsTools,
          })
        : renderFreeAgencyPrompt(this.state, entrant, path.join(REPO_ROOT, 'pokemon-showdown'), {
            mechanicsTools: FROZEN_CIRCUIT_PROMPT_POLICY.mechanicsTools,
          });
    return {
      seatId: this.seats[entrant]!.seatId,
      kind,
      entrant,
      key,
      attempt,
      problems,
      prompt: withRetry(prompt, attempt, maximumAttempts, problems),
    };
  }

  submit(
    kind: CircuitTransactionKind,
    entrant: number,
    response: string,
    attempt: number,
    maximumAttempts: number,
    boundedProblems: (problems: readonly string[]) => string[],
  ): CircuitTransactionSubmission {
    if (kind === 'trade_offer') return this.submitOffer(entrant, response, attempt, maximumAttempts, boundedProblems);
    if (kind === 'trade_response')
      return this.submitResponse(entrant, response, attempt, maximumAttempts, boundedProblems);
    return this.submitFreeAgency(entrant, response, attempt, maximumAttempts, boundedProblems);
  }

  close(): TradeWindowState {
    validateLeagueRosterState(this.state);
    this.phase = null;
    return this.state;
  }

  stateDigest(): string {
    return canonicalJsonDigest({
      state: this.state,
      order: this.order,
      phase: this.phase,
      cursor: this.cursor,
      offer: this.offer,
      offers: this.offers,
      decisions: this.decisions,
    });
  }

  summary(): TransactionSummary {
    return {
      afterWeek: DEFAULT_TRADE_WINDOW.afterWeek,
      tradesAllowed: DEFAULT_TRADE_WINDOW.tradesAllowed,
      maxFreeAgencySwaps: MAX_TRADE_SWAPS,
      order: this.order.map((entrant) => this.seats[entrant]!.seatId),
      offers: this.offers.map((offer) => ({
        from: this.seats[offer.from]!.seatId,
        to: offer.to === null ? null : this.seats[offer.to]!.seatId,
        give: offer.give,
        get: offer.get,
        message: offer.message,
        accepted: offer.accepted,
        proposerDefaulted: offer.proposerFallback,
        responderDefaulted: offer.responderFallback,
        offerEvidenceSupplied: offer.offerEvidenceSupplied ?? null,
        responseEvidenceSupplied: offer.responseEvidenceSupplied ?? null,
      })),
      freeAgency: this.decisions.map((decision) => ({
        seatId: this.seats[decision.entrant]!.seatId,
        swaps: structuredClone(decision.swaps),
        defaulted: decision.fallback,
      })),
      finalRosterDigests: this.state.rosters.map((roster, entrant) => ({
        seatId: this.seats[entrant]!.seatId,
        rosterDigest: canonicalJsonDigest(roster),
      })),
    };
  }

  private submitOffer(
    entrant: number,
    response: string,
    attempt: number,
    maximumAttempts: number,
    bound: (problems: readonly string[]) => string[],
  ): CircuitTransactionSubmission {
    if (this.phase !== 'offers') throw new FrozenCircuitRefereeError('wrong-phase', 'trade offer turn is stale');
    const key = `trade_offer:${entrant}`;
    let parsed = parseTradeOffer(response, this.state, entrant);
    let accepted = true;
    let defaulted = false;
    let diagnostic: string | null = null;
    let problems: string[] | undefined;
    let defaultSelection: string | undefined;
    if (typeof parsed === 'string') {
      diagnostic = parsed;
      problems = bound([parsed]);
      if (attempt < maximumAttempts) {
        return {
          accepted: false,
          advanced: false,
          defaulted: false,
          diagnostic,
          problems,
          key,
          retryAttempt: attempt + 1,
        };
      }
      const safe = parseTradeOffer('{"offer":null}', this.state, entrant);
      if (typeof safe === 'string') throw new Error(`safe no-offer default was rejected: ${safe}`);
      parsed = safe;
      accepted = false;
      defaulted = true;
      diagnostic = `trade offer rejected after ${attempt} attempts: ${diagnostic}`;
      defaultSelection = '{"offer":null}';
    }
    this.state.notebooks[entrant] = parsed.notebook;
    if (!parsed.offer) {
      this.offers.push({
        from: entrant,
        to: null,
        give: null,
        get: null,
        message: null,
        accepted: null,
        proposerFallback: defaulted,
        responderFallback: null,
        offerReasoning: parsed.reasoning,
        responseReasoning: '',
        offerEvidenceSupplied: parsed.evidence.supplied,
      });
      this.cursor += 1;
    } else {
      this.offer = {
        from: entrant,
        value: parsed.offer,
        proposerDefaulted: defaulted,
        reasoning: parsed.reasoning,
        evidenceSupplied: parsed.evidence.supplied,
      };
      this.phase = 'response';
    }
    validateLeagueRosterState(this.state);
    return {
      accepted,
      advanced: true,
      defaulted,
      diagnostic,
      ...(problems ? { problems } : {}),
      key,
      ...(defaultSelection ? { defaultSelection } : {}),
    };
  }

  private submitResponse(
    entrant: number,
    response: string,
    attempt: number,
    maximumAttempts: number,
    bound: (problems: readonly string[]) => string[],
  ): CircuitTransactionSubmission {
    const current = this.offer;
    if (!current || this.phase !== 'response' || entrant !== current.value.to) {
      throw new FrozenCircuitRefereeError('wrong-phase', 'trade response turn is stale');
    }
    const key = `trade-response:${current.from}:${current.value.to}`;
    let parsed = parseTradeResponse(response, this.state.notebooks[current.value.to]!);
    let accepted = true;
    let defaulted = false;
    let diagnostic: string | null = null;
    let problems: string[] | undefined;
    let defaultSelection: string | undefined;
    if (typeof parsed === 'string') {
      diagnostic = parsed;
      problems = bound([parsed]);
      if (attempt < maximumAttempts) {
        return {
          accepted: false,
          advanced: false,
          defaulted: false,
          diagnostic,
          problems,
          key,
          retryAttempt: attempt + 1,
        };
      }
      const safe = parseTradeResponse('{"accept":false}', this.state.notebooks[current.value.to]!);
      if (typeof safe === 'string') throw new Error(`safe reject default was rejected: ${safe}`);
      parsed = safe;
      accepted = false;
      defaulted = true;
      diagnostic = `trade response rejected after ${attempt} attempts: ${diagnostic}`;
      defaultSelection = '{"accept":false}';
    }
    this.state = applyTradeOffer(this.state, {
      from: current.from,
      to: current.value.to,
      give: current.value.give,
      get: current.value.get,
      accepted: parsed.accept,
      notebook: this.state.notebooks[current.from]!,
      responseNotebook: parsed.notebook,
    });
    this.offers.push({
      from: current.from,
      to: current.value.to,
      give: current.value.give,
      get: current.value.get,
      message: current.value.message,
      accepted: parsed.accept,
      proposerFallback: current.proposerDefaulted,
      responderFallback: defaulted,
      offerReasoning: current.reasoning,
      responseReasoning: parsed.reasoning,
      offerEvidenceSupplied: current.evidenceSupplied,
      responseEvidenceSupplied: parsed.evidence.supplied,
    });
    this.offer = null;
    this.phase = 'offers';
    this.cursor += 1;
    return {
      accepted,
      advanced: true,
      defaulted,
      diagnostic,
      ...(problems ? { problems } : {}),
      key,
      ...(defaultSelection ? { defaultSelection } : {}),
    };
  }

  private submitFreeAgency(
    entrant: number,
    response: string,
    attempt: number,
    maximumAttempts: number,
    bound: (problems: readonly string[]) => string[],
  ): CircuitTransactionSubmission {
    if (this.phase !== 'free-agency') {
      throw new FrozenCircuitRefereeError('wrong-phase', 'free-agency turn is stale');
    }
    const key = `free_agency:${entrant}`;
    let parsed = parseTradeDecision(response, this.state, entrant);
    let accepted = true;
    let defaulted = false;
    let diagnostic: string | null = null;
    let problems: string[] | undefined;
    let defaultSelection: string | undefined;
    if (typeof parsed === 'string') {
      diagnostic = parsed;
      problems = bound([parsed]);
      if (attempt < maximumAttempts) {
        return {
          accepted: false,
          advanced: false,
          defaulted: false,
          diagnostic,
          problems,
          key,
          retryAttempt: attempt + 1,
        };
      }
      const safe = parseTradeDecision('{"swaps":[]}', this.state, entrant);
      if (typeof safe === 'string') throw new Error(`safe free-agency default was rejected: ${safe}`);
      parsed = safe;
      accepted = false;
      defaulted = true;
      diagnostic = `free-agency reply rejected after ${attempt} attempts: ${diagnostic}`;
      defaultSelection = '{"swaps":[]}';
    }
    this.state = applyFreeAgency(this.state, entrant, parsed.swaps, parsed.notebook);
    this.decisions.push({
      entrant,
      model: this.seats[entrant]!.name,
      swaps: structuredClone(parsed.swaps),
      reasoning: parsed.reasoning,
      notebook: parsed.notebook,
      fallback: defaulted,
    });
    this.cursor += 1;
    return {
      accepted,
      advanced: true,
      defaulted,
      diagnostic,
      ...(problems ? { problems } : {}),
      key,
      ...(defaultSelection ? { defaultSelection } : {}),
    };
  }
}

function withRetry(prompt: string, attempt: number, maximum: number, problems: readonly string[]): string {
  return problems.length
    ? `${prompt}

RETRY ${attempt}/${maximum}: ${problems.join('; ')}`
    : prompt;
}
