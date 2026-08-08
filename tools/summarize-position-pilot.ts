#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { POSITION_ELIGIBILITY_METRICS_VERSION, type PositionEligibilityMetrics } from '../src/eval/eligibility.js';
import { validatePrivatePositionScore } from '../src/eval/panel-artifact.js';
import { validatePilotManifestV2 } from '../src/eval/position-artifact-manifest.js';
import { canonicalJson, canonicalJsonl } from '../src/eval/serialization.js';
import type { JsonObject } from '../src/types.js';

function parse(argv: string[]): { input: string; manifest: string } {
  let input = 'records/private/position-panels/scores.pilot.jsonl';
  let manifest = 'records/position-panels/manifest.pilot.json';
  let positional = false;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index] as string;
    if (value === '--manifest') {
      const next = argv[++index];
      if (!next) throw new Error('--manifest requires a path');
      manifest = next;
    } else if (value.startsWith('--')) throw new Error(`unknown flag ${value}`);
    else if (positional) throw new Error('only one score file may be supplied');
    else {
      input = value;
      positional = true;
    }
  }
  return { input: path.resolve(input), manifest: path.resolve(manifest) };
}

function digest(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function parseScoreRows(bytes: Buffer): JsonObject[] {
  const raw = bytes.toString('utf8');
  const values = raw
    .split('\n')
    .filter(Boolean)
    .map((line, index) => {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`invalid row ${index + 1}`);
      validatePrivatePositionScore(value as JsonObject, index);
      return value as JsonObject;
    });
  if (!bytes.equals(Buffer.from(canonicalJsonl(values), 'utf8'))) throw new Error('score file is not canonical JSONL');
  return values;
}

function pilotManifest(bytes: Buffer, expectedScoreSha256: string, expectedScoreRows: number): string[] {
  const raw = bytes.toString('utf8');
  const parsed: unknown = JSON.parse(raw);
  if (!bytes.equals(Buffer.from(`${canonicalJson(parsed)}\n`, 'utf8')))
    throw new Error('pilot manifest is not one canonical JSON object');
  const manifest = validatePilotManifestV2(parsed);
  if (path.basename(manifest.outputs.tasks.file) !== manifest.outputs.tasks.file)
    throw new Error('pilot manifest.outputs.tasks.file must be a basename');
  if (manifest.outputs.scores.sha256 !== expectedScoreSha256 || manifest.outputs.scores.rows !== expectedScoreRows)
    throw new Error('pilot manifest does not bind the score file bytes and row count');
  return manifest.orderedTaskIds;
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

function distributions(metrics: PositionEligibilityMetrics[]): JsonObject {
  return {
    legal_actions: summary(metrics.map((entry) => entry.legalActions)),
    min_qualification_draws: summary(metrics.map((entry) => Math.min(...entry.qualificationDrawsPerPanel))),
    min_luck_replications: summary(metrics.map((entry) => Math.min(...entry.qualificationLuckReplications))),
    min_sampled_opponent_slots: summary(metrics.map((entry) => Math.min(...entry.qualificationOpponentSlots))),
    held_out_span_value: summary(metrics.map((entry) => entry.heldOutSpanValue)),
    held_out_span_standard_error: summary(metrics.map((entry) => entry.heldOutSpanStandardError)),
    held_out_span_normal_approx_lower95: summary(metrics.map((entry) => entry.heldOutSpanNormalApproxLower95)),
    stability_rank_correlation: summary(metrics.map((entry) => entry.stabilityRankCorrelation)),
    max_normalized_reward_drift: summary(metrics.map((entry) => entry.maxNormalizedRewardDrift)),
    max_qualification_normalized_standard_error: summary(
      metrics.map((entry) => entry.maxQualificationNormalizedStandardError),
    ),
  };
}

const settings = parse(process.argv.slice(2));
const scoreBytes = fs.readFileSync(settings.input);
const manifestBytes = fs.readFileSync(settings.manifest);
const scoreSha256 = digest(scoreBytes);
const manifestSha256 = digest(manifestBytes);
const scoreRows = parseScoreRows(scoreBytes);
const scoreTaskIds = scoreRows.map((row) => String(row.task_id));
if (new Set(scoreTaskIds).size !== scoreTaskIds.length) throw new Error('score file contains duplicate task IDs');
const orderedTaskIds = pilotManifest(manifestBytes, scoreSha256, scoreRows.length);
if (canonicalJson(scoreTaskIds) !== canonicalJson(orderedTaskIds))
  throw new Error('score row order and task IDs differ from pilot manifest.ordered_task_ids');

const metrics = scoreRows.map((row, index) => {
  const value = row.eligibility_metrics as unknown as PositionEligibilityMetrics;
  if (!value || value.version !== POSITION_ELIGIBILITY_METRICS_VERSION)
    throw new Error(`score row ${index + 1} has no supported eligibility metrics`);
  return value;
});
const qualifying = scoreRows
  .map((row, index) => ({ row, metrics: metrics[index] as PositionEligibilityMetrics }))
  .filter(({ row }) => row.structural_pass === true)
  .map(({ metrics: entry }) => entry);
const flags: Record<string, number> = {};
for (const row of scoreRows) {
  for (const flag of (row.diagnostic_flags as unknown[] | undefined) ?? []) {
    const name = String(flag);
    flags[name] = (flags[name] ?? 0) + 1;
  }
}
const output = {
  schema_version: 2,
  advisory_only: true,
  note: 'Qualification-panel pilot distributions do not freeze or recommend release thresholds; normal bounds are uncalibrated diagnostics.',
  input: { artifact: path.basename(settings.input), sha256: scoreSha256, rows: scoreRows.length },
  pilot_manifest_sha256: manifestSha256,
  structural_pass: qualifying.length,
  diagnostic_flags: Object.fromEntries(Object.entries(flags).sort(([a], [b]) => a.localeCompare(b))),
  distributions: {
    qualification_pass_rows: distributions(qualifying),
    all_rows: distributions(metrics),
  },
};
process.stdout.write(`${canonicalJson(output)}\n`);
