#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import type { NotebookTreatment, NotebookTreatmentKind } from '../src/eval/bo3-adaptation.js';
import {
  buildFrontierPilotMatchday,
  buildFrontierPilotSourceArtifact,
  completeFrontierPilotSource,
  type FrontierPilotSourceArtifact,
  frontierPilotProvider,
  generateFrontierAuthenticNotebook,
  runFrontierStrategicPilot,
  suppliedFrontierTreatment,
  validateFrontierPilotSourceArtifact,
} from '../src/eval/frontier-pilot.js';
import { buildFrozenMatchdayBetweenGameCheckpoint } from '../src/eval/frozen-matchday-adapter.js';
import { canonicalJson, canonicalJsonDigest } from '../src/eval/serialization.js';
import { isReasoningLevel, nitroSpec, type ReasoningLevel } from '../src/providers.js';
import { loadPool } from '../src/teams.js';

const HELP = `Usage: pnpm run strategic-pilot -- --models <spec> [--models <spec> ...]

Run a matched authentic-vs-withheld between-game memory pilot through the
frozen Showdown authorities and the repository's OpenRouter or Prime provider.

Options:
  --models <spec>            repeat for every frontier model to test
  --pool <name>              existing team pool (default: test)
  --focal-team <id>          pool team used by the frontier model (default: first team)
  --opponent-team <id>       distinct fixed-opponent team (default: second team)
  --seed <value>             deterministic source and common-draw namespace
  --draws <n>                common future draws per treatment (default: 4)
  --reasoning <level>        minimal, low, medium, high, or xhigh
  --nitro                    add OpenRouter's :nitro routing variant
  --max-tokens <n>           output-token cap for each model call (default: 8192)
  --timeout <seconds>        provider timeout for each model call (default: 600)
  --max-decisions <n>        continuation safety cap per arm and draw (default: 500)
  --source <path>            reuse a previously written source.json
  --authentic-notebook <path> use supplied authentic notebook bytes instead of asking the model
  --treatment <kind=path>    add stale, false, placebo, or oracle notebook bytes
  --out <directory>          new or empty private report directory

Model specs are openrouter:<model-id> or prime:<model-id>. The command reads
OPENROUTER_API_KEY or PRIME_API_KEY. It writes private prompts, responses,
usage, costs, exact source evidence, treatment bytes, fork outcomes, and joined
digests. One team pair is one source cluster and is never a ranking.`;

interface BatchModelSuccess {
  modelSpec: string;
  status: 'complete';
  reportFile: string;
  reportDigest: string;
  summary: Awaited<ReturnType<typeof runFrontierStrategicPilot>>['summary'];
}

interface BatchModelFailure {
  modelSpec: string;
  status: 'failed';
  error: string;
  traceFile: string | null;
}

type BatchModelResult = BatchModelSuccess | BatchModelFailure;

function integer(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`--${label} must be a positive integer`);
  return parsed;
}

function reasoning(value: string | undefined): ReasoningLevel | undefined {
  if (value === undefined) return undefined;
  if (!isReasoningLevel(value)) throw new Error('--reasoning must be minimal, low, medium, high, or xhigh');
  return value;
}

function filename(value: string): string {
  const safe = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  return safe || 'model';
}

function modelStem(value: string): string {
  return `${filename(value)}-${canonicalJsonDigest(value).slice(0, 8)}`;
}

function defaultOutputDirectory(): string {
  return path.resolve('runs', `strategic-pilot-${new Date().toISOString().replace(/[:.]/gu, '-')}`);
}

function writeCanonical(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${canonicalJson(value)}\n`, { flag: 'wx' });
}

function readSource(file: string): FrontierPilotSourceArtifact {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as FrontierPilotSourceArtifact;
  validateFrontierPilotSourceArtifact(parsed);
  return parsed;
}

function selectedTeam(pool: ReturnType<typeof loadPool>, id: string | undefined, fallback: number) {
  const selected = id === undefined ? pool.teams[fallback] : pool.teams.find((team) => team.id === id);
  if (!selected) throw new Error(`pool ${JSON.stringify(pool.id)} has no team ${JSON.stringify(id ?? fallback)}`);
  return selected;
}

function buildSource(input: {
  poolName: string;
  focalTeamId?: string;
  opponentTeamId?: string;
  seed: string;
}): FrontierPilotSourceArtifact {
  const pool = loadPool(input.poolName);
  const focal = selectedTeam(pool, input.focalTeamId, 0);
  const opponent = selectedTeam(pool, input.opponentTeamId, 1);
  if (focal.id === opponent.id) throw new Error('frontier pilot focal and opponent teams must differ');
  const matchday = buildFrontierPilotMatchday({
    format: pool.format,
    focal: { id: focal.id, name: `frontier-${focal.id}`, packed: focal.packed },
    opponent: { id: opponent.id, name: `fixed-${opponent.id}`, packed: opponent.packed },
    seed: input.seed,
  });
  const caseId = `frontier-${canonicalJsonDigest([
    'frontier-pilot-source-case-v1',
    pool.id,
    pool.format,
    focal.id,
    opponent.id,
    input.seed,
  ]).slice(0, 20)}`;
  return buildFrontierPilotSourceArtifact({
    publicContext: matchday.publicContext,
    source: completeFrontierPilotSource({ caseId, options: matchday.options }),
  });
}

function treatmentSpec(value: string): {
  kind: Exclude<NotebookTreatmentKind, 'authentic' | 'withheld'>;
  file: string;
} {
  const split = value.indexOf('=');
  if (split <= 0 || split === value.length - 1) throw new Error('--treatment must be kind=path');
  const kind = value.slice(0, split);
  if (kind !== 'stale' && kind !== 'false' && kind !== 'placebo' && kind !== 'oracle') {
    throw new Error('--treatment kind must be stale, false, placebo, or oracle');
  }
  return { kind, file: path.resolve(value.slice(split + 1)) };
}

function suppliedTreatments(values: string[] | undefined): NotebookTreatment[] {
  return (values ?? []).map((value) => {
    const spec = treatmentSpec(value);
    return suppliedFrontierTreatment({
      kind: spec.kind,
      notebook: fs.readFileSync(spec.file, 'utf8'),
      sourceLabel: `operator-supplied-${spec.kind}`,
    });
  });
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      help: { type: 'boolean', default: false },
      models: { type: 'string', multiple: true },
      pool: { type: 'string', default: 'test' },
      'focal-team': { type: 'string' },
      'opponent-team': { type: 'string' },
      seed: { type: 'string', default: '20260816' },
      draws: { type: 'string', default: '4' },
      reasoning: { type: 'string' },
      nitro: { type: 'boolean', default: false },
      'max-tokens': { type: 'string', default: '8192' },
      timeout: { type: 'string', default: '600' },
      'max-decisions': { type: 'string', default: '500' },
      source: { type: 'string' },
      'authentic-notebook': { type: 'string' },
      treatment: { type: 'string', multiple: true },
      out: { type: 'string' },
    },
  });
  if (values.help) {
    console.log(HELP);
    return 0;
  }
  const rawModels = values.models ?? [];
  if (!rawModels.length) throw new Error('at least one --models spec is required');
  const models = values.nitro ? rawModels.map(nitroSpec) : rawModels;
  if (new Set(models).size !== models.length) throw new Error('frontier pilot repeats a model spec');
  const reasoningLevel = reasoning(values.reasoning);
  const drawCount = integer(values.draws, 'draws');
  const maxTokens = integer(values['max-tokens'], 'max-tokens');
  const timeoutSeconds = integer(values.timeout, 'timeout');
  const maxDecisions = integer(values['max-decisions'], 'max-decisions');
  const outputDirectory = path.resolve(values.out ?? defaultOutputDirectory());
  if (fs.existsSync(outputDirectory)) {
    const stat = fs.statSync(outputDirectory);
    if (!stat.isDirectory() || fs.readdirSync(outputDirectory).length) {
      throw new Error(`frontier pilot output must be a new or empty directory: ${outputDirectory}`);
    }
  } else {
    fs.mkdirSync(outputDirectory, { recursive: true });
  }

  const sourceArtifact = values.source
    ? readSource(path.resolve(values.source))
    : buildSource({
        poolName: values.pool,
        ...(values['focal-team'] === undefined ? {} : { focalTeamId: values['focal-team'] }),
        ...(values['opponent-team'] === undefined ? {} : { opponentTeamId: values['opponent-team'] }),
        seed: values.seed,
      });
  writeCanonical(path.join(outputDirectory, 'source.json'), sourceArtifact);
  const checkpoint = buildFrozenMatchdayBetweenGameCheckpoint(sourceArtifact.source, 1);
  const additionalTreatments = suppliedTreatments(values.treatment);
  const results: BatchModelResult[] = [];

  for (const modelSpec of models) {
    const provider = frontierPilotProvider(modelSpec, reasoningLevel);
    let authentic: NotebookTreatment;
    let notebookTrace: Awaited<ReturnType<typeof generateFrontierAuthenticNotebook>>['trace'] | undefined;
    if (values['authentic-notebook']) {
      authentic = suppliedFrontierTreatment({
        kind: 'authentic',
        notebook: fs.readFileSync(path.resolve(values['authentic-notebook']), 'utf8'),
        sourceLabel: 'operator-supplied-authentic',
      });
    } else {
      const generated = await generateFrontierAuthenticNotebook({
        checkpoint,
        focalPid: 'p1',
        publicContext: sourceArtifact.publicContext,
        modelSpec,
        provider,
        ...(reasoningLevel === undefined ? {} : { reasoning: reasoningLevel }),
        maxTokens,
        timeoutSeconds,
      });
      notebookTrace = generated.trace;
      if (generated.status !== 'valid' || generated.treatment === null) {
        const traceFile = `${modelStem(modelSpec)}-notebook-failure.json`;
        writeCanonical(path.join(outputDirectory, traceFile), generated.trace);
        results.push({
          modelSpec,
          status: 'failed',
          error: generated.trace.diagnostic ?? 'authentic notebook generation failed',
          traceFile,
        });
        continue;
      }
      authentic = generated.treatment;
    }
    try {
      const report = await runFrontierStrategicPilot({
        sourceArtifact,
        modelSpec,
        provider,
        authenticTreatment: authentic,
        additionalTreatments,
        focalPid: 'p1',
        ...(reasoningLevel === undefined ? {} : { reasoning: reasoningLevel }),
        drawCount,
        drawSeed: values.seed,
        maxTokens,
        timeoutSeconds,
        maxDecisions,
        ...(notebookTrace === undefined ? {} : { notebookTrace }),
      });
      const reportFile = `${modelStem(modelSpec)}.json`;
      writeCanonical(path.join(outputDirectory, reportFile), report);
      results.push({
        modelSpec,
        status: 'complete',
        reportFile,
        reportDigest: report.reportDigest,
        summary: report.summary,
      });
      console.log(
        `${modelSpec}: authentic-withheld=${String(report.summary.authenticMeanSeriesReturnDifference)} ` +
          `valid=${report.summary.validPairs}/${report.summary.matchedPairs} ` +
          `calls=${report.summary.modelCalls} cost=${report.summary.reportedCost}`,
      );
    } catch (cause) {
      results.push({
        modelSpec,
        status: 'failed',
        error: cause instanceof Error ? cause.message : String(cause),
        traceFile: null,
      });
    }
  }

  const batchBase = {
    protocolVersion: 1,
    generatedAt: new Date().toISOString(),
    sourceArtifactDigest: sourceArtifact.sourceArtifactDigest,
    sourceFile: 'source.json',
    drawCount,
    models: results,
    interpretation: 'pilot-only-one-source-cluster-no-ranking',
  };
  const batch = { ...batchBase, batchDigest: canonicalJsonDigest(batchBase) };
  writeCanonical(path.join(outputDirectory, 'summary.json'), batch);
  console.log(`private frontier pilot artifacts: ${outputDirectory}`);
  return results.some((result) => result.status === 'complete') ? 0 : 1;
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? '')) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (cause) => {
      console.error(cause instanceof Error ? cause.message : String(cause));
      process.exitCode = 1;
    },
  );
}
