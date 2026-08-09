import fs from 'node:fs';
import path from 'node:path';

import type { ScaffoldComponent } from '../llm-engine.js';

export interface RunScaffold {
  revision: string | null;
  components: Partial<Record<ScaffoldComponent, string>> | null;
}

export function readRunScaffold(runDir: string): RunScaffold {
  const configPath = path.join(runDir, 'config.json');
  if (!fs.existsSync(configPath)) return { revision: null, components: null };
  let config: { scaffold?: unknown; scaffold_components?: unknown };
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return { revision: null, components: null };
  }
  const revision = typeof config.scaffold === 'string' ? config.scaffold : null;
  const raw = config.scaffold_components;
  if (!raw || typeof raw !== 'object') return { revision, components: null };
  const components: Partial<Record<ScaffoldComponent, string>> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string') components[key as ScaffoldComponent] = value;
  }
  return { revision, components };
}
