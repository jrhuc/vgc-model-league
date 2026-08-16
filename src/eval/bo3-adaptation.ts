import {
  type MatchedForkOutcome,
  type PairedArmContrast,
  pairedArmContrast,
} from './experiment-kernel.js';
import { canonicalJsonDigest } from './serialization.js';
import {
  multiclassBrierScore,
  type OpponentModeProbability,
} from './strategic-task.js';

export const BO3_ADAPTATION_PROTOCOL = {
  version: 1,
  treatment: 'exact-notebook-bytes-v1',
  contrast: 'matched-later-decision-common-draw-v1',
  validity: 'protocol-and-legality-reported-separately-v1',
  belief: 'multiclass-brier-diagnostic-v1',
} as const;

export type NotebookTreatmentKind = 'authentic' | 'withheld' | 'stale' | 'false' | 'placebo' | 'oracle';

export interface NotebookTreatment {
  id: string;
  kind: NotebookTreatmentKind;
  notebook: string;
  sourceDigest: string | null;
  treatmentDigest: string;
}

export interface AdaptationForkOutcome extends MatchedForkOutcome {
  treatmentKind: NotebookTreatmentKind;
  actionId: string | null;
  modeForecast?: OpponentModeProbability[];
  realizedMode?: string;
}

export interface TreatmentForecastScore {
  treatmentKind: NotebookTreatmentKind;
  samples: number;
  meanBrier: number | null;
}

export interface Bo3AdaptationReport {
  protocolVersion: typeof BO3_ADAPTATION_PROTOCOL.version;
  baselineArmId: string;
  armByTreatment: Partial<Record<NotebookTreatmentKind, string>>;
  authenticVsWithheld: PairedArmContrast | null;
  staleVsWithheld: PairedArmContrast | null;
  falseVsWithheld: PairedArmContrast | null;
  placeboVsWithheld: PairedArmContrast | null;
  oracleVsWithheld: PairedArmContrast | null;
  forecasts: TreatmentForecastScore[];
}

export function buildNotebookTreatment(input: {
  id: string;
  kind: NotebookTreatmentKind;
  notebook: string;
  sourceDigest?: string | null;
}): NotebookTreatment {
  if (!input.id) throw new Error('notebook treatment id must be non-empty');
  if (input.kind === 'withheld' && input.notebook !== '') {
    throw new Error('withheld notebook treatment must inject empty bytes');
  }
  if (['false', 'placebo', 'oracle'].includes(input.kind) && !input.notebook) {
    throw new Error(`${input.kind} notebook treatment must inject non-empty bytes`);
  }
  const sourceDigest = input.sourceDigest ?? null;
  if (sourceDigest !== null && !/^[0-9a-f]{64}$/u.test(sourceDigest)) {
    throw new Error('notebook treatment sourceDigest must be a SHA-256 digest when supplied');
  }
  const base = {
    protocolVersion: BO3_ADAPTATION_PROTOCOL.version,
    id: input.id,
    kind: input.kind,
    notebook: input.notebook,
    sourceDigest,
  };
  return { id: input.id, kind: input.kind, notebook: input.notebook, sourceDigest, treatmentDigest: canonicalJsonDigest(base) };
}

function uniqueArmByTreatment(outcomes: readonly AdaptationForkOutcome[]): Partial<Record<NotebookTreatmentKind, string>> {
  const armByTreatment: Partial<Record<NotebookTreatmentKind, string>> = {};
  for (const outcome of outcomes) {
    const current = armByTreatment[outcome.treatmentKind];
    if (current !== undefined && current !== outcome.armId) {
      throw new Error(`treatment ${outcome.treatmentKind} is split across more than one arm id`);
    }
    armByTreatment[outcome.treatmentKind] = outcome.armId;
  }
  return armByTreatment;
}

function contrast(
  outcomes: readonly AdaptationForkOutcome[],
  armByTreatment: Partial<Record<NotebookTreatmentKind, string>>,
  kind: Exclude<NotebookTreatmentKind, 'withheld'>,
  baseline: string,
): PairedArmContrast | null {
  const treatment = armByTreatment[kind];
  return treatment === undefined ? null : pairedArmContrast(outcomes, treatment, baseline);
}

function forecastScores(outcomes: readonly AdaptationForkOutcome[]): TreatmentForecastScore[] {
  const byKind = new Map<NotebookTreatmentKind, number[]>();
  for (const outcome of outcomes) {
    const hasForecast = outcome.modeForecast !== undefined;
    const hasRealized = outcome.realizedMode !== undefined;
    if (hasForecast !== hasRealized) {
      throw new Error('adaptation outcome must bind a mode forecast and realized mode together');
    }
    if (!hasForecast || !outcome.protocolValid || !outcome.actionLegal) continue;
    const score = multiclassBrierScore(
      outcome.modeForecast as OpponentModeProbability[],
      outcome.realizedMode as string,
    );
    byKind.set(outcome.treatmentKind, [...(byKind.get(outcome.treatmentKind) ?? []), score]);
  }
  const kinds: NotebookTreatmentKind[] = ['authentic', 'withheld', 'stale', 'false', 'placebo', 'oracle'];
  return kinds.map((treatmentKind) => {
    const values = byKind.get(treatmentKind) ?? [];
    return {
      treatmentKind,
      samples: values.length,
      meanBrier: values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null,
    };
  });
}

export function analyzeBo3Adaptation(outcomes: readonly AdaptationForkOutcome[]): Bo3AdaptationReport {
  if (!outcomes.length) throw new Error('Bo3 adaptation analysis needs fork outcomes');
  const armByTreatment = uniqueArmByTreatment(outcomes);
  const baselineArmId = armByTreatment.withheld;
  if (baselineArmId === undefined) throw new Error('Bo3 adaptation analysis requires a withheld notebook arm');
  return {
    protocolVersion: BO3_ADAPTATION_PROTOCOL.version,
    baselineArmId,
    armByTreatment,
    authenticVsWithheld: contrast(outcomes, armByTreatment, 'authentic', baselineArmId),
    staleVsWithheld: contrast(outcomes, armByTreatment, 'stale', baselineArmId),
    falseVsWithheld: contrast(outcomes, armByTreatment, 'false', baselineArmId),
    placeboVsWithheld: contrast(outcomes, armByTreatment, 'placebo', baselineArmId),
    oracleVsWithheld: contrast(outcomes, armByTreatment, 'oracle', baselineArmId),
    forecasts: forecastScores(outcomes),
  };
}
