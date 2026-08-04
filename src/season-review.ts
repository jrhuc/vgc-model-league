import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { completeWithDexTools } from './dex-lookups.js';
import type { DraftBoard, DraftBoardMon } from './draft.js';
import type { DraftPickView, DraftTableRow } from './gui/api.js';
import type { ModelReasoningConfig, ReasoningLevel } from './providers.js';
import {
  classifyProviderFailure,
  makeProvider,
  parseSpec,
  reasoningForModel,
  resolveSpecOverride,
} from './providers.js';
import type { RecoveryGate } from './recovery.js';
import { ShowdownReference } from './reference.js';
import type { TradeWindowArtifact } from './trade-window.js';
import type { JsonObject, Provider, ProviderFailure, ProviderMessage } from './types.js';
import { clip } from './value.js';

const SEASON_REVIEW_PROMPT_POLICY = {
  systemTemplate: [
    'You are {{model}}, a coach in a Pokémon VGC draft league played in the format {{format}}. Your season is over.',
    '',
    'This is a retrospective, not a decision. Nothing you write changes a result; it is published on your team page.',
    '- Judge the whole season: the roster you drafted, what you did with the free-agency window, the six you registered for each series, and how you piloted them.',
    '- Say which of those three a result belongs to. A series lost to a hole no registration could cover is a draft or window result, not a piloting one, and the reverse also holds.',
    '- Name the specific picks, swaps, and games that decided your season. General principles about VGC are not an answer.',
    '- Credit what you got right as plainly as what you got wrong. A season that went well still had weak spots, and a season that went badly still had sound calls.',
    '- Keeping a roster unchanged at the window was a decision like any other; judge it as one.',
    '',
    'You have the same Showdown dex tools as during the draft. Use them only to check a fact you intend to state.',
  ],
  outcomeHeading: 'HOW YOUR SEASON ENDED:',
  standingsHeading: 'FINAL LEAGUE STANDINGS (rank | team | W-L | games):',
  draftHeading: 'YOUR DRAFT (pick | name | cost | your reasoning at the time):',
  windowHeading: 'YOUR FREE-AGENCY WINDOW:',
  rosterHeading: 'YOUR FINAL ROSTER:',
  seasonHeading: 'YOUR SERIES, IN ORDER:',
  wordsHeading: 'YOUR PRIVATE WORDS:',
  replyTemplate: [
    'Reply with one JSON object {"summary":"<1-2 sentences on how the season went>","did_well":"<2-4 sentences>","did_poorly":"<2-4 sentences>","would_change":"<2-4 sentences, each one concrete>"}.',
  ],
  rejectionTemplate: 'That review was rejected: {{error}} Reply again with only the JSON object.',
  truncatedTemplate:
    'Your previous reply used the whole {{budget}}-token budget before completing the JSON object. Reply now with only the JSON object.',
  fieldLimit: 2_000,
  maxTokens: 32_768,
  timeoutSeconds: 600,
  attempts: 3,
  providerRetries: 4,
  retryBaseMs: 2_000,
  toolRounds: 6,
  maxCallsPerRound: 6,
} as const;

export interface SeasonReview {
  entrant: number;
  model: string;
  outcome: string;
  summary: string;
  did_well: string;
  did_poorly: string;
  would_change: string;
  fallback: boolean;
}

export interface SeasonReviewState {
  board: DraftBoard;
  models: string[];
  teamNames: string[];
  picks: DraftPickView[];
  rosters: DraftBoardMon[][];
  window: TradeWindowArtifact | undefined;
  standings: DraftTableRow[];
  series: string[][];
  notebooks: string[];
}

export interface RunSeasonReviewOptions extends ModelReasoningConfig {
  runDir: string;
  psDir: string;
  recovery?: RecoveryGate;
  signal?: AbortSignal;
  apiKeys?: Readonly<Record<string, string>>;
  makeReviewProvider?: (spec: string, apiKey: string | undefined, reasoning: ReasoningLevel | undefined) => Provider;
  onReview?: (review: SeasonReview) => void;
}

interface ParsedSeasonReview {
  summary: string;
  did_well: string;
  did_poorly: string;
  would_change: string;
}

interface SeasonSeatLog {
  attempt: number;
  system?: string;
  user: string;
  response: string;
  usage?: Record<string, number>;
  tool_lookups?: { name: string; arguments: JsonObject; result: string }[];
  error?: string;
}

export function seasonReviewScaffoldRevision(): string {
  return createHash('sha256').update(JSON.stringify(SEASON_REVIEW_PROMPT_POLICY)).digest('hex').slice(0, 12);
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 48) || 'model'
  );
}

export function parseSeasonReview(response: string): ParsedSeasonReview | string {
  const match = /\{[\s\S]*\}/.exec(response);
  if (!match) return 'the reply contained no JSON object';
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return 'the JSON object did not parse';
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return 'the reply must be one JSON object';
  }
  const record = parsed as Record<string, unknown>;
  const fields = ['summary', 'did_well', 'did_poorly', 'would_change'] as const;
  const values: Record<string, string> = {};
  for (const field of fields) {
    const value = record[field];
    if (typeof value !== 'string' || !value.trim()) return `"${field}" must be a non-empty string`;
    values[field] = clip(value.trim(), SEASON_REVIEW_PROMPT_POLICY.fieldLimit);
  }
  return {
    summary: values.summary!,
    did_well: values.did_well!,
    did_poorly: values.did_poorly!,
    would_change: values.would_change!,
  };
}

function systemPrompt(state: SeasonReviewState, entrant: number): string {
  const values: Record<string, string> = {
    model: state.models[entrant]!,
    format: state.board.format,
  };
  return SEASON_REVIEW_PROMPT_POLICY.systemTemplate
    .map((line) =>
      Object.entries(values).reduce(
        (rendered, [name, value]) => rendered.replaceAll(`{{${name}}}`, value),
        line as string,
      ),
    )
    .join('\n');
}

function userPrompt(state: SeasonReviewState, entrant: number, outcome: string): string {
  const byId = new Map(state.board.mons.map((mon) => [mon.id, mon] as const));
  const name = (id: string) => byId.get(id)?.name ?? id;
  const lines: string[] = [
    SEASON_REVIEW_PROMPT_POLICY.outcomeHeading,
    outcome,
    '',
    SEASON_REVIEW_PROMPT_POLICY.standingsHeading,
  ];
  for (const [rank, row] of state.standings.entries()) {
    lines.push(
      `${rank + 1}. ${state.teamNames[row.entrant] || state.models[row.entrant]} | ${row.w}-${row.l} | ${row.gw}-${row.gl}`,
    );
  }

  lines.push('', SEASON_REVIEW_PROMPT_POLICY.draftHeading);
  const own = state.picks.filter((pick) => pick.entrant === entrant).sort((a, b) => a.pick - b.pick);
  if (!own.length) lines.push('- (no stored draft)');
  for (const pick of own) {
    const mon = byId.get(pick.mon);
    lines.push(
      `- Pick ${pick.pick + 1}: ${mon?.name ?? pick.mon} (${mon?.cost ?? '?'} pts)${pick.fallback ? ' [fallback pick]' : ''} — ${pick.rationale || '(no stored reasoning)'}`,
    );
  }

  lines.push('', SEASON_REVIEW_PROMPT_POLICY.windowHeading);
  if (!state.window) {
    lines.push('- This league locked rosters after the draft; there was no free-agency window.');
  } else {
    const decision = state.window.decisions.find((entry) => entry.entrant === entrant);
    lines.push(
      `- The window opened after week ${state.window.after_week}, with coaches choosing in inverse standings order.`,
    );
    if (!decision) lines.push('- (no stored decision)');
    else {
      lines.push(
        decision.swaps.length
          ? `- You made ${decision.swaps.length} swap${decision.swaps.length === 1 ? '' : 's'}: ${decision.swaps
              .map((swap) => `dropped ${name(swap.drop)} for ${name(swap.add)}`)
              .join('; ')}.`
          : '- You made no swaps and kept the roster you drafted.',
      );
      lines.push(`- Your reasoning at the time: ${decision.reasoning || '(none recorded)'}`);
    }
    for (const other of state.window.decisions) {
      if (other.entrant === entrant) continue;
      const team = state.teamNames[other.entrant] || state.models[other.entrant];
      lines.push(
        other.swaps.length
          ? `- ${team}: ${other.swaps.map((swap) => `-${name(swap.drop)} +${name(swap.add)}`).join(', ')}`
          : `- ${team}: kept its roster`,
      );
    }
  }

  lines.push(
    '',
    `${SEASON_REVIEW_PROMPT_POLICY.rosterHeading} ${state.rosters[entrant]!.map((mon) => `${mon.name} (${mon.cost})`).join(', ')}`,
  );

  lines.push('', SEASON_REVIEW_PROMPT_POLICY.seasonHeading);
  const series = state.series[entrant] ?? [];
  if (!series.length) lines.push('- (none recorded)');
  for (const entry of series) lines.push(`- ${entry}`);

  lines.push(
    '',
    SEASON_REVIEW_PROMPT_POLICY.wordsHeading,
    `- Final draft notebook: ${state.notebooks[entrant] || '(empty)'}`,
    '',
    ...SEASON_REVIEW_PROMPT_POLICY.replyTemplate,
  );
  return lines.join('\n');
}

/** Reviews already written are replayed rather than re-bought, so a resumed league never pays twice for a
 * retrospective whose season is already closed. */
function replayReviews(file: string): SeasonReview[] {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const rows: SeasonReview[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const { timestamp: _timestamp, ...review } = JSON.parse(line) as SeasonReview & { timestamp?: string };
    rows.push(review as SeasonReview);
  }
  return rows;
}

export async function runSeasonReview(
  finished: ReadonlyArray<{ entrant: number; outcome: string }>,
  state: SeasonReviewState,
  options: RunSeasonReviewOptions,
): Promise<SeasonReview[]> {
  const transcript = path.join(options.runDir, 'season.jsonl');
  const logDir = path.join(options.runDir, 'season');
  const reviews = replayReviews(transcript);
  const pending = finished.filter((entry) => !reviews.some((review) => review.entrant === entry.entrant));
  if (!pending.length) return reviews;
  fs.mkdirSync(logDir, { recursive: true });
  const reference = new ShowdownReference(state.board.format, options.psDir);

  for (const { entrant, outcome } of pending) {
    options.signal?.throwIfAborted();
    const model = state.models[entrant]!;
    const make =
      options.makeReviewProvider ??
      ((spec: string, apiKey: string | undefined, reasoning: ReasoningLevel | undefined) => {
        const resolved = resolveSpecOverride(spec);
        return makeProvider(parseSpec(resolved), {
          ...(reasoning === undefined ? {} : { reasoning }),
          ...(resolved === spec && apiKey !== undefined ? { apiKey } : {}),
        });
      });
    const provider =
      model === 'random' ? undefined : make(model, options.apiKeys?.[model], reasoningForModel(model, options));
    let parsed: ParsedSeasonReview | undefined;
    let fallback = false;
    let lastError = '';
    const system = systemPrompt(state, entrant);
    if (provider) {
      const messages: ProviderMessage[] = [{ role: 'user', content: userPrompt(state, entrant, outcome) }];
      const seatLog = path.join(logDir, `seat-${entrant}-${slug(model)}.jsonl`);
      for (let attempt = 1; attempt <= SEASON_REVIEW_PROMPT_POLICY.attempts && !parsed; attempt += 1) {
        const promptForAttempt = messages[messages.length - 1]!.content ?? '';
        let response = '';
        let usage: Record<string, number> | undefined;
        let error: string | undefined;
        let terminalError: Error | undefined;
        let pauseFailure: ProviderFailure | undefined;
        const lookups: { name: string; arguments: JsonObject; result: string }[] = [];
        try {
          const completion = await completeWithDexTools({
            provider,
            system,
            messages,
            spec: model,
            reference,
            policy: SEASON_REVIEW_PROMPT_POLICY,
            ...(options.recovery === undefined ? {} : { recovery: options.recovery }),
            ...(options.signal === undefined ? {} : { signal: options.signal }),
            onLookup: (call) => lookups.push(call),
          });
          response = completion.text;
          usage = completion.usage;
          const candidate = parseSeasonReview(response || completion.reasoning || '');
          if (typeof candidate === 'string') {
            error =
              completion.finishReason === 'length' ? 'the reply was cut off before completing the review' : candidate;
            lastError = error;
            messages.push({ role: 'assistant', content: response || '[the reply contained no visible text]' });
            messages.push({
              role: 'user',
              content:
                completion.finishReason === 'length'
                  ? SEASON_REVIEW_PROMPT_POLICY.truncatedTemplate.replace(
                      '{{budget}}',
                      String(SEASON_REVIEW_PROMPT_POLICY.maxTokens),
                    )
                  : SEASON_REVIEW_PROMPT_POLICY.rejectionTemplate.replace('{{error}}', candidate),
            });
          } else {
            parsed = candidate;
          }
        } catch (cause) {
          const failure = classifyProviderFailure(cause, model);
          error = failure.summary;
          lastError = error;
          if (failure.pausable && options.recovery) pauseFailure = failure;
          else terminalError = new Error(`${failure.summary} The season review cannot continue.`, { cause });
        }
        fs.appendFileSync(
          seatLog,
          `${JSON.stringify({
            attempt,
            ...(attempt === 1 ? { system } : {}),
            user: promptForAttempt,
            response,
            ...(usage ? { usage } : {}),
            ...(lookups.length ? { tool_lookups: lookups } : {}),
            ...(error ? { error } : {}),
          } satisfies SeasonSeatLog)}\n`,
          'utf8',
        );
        if (terminalError) throw terminalError;
        if (pauseFailure) {
          await options.recovery?.pause(model, pauseFailure.kind, pauseFailure.summary, options.signal);
          attempt -= 1;
        }
      }
    }
    if (!parsed) {
      const reason = provider
        ? `no review was recorded after ${SEASON_REVIEW_PROMPT_POLICY.attempts} rejected replies (${lastError})`
        : 'the random baseline files no review';
      parsed = { summary: reason, did_well: reason, did_poorly: reason, would_change: reason };
      fallback = Boolean(provider);
    }
    const review: SeasonReview = { entrant, model, outcome, ...parsed, fallback };
    reviews.push(review);
    fs.appendFileSync(transcript, `${JSON.stringify({ ...review, timestamp: new Date().toISOString() })}\n`, 'utf8');
    options.onReview?.(review);
  }
  return reviews;
}

export function readSeasonReviews(runDir: string): SeasonReview[] {
  return replayReviews(path.join(runDir, 'season.jsonl'));
}
