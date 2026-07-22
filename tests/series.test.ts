import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { Bo3Context } from '../src/series.js';
import { gameLuck, playBo3, SINGLE_ELIMINATION_GAME_LIMIT } from '../src/series.js';

test('game luck tallies chance events per side from the full log', () => {
  const luck = gameLuck([
    '|move|p2a: Aerodactyl|Rock Slide|p1a: Politoed|[spread] p1a,p1b',
    '|-miss|p2a: Aerodactyl|p1b: Gengar',
    '|-crit|p1a: Politoed',
    '|cant|p1a: Politoed|flinch',
    '|cant|p1b: Tinkaton|flinch',
    '|cant|p2b: Kingambit|par',
    '|-damage|p1a: Politoed|100/196',
    'garbage line without pipe',
  ]);
  assert.deepEqual(luck.p1, { misses: 0, crits_taken: 1, flinched_turns: 2, full_paralysis: 0 });
  assert.deepEqual(luck.p2, { misses: 1, crits_taken: 0, flinched_turns: 0, full_paralysis: 1 });
});

function fakeEngines(): Bo3Context['engines'] {
  const engine = () =>
    ({
      beginGame() {},
      endGame() {},
    }) as unknown as Bo3Context['engines']['p1'];
  return { p1: engine(), p2: engine() };
}

test('single elimination plays deterministic tiebreak games until one side wins', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-series-tiebreak-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const planned: Array<[number, number, number, number]> = [
    [1, 2, 3, 4],
    [5, 6, 7, 8],
    [9, 10, 11, 12],
  ];
  const run = async (name: string) => {
    const seriesDir = path.join(directory, name);
    fs.mkdirSync(seriesDir);
    const seeds: Array<[number, number, number, number]> = [];
    let game = 0;
    const result = await playBo3({
      engines: fakeEngines(),
      names: { p1: 'Side One', p2: 'Side Two' },
      players: { p1: 'model-one', p2: 'model-two' },
      teams: { p1: { id: 'one', packed: '' }, p2: { id: 'two', packed: '' } },
      gameSeeds: planned,
      seriesId: name,
      seriesDir,
      format: 'test',
      psDir: '',
      requireWinner: true,
      runBattle: async (seed) => {
        seeds.push(seed);
        game += 1;
        const winner = game === 4 ? 'Side Two' : null;
        return {
          winner,
          turns: 1,
          log: [winner ? `|win|${winner}` : '|tie'],
          pov: { p1: [], p2: [] },
          errors: { p1: 0, p2: 0 },
          fallbacks: { p1: 0, p2: 0 },
        };
      },
    });
    return { result, seeds };
  };

  const first = await run('first');
  const second = await run('second');
  assert.equal(first.result.winnerSide, 'p2');
  assert.deepEqual(first.result.score, { p1: 0, p2: 1 });
  assert.equal(first.result.games.length, 4);
  assert.deepEqual(first.seeds.slice(0, 3), planned);
  assert.deepEqual(first.seeds[3], second.seeds[3]);
});

test('single elimination fails rather than fabricating a winner after the safety cap', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-series-tiebreak-cap-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let games = 0;
  await assert.rejects(
    playBo3({
      engines: fakeEngines(),
      names: { p1: 'Side One', p2: 'Side Two' },
      players: { p1: 'model-one', p2: 'model-two' },
      teams: { p1: { id: 'one', packed: '' }, p2: { id: 'two', packed: '' } },
      gameSeeds: [
        [1, 2, 3, 4],
        [5, 6, 7, 8],
        [9, 10, 11, 12],
      ],
      seriesId: 'cap',
      seriesDir: directory,
      format: 'test',
      psDir: '',
      requireWinner: true,
      runBattle: async () => {
        games += 1;
        return {
          winner: null,
          turns: 1,
          log: ['|tie'],
          pov: { p1: [], p2: [] },
          errors: { p1: 0, p2: 0 },
          fallbacks: { p1: 0, p2: 0 },
        };
      },
    }),
    /remained tied after 9 games/,
  );
  assert.equal(games, SINGLE_ELIMINATION_GAME_LIMIT);
});
