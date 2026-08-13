import { draftLeagueTopology } from '../../../draftleague-topology';
import type { AppState, ProviderInfo, RunView } from '../../api';
import type { TeamAssignment } from '../views/team-editor';

export type RunMode = 'match' | 'tournament' | 'draft' | 'rotation';
export type TeamSource = 'pool' | 'custom';

export interface RunDraft {
  mode: RunMode;
  models: string[];
  apiKeys: Record<string, string>;
  teamBySlot: Array<TeamAssignment | null>;
  teamSource: TeamSource;
  assignFormat: string;
  pool: string;
  series: string;
  concurrency: string;
  closedSheets: boolean;
  sequentialWeeks: boolean;
  draftOnly: boolean;
  tradeWindow: string;
  nitro: boolean;
  sharedReasoning: boolean;
  reasoning: string;
  reasoningByModel: Record<string, string>;
  timerScale: string;
  seed: string;
  board: string;
}

export type StartRunRequest = Record<string, unknown> & { models: string[]; apiKeys: Record<string, string> };

export function buildStartRunRequest(draft: RunDraft): StartRunRequest {
  const selectedReasoning = Object.fromEntries(
    Object.entries(draft.reasoningByModel).filter(([model, level]) => draft.models.includes(model) && level),
  );
  const reasoningRequest = draft.sharedReasoning
    ? { ...(draft.reasoning ? { reasoning: draft.reasoning } : {}) }
    : { ...(Object.keys(selectedReasoning).length ? { reasoningByModel: selectedReasoning } : {}) };
  return {
    models: draft.models,
    apiKeys: draft.apiKeys,
    seed: draft.seed.trim(),
    ...reasoningRequest,
    ...(draft.nitro ? { nitro: true } : {}),
    timerScale: draft.timerScale === 'off' ? 'off' : Number(draft.timerScale),
    ...(draft.mode === 'match'
      ? {
          mode: 'tournament',
          teams: draft.models.map((_, index) => draft.teamBySlot[index]?.paste ?? ''),
          format: draft.assignFormat,
          concurrency: 1,
        }
      : draft.mode === 'tournament'
        ? draft.teamSource === 'custom'
          ? {
              mode: 'tournament',
              teams: draft.models.map((_, index) => draft.teamBySlot[index]?.paste ?? ''),
              format: draft.assignFormat,
              concurrency: Number(draft.concurrency),
            }
          : { mode: 'tournament', pool: draft.pool, concurrency: Number(draft.concurrency) }
        : draft.mode === 'draft'
          ? {
              mode: 'draft',
              board: draft.board,
              concurrency: Number(draft.concurrency),
              ...(draft.closedSheets ? { closedSheets: true } : {}),
              ...(draft.sequentialWeeks ? { sequentialWeeks: true } : {}),
              ...(draft.draftOnly ? { draftOnly: true } : {}),
              ...(draft.tradeWindow === 'default'
                ? {}
                : { tradeWindow: draft.tradeWindow === 'off' ? null : { afterWeek: Number(draft.tradeWindow) } }),
            }
          : {
              pool: draft.pool,
              seriesPerPair: Number(draft.series),
              concurrency: Number(draft.concurrency),
            }),
  };
}

export function needsProviderKey(providers: ProviderInfo[], spec: string): boolean {
  if (spec === 'random') return false;
  const providerId = spec.split(':')[0]!;
  return providers.find((item) => item.id === providerId)?.requiresKey ?? true;
}

export interface RunReadiness {
  active: boolean;
  missingKeys: string[];
  missingTeam: boolean;
  poolTooSmall: boolean;
  boardOverflow: boolean;
  disabled: boolean;
  label: string;
}

export function runReadiness(
  draft: Pick<RunDraft, 'mode' | 'models' | 'apiKeys' | 'teamBySlot' | 'teamSource' | 'pool' | 'series'>,
  app: Pick<AppState, 'providers' | 'pools' | 'boards'>,
  run: RunView | null,
  starting: boolean,
): RunReadiness {
  const { mode, models, apiKeys, teamBySlot, teamSource, pool } = draft;
  const teamsMode = mode === 'match' || (mode === 'tournament' && teamSource === 'custom');
  const missingKeys = models.filter((spec) => needsProviderKey(app.providers, spec) && !apiKeys[spec]);
  const missingTeam = teamsMode && models.some((_, index) => !teamBySlot[index]?.paste.trim());
  const poolInfo = app.pools.find((info) => info.name === pool);
  const poolTooSmall =
    mode === 'tournament' && teamSource === 'pool' && poolInfo !== undefined && poolInfo.teamCount < models.length;
  const board = app.boards[0] ?? null;
  const boardOverflow = mode === 'draft' && (!board || models.length > board.maxEntrants);
  const active = run?.state === 'running' || run?.state === 'paused';
  const disabled =
    models.length < 2 ||
    active ||
    missingKeys.length > 0 ||
    starting ||
    (mode === 'match'
      ? models.length !== 2 || missingTeam
      : mode === 'draft'
        ? boardOverflow
        : mode === 'tournament' && teamSource === 'custom'
          ? missingTeam
          : !pool || poolTooSmall);
  const total =
    mode === 'rotation'
      ? ((models.length * (models.length - 1)) / 2) * Math.max(1, Number(draft.series) || 1)
      : mode === 'draft'
        ? draftLeagueTopology(models.length).totalSeries
        : Math.max(0, models.length - 1);
  const label = active
    ? 'Run already in progress'
    : models.length < 2
      ? 'Add two models'
      : missingKeys.length
        ? 'Add run-only API keys'
        : mode === 'match'
          ? models.length !== 2
            ? 'Exactly two models'
            : missingTeam
              ? 'Assign both teams'
              : 'Start the match'
          : mode === 'tournament'
            ? missingTeam
              ? 'Assign every team'
              : `Start the ${models.length}-model bracket`
            : mode === 'draft'
              ? `Start the ${models.length}-coach draft`
              : `Start ${total} series`;
  return { active, missingKeys, missingTeam, poolTooSmall, boardOverflow, disabled, label };
}
