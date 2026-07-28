#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { RUNS_DIR } from '../src/paths.js';

type Row = Record<string, unknown>;

function readLines(file: string): Row[] {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Row);
}

function reasoningByKey(traceFile: string): Map<string, number[]> {
  const queues = new Map<string, number[]>();
  if (!fs.existsSync(traceFile)) return queues;
  for (const trace of readLines(traceFile)) {
    const usage = trace.usage as Record<string, unknown> | undefined;
    const value = usage?.reasoning_tokens;
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    const key =
      trace.kind === 'decision_trace'
        ? `d:${trace.game_id}:${trace.turn}:${trace.phase}`
        : trace.kind === 'reflection_trace'
          ? `r:${trace.game_id}:${trace.game_number}`
          : null;
    if (!key) continue;
    const queue = queues.get(key) ?? [];
    queue.push(Math.trunc(value));
    queues.set(key, queue);
  }
  return queues;
}

export function backfillDecisionLog(decisionFile: string, traceFile: string): number {
  const queues = reasoningByKey(traceFile);
  if (queues.size === 0) return 0;
  const rows = readLines(decisionFile);
  let patched = 0;
  for (const row of rows) {
    if (row.reasoning_tokens !== undefined || row.automatic === true) continue;
    const key =
      row.kind === 'decision'
        ? `d:${row.game_id}:${row.turn}:${row.phase}`
        : row.kind === 'game_reflection'
          ? `r:${row.game_id}:${row.game_number}`
          : null;
    if (!key) continue;
    const value = queues.get(key)?.shift();
    if (value === undefined) continue;
    row.reasoning_tokens = value;
    patched += 1;
  }
  if (patched > 0) {
    const tmp = `${decisionFile}.tmp`;
    fs.writeFileSync(tmp, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
    fs.renameSync(tmp, decisionFile);
  }
  return patched;
}

export function backfillRuns(runsDir: string): { files: number; rows: number } {
  let files = 0;
  let rows = 0;
  for (const runId of fs.existsSync(runsDir) ? fs.readdirSync(runsDir) : []) {
    const seriesDir = path.join(runsDir, runId, 'series');
    if (!fs.existsSync(seriesDir)) continue;
    for (const seriesId of fs.readdirSync(seriesDir)) {
      for (const pid of ['p1', 'p2']) {
        const decisions = path.join(seriesDir, seriesId, `${pid}-decisions.jsonl`);
        if (!fs.existsSync(decisions)) continue;
        const patched = backfillDecisionLog(decisions, path.join(seriesDir, seriesId, `${pid}-trace.jsonl`));
        if (patched > 0) {
          files += 1;
          rows += patched;
        }
      }
    }
  }
  return { files, rows };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const runsDir = process.argv[2] ? path.resolve(process.argv[2]) : RUNS_DIR;
  const result = backfillRuns(runsDir);
  console.log(`patched ${result.rows} rows across ${result.files} files in ${runsDir}`);
}
