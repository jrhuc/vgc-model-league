import assert from 'node:assert/strict';
import test from 'node:test';

import { evidenceSuppliedRecord, normalizeStageEvidence } from '../src/stage-evidence.js';

test('stage evidence distinguishes absent fields from an explicit empty notebook', () => {
  const retained = normalizeStageEvidence(undefined, undefined, {
    currentNotebook: 'Keep this plan.',
    rationaleLimit: 100,
    notebookLimit: 100,
  });
  assert.deepEqual(retained, {
    rationale: '',
    notebook: 'Keep this plan.',
    supplied: { rationale: false, notebookUpdate: false },
  });
  assert.deepEqual(evidenceSuppliedRecord(retained), { rationale: false, notebook_update: false });

  const cleared = normalizeStageEvidence('', '', {
    currentNotebook: 'Keep this plan.',
    rationaleLimit: 100,
    notebookLimit: 100,
  });
  assert.deepEqual(cleared, {
    rationale: '',
    notebook: '',
    supplied: { rationale: true, notebookUpdate: true },
  });
  assert.deepEqual(evidenceSuppliedRecord(cleared), { rationale: true, notebook_update: true });
});
