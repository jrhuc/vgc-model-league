import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUNDLED_TEAMS_DIR = path.join(REPO_ROOT, 'teams');
export const DATA_DIR = path.resolve(process.env.VGC_LEAGUE_DATA_DIR ?? REPO_ROOT);
export const PINNED_PS_DIR = path.join(REPO_ROOT, 'pokemon-showdown');
export const TEAMS_DIR = path.join(DATA_DIR, 'teams');
export const RUNS_DIR = path.join(DATA_DIR, 'runs');
export const RESULTS_PATH = path.join(DATA_DIR, 'records', 'results.jsonl');

export function prepareDataDirectories(): void {
  if (TEAMS_DIR !== BUNDLED_TEAMS_DIR && !fs.existsSync(TEAMS_DIR)) {
    fs.cpSync(BUNDLED_TEAMS_DIR, TEAMS_DIR, { recursive: true, errorOnExist: true });
  }
  for (const directory of [TEAMS_DIR, RUNS_DIR, path.dirname(RESULTS_PATH)]) {
    fs.mkdirSync(directory, { recursive: true });
  }
}

export function defaultPsDir(): string {
  return path.resolve(process.env.VGC_LEAGUE_PS ?? PINNED_PS_DIR);
}
