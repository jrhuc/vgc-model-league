#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { POSITION_ELIGIBILITY_METRICS_VERSION, type PositionEligibilityMetrics } from '../src/eval/eligibility.js';
import type { JsonObject } from '../src/types.js';

const input = path.resolve(process.argv[2] ?? 'records/private/position-panels/scores.pilot.jsonl');

function digest(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function rows(file: string): JsonObject[] {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line, index) => {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`invalid row ${index + 1}`);
      return value as JsonObject;
    });
}

function quantile(sorted: readonly number[], probability: number): number | null {
  if (!sorted.length) return null;
  const position = probability * (sorted.length - 1);
  const lower = Math.floor(position);
  const weight = position - lower;
  return (sorted[lower] as number) * (1 - weight) + (sorted[Math.min(lower + 1, sorted.length - 1)] as number) * weight;
}

function summary(values: Array<number | null>): JsonObject {
  const finite = values
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
    .sort((a, b) => a - b);
  return {
    n: finite.length,
    missing: values.length - finite.length,
    min: finite[0] ?? null,
    p05: quantile(finite, 0.05),
    p25: quantile(finite, 0.25),
    p50: quantile(finite, 0.5),
    p75: quantile(finite, 0.75),
    p95: quantile(finite, 0.95),
    max: finite.at(-1) ?? null,
  };
}

const scoreRows = rows(input);
const metrics = scoreRows.map((row, index) => {
  const value = row.eligibility_metrics as unknown as PositionEligibilityMetrics;
  if (!value || value.version !== POSITION_ELIGIBILITY_METRICS_VERSION)
    throw new Error(`score row ${index + 1} has no supported eligibility metrics`);
  return value;
});
const flags: Record<string, number> = {};
for (const row of scoreRows) {
  for (const flag of (row.diagnostic_flags as unknown[] | undefined) ?? []) {
    const name = String(flag);
    flags[name] = (flags[name] ?? 0) + 1;
  }
}
const output = {
  schema_version: 1,
  advisory_only: true,
  note: 'Empirical pilot distributions do not freeze or recommend release thresholds.',
  input: { file: input, sha256: digest(input), rows: scoreRows.length },
  structural_pass: scoreRows.filter((row) => row.structural_pass === true).length,
  diagnostic_flags: Object.fromEntries(Object.entries(flags).sort(([a], [b]) => a.localeCompare(b))),
  distributions: {
    legal_actions: summary(metrics.map((entry) => entry.legalActions)),
    min_panel_draws: summary(metrics.map((entry) => Math.min(...entry.drawsPerPanel))),
    held_out_span_lower95: summary(metrics.map((entry) => entry.heldOutSpanLower95)),
    held_out_span_signal_to_noise: summary(metrics.map((entry) => entry.heldOutSpanSignalToNoise)),
    stability_rank_correlation: summary(metrics.map((entry) => entry.stabilityRankCorrelation)),
    max_normalized_reward_drift: summary(metrics.map((entry) => entry.maxNormalizedRewardDrift)),
    max_measurement_normalized_standard_error: summary(
      metrics.map((entry) => entry.maxMeasurementNormalizedStandardError),
    ),
  },
};
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
