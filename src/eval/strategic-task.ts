import { seededRng, shuffle } from '../random.js';
import { scoreReferenceAction, type ReferenceActionScore, type ReferenceSuiteResult } from './reference-suite.js';
import { canonicalJsonDigest } from './serialization.js';

export const STRATEGIC_CHOICE_TASK_PROTOCOL = {
  version: 1,
  actionIdentity: 'opaque-task-salt-canonical-action-digest-v1',
  presentation: 'seeded-shuffle-v1',
  response: 'strict-json-action-and-declared-forecasts-v1',
  invalidOutput: 'separate-endpoint-no-implicit-utility-v1',
} as const;

export type StrategicForecastMode = 'action-only' | 'binary-forecast' | 'opponent-mode-forecast';

export interface StrategicTaskActionInput {
  canonicalAction: string;
  label: string;
}

export interface StrategicPublicAction {
  actionId: string;
  label: string;
}

export interface StrategicPrivateAction extends StrategicPublicAction {
  canonicalAction: string;
}

export interface StrategicChoiceTaskPublic {
  protocolVersion: typeof STRATEGIC_CHOICE_TASK_PROTOCOL.version;
  id: string;
  format: string;
  phase: string;
  forecastMode: StrategicForecastMode;
  prompt: string;
  actions: StrategicPublicAction[];
  presentationDigest: string;
}

export interface StrategicChoiceTaskPrivate {
  taskId: string;
  actions: StrategicPrivateAction[];
  actionMapDigest: string;
}

export interface StrategicChoiceTaskPackage {
  public: StrategicChoiceTaskPublic;
  private: StrategicChoiceTaskPrivate;
}

export interface OpponentModeProbability {
  id: string;
  p: number;
}

export interface ParsedStrategicChoice {
  status: 'valid';
  actionId: string;
  pGameWin: number | null;
  pSeriesWin: number | null;
  confidence: number | null;
  opponentModes: OpponentModeProbability[];
}

export interface InvalidStrategicChoice {
  status: 'invalid';
  reason: string;
}

export type StrategicChoiceParseResult = ParsedStrategicChoice | InvalidStrategicChoice;

export interface StrategicChoiceScore {
  status: 'valid';
  actionId: string;
  reference: ReferenceActionScore;
}

export interface InvalidStrategicChoiceScore {
  status: 'invalid';
  reason: string;
}

function probability(value: unknown, name: string): number | string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    return `${name} must be a finite number from 0 through 1`;
  }
  return value;
}

function actionId(taskId: string, identitySalt: string, canonicalAction: string): string {
  return `a_${canonicalJsonDigest([taskId, identitySalt, canonicalAction]).slice(0, 16)}`;
}

function responseInstruction(mode: StrategicForecastMode): string {
  if (mode === 'action-only') return 'Return exactly one JSON object {"action_id":"a_..."} and no other keys.';
  if (mode === 'binary-forecast') {
    return [
      'Return exactly one JSON object with these keys:',
      '{"action_id":"a_...","p_game_win":0.0,"p_series_win":0.0,"confidence":0.0}',
      'Every probability is a number from 0 through 1. Include no prose.',
    ].join('\n');
  }
  return [
    'Return exactly one JSON object with these keys:',
    '{"action_id":"a_...","p_game_win":0.0,"p_series_win":0.0,"confidence":0.0,',
    ' "opponent_modes":[{"id":"mode-id","p":0.0}]}',
    'Opponent-mode probabilities must be unique and sum to 1. Include no prose.',
  ].join('\n');
}

export function buildStrategicChoiceTask(input: {
  id: string;
  format: string;
  phase: string;
  state: string;
  actions: readonly StrategicTaskActionInput[];
  presentationSeed: string | number;
  actionIdentitySalt: string;
  forecastMode?: StrategicForecastMode;
}): StrategicChoiceTaskPackage {
  if (!input.id || !input.format || !input.phase || !input.state) {
    throw new Error('strategic choice task requires non-empty identity, format, phase, and state');
  }
  if (input.actions.length < 2) throw new Error('strategic choice task requires at least two actions');
  if (!input.actionIdentitySalt) throw new Error('strategic choice task actionIdentitySalt must be non-empty');
  const canonical = new Set<string>();
  const presentationSeed = String(input.presentationSeed);
  const privateActions: StrategicPrivateAction[] = input.actions.map((action) => {
    if (!action.canonicalAction || !action.label) throw new Error('strategic task actions require command and label');
    if (canonical.has(action.canonicalAction)) throw new Error('strategic task repeats a canonical action');
    canonical.add(action.canonicalAction);
    return {
      actionId: actionId(input.id, input.actionIdentitySalt, action.canonicalAction),
      canonicalAction: action.canonicalAction,
      label: action.label,
    };
  });
  if (new Set(privateActions.map((action) => action.actionId)).size !== privateActions.length) {
    throw new Error('strategic action identity collision');
  }
  const displayed = shuffle(privateActions, seededRng(`${input.id}:${presentationSeed}:presentation`));
  const forecastMode = input.forecastMode ?? 'action-only';
  const publicActions = displayed.map(({ actionId: id, label }) => ({ actionId: id, label }));
  const prompt = [
    'Choose one listed action for this controlled Pokémon VGC decision.',
    'Action identifiers are opaque. Select by the action label, not by its display position.',
    '',
    input.state,
    '',
    'LEGAL ACTIONS:',
    ...publicActions.map((action) => `- ${action.actionId}: ${action.label}`),
    '',
    responseInstruction(forecastMode),
  ].join('\n');
  return {
    public: {
      protocolVersion: STRATEGIC_CHOICE_TASK_PROTOCOL.version,
      id: input.id,
      format: input.format,
      phase: input.phase,
      forecastMode,
      prompt,
      actions: publicActions,
      presentationDigest: canonicalJsonDigest(publicActions),
    },
    private: {
      taskId: input.id,
      actions: privateActions,
      actionMapDigest: canonicalJsonDigest(privateActions),
    },
  };
}

function parsedObject(response: string): Record<string, unknown> | string {
  const match = /\{[\s\S]*\}/u.exec(response);
  if (!match) return 'the reply contained no JSON object';
  try {
    const parsed = JSON.parse(match[0]) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return 'the reply must be one JSON object';
    return parsed as Record<string, unknown>;
  } catch {
    return 'the JSON object did not parse';
  }
}

function allowedKeys(mode: StrategicForecastMode): Set<string> {
  if (mode === 'action-only') return new Set(['action_id']);
  const keys = ['action_id', 'p_game_win', 'p_series_win', 'confidence'];
  if (mode === 'opponent-mode-forecast') keys.push('opponent_modes');
  return new Set(keys);
}

function parseOpponentModes(value: unknown): OpponentModeProbability[] | string {
  if (!Array.isArray(value) || !value.length) return 'opponent_modes must be a non-empty array';
  const result: OpponentModeProbability[] = [];
  const ids = new Set<string>();
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return `opponent_modes[${index}] must be an object`;
    }
    const record = entry as Record<string, unknown>;
    if (Object.keys(record).sort().join(',') !== 'id,p') return `opponent_modes[${index}] must contain only id and p`;
    if (typeof record.id !== 'string' || !record.id) return `opponent_modes[${index}].id must be non-empty`;
    if (ids.has(record.id)) return `opponent mode ${JSON.stringify(record.id)} is repeated`;
    const p = probability(record.p, `opponent_modes[${index}].p`);
    if (typeof p === 'string') return p;
    ids.add(record.id);
    result.push({ id: record.id, p });
  }
  const total = result.reduce((sum, entry) => sum + entry.p, 0);
  if (Math.abs(total - 1) > 1e-6) return 'opponent-mode probabilities must sum to 1';
  return result;
}

export function parseStrategicChoice(
  response: string,
  task: StrategicChoiceTaskPublic,
): StrategicChoiceParseResult {
  const parsed = parsedObject(response);
  if (typeof parsed === 'string') return { status: 'invalid', reason: parsed };
  const allowed = allowedKeys(task.forecastMode);
  const keys = Object.keys(parsed);
  if (keys.some((key) => !allowed.has(key)) || keys.length !== allowed.size) {
    return { status: 'invalid', reason: `the JSON object must contain exactly ${[...allowed].sort().join(', ')}` };
  }
  if (typeof parsed.action_id !== 'string' || !task.actions.some((action) => action.actionId === parsed.action_id)) {
    return { status: 'invalid', reason: 'action_id must name one displayed legal action' };
  }
  if (task.forecastMode === 'action-only') {
    return {
      status: 'valid',
      actionId: parsed.action_id,
      pGameWin: null,
      pSeriesWin: null,
      confidence: null,
      opponentModes: [],
    };
  }
  const pGameWin = probability(parsed.p_game_win, 'p_game_win');
  const pSeriesWin = probability(parsed.p_series_win, 'p_series_win');
  const confidence = probability(parsed.confidence, 'confidence');
  const invalid = [pGameWin, pSeriesWin, confidence].find((entry) => typeof entry === 'string');
  if (typeof invalid === 'string') return { status: 'invalid', reason: invalid };
  let opponentModes: OpponentModeProbability[] = [];
  if (task.forecastMode === 'opponent-mode-forecast') {
    const modes = parseOpponentModes(parsed.opponent_modes);
    if (typeof modes === 'string') return { status: 'invalid', reason: modes };
    opponentModes = modes;
  }
  return {
    status: 'valid',
    actionId: parsed.action_id,
    pGameWin: pGameWin as number,
    pSeriesWin: pSeriesWin as number,
    confidence: confidence as number,
    opponentModes,
  };
}

export function scoreStrategicChoice(
  parsed: StrategicChoiceParseResult,
  reference: ReferenceSuiteResult,
): StrategicChoiceScore | InvalidStrategicChoiceScore {
  if (parsed.status === 'invalid') return parsed;
  return { status: 'valid', actionId: parsed.actionId, reference: scoreReferenceAction(reference, parsed.actionId) };
}

export function binaryBrierScore(probabilityValue: number, outcome: 0 | 1): number {
  const parsed = probability(probabilityValue, 'forecast');
  if (typeof parsed === 'string') throw new Error(parsed);
  return (parsed - outcome) ** 2;
}

export function multiclassBrierScore(forecast: readonly OpponentModeProbability[], realizedMode: string): number {
  const parsed = parseOpponentModes(forecast);
  if (typeof parsed === 'string') throw new Error(parsed);
  if (!parsed.some((entry) => entry.id === realizedMode)) {
    throw new Error(`realized opponent mode ${JSON.stringify(realizedMode)} is absent from the forecast support`);
  }
  return parsed.reduce((sum, entry) => sum + (entry.p - Number(entry.id === realizedMode)) ** 2, 0);
}
