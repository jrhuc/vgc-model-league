import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PINNED_PS_DIR = path.join(REPO_ROOT, 'pokemon-showdown');
export const TEAMS_DIR = path.join(REPO_ROOT, 'teams');
export const RUNS_DIR = path.join(REPO_ROOT, 'runs');
export const RESULTS_PATH = path.join(REPO_ROOT, 'records', 'results.jsonl');

export function defaultPsDir(): string {
  return path.resolve(process.env.VGC_LEAGUE_PS ?? PINNED_PS_DIR);
}
