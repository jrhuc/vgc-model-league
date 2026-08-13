import { DRAFT_PROTOCOL_VERSION } from '../draftleague.js';
import { draftLeagueTopology } from '../draftleague-topology.js';
import { providerOption } from '../provider-registry.js';
import type { ModelReasoningConfig, ReasoningLevel } from '../providers.js';
import { isReasoningLevel, nitroSpec, parseSpec, validateReasoning } from '../providers.js';
import { ROTATION_PROTOCOL_VERSION } from '../rotation.js';
import type { Team } from '../teams.js';
import { parseTimerScale } from '../timer.js';
import type { ProvenanceMode } from '../tournament.js';
import { TOURNAMENT_PROTOCOL_VERSION } from '../tournament.js';
import { DEFAULT_TRADE_WINDOW, MAX_TRADE_OFFERS, type TradeWindowConfig } from '../trade-window.js';
import type { ExperimentMode, TimerScale } from '../types.js';
import { isRecord } from '../value.js';

export interface RunConfig extends ModelReasoningConfig {
  mode: ExperimentMode;
  protocolVersion: number;
  models: string[];
  seriesPerPair: number;
  pool: string;
  concurrency: number;
  teams?: Team[];
  format?: string;
  board?: string;
  seed?: number;
  timerScale?: TimerScale;
  closedSheets?: boolean;
  sequentialWeeks?: boolean;
  tradeWindow?: TradeWindowConfig | null;
  draftOnly?: boolean;
  provenance?: ProvenanceMode;
}

export interface ParsedRunRequest {
  config: RunConfig;
  apiKeys: Record<string, string>;
}

interface RunBoard {
  id: string;
  maxEntrants: number;
}

interface RunPool {
  name: string;
  teamCount: number;
}

interface RunFormat {
  id: string;
}

export interface RunRequestContext {
  boards: readonly RunBoard[];
  pools: readonly RunPool[];
  formats: readonly RunFormat[];
  defaultFormatId: string;
  packAndValidateTeam: (paste: string, format: string) => string;
}

export class RunRequestError extends Error {}

function invalid(message: string): never {
  throw new RunRequestError(message);
}

function clampInt(value: unknown, minimum: number, maximum: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

export function parseRunRequest(
  body: Readonly<Record<string, unknown>>,
  context: Readonly<RunRequestContext>,
): ParsedRunRequest {
  const mode = (
    body.mode === undefined || body.mode === 'rotation'
      ? 'rotation'
      : body.mode === 'tournament' || body.mode === 'draft'
        ? body.mode
        : undefined
  ) as ExperimentMode | undefined;
  if (!mode) invalid('unknown run mode');

  const rawModels = Array.isArray(body.models) ? body.models.map(String).filter(Boolean) : [];
  const models = body.nitro === true ? rawModels.map(nitroSpec) : rawModels;
  const effectiveModel = (model: string): string =>
    models.includes(model) ? model : rawModels.includes(model) && body.nitro === true ? nitroSpec(model) : model;
  if (models.length < 2) invalid('a run needs at least two model specs');
  if (models.length > 8) invalid('a run supports at most 8 model specs');

  const reasoningValue = body.reasoning ? String(body.reasoning) : undefined;
  if (reasoningValue && !isReasoningLevel(reasoningValue)) {
    invalid('reasoning must be one of: minimal, low, medium, high, xhigh');
  }
  const reasoning = reasoningValue as ReasoningLevel | undefined;
  if (body.reasoningByModel !== undefined && !isRecord(body.reasoningByModel)) {
    invalid('reasoningByModel must be an object');
  }
  const reasoningByModel: Record<string, ReasoningLevel> = {};
  for (const [rawModel, value] of Object.entries(isRecord(body.reasoningByModel) ? body.reasoningByModel : {})) {
    const model = effectiveModel(rawModel);
    if (!models.includes(model)) invalid(`reasoning configured for unselected model ${rawModel}`);
    if (model === 'random') invalid('random does not support configurable reasoning');
    if (!isReasoningLevel(value)) {
      invalid(`reasoning for ${rawModel} must be one of: minimal, low, medium, high, xhigh`);
    }
    reasoningByModel[model] = value;
  }
  if (reasoning && Object.keys(reasoningByModel).length) {
    invalid('choose either shared reasoning or per-model reasoning, not both');
  }

  const suppliedKeys = isRecord(body.apiKeys) ? body.apiKeys : {};
  const apiKeys: Record<string, string> = {};
  const missing: string[] = [];
  for (const [index, model] of models.entries()) {
    if (model === 'random') continue;
    try {
      const spec = parseSpec(model);
      validateReasoning(spec, reasoningByModel[model] ?? reasoning);
      const suppliedKey = suppliedKeys[model] ?? suppliedKeys[rawModels[index]!];
      const apiKey = typeof suppliedKey === 'string' ? suppliedKey.trim() : '';
      const option = providerOption(spec.provider);
      const requiresKey = option?.requiresKey ?? true;
      if (!apiKey && requiresKey) {
        missing.push(`${option?.label ?? spec.provider} (${model})`);
      } else {
        apiKeys[model] = apiKey || 'none';
      }
    } catch (error) {
      invalid(error instanceof Error ? error.message : String(error));
    }
  }
  if (missing.length) invalid(`API key required for: ${missing.join(', ')}`);

  const inlinePastes = mode === 'tournament' && Array.isArray(body.teams) ? body.teams.map(String) : undefined;
  let pool = '';
  let teams: Team[] | undefined;
  let format: string | undefined;
  let board: string | undefined;
  if (mode === 'draft') {
    const boards = context.boards;
    board = String(body.board ?? '') || boards[0]?.id || '';
    const info = boards.find((entry) => entry.id === board);
    if (!info) invalid(`unknown draft board ${JSON.stringify(board)}`);
    if (models.length > info.maxEntrants) {
      invalid(`board ${JSON.stringify(board)} supports at most ${info.maxEntrants} models`);
    }
  } else if (inlinePastes) {
    if (inlinePastes.length !== models.length) invalid('provide exactly one team paste per model');
    format = String(body.format ?? '').trim() || context.defaultFormatId;
    const formats = context.formats;
    if (!formats.some((info) => info.id === format)) {
      invalid(`unknown format ${JSON.stringify(format)}`);
    }
    teams = inlinePastes.map((paste, index) => {
      if (!paste.trim() || paste.length > 20_000) {
        invalid(`team ${index + 1} must be a non-empty paste under 20k characters`);
      }
      try {
        return { id: `paste-${index + 1}`, packed: context.packAndValidateTeam(paste, format!) };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return invalid(`team ${index + 1} is not legal in ${format}: ${detail}`);
      }
    });
  } else {
    pool = String(body.pool ?? '');
    const pools = context.pools;
    const info = pools.find((entry) => entry.name === pool);
    if (!info) invalid(`unknown team pool ${JSON.stringify(pool)}`);
    if (mode === 'tournament' && info.teamCount < models.length) {
      invalid(`pool ${JSON.stringify(pool)} has ${info.teamCount} teams for ${models.length} entrants`);
    }
  }

  const seed = body.seed === undefined || body.seed === null || body.seed === '' ? undefined : Number(body.seed);
  if (seed !== undefined && !Number.isSafeInteger(seed)) invalid('seed must be an integer');
  let timerScale: TimerScale | undefined;
  try {
    timerScale = parseTimerScale(body.timerScale);
  } catch (error) {
    invalid(error instanceof Error ? error.message : String(error));
  }

  let tradeWindow: TradeWindowConfig | null | undefined;
  if (mode === 'draft') {
    const weeks = draftLeagueTopology(models.length).weekCount;
    if (body.tradeWindow === undefined) {
      tradeWindow = { afterWeek: Math.min(3, weeks), tradesAllowed: DEFAULT_TRADE_WINDOW.tradesAllowed };
    } else if (body.tradeWindow === null) {
      tradeWindow = null;
    } else if (isRecord(body.tradeWindow)) {
      const afterWeek = Number(body.tradeWindow.afterWeek);
      if (!Number.isSafeInteger(afterWeek) || afterWeek < 1 || afterWeek > weeks) {
        invalid(`trade window week must be between 1 and ${weeks}`);
      }
      const tradesAllowed =
        body.tradeWindow.tradesAllowed === undefined
          ? DEFAULT_TRADE_WINDOW.tradesAllowed
          : Number(body.tradeWindow.tradesAllowed);
      if (!Number.isSafeInteger(tradesAllowed) || tradesAllowed < 0 || tradesAllowed > MAX_TRADE_OFFERS) {
        invalid(`trade window tradesAllowed must be an integer between 0 and ${MAX_TRADE_OFFERS}`);
      }
      tradeWindow = { afterWeek, tradesAllowed };
    } else {
      invalid('tradeWindow must be null or an object with afterWeek');
    }
  }

  return {
    config: {
      mode,
      protocolVersion:
        mode === 'tournament'
          ? TOURNAMENT_PROTOCOL_VERSION
          : mode === 'draft'
            ? DRAFT_PROTOCOL_VERSION
            : ROTATION_PROTOCOL_VERSION,
      models,
      seriesPerPair: mode === 'rotation' ? clampInt(body.seriesPerPair, 1, 20, 2) : 1,
      pool,
      concurrency: clampInt(body.concurrency, 1, 8, 2),
      ...(teams === undefined ? {} : { teams }),
      ...(format === undefined ? {} : { format }),
      ...(board === undefined ? {} : { board }),
      ...(seed === undefined ? {} : { seed }),
      ...(reasoning === undefined ? {} : { reasoning }),
      ...(Object.keys(reasoningByModel).length ? { reasoningByModel } : {}),
      ...(timerScale === undefined ? {} : { timerScale }),
      ...(mode === 'draft' && body.closedSheets === true ? { closedSheets: true } : {}),
      ...(mode === 'draft' && body.sequentialWeeks === true ? { sequentialWeeks: true } : {}),
      ...(mode === 'draft' ? { tradeWindow: tradeWindow! } : {}),
      ...(mode === 'draft' && body.draftOnly === true ? { draftOnly: true } : {}),
      ...(mode === 'tournament' && body.provenance === 'blind' ? { provenance: 'blind' as const } : {}),
    },
    apiKeys,
  };
}
