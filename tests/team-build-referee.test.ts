import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadBoard } from '../src/draft.js';
import { defaultPsDir } from '../src/paths.js';
import { seededRng } from '../src/random.js';
import {
  renderTeamBuildTask,
  runTeamBuild,
  type TeamBuildTask,
  validateTeamBuildSubmission,
} from '../src/teambuild.js';
import type { Completion, Provider } from '../src/types.js';

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

function task(sheetPolicy: 'open' | 'closed' = 'open'): TeamBuildTask {
  return {
    id: 'referee-fixture',
    model: 'scripted:model',
    format: BOARD.format,
    sheetPolicy,
    executionPolicy: 'strict',
    constraint: { kind: 'frozen-candidate-pool', id: 'referee-pool', teamSize: 6, candidates: CANDIDATES },
    objective: { kind: 'general', brief: 'Build a coherent team.' },
    notebook: 'Retain flexible speed control.',
    provenance: { source: 'team-build-referee-test' },
  };
}

const RESPONSE = JSON.stringify({
  team_plan: 'Flexible speed control lets this team pressure both fast and slow modes.',
  sets: [
    {
      id: 'garchomp',
      item: 'Life Orb',
      ability: 'Rough Skin',
      nature: 'Jolly',
      moves: ['Earthquake', 'Dragon Claw', 'Rock Slide', 'Protect'],
      evs: { hp: 2, atk: 32, def: 0, spa: 0, spd: 0, spe: 32 },
    },
    {
      id: 'incineroar',
      item: 'Sitrus Berry',
      ability: 'Intimidate',
      nature: 'Impish',
      moves: ['Fake Out', 'Flare Blitz', 'Parting Shot', 'Darkest Lariat'],
      evs: { hp: 32, atk: 0, def: 20, spa: 0, spd: 14, spe: 0 },
    },
    {
      id: 'sinistcha',
      item: 'Leftovers',
      ability: 'Hospitality',
      nature: 'Bold',
      moves: ['Matcha Gotcha', 'Rage Powder', 'Life Dew', 'Protect'],
      evs: { hp: 32, atk: 0, def: 20, spa: 0, spd: 14, spe: 0 },
    },
    {
      id: 'farigiraf',
      item: 'Colbur Berry',
      ability: 'Armor Tail',
      nature: 'Relaxed',
      moves: ['Psychic', 'Trick Room', 'Helping Hand', 'Protect'],
      evs: { hp: 32, atk: 0, def: 20, spa: 14, spd: 0, spe: 0 },
    },
    {
      id: 'whimsicott',
      item: 'Focus Sash',
      ability: 'Prankster',
      nature: 'Timid',
      moves: ['Tailwind', 'Encore', 'Moonblast', 'Protect'],
      evs: { hp: 2, atk: 0, def: 0, spa: 32, spd: 0, spe: 32 },
    },
    {
      id: 'charizard-mega-y',
      item: 'Charizardite Y',
      ability: 'Blaze',
      nature: 'Modest',
      moves: ['Heat Wave', 'Solar Beam', 'Weather Ball', 'Protect'],
      evs: { hp: 20, atk: 0, def: 0, spa: 32, spd: 0, spe: 14 },
    },
  ],
});

function provider(response: string): Provider {
  return {
    complete(): Promise<Completion> {
      return Promise.resolve({ text: response, usage: {}, toolCalls: [] });
    },
  };
}

test('strict referee agrees byte-for-byte with a scripted strict run', async (t) => {
  const pure = validateTeamBuildSubmission(task(), RESPONSE, {
    psDir: defaultPsDir(),
    attempts: 1,
    createdAt: CREATED_AT,
  });
  assert.equal(pure.status, 'accepted');
  if (pure.status !== 'accepted') return;
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-team-build-referee-'));
  t.after(() => fs.rmSync(logDir, { recursive: true, force: true }));
  const result = await runTeamBuild(task(), {
    logDir,
    rng: seededRng(1),
    psDir: defaultPsDir(),
    createdAt: CREATED_AT,
    makeTeambuildProvider: () => provider(RESPONSE),
  });
  assert.deepEqual(result.artifact, pure.artifact);
  assert.equal(result.packed, pure.packed);
  assert.deepEqual(result.artifact.action, pure.artifact.action);
});

test('strict referee rejects malformed and illegal submissions without mutating its task', () => {
  const input = task();
  const before = structuredClone(input);
  const malformed = validateTeamBuildSubmission(input, '{"sets": []}', {
    psDir: defaultPsDir(),
    createdAt: CREATED_AT,
  });
  assert.equal(malformed.status, 'rejected');
  assert.deepEqual(input, before);

  const illegal = JSON.parse(RESPONSE) as { sets: Array<{ item: string }> };
  illegal.sets[0]!.item = 'Not An Item';
  const rejected = validateTeamBuildSubmission(input, JSON.stringify(illegal), {
    psDir: defaultPsDir(),
    createdAt: CREATED_AT,
  });
  assert.equal(rejected.status, 'rejected');
  if (rejected.status !== 'rejected') return;
  assert.equal(rejected.artifact.action, null);
  assert.equal(rejected.artifact.fallback, false);
  assert.equal(rejected.artifact.validation.repaired, false);
  assert.ok(rejected.problems.some((problem) => problem.includes('canonical Showdown name')));
  assert.deepEqual(input, before);
});

test('strict rendering is deterministic and binds open and closed policy identities', () => {
  const open = renderTeamBuildTask(task('open'), { psDir: defaultPsDir() });
  const openAgain = renderTeamBuildTask(task('open'), { psDir: defaultPsDir() });
  const closed = renderTeamBuildTask(task('closed'), { psDir: defaultPsDir() });
  assert.deepEqual(open, openAgain);
  assert.notEqual(open.scaffold, closed.scaffold);
  assert.match(open.system, /team sheets are open/);
  assert.match(closed.system, /team sheets are closed/);
  assert.equal(open.executionPolicy, 'strict');
  assert.equal(open.task.executionPolicy, 'strict');
});
