import type { ResearchArtifactView, ResearchLimitsView, ResearchResponse, ResearchTaskView } from '../../api';

const MAXIMUM_LIMITS: ResearchLimitsView = {
  taskPreviews: 24,
  promptCharacters: 16_000,
  actionsPerTask: 4_096,
  actionLabelCharacters: 4_096,
  artifactRows: 10_000,
  manifestBytes: 1_048_576,
  taskBytes: 16_777_216,
};

function reject(path: string, requirement: string): never {
  throw new Error(`Invalid research response at ${path}: ${requirement}`);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) reject(path, 'expected an object');
  return value as Record<string, unknown>;
}

function array(value: unknown, path: string, maximum: number): unknown[] {
  if (!Array.isArray(value)) reject(path, 'expected an array');
  if (value.length > maximum) reject(path, `exceeds ${maximum} entries`);
  return value;
}

function count(value: unknown, path: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum)
    reject(path, `expected an integer from 0 to ${maximum}`);
  return value as number;
}

function positiveCount(value: unknown, path: string, maximum = Number.MAX_SAFE_INTEGER): number {
  const result = count(value, path, maximum);
  if (result === 0) reject(path, 'expected a positive integer');
  return result;
}

function nullableCount(value: unknown, path: string, maximum: number): number | null {
  return value === null ? null : count(value, path, maximum);
}

function finite(value: unknown, path: string, minimum = -Infinity, maximum = Infinity): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum)
    reject(path, `expected a finite number from ${minimum} to ${maximum}`);
  return value;
}

function text(value: unknown, path: string, maximum: number, nonempty = true): string {
  if (typeof value !== 'string') reject(path, 'expected a string');
  if ((nonempty && value.length === 0) || value.length > maximum)
    reject(path, `${nonempty ? 'expected a nonempty string' : 'string'} of at most ${maximum} characters`);
  return value;
}

function nullableText(value: unknown, path: string, maximum: number): string | null {
  return value === null ? null : text(value, path, maximum);
}

function textArray(value: unknown, path: string, maximum: number, maximumCharacters = 4_096): string[] {
  return array(value, path, maximum).map((entry, index) => text(entry, `${path}[${index}]`, maximumCharacters));
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') reject(path, 'expected a boolean');
  return value;
}

function oneOf<T extends string>(value: unknown, path: string, choices: readonly T[]): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) reject(path, `expected ${choices.join(' | ')}`);
  return value as T;
}

function validateLimits(value: unknown): ResearchLimitsView {
  const limits = record(value, 'limits');
  return {
    taskPreviews: positiveCount(limits.taskPreviews, 'limits.taskPreviews', MAXIMUM_LIMITS.taskPreviews),
    promptCharacters: positiveCount(
      limits.promptCharacters,
      'limits.promptCharacters',
      MAXIMUM_LIMITS.promptCharacters,
    ),
    actionsPerTask: positiveCount(limits.actionsPerTask, 'limits.actionsPerTask', MAXIMUM_LIMITS.actionsPerTask),
    actionLabelCharacters: positiveCount(
      limits.actionLabelCharacters,
      'limits.actionLabelCharacters',
      MAXIMUM_LIMITS.actionLabelCharacters,
    ),
    artifactRows: positiveCount(limits.artifactRows, 'limits.artifactRows', MAXIMUM_LIMITS.artifactRows),
    manifestBytes: positiveCount(limits.manifestBytes, 'limits.manifestBytes', MAXIMUM_LIMITS.manifestBytes),
    taskBytes: positiveCount(limits.taskBytes, 'limits.taskBytes', MAXIMUM_LIMITS.taskBytes),
  };
}

function validateValidation(value: unknown, path: string): ResearchArtifactView['validation'] {
  const validation = record(value, path);
  return {
    status: oneOf(validation.status, `${path}.status`, ['valid', 'invalid']),
    scope: oneOf(validation.scope, `${path}.scope`, ['public-artifacts-only']),
    errors: textArray(validation.errors, `${path}.errors`, MAXIMUM_LIMITS.artifactRows, 512),
  };
}

function validateProtocols(value: unknown, path: string): void {
  const protocols = record(value, path);
  positiveCount(protocols.schemaVersion, `${path}.schemaVersion`);
  record(protocols.action, `${path}.action`);
  record(protocols.task, `${path}.task`);
  record(protocols.counterfactual, `${path}.counterfactual`);
  record(protocols.exhaustivePanels, `${path}.exhaustivePanels`);
  record(protocols.canonicalJson, `${path}.canonicalJson`);
  if (protocols.nearDuplicates !== null) record(protocols.nearDuplicates, `${path}.nearDuplicates`);
  positiveCount(protocols.eligibilityMetricsVersion, `${path}.eligibilityMetricsVersion`);
}

function digest(value: unknown, path: string): string {
  const result = text(value, path, 64);
  if (!/^[0-9a-f]{64}$/u.test(result)) reject(path, 'expected a lowercase SHA-256 digest');
  return result;
}

function nullableDigest(value: unknown, path: string): string | null {
  return value === null ? null : digest(value, path);
}

function validateProvenance(value: unknown, path: string): void {
  const provenance = record(value, path);
  text(provenance.sourceSetId, `${path}.sourceSetId`, 4_096);
  nullableText(provenance.calibrationSourceSetId, `${path}.calibrationSourceSetId`, 4_096);
  digest(provenance.manifestSha256, `${path}.manifestSha256`);
  nullableDigest(provenance.upstreamPilotManifestSha256, `${path}.upstreamPilotManifestSha256`);
  nullableDigest(provenance.upstreamCalibrationManifestSha256, `${path}.upstreamCalibrationManifestSha256`);
  digest(provenance.evaluatorDigest, `${path}.evaluatorDigest`);
  nullableDigest(provenance.splitterDigest, `${path}.splitterDigest`);
  text(provenance.showdownCommit, `${path}.showdownCommit`, 128);
  text(provenance.seedNamespace, `${path}.seedNamespace`, 4_096);
  nullableText(provenance.policyId, `${path}.policyId`, 4_096);
  const runtime = record(provenance.runtime, `${path}.runtime`);
  text(runtime.node, `${path}.runtime.node`, 256);
  text(runtime.platform, `${path}.runtime.platform`, 256);
  text(runtime.arch, `${path}.runtime.arch`, 256);
}

function validateCounts(value: unknown, path: string, maximum: number): void {
  const counts = record(value, path);
  const input = count(counts.input, `${path}.input`, maximum);
  const eligible = nullableCount(counts.eligible, `${path}.eligible`, input);
  const excluded = nullableCount(counts.excluded, `${path}.excluded`, input);
  const train = nullableCount(counts.train, `${path}.train`, input);
  const evaluation = nullableCount(counts.eval, `${path}.eval`, input);
  nullableCount(counts.sourceGroups, `${path}.sourceGroups`, input);
  nullableCount(counts.duplicateClusters, `${path}.duplicateClusters`, input);
  nullableCount(counts.nearDuplicatePairs, `${path}.nearDuplicatePairs`, Number.MAX_SAFE_INTEGER);
  if (eligible !== null && excluded !== null && eligible + excluded !== input)
    reject(path, 'eligible and excluded counts must sum to input');
  if (eligible !== null && train !== null && evaluation !== null && train + evaluation !== eligible)
    reject(path, 'train and eval counts must sum to eligible');
}

function validateSplitBalance(value: unknown, path: string, maximum: number): void {
  const balance = record(value, path);
  finite(balance.evalFraction, `${path}.evalFraction`, 0, 1);
  finite(balance.evalFractionDeviation, `${path}.evalFractionDeviation`, 0, 1);
  finite(balance.maxStratumDeviation, `${path}.maxStratumDeviation`, 0, 1);
  const strata = record(balance.strata, `${path}.strata`);
  const entries = Object.entries(strata);
  if (entries.length > maximum) reject(`${path}.strata`, `exceeds ${maximum} entries`);
  for (const [name, raw] of entries) {
    text(name, `${path}.strata key`, 4_096);
    const stratum = record(raw, `${path}.strata.${name}`);
    const total = count(stratum.total, `${path}.strata.${name}.total`, maximum);
    const evaluation = count(stratum.eval, `${path}.strata.${name}.eval`, maximum);
    if (evaluation > total) reject(`${path}.strata.${name}.eval`, 'cannot exceed total');
    finite(stratum.evalFraction, `${path}.strata.${name}.evalFraction`, 0, 1);
    finite(stratum.deviation, `${path}.strata.${name}.deviation`, 0, 1);
  }
}

function validateTask(value: unknown, path: string, limits: ResearchLimitsView): ResearchTaskView {
  const task = record(value, path);
  text(task.taskId, `${path}.taskId`, 4_096);
  text(task.format, `${path}.format`, 4_096);
  oneOf(task.split, `${path}.split`, ['pilot', 'train', 'eval']);
  oneOf(task.phase, `${path}.phase`, ['team_preview', 'forced_switch', 'turn']);
  count(task.turn, `${path}.turn`);
  const prompt = text(task.prompt, `${path}.prompt`, limits.promptCharacters);
  const promptTruncated = boolean(task.promptTruncated, `${path}.promptTruncated`);
  if (promptTruncated && prompt.length !== limits.promptCharacters)
    reject(`${path}.prompt`, 'a truncated preview must fill the declared prompt-character limit');
  const actionCount = positiveCount(task.actionCount, `${path}.actionCount`, limits.actionsPerTask);
  const actions = array(task.actions, `${path}.actions`, limits.actionsPerTask);
  if (actions.length !== actionCount) reject(`${path}.actions`, 'must be the complete actionCount menu');
  actions.forEach((raw, index) => {
    const actionPath = `${path}.actions[${index}]`;
    const action = record(raw, actionPath);
    const number = count(action.number, `${actionPath}.number`, limits.actionsPerTask - 1);
    if (number !== index) reject(`${actionPath}.number`, `expected contiguous zero-based number ${index}`);
    text(action.canonicalAction, `${actionPath}.canonicalAction`, limits.actionLabelCharacters);
    const label = text(action.label, `${actionPath}.label`, limits.actionLabelCharacters);
    if (/\r|\n/u.test(label)) reject(`${actionPath}.label`, 'must occupy one line');
  });
  return task as unknown as ResearchTaskView;
}

function validateArtifact(value: unknown, path: string, limits: ResearchLimitsView): ResearchArtifactView {
  const artifact = record(value, path);
  const kind = oneOf(artifact.kind, `${path}.kind`, ['pilot', 'frozen']);
  const validation = validateValidation(artifact.validation, `${path}.validation`);
  const schemaVersion =
    artifact.schemaVersion === null ? null : positiveCount(artifact.schemaVersion, `${path}.schemaVersion`);
  const releaseReady = artifact.releaseReady === null ? null : boolean(artifact.releaseReady, `${path}.releaseReady`);
  const status = text(artifact.status, `${path}.status`, 4_096);
  if (artifact.protocols !== null) validateProtocols(artifact.protocols, `${path}.protocols`);
  if (artifact.provenance !== null) validateProvenance(artifact.provenance, `${path}.provenance`);
  if (artifact.counts !== null) validateCounts(artifact.counts, `${path}.counts`, limits.artifactRows);
  if (artifact.splitBalance !== null)
    validateSplitBalance(artifact.splitBalance, `${path}.splitBalance`, limits.artifactRows);
  const gates = textArray(artifact.releaseGates, `${path}.releaseGates`, limits.artifactRows);
  const availability = oneOf(artifact.taskPreviewAvailability, `${path}.taskPreviewAvailability`, [
    'available',
    'withheld',
    'unavailable',
  ]);
  const reason = nullableText(artifact.taskPreviewReason, `${path}.taskPreviewReason`, 4_096);
  const taskTotal = count(artifact.taskTotal, `${path}.taskTotal`, limits.artifactRows);
  const taskPreviewCount = count(artifact.taskPreviewCount, `${path}.taskPreviewCount`, limits.taskPreviews);
  const rawTasks = array(artifact.tasks, `${path}.tasks`, limits.taskPreviews);
  if (rawTasks.length !== taskPreviewCount) reject(`${path}.tasks`, 'must match taskPreviewCount');
  if (taskPreviewCount > taskTotal) reject(`${path}.taskPreviewCount`, 'cannot exceed taskTotal');
  const tasks = rawTasks.map((task, index) => validateTask(task, `${path}.tasks[${index}]`, limits));
  const taskIds = new Set<string>();
  tasks.forEach((task, index) => {
    if (taskIds.has(task.taskId)) reject(`${path}.tasks[${index}].taskId`, 'must be unique within the artifact');
    taskIds.add(task.taskId);
    if (kind === 'pilot' && task.split !== 'pilot')
      reject(`${path}.tasks[${index}].split`, 'pilot artifacts require pilot tasks');
    if (kind === 'frozen' && task.split === 'pilot')
      reject(`${path}.tasks[${index}].split`, 'frozen artifacts require train or eval tasks');
  });

  if (validation.status === 'invalid') {
    if (validation.errors.length === 0) reject(`${path}.validation.errors`, 'invalid artifacts require an error');
    if (
      schemaVersion !== null ||
      releaseReady !== null ||
      status !== 'invalid' ||
      artifact.protocols !== null ||
      artifact.provenance !== null ||
      artifact.counts !== null ||
      artifact.splitBalance !== null ||
      gates.length !== 0 ||
      availability !== 'unavailable' ||
      reason === null ||
      taskTotal !== 0 ||
      taskPreviewCount !== 0 ||
      tasks.length !== 0
    ) {
      reject(path, 'invalid artifacts must fail closed');
    }
  } else {
    if (validation.errors.length !== 0) reject(`${path}.validation.errors`, 'valid artifacts cannot have errors');
    if (
      schemaVersion === null ||
      releaseReady === null ||
      status === 'invalid' ||
      artifact.protocols === null ||
      artifact.provenance === null ||
      artifact.counts === null
    ) {
      reject(path, 'valid artifacts require trusted release, schema, protocol, provenance, and count state');
    }
    if (availability === 'unavailable')
      reject(`${path}.taskPreviewAvailability`, 'valid artifacts cannot be unavailable');
    if (availability === 'available' && reason !== null)
      reject(`${path}.taskPreviewReason`, 'available previews cannot have a withholding reason');
    if (availability === 'withheld' && reason === null)
      reject(`${path}.taskPreviewReason`, 'withheld previews require a reason');
    if (availability === 'withheld' && (taskPreviewCount !== 0 || tasks.length !== 0))
      reject(`${path}.tasks`, 'withheld previews must not expose tasks');
    if (availability === 'available' && taskPreviewCount !== Math.min(taskTotal, limits.taskPreviews))
      reject(`${path}.taskPreviewCount`, 'available previews must fill the bounded preview window');
  }

  return artifact as unknown as ResearchArtifactView;
}

function validateProgram(value: unknown): ResearchResponse['program'] {
  const program = record(value, 'program');
  const positions = record(program.positions, 'program.positions');
  if (positions.target !== 'vgc-positions-v1') reject('program.positions.target', 'unsupported target');
  oneOf(positions.stage, 'program.positions.stage', ['not-generated', 'pilot', 'candidate', 'invalid']);
  const circuit = record(program.draftCircuit, 'program.draftCircuit');
  if (circuit.target !== 'vgc-draft-circuit-v1') reject('program.draftCircuit.target', 'unsupported target');
  if (circuit.stage !== 'design') reject('program.draftCircuit.stage', 'expected design');
  return program as unknown as ResearchResponse['program'];
}

function validateLegacy(value: unknown): ResearchResponse['legacyPositions'] {
  const legacy = record(value, 'legacyPositions');
  const present = boolean(legacy.present, 'legacyPositions.present');
  const rows = count(legacy.rows, 'legacyPositions.rows');
  if (legacy.manifestBound !== false) reject('legacyPositions.manifestBound', 'must remain false');
  if (legacy.displayPolicy !== 'inventory-only') reject('legacyPositions.displayPolicy', 'expected inventory-only');
  if (!present && rows !== 0) reject('legacyPositions.rows', 'must be zero when the inventory is absent');
  return legacy as unknown as ResearchResponse['legacyPositions'];
}

export function decodeResearchResponse(value: unknown): ResearchResponse {
  const response = record(value, 'response');
  if (response.schemaVersion !== 1) reject('schemaVersion', 'expected schema 1');
  const limits = validateLimits(response.limits);
  const status = oneOf(response.status, 'status', ['empty', 'ready', 'degraded']);
  const program = validateProgram(response.program);
  validateLegacy(response.legacyPositions);
  const errors = textArray(response.errors, 'errors', limits.artifactRows, 512);
  textArray(response.warnings, 'warnings', limits.artifactRows, 512);
  const rawArtifacts = array(response.artifacts, 'artifacts', 2);
  const artifacts = rawArtifacts.map((artifact, index) => validateArtifact(artifact, `artifacts[${index}]`, limits));
  const kinds = new Set(artifacts.map((artifact) => artifact.kind));
  if (kinds.size !== artifacts.length) reject('artifacts', 'artifact kinds must be unique');
  const invalid = artifacts.some((artifact) => artifact.validation.status === 'invalid');
  const expectedStatus = errors.length > 0 || invalid ? 'degraded' : artifacts.length > 0 ? 'ready' : 'empty';
  if (status !== expectedStatus) reject('status', `expected ${expectedStatus} for the returned artifact state`);
  const expectedStage =
    errors.length > 0 || invalid
      ? 'invalid'
      : artifacts.some((artifact) => artifact.kind === 'frozen')
        ? 'candidate'
        : artifacts.some((artifact) => artifact.kind === 'pilot')
          ? 'pilot'
          : 'not-generated';
  if (program.positions.stage !== expectedStage)
    reject('program.positions.stage', `expected ${expectedStage} for the returned artifact state`);
  return value as ResearchResponse;
}
