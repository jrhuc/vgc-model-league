import path from 'node:path';

import type { ArenaEvent } from '../arena.js';
import { makeRunDirectory, runBenchmark } from '../arena.js';
import { RESULTS_PATH } from '../paths.js';
import { BattleState } from '../state.js';
import type { Pid } from '../types.js';
import { afterColon } from '../value.js';
import type { App, Screen } from './app.js';
import type { RunConfig } from './setup.js';
import { StandingsScreen } from './standings.js';
import type { Key } from './term.js';
import { accent, accentBold, bad, bold, dim, displayWidth, good, padDisplay, SPINNER_FRAMES, warn } from './term.js';
import { formatElapsed, pinFooter, rule, tableLines, wrapText } from './widgets.js';

interface SeriesRow {
  players: Record<Pid, string>;
  status: 'queued' | 'running' | 'done';
  score: Record<Pid, number>;
  game: number;
  turns: number;
  winner: string | null;
}

export class RunScreen implements Screen {
  private rows: SeriesRow[] = [];
  private state: 'starting' | 'running' | 'done' | 'failed' = 'starting';
  private error = '';
  private notices: string[] = [];
  private cursor = 0;
  private browsing = false;
  private detail: number | undefined;
  private readonly battles = new Map<number, { game: number; state: BattleState }>();
  private seed: number | undefined;
  private readonly runId: string;
  private readonly runDir: string;
  private readonly startTime = Date.now();
  private endTime: number | undefined;
  private spinnerIndex = 0;
  private timer: NodeJS.Timeout | undefined;
  private readonly controller = new AbortController();

  constructor(
    private readonly app: App,
    private readonly back: Screen,
    private readonly config: RunConfig,
  ) {
    this.runDir = makeRunDirectory();
    this.runId = path.basename(this.runDir);
  }

  enter(): void {
    this.timer = setInterval(() => {
      this.spinnerIndex += 1;
      if (this.state === 'starting' || this.state === 'running') this.app.paint();
    }, 120);
    void this.launch();
  }

  leave(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.controller.abort();
  }

  private async launch(): Promise<void> {
    const originalError = console.error;
    console.error = (...parts: unknown[]) => {
      this.notices.push(parts.map(String).join(' '));
      this.app.paint();
    };
    try {
      this.state = 'running';
      await runBenchmark(this.config.models, this.config.seriesPerPair, this.runDir, {
        pool: this.config.pool,
        concurrency: this.config.concurrency,
        recordsPath: RESULTS_PATH,
        signal: this.controller.signal,
        ...(this.config.seed === undefined ? {} : { seed: this.config.seed }),
        ...(this.config.reasoning === undefined ? {} : { reasoning: this.config.reasoning }),
        onEvent: (event) => this.onEvent(event),
      });
      this.state = 'done';
    } catch (error) {
      if (this.controller.signal.aborted) return;
      this.state = 'failed';
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      console.error = originalError;
      this.endTime = Date.now();
      this.app.paint();
    }
  }

  private onEvent(event: ArenaEvent): void {
    if (event.type === 'plans') {
      this.seed = event.seed;
      this.rows = event.plans.map((plan) => ({
        players: plan.players,
        status: 'queued',
        score: { p1: 0, p2: 0 },
        game: 0,
        turns: 0,
        winner: null,
      }));
    } else if (event.type === 'series-start') {
      const row = this.rows[event.index];
      if (row) {
        row.status = 'running';
        row.game = 1;
      }
      if (!this.browsing) this.cursor = event.index;
    } else if (event.type === 'game-update') {
      let entry = this.battles.get(event.index);
      if (!entry || entry.game !== event.game) {
        entry = { game: event.game, state: new BattleState('p1') };
        this.battles.set(event.index, entry);
      }
      entry.state.feed(event.lines);
      const row = this.rows[event.index];
      if (row && row.status === 'running') row.game = event.game;
    } else if (event.type === 'game-end') {
      const row = this.rows[event.index];
      if (row) {
        row.score = event.score;
        row.game = event.game + 1;
        row.turns += event.turns;
      }
    } else {
      const row = this.rows[event.index];
      if (row) {
        row.status = 'done';
        row.winner = typeof event.record.winner === 'string' ? event.record.winner : null;
        row.score = event.record.score as Record<Pid, number>;
        row.turns = Number(event.record.turns ?? row.turns);
      }
    }
    this.app.paint();
  }

  key(key: Key): void {
    if (key.name === 'ctrl-c') {
      this.app.quit();
      return;
    }
    if (this.detail !== undefined) {
      if (key.name === 'escape' || key.name === 'enter') {
        this.detail = undefined;
        this.app.paint();
      }
      return;
    }
    if ((key.name === 'up' || key.name === 'down') && this.rows.length) {
      this.browsing = true;
      this.cursor = Math.min(this.rows.length - 1, Math.max(0, this.cursor + (key.name === 'down' ? 1 : -1)));
      this.app.paint();
      return;
    }
    if (key.name === 'enter' && this.rows.length) {
      this.detail = this.cursor;
      this.app.paint();
      return;
    }
    if (this.state !== 'done' && this.state !== 'failed') return;
    if (key.name === 'char' && key.char === 's') this.app.setScreen(new StandingsScreen(this.app, this.back));
    else if (key.name === 'escape') this.app.setScreen(this.back);
    else if (key.name === 'char' && key.char === 'q') this.app.quit();
  }

  render(width: number, height = 24): string[] {
    if (this.detail !== undefined) return this.renderDetail(width, height);
    const lines: string[] = [];
    const finished = this.rows.filter((row) => row.status === 'done').length;
    const elapsed = formatElapsed((this.endTime ?? Date.now()) - this.startTime);
    const total = this.rows.length;
    const barWidth = Math.max(8, Math.min(28, width - 42));
    const filled = total ? Math.round((finished / total) * barWidth) : 0;
    const bar = `${good('█'.repeat(filled))}${dim('░'.repeat(barWidth - filled))}`;
    lines.push('');
    lines.push(
      `  ${accentBold('VGCBENCH')}  ${bold('STADIUM LIVE')}  ${dim(`${this.runId} · ${this.config.pool}${this.seed === undefined ? '' : ` · seed ${this.seed}`}`)}`,
    );
    lines.push('');
    const spinner = accent(SPINNER_FRAMES[this.spinnerIndex % SPINNER_FRAMES.length]!);
    const status =
      this.state === 'done'
        ? `${good('✓')} ${bold('run complete')}`
        : this.state === 'failed'
          ? `${bad('✗')} ${bold('run failed')}`
          : `${spinner} ${bold('series in play')}`;
    lines.push(`  ${status}  ${bar}  ${bold(`${finished}/${total || '?'}`)}  ${dim(elapsed)}`);
    lines.push('');
    lines.push(rule('SERIES BOARD', width));
    const wrapWidth = Math.max(20, width - 4);
    const errorLines = this.error ? wrapText(this.error, wrapWidth, 6) : [];
    const noticeBlocks = this.notices.slice(-2).map((notice) => wrapText(notice, wrapWidth, 3));
    if (this.rows.length) {
      const reserved =
        13 +
        noticeBlocks.reduce((sum, block) => sum + block.length + 1, 0) +
        (errorLines.length ? errorLines.length + 1 : 0);
      const rowSlots = Math.max(1, height - reserved);
      const running = this.rows.findIndex((row) => row.status === 'running');
      const anchor = this.browsing ? this.cursor : running >= 0 ? running : Math.max(0, finished - 1);
      const start = Math.max(0, Math.min(anchor - Math.floor(rowSlots / 2), this.rows.length - rowSlots));
      const body = this.rows.slice(start, start + rowSlots).map((row, index) => {
        const absolute = start + index;
        return [
          absolute === this.cursor ? accentBold(`▸ ${absolute + 1}`) : dim(String(absolute + 1)),
          `${row.players.p1} ${accentBold('VS')} ${row.players.p2}`,
          this.result(row, absolute),
        ];
      });
      lines.push(...tableLines([{ title: '#', align: 'right' }, { title: 'matchup' }, { title: 'result' }], body));
      if (body.length < this.rows.length)
        lines.push(`  ${dim(`showing ${start + 1}–${start + body.length} of ${this.rows.length}`)}`);
    } else {
      lines.push(`  ${dim('preparing seeded series plans…')}`);
    }
    if (errorLines.length) lines.push('', ...errorLines.map((line) => `  ${bad(line)}`));
    for (const block of noticeBlocks) lines.push('', ...block.map((line) => `  ${warn(line)}`));
    const footer = [
      '',
      `  ${dim(
        this.state === 'done' || this.state === 'failed'
          ? '↑↓ select · enter game view · s standings · esc setup · q quit'
          : '↑↓ select · enter game view · ctrl-c leaves the TUI; completed series remain recorded',
      )}`,
    ];
    return pinFooter(lines, footer, height);
  }

  private result(row: SeriesRow, index: number): string {
    if (row.status === 'queued') return dim('· queued');
    if (row.status === 'running') {
      const spinner = accent(SPINNER_FRAMES[this.spinnerIndex % SPINNER_FRAMES.length]!);
      const battle = this.battles.get(index);
      const progress = battle ? (battle.state.turn ? `turn ${battle.state.turn}` : 'preview') : 'starting';
      return `${spinner} game ${Math.max(1, row.game)} ${dim(`· ${progress} · ${row.score.p1}-${row.score.p2}`)}`;
    }
    const score = `${row.score.p1}-${row.score.p2}`;
    const turns = dim(`· ${row.turns} turns`);
    if (!row.winner) return `${warn('− tie')} ${score} ${turns}`;
    return `${good('✓')} ${bold(row.winner)} ${score} ${turns}`;
  }

  private renderDetail(width: number, height: number): string[] {
    const index = this.detail!;
    const row = this.rows[index];
    const entry = this.battles.get(index);
    const lines = [''];
    lines.push(
      `  ${accentBold('VGCBENCH')}  ${bold('GAME VIEW')}  ${dim(`series ${index + 1} of ${this.rows.length} · ${this.runId}`)}`,
    );
    lines.push('');
    if (row) {
      const outcome = row.status === 'done' ? (row.winner ? `winner ${row.winner}` : 'tie') : row.status;
      lines.push(
        `  ${bold(row.players.p1)} ${accentBold('VS')} ${bold(row.players.p2)}  ${dim(`${outcome} · score ${row.score.p1}-${row.score.p2}`)}`,
      );
    }
    lines.push('');
    if (!entry) {
      lines.push(
        `  ${dim(row?.status === 'queued' ? 'series queued; no game has started' : 'waiting for the first simulator update…')}`,
      );
    } else {
      const battle = entry.state;
      lines.push(rule(`GAME ${entry.game} · ${battle.turn ? `TURN ${battle.turn}` : 'TEAM PREVIEW'}`, width));
      lines.push(`  ${dim(`weather ${battle.weatherLabel()} · field ${battle.fieldLabels().join(', ') || 'none'}`)}`);
      for (const pid of ['p1', 'p2'] as const) lines.push('', ...this.sideLines(pid, battle, row));
    }
    return pinFooter(lines, ['', `  ${dim('esc back to series board')}`], height);
  }

  private sideLines(pid: Pid, battle: BattleState, row: SeriesRow | undefined): string[] {
    const side = battle.sides[pid];
    const activeSlots = new Map(Object.entries(side.active).map(([slot, key]) => [key, slot.toUpperCase()]));
    const conditionLabels = battle.conditionLabels(pid);
    const conditions = conditionLabels.length ? `  ${warn(conditionLabels.join(', '))}` : '';
    const lines = [`  ${bold(`${pid} · ${row?.players[pid] ?? '?'}`)}${conditions}`];
    const speciesKey = (species: string) => species.toLowerCase().replace(/[^a-z0-9]/g, '');
    const all = [...side.mons.values()];
    const rich = new Set(
      all
        .filter((mon) => mon.hp !== undefined || mon.moves.size || mon.item || mon.ability)
        .map((mon) => speciesKey(mon.species)),
    );
    const identityKey = (ident: string) => `${pid}:${(afterColon(ident) || 'Pokémon').toLowerCase()}`;
    for (const mon of all.filter((candidate) => candidate.hp !== undefined || candidate.moves.size)) {
      const sheetMon = side.sheet.find((candidate) => identityKey(candidate.ident) === identityKey(mon.ident));
      if (sheetMon) rich.add(speciesKey(sheetMon.species));
    }
    const mons = all.filter((mon) => !(mon.preview && mon.hp === undefined && rich.has(speciesKey(mon.species))));
    if (!mons.length) {
      lines.push(`    ${dim('nothing revealed yet')}`);
      return lines;
    }
    const nameWidth = Math.max(...mons.map((mon) => displayWidth(mon.species)));
    for (const mon of mons) {
      const key = identityKey(mon.ident);
      const activeSlot = activeSlots.get(key);
      const marker = mon.fainted ? bad('✗ ') : activeSlot ? good(`${activeSlot}›`) : dim('· ');
      const attrs = [mon.fainted ? bad('fainted') : mon.hp ? `HP ${mon.hp}` : dim('unrevealed')];
      if (mon.status && !mon.fainted) attrs.push(warn(mon.status));
      if (mon.lastMove) {
        const target = mon.lastMove.target ? ` → ${afterColon(mon.lastMove.target)}` : '';
        attrs.push(`${dim('last')} ${accent(mon.lastMove.name)}${dim(`${target} · T${mon.lastMove.turn}`)}`);
      }
      const boosts = Object.entries(mon.boosts)
        .filter(([, value]) => value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([stat, value]) => `${stat} ${value > 0 ? '+' : ''}${value}`);
      if (boosts.length) attrs.push(accent(boosts.join(', ')));
      lines.push(`    ${marker}${padDisplay(mon.species, nameWidth)}  ${attrs.join('  ')}`);
    }
    return lines;
  }
}
