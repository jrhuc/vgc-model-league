import fs from 'node:fs';
import path from 'node:path';

import type { ScaffoldComponent } from '../llm-engine.js';

export interface RunScaffold {
  revision: string | null;
  components: Partial<Record<ScaffoldComponent, string>> | null;
}

/** A metric may pool two runs only when every component it reads is unchanged between them.
 * Play metrics all read the battle prompt, the tool set and the decision policy, so the
 * decomposition does not make them freely poolable — it makes reflection and draft revisions
 * stop invalidating them, and it names which component moved when pooling is refused. */
export const METRIC_SCAFFOLD_DEPS = {
  'calc-fidelity': ['system', 'stateRender', 'toolRender', 'tools', 'policy'],
  'mechanics-errors': ['system', 'stateRender', 'tools', 'policy'],
  regret: ['system', 'stateRender', 'toolRender', 'tools', 'policy'],
  'opponent-model': ['system', 'stateRender', 'toolRender', 'tools', 'policy'],
  'reflection-quality': ['system', 'stateRender', 'toolRender', 'tools', 'policy', 'reflection'],
} as const satisfies Record<string, readonly ScaffoldComponent[]>;

export type EvalMetric = keyof typeof METRIC_SCAFFOLD_DEPS;

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

export interface PoolVerdict {
  poolable: boolean;
  /** Components that differ and are read by the metric; empty when the refusal is a missing decomposition. */
  changed: ScaffoldComponent[];
  reason: 'match' | 'component-changed' | 'revision-changed' | 'unknown-scaffold';
}

/** Runs recorded before the decomposition carry only the combined revision, so they pool
 * on exact revision equality — the conservative answer, never a guess at what changed. */
export function poolable(metric: EvalMetric, a: RunScaffold, b: RunScaffold): PoolVerdict {
  const deps = METRIC_SCAFFOLD_DEPS[metric] as readonly ScaffoldComponent[];
  if (a.components && b.components) {
    const changed = deps.filter((component) => a.components?.[component] !== b.components?.[component]);
    if (!changed.length) return { poolable: true, changed: [], reason: 'match' };
    return { poolable: false, changed, reason: 'component-changed' };
  }
  if (!a.revision || !b.revision) return { poolable: false, changed: [], reason: 'unknown-scaffold' };
  if (a.revision === b.revision) return { poolable: true, changed: [], reason: 'match' };
  return { poolable: false, changed: [], reason: 'revision-changed' };
}

export interface ScaffoldCohort {
  key: string;
  runs: string[];
}

/** Groups runs into maximal sets that share every component the metric reads. */
export function cohorts(metric: EvalMetric, runs: Map<string, RunScaffold>): ScaffoldCohort[] {
  const deps = METRIC_SCAFFOLD_DEPS[metric] as readonly ScaffoldComponent[];
  const grouped = new Map<string, string[]>();
  for (const [runId, scaffold] of runs) {
    const key = scaffold.components
      ? deps.map((component) => scaffold.components?.[component] ?? '?').join('/')
      : `revision:${scaffold.revision ?? 'unknown'}`;
    const bucket = grouped.get(key);
    if (bucket) bucket.push(runId);
    else grouped.set(key, [runId]);
  }
  return [...grouped].map(([key, list]) => ({ key, runs: list })).sort((x, y) => y.runs.length - x.runs.length);
}
