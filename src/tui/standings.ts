import { RESULTS_PATH } from '../paths.js';
import type { SeriesRecord } from '../records.js';
import { h2h, loadRows, standings } from '../records.js';
import type { App, Screen } from './app.js';
import type { Key } from './term.js';
import { accent, accentBold, bold, dim } from './term.js';
import { rule, tableLines } from './widgets.js';

export class StandingsScreen implements Screen {
  private rows: SeriesRecord[] = [];
  private pools: Array<string | undefined> = [undefined];
  private poolIndex = 0;

  constructor(
    private readonly app: App,
    private readonly back: Screen,
  ) {
    this.reload();
  }

  private reload(): void {
    this.rows = loadRows(RESULTS_PATH);
    const names = [...new Set(this.rows.map((row) => String(row.pool ?? '')))].filter(Boolean).sort();
    this.pools = [undefined, ...names];
    this.poolIndex = Math.min(this.poolIndex, this.pools.length - 1);
  }

  private filtered(): SeriesRecord[] {
    const pool = this.pools[this.poolIndex];
    return pool === undefined ? this.rows : this.rows.filter((row) => row.pool === pool);
  }

  key(key: Key): void {
    if (key.name === 'ctrl-c' || (key.name === 'char' && key.char === 'q')) {
      this.app.quit();
      return;
    }
    if (key.name === 'escape' || key.name === 'enter') {
      this.app.setScreen(this.back);
      return;
    }
    if (key.name === 'left') this.poolIndex = (this.poolIndex + this.pools.length - 1) % this.pools.length;
    else if (key.name === 'right') this.poolIndex = (this.poolIndex + 1) % this.pools.length;
    else if (key.name === 'char' && key.char === 'r') this.reload();
    this.app.paint();
  }

  render(width: number): string[] {
    const rows = this.filtered();
    const pool = this.pools[this.poolIndex] ?? 'all pools';
    const lines: string[] = [];
    lines.push('');
    lines.push(
      `  ${accentBold('vgcbench')}  ${dim('standings')}  ${accent('‹')} ${bold(pool)} ${accent('›')}  ${dim(`${rows.length} series`)}`,
    );
    lines.push('');
    if (!rows.length) {
      lines.push(`  ${dim('no recorded results yet — run a benchmark first')}`);
    } else {
      lines.push(rule('STANDINGS', width));
      lines.push(
        ...tableLines(
          [
            { title: 'model' },
            { title: 'series', align: 'right' },
            { title: 'w', align: 'right' },
            { title: 'l', align: 'right' },
            { title: 't', align: 'right' },
            { title: 'win rate', align: 'right' },
            { title: 'elo', align: 'right' },
          ],
          standings(rows).map((item, index) => [
            index === 0 ? accentBold(item.spec) : item.spec,
            String(item.series),
            String(item.w),
            String(item.l),
            String(item.t),
            `${(100 * item.winrate).toFixed(1)}%`,
            index === 0 ? accentBold(item.elo.toFixed(1)) : item.elo.toFixed(1),
          ]),
        ),
      );
      const matrix = h2h(rows);
      const specs = Object.keys(matrix);
      if (specs.length >= 2) {
        lines.push('');
        lines.push(rule('HEAD TO HEAD (W-L-T)', width));
        lines.push(
          ...tableLines(
            [{ title: '' }, ...specs.map((spec) => ({ title: spec, align: 'right' as const }))],
            specs.map((model) => [
              model,
              ...specs.map((opponent) => (model === opponent ? dim('—') : matrix[model]![opponent]!.join('-'))),
            ]),
          ),
        );
      }
    }
    lines.push('');
    lines.push(`  ${dim('←→ pool filter · r reload · esc back · q quit')}`);
    return lines;
  }
}
