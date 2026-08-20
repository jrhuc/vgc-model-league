import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  isStepCount,
  type JSONSchema7,
  jsonSchema,
  type ModelMessage,
  type StepResult,
  ToolLoopAgent,
  type ToolSet,
  tool,
} from 'ai';
import { z } from 'zod';

import { createBoardSearch } from './board-search.js';
import type { DraftBoard, DraftBoardMon } from './draft.js';
import type { DraftTableRow, TeambuildView } from './gui/api.js';
import { BattleLog } from './gui/battlelog.js';
import { appendJsonlObject, readJsonlObjects } from './jsonl.js';
import { FORMAT_AUTHORITY_NOTICE } from './prompts.js';
import type { AgentModel, ModelReasoningConfig, ReasoningLevel } from './providers.js';
import { classifyProviderFailure, makeAgentModel, parseSpec, reasoningForModel } from './providers.js';
import type { RecoveryGate } from './recovery.js';
import { DEX_TOOLS, ShowdownReference } from './reference.js';
import { mapLimit } from './series.js';
import {
  type EvidenceSupplied,
  normalizeStageEvidence,
  noStageEvidence,
  type StageEvidence,
} from './stage-evidence.js';
import type { JsonObject, ProviderFailure } from './types.js';
import { isRecord } from './value.js';

const WEEKLY_REVIEW_PROMPT_POLICY = {
  systemTemplate: [
    'You are {{model}}, a coach in a Pokémon VGC draft league played in the format {{format}}.',
    FORMAT_AUTHORITY_NOTICE,
    '',
    'Round-robin week {{week}} of {{weeks}} is complete. This is your private weekly review: the one point where you revise the notebook that every later team build and transaction decision of yours reads.',
    '- The notebook is yours to organise. It is the only state that carries from week to week; nothing else you write here is kept.',
    '- Every coach builds a new six from its roster for every matchup. Sets, items, moves and spreads you saw this week were built for that one series and may not return.',
    '- Rosters change only in transaction windows. {{windowNotice}}',
    '',
    'You have the Showdown dex tools and three league tools: read_public_series returns the spectator log of any completed series, read_own_series returns your own turn-by-turn choices with their stated reasons and your end-of-game notes, and read_own_build returns the six you registered and your plan. Use them to check anything you intend to write down.',
  ],
  reconcileSystemTemplate: [
    'You are {{model}}, a coach in a Pokémon VGC draft league played in the format {{format}}.',
    FORMAT_AUTHORITY_NOTICE,
    '',
    'The transaction window after round-robin week {{week}} of {{weeks}} has closed and your roster changed. This is your private reconciliation: revise the notebook that every later team build and transaction decision of yours reads so that it describes the roster you now own.',
    '- The notebook is yours to organise. It is the only state that carries from week to week; nothing else you write here is kept.',
    '- Every coach builds a new six from its roster for every matchup.',
    '- {{windowNotice}}',
    '',
    'You have the Showdown dex tools and three league tools: read_public_series returns the spectator log of any completed series, read_own_series returns your own turn-by-turn choices with their stated reasons and your end-of-game notes, and read_own_build returns the six you registered and your plan.',
  ],
  standingsHeading: 'LEAGUE STANDINGS AFTER WEEK {{week}} (rank | coach | W-L | games):',
  ownResultsHeading: 'YOUR SERIES THIS PERIOD:',
  publicResultsHeading: 'OTHER RESULTS THIS PERIOD (series index | result):',
  scheduleHeading: 'YOUR REMAINING SCHEDULE (week | opponent | their current roster):',
  transactionsHeading: 'PUBLIC TRANSACTIONS SO FAR:',
  rosterHeading: 'YOUR ROSTER:',
  previousRosterHeading: 'YOUR ROSTER BEFORE THE WINDOW:',
  currentRosterHeading: 'YOUR ROSTER NOW:',
  notebookHeading: 'YOUR CURRENT NOTEBOOK:',
  replyTemplate: [
    'Reply with one JSON object {"notebook":"<complete replacement private notebook>"}. An optional "reasoning":"<concise private note on what changed and why>" field is recorded as evidence.',
    'Returning the current notebook unchanged is a complete answer.',
  ],
  rejectionTemplate: 'That review was rejected: {{error}} Reply again with only the JSON object.',
  truncatedTemplate:
    'Your previous reply used the whole {{budget}}-token budget before completing the JSON object. Reply now with only the JSON object.',
  notebookLimit: 4_000,
  rationaleLimit: 2_000,
  toolOutputLimit: 24_000,
  maxTokens: 32_768,
  timeoutSeconds: 1800,
  attempts: 3,
  providerRetries: 4,
  toolRounds: 8,
} as const;

export interface WeeklyReviewSeries {
  index: number;
  week: number;
  seriesId: string;
  entrants: [number, number];
  score: [number, number];
  winner: number | null;
  context: Record<number, string>;
  builds: Record<number, TeambuildView | undefined>;
}

export type ReviewStage = 'week' | 'transactions';

export interface WeeklyReviewState {
  board: DraftBoard;
  models: string[];
  stage: ReviewStage;
  week: number;
  weeks: number;
  rosterVersion: number;
  rosters: DraftBoardMon[][];
  notebooks: string[];
  standings: DraftTableRow[];
  series: WeeklyReviewSeries[];
  period: number[];
  schedule: Array<{ index: number; week: number; entrants: [number, number] }>;
  transactions: string[];
  nextWindowWeek: number | null;
  previousRosters?: DraftBoardMon[][];
  seats?: number[];
}

export interface RunWeeklyReviewOptions extends ModelReasoningConfig {
  runDir: string;
  psDir: string;
  concurrency?: number;
  recovery?: RecoveryGate;
  signal?: AbortSignal;
  apiKeys?: Readonly<Record<string, string>>;
  makeReviewModel?: (spec: string, apiKey: string | undefined, reasoning: ReasoningLevel | undefined) => AgentModel;
  onReview?: (review: WeeklyReview) => void;
}

export interface WeeklyReview {
  entrant: number;
  model: string;
  stage: ReviewStage;
  week: number;
  roster_version: number;
  notebook: string;
  reasoning: string;
  evidence_supplied: EvidenceSupplied;
  fallback: boolean;
  previous_digest: string;
  digest: string;
}

interface ReviewSeatLog {
  attempt: number;
  system?: string;
  user: string;
  response: string;
  usage?: Record<string, number>;
  tool_lookups?: { name: string; arguments: JsonObject; result: string }[];
  error?: string;
}

export function weeklyReviewScaffoldRevision(): string {
  return createHash('sha256').update(JSON.stringify(WEEKLY_REVIEW_PROMPT_POLICY)).digest('hex').slice(0, 12);
}

export function notebookDigest(notebook: string): string {
  return createHash('sha256').update(notebook).digest('hex');
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

export function reviewArtifactPaths(
  runDir: string,
  week: number,
  stage: ReviewStage = 'week',
): { transcript: string; logDir: string } {
  const name = stage === 'week' ? `week-${week}` : `week-${week}-transactions`;
  return {
    transcript: path.join(runDir, 'reviews', `${name}.jsonl`),
    logDir: path.join(runDir, 'reviews', name),
  };
}

export function parseWeeklyReview(response: string, currentNotebook: string): StageEvidence | string {
  const match = /\{[\s\S]*\}/.exec(response);
  if (!match) return 'the reply contained no JSON object';
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return 'the JSON object did not parse';
  }
  if (!isRecord(parsed)) return 'the reply must be one JSON object';
  if (typeof parsed.notebook !== 'string')
    return '"notebook" must be a string holding the complete replacement notebook';
  if (parsed.reasoning !== undefined && typeof parsed.reasoning !== 'string') return '"reasoning" must be a string';
  return normalizeStageEvidence(parsed.reasoning, parsed.notebook, {
    currentNotebook,
    rationaleLimit: WEEKLY_REVIEW_PROMPT_POLICY.rationaleLimit,
    notebookLimit: WEEKLY_REVIEW_PROMPT_POLICY.notebookLimit,
  });
}

function renderTemplate(lines: readonly string[], values: Readonly<Record<string, string>>): string {
  return lines
    .map((line) =>
      Object.entries(values).reduce((rendered, [name, value]) => rendered.replaceAll(`{{${name}}}`, value), line),
    )
    .join('\n');
}

function windowNotice(state: WeeklyReviewState): string {
  if (state.nextWindowWeek === null) return 'Rosters are now locked for the rest of the season.';
  if (state.nextWindowWeek === state.week && state.stage === 'week') {
    return 'A transaction window opens as soon as this review closes; your notebook is what you take into it.';
  }
  return `The next transaction window opens after week ${state.nextWindowWeek}.`;
}

function systemPrompt(state: WeeklyReviewState, entrant: number): string {
  const template =
    state.stage === 'week'
      ? WEEKLY_REVIEW_PROMPT_POLICY.systemTemplate
      : WEEKLY_REVIEW_PROMPT_POLICY.reconcileSystemTemplate;
  return renderTemplate(template, {
    model: state.models[entrant]!,
    format: state.board.format,
    week: String(state.week),
    weeks: String(state.weeks),
    windowNotice: windowNotice(state),
  });
}

function rosterLine(roster: readonly DraftBoardMon[]): string {
  return roster.map((mon) => `${mon.name} (${mon.id}, ${mon.cost})`).join(', ');
}

function resultLine(series: WeeklyReviewSeries, models: readonly string[]): string {
  const [a, b] = series.entrants;
  if (series.winner === null) return `${models[a]} drew with ${models[b]} ${series.score[0]}-${series.score[1]}`;
  const loser = series.winner === a ? b : a;
  const [won, lost] = series.winner === a ? series.score : [series.score[1], series.score[0]];
  return `${models[series.winner]} beat ${models[loser]} ${won}-${lost}`;
}

function userPrompt(state: WeeklyReviewState, entrant: number): string {
  const lines: string[] = [WEEKLY_REVIEW_PROMPT_POLICY.standingsHeading.replace('{{week}}', String(state.week))];
  for (const [rank, row] of state.standings.entries()) {
    lines.push(
      `${rank + 1}. entrant ${row.entrant} | ${state.models[row.entrant]} | ${row.w}-${row.l} | ${row.gw}-${row.gl}`,
    );
  }
  if (state.stage === 'week') {
    const period = new Set(state.period);
    lines.push('', WEEKLY_REVIEW_PROMPT_POLICY.ownResultsHeading);
    const own = state.series.filter((series) => period.has(series.index) && series.entrants.includes(entrant));
    if (!own.length) lines.push('- (none)');
    for (const series of own) {
      lines.push(
        `- Series ${series.index}, week ${series.week}: ${series.context[entrant] ?? resultLine(series, state.models)}`,
      );
    }
    lines.push('', WEEKLY_REVIEW_PROMPT_POLICY.publicResultsHeading);
    const others = state.series.filter((series) => period.has(series.index) && !series.entrants.includes(entrant));
    if (!others.length) lines.push('- (none)');
    for (const series of others)
      lines.push(`- Series ${series.index}, week ${series.week}: ${resultLine(series, state.models)}`);
  }
  lines.push('', WEEKLY_REVIEW_PROMPT_POLICY.scheduleHeading);
  const ahead = state.schedule.filter((plan) => plan.week > state.week && plan.entrants.includes(entrant));
  if (!ahead.length) lines.push('- (the round robin is complete; playoffs seed from the standings)');
  for (const plan of ahead) {
    const opponent = plan.entrants[0] === entrant ? plan.entrants[1] : plan.entrants[0];
    lines.push(`- Week ${plan.week} | ${state.models[opponent]} | ${rosterLine(state.rosters[opponent]!)}`);
  }
  lines.push('', WEEKLY_REVIEW_PROMPT_POLICY.transactionsHeading);
  if (!state.transactions.length) lines.push('- (none yet)');
  lines.push(...state.transactions);
  if (state.stage === 'week') {
    lines.push('', `${WEEKLY_REVIEW_PROMPT_POLICY.rosterHeading} ${rosterLine(state.rosters[entrant]!)}`);
  } else {
    lines.push(
      '',
      `${WEEKLY_REVIEW_PROMPT_POLICY.previousRosterHeading} ${rosterLine(state.previousRosters![entrant]!)}`,
      `${WEEKLY_REVIEW_PROMPT_POLICY.currentRosterHeading} ${rosterLine(state.rosters[entrant]!)}`,
    );
  }
  lines.push(
    '',
    WEEKLY_REVIEW_PROMPT_POLICY.notebookHeading,
    state.notebooks[entrant] || '(empty)',
    '',
    ...WEEKLY_REVIEW_PROMPT_POLICY.replyTemplate,
  );
  return lines.join('\n');
}

export function renderWeeklyReviewPrompt(state: WeeklyReviewState, entrant: number): string {
  return [systemPrompt(state, entrant), '', userPrompt(state, entrant)].join('\n');
}

function boundedToolOutput(text: string): string {
  const limit = WEEKLY_REVIEW_PROMPT_POLICY.toolOutputLimit;
  return text.length > limit ? `${text.slice(0, limit)}\n[truncated at ${limit} characters]` : text;
}

function readGameLogs(runDir: string, seriesId: string): string[][] {
  const dir = path.join(runDir, 'series', seriesId);
  const games: string[][] = [];
  for (let game = 1; ; game += 1) {
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(dir, `game-${game}.log`), 'utf8');
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw cause;
    }
    games.push(raw.split('\n'));
  }
  return games;
}

export function narratePublicSeries(runDir: string, series: WeeklyReviewSeries, models: readonly string[]): string {
  const [a, b] = series.entrants;
  const names: Record<string, string> = { P1: models[a]!, P2: models[b]! };
  const lines: string[] = [`Series ${series.index}, week ${series.week}: ${resultLine(series, models)}.`];
  for (const [gameIndex, gameLines] of readGameLogs(runDir, series.seriesId).entries()) {
    const log = new BattleLog(1_000);
    log.feed(gameLines);
    lines.push('', `Game ${gameIndex + 1}:`);
    for (const entry of log.entries) {
      lines.push(
        `${entry.turn ? `T${entry.turn} ` : ''}${entry.text.replace(/\bP([12])\b/g, (_, side) => names[`P${side}`]!)}`,
      );
    }
  }
  return boundedToolOutput(lines.join('\n'));
}

export function narrateOwnSeries(runDir: string, series: WeeklyReviewSeries, entrant: number): string {
  const pid = series.entrants[0] === entrant ? 'p1' : 'p2';
  const rows = readJsonlObjects(path.join(runDir, 'series', series.seriesId, `${pid}-decisions.jsonl`));
  const lines: string[] = [`Series ${series.index}, week ${series.week}, your seat ${pid}.`];
  let game = '';
  for (const row of rows) {
    if (String(row.game_number) !== game) {
      game = String(row.game_number);
      lines.push('', `Game ${game}:`);
    }
    if (row.kind === 'decision') {
      const why = typeof row.rationale === 'string' && row.rationale ? ` — ${row.rationale}` : '';
      lines.push(`${row.phase === 'team_preview' ? 'Preview' : `T${String(row.turn)}`}: ${String(row.action)}${why}`);
    } else if (row.kind === 'game_reflection') {
      lines.push(
        `After the game (${String(row.result)}): ${String(row.summary ?? '')}${row.adjustment ? ` Adjustment: ${String(row.adjustment)}` : ''}`,
      );
    }
  }
  if (series.context[entrant]) lines.push('', `Series note: ${series.context[entrant]}`);
  return boundedToolOutput(lines.join('\n'));
}

export function describeOwnBuild(series: WeeklyReviewSeries, entrant: number, board: DraftBoard): string {
  const build = series.builds[entrant];
  if (!build) return `No stored build for series ${series.index}.`;
  const byId = new Map(board.mons.map((mon) => [mon.id, mon] as const));
  const registered = new Set(build.brought);
  const lines = [`Series ${series.index}, week ${series.week}. Plan: ${build.rationale || '(none)'}`];
  for (const set of build.sets) {
    const investment = Object.entries(set.evs)
      .filter(([, value]) => Number(value) > 0)
      .map(([stat, value]) => `${stat} ${value}`)
      .join('/');
    lines.push(
      `- ${set.species} @ ${set.item}; ${set.ability}; ${set.nature}; ${set.moves.join('/')}; ${investment || '0 investment'}`,
    );
  }
  const left = [...byId.values()].filter(
    (mon) => !registered.has(mon.id) && build.sets.every((set) => set.species !== mon.name),
  );
  if (left.length) lines.push(`Left behind: ${left.map((mon) => mon.name).join(', ')}`);
  return boundedToolOutput(lines.join('\n'));
}

function reviewTools(state: WeeklyReviewState, entrant: number, options: RunWeeklyReviewOptions): ToolSet {
  const reference = new ShowdownReference(state.board.format, options.psDir);
  const boardSearch = createBoardSearch(state.board, options.psDir);
  const tools: ToolSet = {};
  for (const definition of [...DEX_TOOLS, boardSearch.definition]) {
    tools[definition.name] = tool({
      description: definition.description,
      inputSchema: jsonSchema(definition.parameters as JSONSchema7),
      execute: (input) =>
        definition.name === boardSearch.definition.name
          ? boardSearch.run(input as JsonObject)
          : reference.lookup(definition.name, input as Record<string, unknown>),
    });
  }
  const completed = new Map(state.series.map((series) => [series.index, series] as const));
  const seriesIndex = z.object({ series_index: z.number().int().nonnegative() });
  tools.read_public_series = tool({
    description:
      'The spectator log of one completed series this season: registrations, leads, every turn, and the result.',
    inputSchema: seriesIndex,
    execute: ({ series_index }) => {
      const series = completed.get(series_index);
      return series
        ? narratePublicSeries(options.runDir, series, state.models)
        : `Series ${series_index} has not been completed yet or does not exist.`;
    },
  });
  tools.read_own_series = tool({
    description:
      'Your own choices in one of your completed series, with the reasons you gave at the time and your end-of-game notes.',
    inputSchema: seriesIndex,
    execute: ({ series_index }) => {
      const series = completed.get(series_index);
      if (!series || !series.entrants.includes(entrant))
        return `Series ${series_index} is not one of your completed series.`;
      return narrateOwnSeries(options.runDir, series, entrant);
    },
  });
  tools.read_own_build = tool({
    description: 'The six you registered for one of your completed series and the plan you wrote for it.',
    inputSchema: seriesIndex,
    execute: ({ series_index }) => {
      const series = completed.get(series_index);
      if (!series || !series.entrants.includes(entrant))
        return `Series ${series_index} is not one of your completed series.`;
      return describeOwnBuild(series, entrant, state.board);
    },
  });
  return tools;
}

function usageRecord(steps: ReadonlyArray<StepResult<ToolSet>>): Record<string, number> {
  const usage: Record<string, number> = { input_tokens: 0, output_tokens: 0 };
  let reasoning = 0;
  let cached = 0;
  let cost = 0;
  for (const step of steps) {
    usage.input_tokens! += step.usage.inputTokens ?? 0;
    usage.output_tokens! += step.usage.outputTokens ?? 0;
    reasoning += step.usage.outputTokenDetails?.reasoningTokens ?? 0;
    cached += step.usage.inputTokenDetails?.cacheReadTokens ?? 0;
    const gateway = isRecord(step.providerMetadata?.openrouter) ? step.providerMetadata.openrouter : undefined;
    if (typeof gateway?.cost === 'number') cost += gateway.cost;
  }
  if (reasoning > 0) usage.reasoning_tokens = reasoning;
  if (cached > 0) usage.cached_input_tokens = cached;
  if (cost > 0) usage.cost = cost;
  return usage;
}

function lookupsOf(
  steps: ReadonlyArray<StepResult<ToolSet>>,
): { name: string; arguments: JsonObject; result: string }[] {
  const lookups: { name: string; arguments: JsonObject; result: string }[] = [];
  for (const step of steps) {
    for (const result of step.toolResults) {
      lookups.push({
        name: result.toolName,
        arguments: (isRecord(result.input) ? result.input : {}) as JsonObject,
        result: typeof result.output === 'string' ? result.output : JSON.stringify(result.output),
      });
    }
  }
  return lookups;
}

function replayReviews(file: string): WeeklyReview[] {
  return readJsonlObjects(file).map((row, index) => {
    const { timestamp, ...review } = row;
    const supplied = review.evidence_supplied;
    const valid =
      Number.isSafeInteger(review.entrant) &&
      Number(review.entrant) >= 0 &&
      typeof review.model === 'string' &&
      (review.stage === 'week' || review.stage === 'transactions') &&
      Number.isSafeInteger(review.week) &&
      Number.isSafeInteger(review.roster_version) &&
      typeof review.notebook === 'string' &&
      typeof review.reasoning === 'string' &&
      isRecord(supplied) &&
      typeof supplied.rationale === 'boolean' &&
      typeof supplied.notebookUpdate === 'boolean' &&
      typeof review.fallback === 'boolean' &&
      typeof review.previous_digest === 'string' &&
      review.digest === notebookDigest(review.notebook) &&
      (timestamp === undefined || typeof timestamp === 'string');
    if (!valid) throw new Error(`invalid weekly review row ${index + 1} in ${file}`);
    return review as unknown as WeeklyReview;
  });
}

export function readWeeklyReviews(runDir: string, week: number, stage: ReviewStage = 'week'): WeeklyReview[] {
  return replayReviews(reviewArtifactPaths(runDir, week, stage).transcript);
}

export async function runWeeklyReview(
  state: WeeklyReviewState,
  options: RunWeeklyReviewOptions,
): Promise<WeeklyReview[]> {
  const { transcript, logDir } = reviewArtifactPaths(options.runDir, state.week, state.stage);
  const reviews = replayReviews(transcript);
  for (const review of reviews) {
    if (review.stage !== state.stage || review.week !== state.week || review.roster_version !== state.rosterVersion) {
      throw new Error(`${transcript} holds a review for week ${review.week} roster version ${review.roster_version}`);
    }
    if (review.previous_digest !== notebookDigest(state.notebooks[review.entrant] ?? '')) {
      throw new Error(`${transcript} entrant ${review.entrant} review does not continue the current notebook`);
    }
    state.notebooks[review.entrant] = review.notebook;
  }
  const pending = (state.seats ?? state.models.map((_, entrant) => entrant)).filter(
    (entrant) => !reviews.some((r) => r.entrant === entrant),
  );
  const byEntrant = (a: WeeklyReview, b: WeeklyReview) => a.entrant - b.entrant;
  if (!pending.length) return reviews.sort(byEntrant);
  fs.mkdirSync(logDir, { recursive: true });

  const fresh = await mapLimit(
    pending,
    options.concurrency ?? pending.length,
    options.signal,
    async (entrant, signal) => {
      signal.throwIfAborted();
      const model = state.models[entrant]!;
      const current = state.notebooks[entrant] ?? '';
      const make =
        options.makeReviewModel ??
        ((spec: string, apiKey: string | undefined, reasoning: ReasoningLevel | undefined) =>
          makeAgentModel(parseSpec(spec), {
            ...(reasoning === undefined ? {} : { reasoning }),
            ...(apiKey === undefined ? {} : { apiKey }),
          }));
      const agentModel =
        model === 'random' ? undefined : make(model, options.apiKeys?.[model], reasoningForModel(model, options));
      let evidence: StageEvidence | undefined;
      let fallback = false;
      if (agentModel) {
        const system = systemPrompt(state, entrant);
        const agent = new ToolLoopAgent({
          model: agentModel.model,
          instructions: system,
          tools: reviewTools(state, entrant, options),
          stopWhen: isStepCount(WEEKLY_REVIEW_PROMPT_POLICY.toolRounds + 1),
          prepareStep: ({ stepNumber }) =>
            stepNumber >= WEEKLY_REVIEW_PROMPT_POLICY.toolRounds ? { toolChoice: 'none' as const } : {},
          maxOutputTokens: WEEKLY_REVIEW_PROMPT_POLICY.maxTokens,
          temperature: 0.2,
          maxRetries: WEEKLY_REVIEW_PROMPT_POLICY.providerRetries - 1,
          ...(agentModel.reasoning === undefined ? {} : { reasoning: agentModel.reasoning }),
        });
        const messages: ModelMessage[] = [{ role: 'user', content: userPrompt(state, entrant) }];
        const seatLog = path.join(logDir, `seat-${entrant}-${slug(model)}.jsonl`);
        for (let attempt = 1; attempt <= WEEKLY_REVIEW_PROMPT_POLICY.attempts && !evidence; attempt += 1) {
          const last = messages[messages.length - 1]!;
          const promptForAttempt = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
          let response = '';
          let usage: Record<string, number> | undefined;
          let lookups: ReviewSeatLog['tool_lookups'];
          let error: string | undefined;
          let terminalError: Error | undefined;
          let pauseFailure: ProviderFailure | undefined;
          try {
            await options.recovery?.wait(model, signal);
            const result = await agent.generate({
              messages,
              abortSignal: signal,
              timeout: { totalMs: WEEKLY_REVIEW_PROMPT_POLICY.timeoutSeconds * 1000 },
            });
            response = result.text;
            usage = usageRecord(result.steps);
            lookups = lookupsOf(result.steps);
            const truncated = result.finishReason === 'length';
            const candidate = truncated
              ? 'the reply was cut off before completing the JSON object'
              : parseWeeklyReview(response, current);
            if (typeof candidate === 'string') {
              error = candidate;
              messages.push(...result.responseMessages);
              messages.push({
                role: 'user',
                content: truncated
                  ? WEEKLY_REVIEW_PROMPT_POLICY.truncatedTemplate.replace(
                      '{{budget}}',
                      String(WEEKLY_REVIEW_PROMPT_POLICY.maxTokens),
                    )
                  : WEEKLY_REVIEW_PROMPT_POLICY.rejectionTemplate.replace('{{error}}', candidate),
              });
            } else {
              evidence = candidate;
            }
          } catch (cause) {
            const failure = classifyProviderFailure(agentModel.redact(cause), model);
            error = failure.summary;
            if (failure.pausable && options.recovery) pauseFailure = failure;
            else terminalError = new Error(`${failure.summary} The weekly review cannot continue.`, { cause });
          }
          fs.appendFileSync(
            seatLog,
            `${JSON.stringify({
              attempt,
              ...(attempt === 1 ? { system } : {}),
              user: promptForAttempt,
              response,
              ...(usage ? { usage } : {}),
              ...(lookups?.length ? { tool_lookups: lookups } : {}),
              ...(error ? { error } : {}),
            } satisfies ReviewSeatLog)}\n`,
            'utf8',
          );
          if (terminalError) throw terminalError;
          if (pauseFailure) {
            await options.recovery?.pause(model, pauseFailure, signal);
            attempt -= 1;
          }
        }
        fallback = evidence === undefined;
      }
      evidence ??= noStageEvidence(current);
      const review: WeeklyReview = {
        entrant,
        model,
        stage: state.stage,
        week: state.week,
        roster_version: state.rosterVersion,
        notebook: evidence.notebook,
        reasoning: evidence.rationale,
        evidence_supplied: evidence.supplied,
        fallback,
        previous_digest: notebookDigest(current),
        digest: notebookDigest(evidence.notebook),
      };
      appendJsonlObject(transcript, { ...review, timestamp: new Date().toISOString() });
      state.notebooks[entrant] = review.notebook;
      options.onReview?.(review);
      return review;
    },
  );
  reviews.push(...fresh);
  return reviews.sort(byEntrant);
}
