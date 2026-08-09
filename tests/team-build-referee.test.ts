import assert from 'node:assert/strict';
import test from 'node:test';

import { loadBoard } from '../src/draft.js';
import { defaultPsDir } from '../src/paths.js';
import { replayTeamBuildArtifact, type TeamBuildTask, validateTeamBuildSubmission } from '../src/teambuild.js';
import { legalTeamResponse } from './fixtures/team-build.js';

const BOARD = loadBoard('regmb-202607');
const candidate = (id: string) => {
  const found = BOARD.mons.find((entry) => entry.id === id);
  assert.ok(found, `board is missing ${id}`);
  return found;
};
const CANDIDATES = ['garchomp', 'incineroar', 'sinistcha', 'farigiraf', 'whimsicott', 'charizard-mega-y'].map(
  candidate,
);
const CREATED_AT = '2026-03-17T00:00:00.000Z';

function task(): TeamBuildTask {
  return {
    id: 'referee-fixture',
    model: 'scripted:model',
    format: BOARD.format,
    sheetPolicy: 'open',
    executionPolicy: 'strict',
    constraint: { kind: 'frozen-candidate-pool', id: 'referee-pool', teamSize: 6, candidates: CANDIDATES },
    objective: { kind: 'general', brief: 'Build a coherent team.' },
    notebook: 'Retain flexible speed control.',
    provenance: { source: 'team-build-referee-test' },
  };
}

const RESPONSE = legalTeamResponse('Flexible speed control lets this team pressure both fast and slow modes.');

test('provider-free construction referee produces an exactly replayable artifact', () => {
  const result = validateTeamBuildSubmission(task(), RESPONSE, {
    psDir: defaultPsDir(),
    attempts: 1,
    createdAt: CREATED_AT,
  });
  assert.equal(result.status, 'accepted');
  if (result.status !== 'accepted') return;
  const replayed = replayTeamBuildArtifact(result.artifact, { psDir: defaultPsDir() });
  assert.deepEqual(replayed.artifact, result.artifact);
  assert.equal(replayed.packed, result.packed);
});

test('provider-free construction referee rejects malformed and illegal free text', () => {
  const malformed = validateTeamBuildSubmission(task(), '{"sets": []}', {
    psDir: defaultPsDir(),
    createdAt: CREATED_AT,
  });
  assert.equal(malformed.status, 'rejected');

  const illegal = JSON.parse(RESPONSE) as { sets: Array<{ item: string }> };
  illegal.sets[0]!.item = 'Not An Item';
  const rejected = validateTeamBuildSubmission(task(), JSON.stringify(illegal), {
    psDir: defaultPsDir(),
    createdAt: CREATED_AT,
  });
  assert.equal(rejected.status, 'rejected');
  if (rejected.status !== 'rejected') return;
  assert.equal(rejected.artifact.action, null);
  assert.equal(rejected.artifact.fallback, false);
  assert.equal(rejected.artifact.validation.repaired, false);
  assert.ok(rejected.problems.some((problem) => problem.includes('canonical Showdown name')));
});

test('semantic replay rejects action sets or roster ids that do not match packed bytes', () => {
  const result = validateTeamBuildSubmission(task(), RESPONSE, { psDir: defaultPsDir(), createdAt: CREATED_AT });
  assert.equal(result.status, 'accepted');
  if (result.status !== 'accepted') return;

  const changedSet = structuredClone(result.artifact);
  changedSet.action!.sets[0]!.nature = 'Adamant';
  assert.throws(() => replayTeamBuildArtifact(changedSet), /do not exactly match|inconsistent/);

  const changedSelection = structuredClone(result.artifact);
  changedSelection.action!.selected[0] = 'not-owned';
  assert.throws(() => replayTeamBuildArtifact(changedSelection), /does not own/);
});
