import { clip } from './value.js';

export interface EvidenceSupplied {
  rationale: boolean;
  notebookUpdate: boolean;
}

export interface StageEvidence {
  rationale: string;
  notebook: string;
  supplied: EvidenceSupplied;
}

export interface StageEvidenceOptions {
  currentNotebook: string;
  rationaleLimit: number;
  notebookLimit: number;
}

/** Optional evidence is distinguished by field presence: an absent notebook retains prior context,
 * while a supplied empty string deliberately clears it. */
export function normalizeStageEvidence(
  rationale: unknown,
  notebook: unknown,
  options: StageEvidenceOptions,
): StageEvidence {
  const rationaleSupplied = typeof rationale === 'string';
  const notebookSupplied = typeof notebook === 'string';
  return {
    rationale: rationaleSupplied ? clip(rationale.trim(), options.rationaleLimit) : '',
    notebook: notebookSupplied ? clip(notebook.trim(), options.notebookLimit) : options.currentNotebook,
    supplied: { rationale: rationaleSupplied, notebookUpdate: notebookSupplied },
  };
}

export function noStageEvidence(currentNotebook: string): StageEvidence {
  return { rationale: '', notebook: currentNotebook, supplied: { rationale: false, notebookUpdate: false } };
}

export function evidenceSuppliedRecord(evidence: StageEvidence): {
  rationale: boolean;
  notebook_update: boolean;
} {
  return {
    rationale: evidence.supplied.rationale,
    notebook_update: evidence.supplied.notebookUpdate,
  };
}
