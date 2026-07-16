import type { BattleStream } from 'pokemon-showdown';
import type { RoomBattleTimer, TimerPlayer } from './showdown.js';
import { loadRoomBattleTimer } from './showdown.js';
import type { Pid } from './types.js';

export type TimerEvent = 'autodefault' | 'forfeit' | 'tie';

export class TimerAdapter {
  private readonly players: TimerPlayer[];
  private readonly bySlot: Record<Pid, TimerPlayer>;
  private readonly timer: RoomBattleTimer;
  private readonly battle: {
    format: string;
    challengeType: string;
    ended: boolean;
    players: TimerPlayer[];
    playerTable: Record<string, never>;
    room: { add(): unknown; update(): unknown };
    turn: number;
    requestCount: number;
    stream: { write(command: string): void | Promise<void> };
    tie(): void | Promise<void>;
    forfeitPlayer(player: TimerPlayer): void | Promise<void>;
  };

  constructor(
    format: string,
    private readonly stream: BattleStream,
    private readonly onEvent: (pid: Pid, event: TimerEvent) => void,
    psDir: string,
  ) {
    this.players = (['p1', 'p2'] as const).map((slot) => ({
      slot,
      name: slot,
      active: true,
      knownActive: true,
      eliminated: false,
      request: { isWait: 'cantUndo' },
      sendRoom() {},
    }));
    this.bySlot = { p1: this.players[0]!, p2: this.players[1]! };
    const room = { add: () => room, update: () => room };
    this.battle = {
      format,
      challengeType: 'challenge',
      ended: false,
      players: this.players,
      playerTable: {},
      room,
      turn: 0,
      requestCount: 0,
      stream: {
        write: (command) => {
          const match = /^>(p[12]) default$/.exec(command);
          if (match) {
            const pid = match[1] as Pid;
            this.bySlot[pid].request.isWait = true;
            this.onEvent(pid, 'autodefault');
          }
          return this.stream.write(command);
        },
      },
      tie: () => {
        for (const player of this.players) this.onEvent(player.slot, 'tie');
        return this.stream.write('>forcetie');
      },
      forfeitPlayer: (player) => {
        player.eliminated = true;
        player.request.isWait = true;
        this.onEvent(player.slot, 'forfeit');
        return this.stream.write(`>forcelose ${player.slot}`);
      },
    };
    const Timer = loadRoomBattleTimer(psDir);
    this.timer = new Timer(this.battle);
    this.timer.start();
  }

  setPlayer(pid: Pid, name: string): void {
    this.bySlot[pid].name = name;
  }

  receive(message: string): string {
    const lines = message.split('\n');
    if (lines[0] === 'update') {
      for (const line of lines.slice(1)) {
        if (line.startsWith('|turn|')) this.battle.turn = Number(line.slice(6));
      }
    } else if (lines[0] === 'sideupdate') {
      const pid = lines[1] as Pid;
      const player = this.bySlot[pid];
      const line = lines[2] ?? '';
      if (player && line.startsWith('|request|')) {
        const request = JSON.parse(line.slice(9)) as Record<string, unknown>;
        player.request = { isWait: request.wait ? 'cantUndo' : false };
        this.battle.requestCount += 1;
        if (!request.update) this.timer.nextRequest(player);
        if (!request.wait) {
          request.timer = { turnSeconds: player.turnSecondsLeft, seconds: player.secondsLeft };
          lines[2] = `|request|${JSON.stringify(request)}`;
        }
      } else if (player && line.startsWith('|error|[Invalid choice]')) {
        player.request.isWait = line.includes("Can't undo") ? 'cantUndo' : false;
      }
    } else if (lines[0] === 'end') {
      this.battle.ended = true;
      this.timer.end();
    }
    return lines.join('\n');
  }

  choose(pid: Pid, choice: string): void | Promise<void> {
    const player = this.bySlot[pid];
    if (player.request.isWait) return;
    player.request.isWait = true;
    return this.stream.write(`>${pid} ${choice}`);
  }

  end(): void {
    this.battle.ended = true;
    this.timer.end();
  }
}
