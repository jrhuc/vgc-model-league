#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import {
  aggregateFrontierPilotReports,
  type FrontierPilotAggregateReport,
} from '../src/eval/frontier-pilot-analysis.js';
import type { FrontierStrategicPilotReport } from '../src/eval/frontier-pilot.js';
import { canonicalJson } from '../src/eval/serialization.js';

const HELP = `Usage: pnpm run summarize-strategic-pilots -- [options] <report-or-directory>...

Validate private frontier strategic pilot reports and aggregate authentic-minus-
withheld effects at the source-cluster level. Directories are scanned
recursively. source.json and batch summary.json files are ignored.

Options:
  --out <path>   write canonical aggregate JSON without overwriting an existing file
  --help         show this help

The output is a pilot diagnostic, never a ranking. Standard errors are computed
across source-cluster means, with repeated runs of the same source averaged
inside that source first.`;

function reportShape(value: unknown): value is FrontierStrategicPilotReport {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.reportDigest === 'string' && typeof record.model === 'object' && Array.isArray(record.outcomes);
}

function filesUnder(entry: string): string[] {
  const absolute = path.resolve(entry);
  const stat = fs.statSync(absolute);
  if (stat.isFile()) return [absolute];
  if (!stat.isDirectory()) throw new Error(`${entry} is neither a report file nor a directory`);
  return fs.readdirSync(absolute, { withFileTypes: true }).flatMap((child) => {
    const childPath = path.join(absolute, child.name);
    if (child.isDirectory()) return filesUnder(childPath);
    return child.isFile() && child.name.endsWith('.json') ? [childPath] : [];
  });
}

function loadReports(entries: readonly string[]): FrontierStrategicPilotReport[] {
  const reports: FrontierStrategicPilotReport[] = [];
  const seenFiles = new Set<string>();
  for (const entry of entries) {
    const explicitFile = fs.statSync(path.resolve(entry)).isFile();
    let matched = false;
    for (const file of filesUnder(entry).sort()) {
      if (seenFiles.has(file)) continue;
      seenFiles.add(file);
      let parsed: unknown;
      try {
        parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (cause) {
        if (explicitFile) throw new Error(`${file}: ${cause instanceof Error ? cause.message : String(cause)}`);
        continue;
      }
      if (!reportShape(parsed)) {
        if (explicitFile) throw new Error(`${file} is not a frontier strategic pilot report`);
        continue;
      }
      reports.push(parsed);
      matched = true;
    }
    if (explicitFile && !matched) throw new Error(`${entry} did not contain a frontier strategic pilot report`);
  }
  if (!reports.length) throw new Error('no frontier strategic pilot reports were found');
  return reports;
}

function writeAggregate(file: string, aggregate: FrontierPilotAggregateReport): void {
  const absolute = path.resolve(file);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, `${canonicalJson(aggregate)}\n`, { flag: 'wx' });
}

export function main(argv = process.argv.slice(2)): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      help: { type: 'boolean', default: false },
      out: { type: 'string' },
    },
  });
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  if (!positionals.length) throw new Error('at least one report file or directory is required');
  const aggregate = aggregateFrontierPilotReports(loadReports(positionals));
  if (values.out) writeAggregate(values.out, aggregate);
  else console.log(canonicalJson(aggregate));
  for (const model of aggregate.models) {
    console.error(
      `${model.modelSpec}: sources=${model.validSourceClusters}/${model.sourceClusters} ` +
        `mean=${String(model.meanSourceDifference)} se=${String(model.standardError)} ` +
        `positive=${String(model.positiveSourceRate)} valid=${model.validPairs}/${model.matchedPairs} ` +
        `cost=${model.reportedCost} readiness=${model.readiness}`,
    );
  }
  return 0;
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? '')) {
  try {
    process.exitCode = main();
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exitCode = 1;
  }
}
