import assert from 'node:assert/strict';
import test from 'node:test';

import {
  analyzeBo3Adaptation,
  buildNotebookTreatment,
  type AdaptationForkOutcome,
  type NotebookTreatmentKind,
} from '../src/eval/bo3-adaptation.js';

function outcome(
  treatmentKind: NotebookTreatmentKind,
  drawId: string,
  clusterId: string,
  utility: number,
): AdaptationForkOutcome {
  return {
    caseId: 'series-1',
    decisionNodeId: 'game-2-preview',
    armId: treatmentKind,
    treatmentKind,
    drawId,
    clusterId,
    protocolValid: true,
    actionLegal: true,
    utility,
    actionId: `action-${treatmentKind}`,
    modeForecast: [
      { id: 'repeat', p: treatmentKind === 'authentic' ? 0.8 : 0.5 },
      { id: 'change', p: treatmentKind === 'authentic' ? 0.2 : 0.5 },
    ],
    realizedMode: 'repeat',
  };
}

function arm(kind: NotebookTreatmentKind, offsets: [number, number]): AdaptationForkOutcome[] {
  return [outcome(kind, 'd1', 'c1', offsets[0]), outcome(kind, 'd2', 'c2', offsets[1])];
}

test('notebook treatments bind exact bytes and reject malformed controls', () => {
  const treatment = buildNotebookTreatment({ id: 'auth', kind: 'authentic', notebook: 'Observed protect on turn one.' });
  assert.equal(treatment.kind, 'authentic');
  assert.ok(/^[0-9a-f]{64}$/u.test(treatment.treatmentDigest));
  assert.throws(
    () => buildNotebookTreatment({ id: 'withheld', kind: 'withheld', notebook: 'not empty' }),
    /empty bytes/u,
  );
  assert.throws(() => buildNotebookTreatment({ id: 'false', kind: 'false', notebook: '' }), /non-empty bytes/u);
});

test('Bo3 adaptation reports causal memory lift, false-memory harm, and belief calibration', () => {
  const outcomes = [
    ...arm('withheld', [0.4, 0.5]),
    ...arm('authentic', [0.6, 0.7]),
    ...arm('false', [0.2, 0.3]),
    ...arm('placebo', [0.4, 0.5]),
    ...arm('oracle', [0.7, 0.8]),
  ];
  const report = analyzeBo3Adaptation(outcomes);
  assert.ok(Math.abs((report.authenticVsWithheld?.meanDifference ?? 0) - 0.2) < 1e-12);
  assert.ok(Math.abs((report.falseVsWithheld?.meanDifference ?? 0) + 0.2) < 1e-12);
  assert.ok(Math.abs(report.placeboVsWithheld?.meanDifference ?? 1) < 1e-12);
  assert.ok(Math.abs((report.oracleVsWithheld?.meanDifference ?? 0) - 0.3) < 1e-12);
  const authentic = report.forecasts.find((entry) => entry.treatmentKind === 'authentic')!;
  const withheld = report.forecasts.find((entry) => entry.treatmentKind === 'withheld')!;
  assert.ok((authentic.meanBrier ?? 1) < (withheld.meanBrier ?? 0));
});

test('Bo3 adaptation refuses to merge different arm ids into one treatment', () => {
  const outcomes = [...arm('withheld', [0, 0]), ...arm('authentic', [1, 1])];
  outcomes[2]!.armId = 'authentic-a';
  outcomes[3]!.armId = 'authentic-b';
  assert.throws(() => analyzeBo3Adaptation(outcomes), /more than one arm id/u);
});
