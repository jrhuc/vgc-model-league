import type { DraftLeagueEvent } from '../draftleague.js';
import type { ModelReasoningConfig } from '../providers.js';
import type { RecoveryPause } from '../recovery.js';
import type { Team } from '../teams.js';
import type { ContributorAttribution, TimerScale } from '../types.js';

export interface RunWorkerStart extends ModelReasoningConfig {
  type: 'start';
  mode: 'rotation' | 'tournament' | 'draft';
  models: string[];
  seriesPerPair: number;
  runDir: string;
  pool: string;
  concurrency: number;
  recordsPath: string;
  apiKeys: Record<string, string>;
  teams?: Team[];
  format?: string;
  board?: string;
  seed?: number;
  timerScale?: TimerScale;
  contributor?: ContributorAttribution;
}

export type RunWorkerInput = RunWorkerStart | { type: 'abort' } | { type: 'resume' };

export type RunWorkerOutput =
  | { type: 'event'; event: DraftLeagueEvent }
  | { type: 'notice'; message: string }
  | { type: 'paused'; pause: RecoveryPause }
  | { type: 'resumed' }
  | { type: 'done' }
  | { type: 'failed'; error: string };
