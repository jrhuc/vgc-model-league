const path = require('node:path');
const readline = require('node:readline');

const psDir = process.argv[2];
if (!psDir) throw new Error('missing Pokemon Showdown path');

global.Config = {};
global.Monitor = {crashlog() {}, slow() {}};
global.Dex = require(path.join(psDir, 'dist', 'sim')).Dex;
global.Dex.includeModData();

const {BattleStream} = require(path.join(psDir, 'dist', 'sim', 'battle-stream.js'));
const {RoomBattleTimer} = require(path.join(psDir, 'dist', 'server', 'room-battle.js'));

const stream = new BattleStream({noCatch: true});
const players = ['p1', 'p2'].map(slot => ({
  slot,
  name: slot,
  active: true,
  knownActive: true,
  eliminated: false,
  request: {isWait: 'cantUndo'},
  sendRoom() {},
}));
const bySlot = Object.fromEntries(players.map(player => [player.slot, player]));
const room = {
  add() { return room; },
  update() { return room; },
};
let battle = null;
let timer = null;
let format = '';
let playerCount = 0;

function emitTimer(slot, event) {
  process.stdout.write(`sideupdate\n${slot}\n|timer|${event}\n\n`);
}

function startTimer() {
  if (timer || !format || playerCount < players.length) return;
  battle = {
    format,
    challengeType: 'challenge',
    ended: false,
    players,
    playerTable: {},
    room,
    turn: 0,
    requestCount: 0,
    stream: {
      write(command) {
        const match = /^>(p[12]) default$/.exec(command);
        if (match) {
          bySlot[match[1]].request.isWait = true;
          emitTimer(match[1], 'autodefault');
        }
        return stream.write(command);
      },
    },
    tie() {
      for (const player of players) emitTimer(player.slot, 'tie');
      return stream.write('>forcetie');
    },
    forfeitPlayer(player) {
      player.eliminated = true;
      player.request.isWait = true;
      emitTimer(player.slot, 'forfeit');
      return stream.write(`>forcelose ${player.slot}`);
    },
  };
  timer = new RoomBattleTimer(battle);
  timer.start();
}

function receive(message) {
  const lines = message.trimEnd().split('\n');
  if (!lines.length || !battle) return message;
  if (lines[0] === 'update') {
    for (const line of lines.slice(1)) {
      if (line.startsWith('|turn|')) battle.turn = Number(line.slice(6));
    }
  } else if (lines[0] === 'sideupdate') {
    const player = bySlot[lines[1]];
    const line = lines[2] || '';
    if (line.startsWith('|request|')) {
      const request = JSON.parse(line.slice(9));
      player.request = {isWait: request.wait ? 'cantUndo' : false};
      battle.requestCount += 1;
      if (!request.update) timer.nextRequest(player);
      if (!request.wait) {
        request.timer = {
          turnSeconds: player.turnSecondsLeft,
          seconds: player.secondsLeft,
        };
        lines[2] = `|request|${JSON.stringify(request)}`;
        return `${lines.join('\n')}\n\n`;
      }
    } else if (line.startsWith("|error|[Invalid choice]")) {
      player.request.isWait = line.includes("Can't undo") ? 'cantUndo' : false;
    }
  } else if (lines[0] === 'end') {
    battle.ended = true;
    timer.end();
  }
  return message;
}

async function readOutput() {
  for await (const message of stream) process.stdout.write(receive(`${message}\n\n`));
}

async function readInput() {
  const input = readline.createInterface({input: process.stdin, crlfDelay: Infinity});
  for await (const line of input) {
    if (line.startsWith('>start ')) {
      format = JSON.parse(line.slice(7)).formatid;
    } else if (line.startsWith('>player ')) {
      const match = /^>player (p[12]) (.+)$/.exec(line);
      if (match) {
        bySlot[match[1]].name = JSON.parse(match[2]).name;
        playerCount += 1;
        startTimer();
      }
    } else {
      const match = /^>(p[12]) /.exec(line);
      if (match && bySlot[match[1]].request.isWait) continue;
      if (match) bySlot[match[1]].request.isWait = true;
    }
    await stream.write(line);
  }
  await stream.writeEnd();
}

Promise.all([readOutput(), readInput()]).catch(error => {
  if (timer) timer.end();
  process.stdin.destroy();
  stream.destroy();
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
