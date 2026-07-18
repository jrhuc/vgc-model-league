import type { ReasoningLevel } from '../providers.js';
import type { ContributorAttribution, RotationEvent } from '../rotation.js';

export interface RunWorkerStart {
  type: 'start';
  models: string[];
  seriesPerPair: number;
  runDir: string;
  pool: string;
  concurrency: number;
  recordsPath: string;
  apiKeys: Record<string, string>;
  seed?: number;
  reasoning?: ReasoningLevel;
  contributor?: ContributorAttribution;
}

export type RunWorkerInput = RunWorkerStart | { type: 'abort' };

export type RunWorkerOutput =
  | { type: 'event'; event: RotationEvent }
  | { type: 'notice'; message: string }
  | { type: 'done' }
  | { type: 'failed'; error: string };
