import path from 'node:path';

import type { ArenaEvent } from '../arena.js';
import { makeRunDirectory, runBenchmark } from '../arena.js';
import { RESULTS_PATH } from '../paths.js';
import type { Pid } from '../types.js';
import type { App, Screen } from './app.js';
import type { RunConfig } from './setup.js';
import { StandingsScreen } from './standings.js';
import type { Key } from './term.js';
import { accent, accentBold, bad, bold, dim, good, SPINNER_FRAMES, warn } from './term.js';
import { formatElapsed, pinFooter, rule, tableLines } from './widgets.js';

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
  private seed: number | undefined;
  private readonly runId: string;
  private readonly runDir: string;
  private readonly startTime = Date.now();
  private endTime: number | undefined;
  private spinnerIndex = 0;
  private timer: NodeJS.Timeout | undefined;

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
        ...(this.config.seed === undefined ? {} : { seed: this.config.seed }),
        ...(this.config.reasoning === undefined ? {} : { reasoning: this.config.reasoning }),
        onEvent: (event) => this.onEvent(event),
      });
      this.state = 'done';
    } catch (error) {
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
    if (this.state !== 'done' && this.state !== 'failed') return;
    if (key.name === 'char' && key.char === 's') this.app.setScreen(new StandingsScreen(this.app, this.back));
    else if (key.name === 'enter' || key.name === 'escape') this.app.setScreen(this.back);
    else if (key.name === 'char' && key.char === 'q') this.app.quit();
  }

  render(width: number, height = 24): string[] {
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
    if (this.rows.length) {
      const notices = this.notices.slice(-2);
      const reserved = 13 + notices.length * 2 + (this.error ? 2 : 0);
      const rowSlots = Math.max(1, height - reserved);
      const running = this.rows.findIndex((row) => row.status === 'running');
      const anchor = running >= 0 ? running : Math.max(0, finished - 1);
      const start = Math.max(0, Math.min(anchor - Math.floor(rowSlots / 2), this.rows.length - rowSlots));
      const body = this.rows
        .slice(start, start + rowSlots)
        .map((row, index) => [
          dim(String(start + index + 1)),
          `${row.players.p1} ${accentBold('VS')} ${row.players.p2}`,
          this.result(row),
        ]);
      lines.push(...tableLines([{ title: '#', align: 'right' }, { title: 'matchup' }, { title: 'result' }], body));
      if (body.length < this.rows.length)
        lines.push(`  ${dim(`showing ${start + 1}–${start + body.length} of ${this.rows.length}`)}`);
    } else {
      lines.push(`  ${dim('preparing seeded series plans…')}`);
    }
    if (this.error) lines.push('', `  ${bad(this.error)}`);
    for (const notice of this.notices.slice(-2)) lines.push('', `  ${warn(notice)}`);
    const footer = [
      '',
      `  ${dim(
        this.state === 'done' || this.state === 'failed'
          ? 's standings · enter setup · q quit'
          : 'running · ctrl-c leaves the TUI; completed series remain recorded',
      )}`,
    ];
    return pinFooter(lines, footer, height);
  }

  private result(row: SeriesRow): string {
    if (row.status === 'queued') return dim('· queued');
    if (row.status === 'running') {
      const spinner = accent(SPINNER_FRAMES[this.spinnerIndex % SPINNER_FRAMES.length]!);
      return `${spinner} game ${Math.max(1, row.game)} ${dim(`· ${row.score.p1}-${row.score.p2}`)}`;
    }
    const score = `${row.score.p1}-${row.score.p2}`;
    const turns = dim(`· ${row.turns} turns`);
    if (!row.winner) return `${warn('− tie')} ${score} ${turns}`;
    return `${good('✓')} ${bold(row.winner)} ${score} ${turns}`;
  }
}
