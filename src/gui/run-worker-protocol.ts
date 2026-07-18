import type { ReasoningLevel } from '../providers.js';
import type { ContributorAttribution } from '../rotation.js';
import type { Team } from '../teams.js';
import type { TournamentEvent } from '../tournament.js';

export interface RunWorkerStart {
  type: 'start';
  mode: 'rotation' | 'tournament';
  models: string[];
  seriesPerPair: number;
  runDir: string;
  pool: string;
  concurrency: number;
  recordsPath: string;
  apiKeys: Record<string, string>;
  teams?: Team[];
  format?: string;
  seed?: number;
  reasoning?: ReasoningLevel;
  contributor?: ContributorAttribution;
}

export type RunWorkerInput = RunWorkerStart | { type: 'abort' };

export type RunWorkerOutput =
  | { type: 'event'; event: TournamentEvent }
  | { type: 'notice'; message: string }
  | { type: 'done' }
  | { type: 'failed'; error: string };
