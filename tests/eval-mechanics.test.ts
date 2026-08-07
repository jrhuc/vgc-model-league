import assert from 'node:assert/strict';
import test from 'node:test';

import { parseGameLog, tally } from '../src/eval/mechanics.js';

function classOf(lines: string[], move: string) {
  return parseGameLog(lines).find((event) => event.move === move);
}

test('a spread move immune on one target but damaging another is not wasted', () => {
  const event = classOf(
    [
      '|turn|1',
      '|move|p1a: Garchomp|Earthquake|p2a: Rotom-Wash|[spread] p2a,p2b',
      '|-immune|p2a: Rotom-Wash|[from] ability: Levitate',
      '|-damage|p2b: Incineroar|120/201',
      '|upkeep',
    ],
    'Earthquake',
  );
  assert.equal(event?.wasted, false);
  assert.equal(event?.classification, null);
});

test('a move whose every target was immune is a provable mechanics error', () => {
  const event = classOf(
    [
      '|turn|3',
      '|move|p1a: Garchomp|Earthquake|p2a: Rotom-Wash',
      '|-immune|p2a: Rotom-Wash|[from] ability: Levitate',
      '|upkeep',
    ],
    'Earthquake',
  );
  assert.equal(event?.wasted, true);
  assert.equal(event?.immune, true);
  assert.equal(event?.cause, 'immunity');
  assert.equal(event?.classification, 'mechanics-error');
  assert.equal(event?.pid, 'p1');
  assert.equal(event?.turn, 3);
});

test('a failed Protect chain is a lost bet, not a mechanics error', () => {
  const event = classOf(['|turn|4', '|move|p2b: Incineroar|Protect||[still]', '|-fail|p2b: Incineroar'], 'Protect');
  assert.equal(event?.classification, 'failed-read');
  assert.equal(event?.cause, 'protect-chain');
});

test('Sucker Punch into a non-attacker is a lost bet', () => {
  const event = classOf(
    ['|turn|2', '|move|p1a: Kingambit|Sucker Punch|p2a: Amoonguss', '|-fail|p1a: Kingambit'],
    'Sucker Punch',
  );
  assert.equal(event?.classification, 'failed-read');
  assert.equal(event?.cause, 'read-dependent');
});

test('re-setting a side condition that is already up is determined by visible state', () => {
  const event = classOf(
    ['|turn|5', '|move|p1b: Whimsicott|Tailwind|p1b: Whimsicott', '|-fail|p1b: Whimsicott'],
    'Tailwind',
  );
  assert.equal(event?.classification, 'mechanics-error');
  assert.equal(event?.cause, 'state-determined');
});

test('an unrecognised failure is left unclassified rather than guessed at', () => {
  const event = classOf(
    ['|turn|6', '|move|p1a: Archaludon|Flash Cannon|p2a: Gholdengo', '|-fail|p1a: Archaludon'],
    'Flash Cannon',
  );
  assert.equal(event?.classification, 'unclassified');
});

test('a miss is luck and never reads as a wasted move', () => {
  const event = classOf(
    ['|turn|1', '|move|p1a: Torkoal|Eruption|p2a: Rillaboom', '|-miss|p1a: Torkoal|p2a: Rillaboom'],
    'Eruption',
  );
  assert.equal(event?.wasted, false);
  assert.equal(event?.classification, null);
});

test('a move blocked by Protect is not counted against the attacker', () => {
  const event = classOf(
    ['|turn|2', '|move|p2b: Froslass|Shadow Ball|p1b: Delphox', '|-activate|p1b: Delphox|move: Protect', '|upkeep'],
    'Shadow Ball',
  );
  assert.equal(event?.wasted, false);
  assert.equal(event?.classification, null);
});

test('tally separates the two error classes and attributes causes', () => {
  const events = parseGameLog([
    '|turn|1',
    '|move|p1a: Garchomp|Earthquake|p2a: Rotom-Wash',
    '|-immune|p2a: Rotom-Wash|[from] ability: Levitate',
    '|move|p2a: Rotom-Wash|Protect||[still]',
    '|-fail|p2a: Rotom-Wash',
    '|move|p1b: Incineroar|Flare Blitz|p2b: Amoonguss',
    '|-damage|p2b: Amoonguss|10/195',
    '|upkeep',
  ]);
  const result = tally(events);
  assert.equal(result.moves, 3);
  assert.equal(result.mechanicsErrors, 1);
  assert.equal(result.failedReads, 1);
  assert.equal(result.byCause.immunity, 1);
  assert.equal(result.byMove.Earthquake, 1);
  assert.equal(result.byMove.Protect, undefined);
});
