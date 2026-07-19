import type { DraftLeagueEvent } from '../draftleague.js';
import type { ModelReasoningConfig } from '../providers.js';
import type { Team } from '../teams.js';
import type { ContributorAttribution } from '../types.js';

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
  contributor?: ContributorAttribution;
}

export type RunWorkerInput = RunWorkerStart | { type: 'abort' };

export type RunWorkerOutput =
  | { type: 'event'; event: DraftLeagueEvent }
  | { type: 'notice'; message: string }
  | { type: 'done' }
  | { type: 'failed'; error: string };
