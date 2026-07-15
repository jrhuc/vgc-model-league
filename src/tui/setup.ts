import fs from 'node:fs';
import path from 'node:path';

import { TEAMS_DIR } from '../paths.js';
import type { ProviderSpec, ReasoningLevel } from '../providers.js';
import { envKeyName, parseSpec, REASONING_LEVELS, reasoningLevels } from '../providers.js';
import type { App, Screen } from './app.js';
import { ProviderScreen } from './models.js';
import { RunScreen } from './run.js';
import { StandingsScreen } from './standings.js';
import type { Key } from './term.js';
import { accent, accentBold, bad, bold, dim, good, inverse, warn } from './term.js';
import { pinFooter, rule } from './widgets.js';

export interface RunConfig {
  models: string[];
  seriesPerPair: number;
  pool: string;
  concurrency: number;
  seed?: number;
  reasoning?: ReasoningLevel;
}

interface PoolInfo {
  name: string;
  id: string;
  format: string;
  teamCount: number;
}

interface CredentialStatus {
  provider: string;
  envKey?: string;
  present: boolean;
  optional: boolean;
}

type Step = 0 | 1 | 2;
type Item =
  | { kind: 'model'; index: number }
  | {
      kind:
        | 'add'
        | 'manual'
        | 'next'
        | 'pool'
        | 'reasoning'
        | 'series'
        | 'concurrency'
        | 'seed'
        | 'connections'
        | 'start';
    };

export function listPools(teamsDir = TEAMS_DIR): PoolInfo[] {
  const pools: PoolInfo[] = [];
  for (const name of fs.existsSync(teamsDir) ? fs.readdirSync(teamsDir).sort() : []) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(teamsDir, name, 'pool.json'), 'utf8')) as {
        id?: string;
        format?: string;
        teams?: unknown[];
      };
      pools.push({
        name,
        id: manifest.id ?? name,
        format: manifest.format ?? '?',
        teamCount: Array.isArray(manifest.teams) ? manifest.teams.length : 0,
      });
    } catch {}
  }
  return pools;
}

export function allowedReasoning(specs: string[]): ReasoningLevel[] {
  const llmSpecs: ProviderSpec[] = [];
  for (const spec of specs) {
    if (spec === 'random') continue;
    try {
      llmSpecs.push(parseSpec(spec));
    } catch {}
  }
  if (!llmSpecs.length) return [];
  return REASONING_LEVELS.filter((level) => llmSpecs.every((spec) => reasoningLevels(spec).includes(level)));
}

export function commandPreview(config: RunConfig): string {
  const parts = ['vgcbench run', '--models', ...config.models];
  if (config.reasoning) parts.push('--reasoning', config.reasoning);
  parts.push('--series-per-pair', String(config.seriesPerPair), '--pool', config.pool);
  if (config.concurrency !== 2) parts.push('--concurrency', String(config.concurrency));
  if (config.seed !== undefined) parts.push('--seed', String(config.seed));
  return parts.join(' ');
}

export function runSize(
  modelCount: number,
  seriesPerPair: number,
): {
  pairings: number;
  series: number;
  minimumGames: number;
  maximumGames: number;
} {
  const pairings = (modelCount * (modelCount - 1)) / 2;
  const series = pairings * seriesPerPair;
  return { pairings, series, minimumGames: series * 2, maximumGames: series * 3 };
}

export class SetupScreen implements Screen {
  private models: string[] = [];
  private readonly pools = listPools();
  private poolIndex = 0;
  private reasoning: ReasoningLevel | undefined;
  private seriesPerPair = 2;
  private concurrency = 2;
  private seedText = '';
  private step: Step = 0;
  private readonly cursors = [0, 0, 0];
  private editing = false;
  private editBuffer = '';
  private message = '';

  constructor(private readonly app: App) {
    const preferred = this.pools.findIndex((pool) => pool.name !== 'test');
    this.poolIndex = preferred >= 0 ? preferred : 0;
  }

  private items(step = this.step): Item[] {
    if (step === 0)
      return [
        ...this.models.map((_, index) => ({ kind: 'model', index }) as Item),
        { kind: 'add' },
        { kind: 'manual' },
        { kind: 'next' },
      ];
    if (step === 1)
      return [
        { kind: 'pool' },
        { kind: 'reasoning' },
        { kind: 'series' },
        { kind: 'concurrency' },
        { kind: 'seed' },
        { kind: 'next' },
      ];
    return [{ kind: 'connections' }, { kind: 'start' }];
  }

  private get cursor(): number {
    return this.cursors[this.step]!;
  }

  private set cursor(value: number) {
    this.cursors[this.step] = value;
  }

  private currentItem(): Item {
    const items = this.items();
    return items[Math.min(this.cursor, items.length - 1)]!;
  }

  private reasoningOptions(): Array<ReasoningLevel | undefined> {
    return [undefined, ...allowedReasoning(this.models)];
  }

  private config(): RunConfig {
    const pool = this.pools[this.poolIndex];
    return {
      models: [...this.models],
      seriesPerPair: this.seriesPerPair,
      pool: pool?.name ?? '',
      concurrency: this.concurrency,
      ...(this.seedText === '' ? {} : { seed: Number(this.seedText) }),
      ...(this.reasoning === undefined ? {} : { reasoning: this.reasoning }),
    };
  }

  private credentialStatuses(): CredentialStatus[] {
    const statuses = new Map<string, CredentialStatus>();
    for (const value of this.models) {
      const spec = parseSpec(value);
      const envKey = envKeyName(spec);
      if (!envKey || statuses.has(spec.provider)) continue;
      statuses.set(spec.provider, {
        provider: spec.provider,
        envKey,
        present: Boolean(process.env[envKey]),
        optional: spec.provider === 'compat',
      });
    }
    return [...statuses.values()];
  }

  private addModel = (spec: string): void => {
    if (this.models.includes(spec)) {
      this.message = `${spec} is already a contender`;
      return;
    }
    this.models.push(spec);
    this.reasoning = undefined;
    this.step = 0;
    this.cursor = this.models.length - 1;
    this.message = `${spec} added`;
  };

  private openProviders(): void {
    this.app.setScreen(new ProviderScreen(this.app, this, this, this.addModel));
  }

  private advance(): void {
    if (this.step === 0 && this.models.length < 2) {
      this.message = 'Add at least two contenders before designing the match.';
      return;
    }
    if (this.step < 2) {
      this.step = (this.step + 1) as Step;
      this.message = '';
    }
  }

  private start(): void {
    const pool = this.pools[this.poolIndex];
    if (!pool || pool.teamCount < 2) {
      this.message = 'No runnable team pool is available. A pool needs at least two validated teams.';
      return;
    }
    const missing = this.credentialStatuses().filter((status) => !status.present && !status.optional);
    if (missing.length) {
      this.message = `Connect ${missing.map((status) => status.provider).join(', ')} before starting.`;
      return;
    }
    this.message = '';
    this.app.setScreen(new RunScreen(this.app, this, this.config()));
  }

  key(key: Key): void {
    if (key.name === 'ctrl-c') {
      this.app.quit();
      return;
    }
    if (this.editing) {
      this.editKey(key);
      return;
    }
    if (key.name === 'char' && key.char === 'q') {
      this.app.quit();
      return;
    }
    if (key.name === 'char' && key.char === 's') {
      this.app.setScreen(new StandingsScreen(this.app, this));
      return;
    }
    if (key.name === 'char' && key.char === 'a') {
      this.openProviders();
      return;
    }
    if (key.name === 'char' && key.char === 'm' && this.step === 0) {
      this.editing = true;
      this.editBuffer = '';
      this.message = '';
      this.app.paint();
      return;
    }
    if (key.name === 'escape') {
      if (this.step > 0) {
        this.step = (this.step - 1) as Step;
        this.message = '';
      } else {
        this.message = 'This is the first step. Press q to quit.';
      }
      this.app.paint();
      return;
    }

    const items = this.items();
    const item = this.currentItem();
    if (key.name === 'up') this.cursor = (this.cursor + items.length - 1) % items.length;
    else if (key.name === 'down' || key.name === 'tab') this.cursor = (this.cursor + 1) % items.length;
    else if (key.name === 'home') this.cursor = 0;
    else if (key.name === 'end') this.cursor = items.length - 1;
    else if ((key.name === 'delete' || key.name === 'backspace') && item.kind === 'model') {
      this.models.splice(item.index, 1);
      this.reasoning = undefined;
      this.cursor = Math.min(this.cursor, this.items().length - 1);
      this.message = 'Contender removed.';
    } else if (key.name === 'enter') this.activate(item);
    else if (key.name === 'left' || key.name === 'right') this.adjust(item, key.name === 'right' ? 1 : -1);
    else if (key.name === 'backspace' && item.kind === 'seed') this.seedText = this.seedText.slice(0, -1);
    else if (key.name === 'char' && item.kind === 'seed' && /\d/.test(key.char!) && this.seedText.length < 15)
      this.seedText += key.char!;
    this.app.paint();
  }

  private activate(item: Item): void {
    if (item.kind === 'add' || item.kind === 'connections') this.openProviders();
    else if (item.kind === 'manual') {
      this.editing = true;
      this.editBuffer = '';
      this.message = '';
    } else if (item.kind === 'next') this.advance();
    else if (item.kind === 'start') this.start();
  }

  private adjust(item: Item, direction: number): void {
    if (item.kind === 'pool' && this.pools.length)
      this.poolIndex = (this.poolIndex + this.pools.length + direction) % this.pools.length;
    else if (item.kind === 'reasoning') {
      const options = this.reasoningOptions();
      const index = options.indexOf(this.reasoning);
      this.reasoning = options[(index + options.length + direction) % options.length];
    } else if (item.kind === 'series') this.seriesPerPair = Math.max(1, this.seriesPerPair + direction);
    else if (item.kind === 'concurrency') this.concurrency = Math.min(8, Math.max(1, this.concurrency + direction));
  }

  private editKey(key: Key): void {
    if (key.name === 'escape') {
      this.editing = false;
      this.message = '';
    } else if (key.name === 'enter') {
      const spec = this.editBuffer.trim();
      if (!spec) this.editing = false;
      else {
        try {
          parseSpec(spec);
          this.addModel(spec);
          this.editing = false;
        } catch (error) {
          this.message = error instanceof Error ? error.message : String(error);
        }
      }
    } else if (key.name === 'backspace' || key.name === 'delete') this.editBuffer = this.editBuffer.slice(0, -1);
    else if (key.name === 'space') this.editBuffer += ' ';
    else if (key.name === 'char' && this.editBuffer.length < 300) this.editBuffer += key.char!;
    this.app.paint();
  }

  render(width: number, height = 24): string[] {
    if (this.editing) return this.renderManual(width, height);
    const lines = [...this.header(width)];
    if (this.step === 0) lines.push(...this.renderContenders(width, height));
    else if (this.step === 1) lines.push(...this.renderMatchDesign(width));
    else lines.push(...this.renderReview(width, height));
    if (this.message && this.step !== 2) lines.push('', `  ${bad(this.message)}`);
    return this.withFooter(lines, height);
  }

  private header(width: number): string[] {
    const steps = ['01 CONTENDERS', '02 MATCH DESIGN', '03 REVIEW'];
    const progress = steps
      .map((label, index) => (index === this.step ? accentBold(label) : index < this.step ? good(label) : dim(label)))
      .join(dim('  ──  '));
    return [
      '',
      `  ${accentBold('VGCBENCH')}  ${bold('STADIUM LAB')}  ${dim('LLM × competitive Pokémon')}`,
      `  ${progress}`,
      '',
      rule(this.step === 0 ? 'CONTENDER FIELD' : this.step === 1 ? 'MATCH DESIGN' : 'RUN REVIEW', width),
    ];
  }

  private renderContenders(_width: number, height: number): string[] {
    const lines: string[] = [];
    const focused = this.currentItem();
    lines.push(`  ${dim(`${this.models.length} selected · models enter a round robin`)}`);
    const slots = Math.max(2, Math.min(7, height - 15));
    const focusIndex = focused.kind === 'model' ? focused.index : Math.max(0, this.models.length - 1);
    const start = Math.max(0, Math.min(focusIndex - Math.floor(slots / 2), this.models.length - slots));
    const shown = this.models.slice(start, start + slots);
    if (start > 0) lines.push(`    ${dim(`↑ ${start} more`)}`);
    for (const [offset, spec] of shown.entries()) {
      const index = start + offset;
      const row = `${String(index + 1).padStart(2, '0')}  ${this.specLabel(spec)}  ${this.authGlyph(spec)}`;
      lines.push(this.row(focused.kind === 'model' && focused.index === index, row));
    }
    if (!this.models.length) lines.push(`    ${dim('No contenders yet. Add one from a provider catalog.')}`);
    if (start + shown.length < this.models.length)
      lines.push(`    ${dim(`↓ ${this.models.length - start - shown.length} more`)}`);
    lines.push(this.row(focused.kind === 'add', '+  Add from provider'));
    lines.push(this.row(focused.kind === 'manual', '⌨  Enter model spec manually'));
    lines.push('');
    lines.push(this.row(focused.kind === 'next', 'Continue to match design  →'));
    lines.push('');
    lines.push(`  ${this.context(focused)}`);
    return lines;
  }

  private renderMatchDesign(width: number): string[] {
    const focused = this.currentItem();
    const pool = this.pools[this.poolIndex];
    const reasoning = this.reasoning ?? 'native defaults';
    const mirror = this.seriesPerPair % 2 === 0 ? good('mirrored') : warn('unmirrored final series');
    return [
      this.field(
        focused,
        'pool',
        'team pool',
        pool?.name ?? 'none',
        pool ? `${pool.teamCount} teams · ${pool.format}` : bad('no pools found'),
      ),
      this.field(
        focused,
        'reasoning',
        'reasoning effort',
        reasoning,
        `${this.reasoningOptions().length - 1} shared levels`,
      ),
      this.field(focused, 'series', 'series / pairing', String(this.seriesPerPair), mirror),
      this.field(focused, 'concurrency', 'parallel series', String(this.concurrency), 'rate-limit pressure'),
      this.field(
        focused,
        'seed',
        'schedule seed',
        this.seedText || 'auto',
        this.seedText ? 'pinned' : 'recorded at start',
      ),
      '',
      this.row(focused.kind === 'next', 'Review run  →'),
      '',
      rule('WHAT THIS CONTROLS', width),
      `  ${this.context(focused)}`,
    ];
  }

  private renderReview(width: number, height: number): string[] {
    const focused = this.currentItem();
    const pool = this.pools[this.poolIndex];
    const size = runSize(this.models.length, this.seriesPerPair);
    const lines: string[] = [];
    const modelSlots = Math.max(2, Math.min(4, height - 18));
    for (const [index, spec] of this.models.slice(0, modelSlots).entries()) {
      const prefix = index === 1 && this.models.length === 2 ? `${accentBold('VS')}  ` : `C${index + 1}  `;
      lines.push(`  ${prefix} ${bold(this.specLabel(spec))}`);
    }
    if (this.models.length > modelSlots) lines.push(`       ${dim(`+ ${this.models.length - modelSlots} contenders`)}`);
    lines.push('');
    lines.push(
      `  ${bold(pool?.name ?? 'no pool')}  ${dim(pool ? `${pool.teamCount} teams · ${pool.format}` : 'not runnable')}`,
    );
    lines.push(
      `  ${accentBold(String(size.pairings))} pairings  ${accentBold(String(size.series))} series  ${accentBold(`${size.minimumGames}–${size.maximumGames}`)} games`,
    );
    lines.push(
      `  ${this.seriesPerPair % 2 === 0 ? good('● mirrored sides + team matchup') : warn('▲ final series in each pairing is not mirrored')}`,
    );
    if (this.models.some((value) => /(?:^|[/:_.-])latest$/i.test(parseSpec(value).model)))
      lines.push(`  ${warn('▲ mutable “latest” alias selected; prefer a snapshot ID for reproducible comparisons')}`);
    const credentials = this.credentialStatuses();
    if (credentials.length) {
      lines.push('');
      lines.push(
        `  ${credentials
          .map((status) => {
            if (status.present) return `${good('●')} ${status.provider}`;
            if (status.optional) return `${warn('◇')} ${status.provider} key optional`;
            return `${bad('○')} ${status.provider} not connected`;
          })
          .join('   ')}`,
      );
    }
    lines.push('');
    lines.push(this.row(focused.kind === 'connections', 'Connections & model catalogs'));
    lines.push(this.row(focused.kind === 'start', '▶  Start benchmark'));
    lines.push(`  ${this.context(focused)}`);
    lines.push('');
    lines.push(rule('BATCH COMMAND', width));
    lines.push(...this.commandLines(width));
    if (this.message) lines.push(`  ${bad(this.message)}`);
    return lines;
  }

  private commandLines(width: number): string[] {
    const maximum = Math.max(24, width - 4);
    const output: string[] = [];
    let line = '$';
    for (const word of commandPreview(this.config()).split(' ')) {
      const next = `${line} ${word}`;
      if (next.length > maximum && line !== '$') {
        output.push(`  ${dim(line)}`);
        line = `  ${word}`;
      } else {
        line = next;
      }
    }
    output.push(`  ${dim(line)}`);
    return output;
  }

  private renderManual(width: number, height: number): string[] {
    const lines = [
      ...this.header(width),
      `  ${bold('Enter a model spec')}`,
      '',
      `  ${accent('▸')} ${this.editBuffer}${accent('▏')}`,
      '',
      `  ${dim('Examples: anthropic:<model-id> · openai:<model-id> · compat:<base-url>:<model-id> · random')}`,
      `  ${dim('Manual entry is the fallback for private deployments and providers without catalogs.')}`,
    ];
    if (this.message) lines.push('', `  ${bad(this.message)}`);
    return this.withFooter(lines, height, 'enter add · esc cancel · backspace erase');
  }

  private specLabel(value: string): string {
    if (value === 'random') return 'Random / legal-move baseline';
    const spec = parseSpec(value);
    return `${spec.provider} / ${spec.model}`;
  }

  private authGlyph(value: string): string {
    const spec = parseSpec(value);
    const key = envKeyName(spec);
    if (!key) return dim('baseline');
    if (process.env[key]) return good('● connected');
    if (spec.provider === 'compat') return warn('◇ key optional');
    return bad('○ connect');
  }

  private field(focused: Item, kind: Item['kind'], label: string, value: string, note: string): string {
    const isFocused = focused.kind === kind;
    const shown = `${label.padEnd(20)}  ${bold(value)}  ${dim(note)}`;
    return this.row(isFocused, shown);
  }

  private row(focused: boolean, text: string): string {
    return focused ? `  ${accent('▸')} ${inverse(` ${text} `)}` : `    ${text}`;
  }

  private context(item: Item): string {
    const text = (() => {
      if (item.kind === 'model')
        return 'Delete removes this contender. Provider and model ID are recorded in every result.';
      if (item.kind === 'add' || item.kind === 'connections')
        return 'Choose a provider, connect an API key for this session, then fetch its live model catalog.';
      if (item.kind === 'manual')
        return 'Use provider:model only when discovery is unavailable or the deployment is private.';
      if (item.kind === 'pool')
        return 'The immutable pool owns the VGC format and fixed team snapshot; it is the benchmark epoch.';
      if (item.kind === 'reasoning')
        return 'One effort label is sent to every contender. Native defaults are not compute-normalized; shared labels are provider-relative.';
      if (item.kind === 'series')
        return 'Each unordered model pair plays this many Bo3 series. Even counts swap sides on the same team matchup.';
      if (item.kind === 'concurrency')
        return 'Number of series run at once. This changes throughput and rate-limit pressure, not the planned matchups.';
      if (item.kind === 'seed')
        return 'Pins teams, sides, and engine seeds. Cloud model output can still vary; the resolved seed is always recorded.';
      if (item.kind === 'start')
        return 'Starting can incur provider cost. The run writes its exact config before the first series.';
      return 'A round robin needs at least two contenders. The next step sets the shared competitive conditions.';
    })();
    return dim(text);
  }

  private withFooter(lines: string[], height: number, help?: string): string[] {
    const controls =
      this.step === 1
        ? '↑↓ move · ←→ adjust · enter select · a providers · s standings · esc back · q quit'
        : `↑↓ move · enter select · a providers · s standings · ${this.step ? 'esc back · ' : ''}q quit`;
    const footer = ['', `  ${dim(help ?? controls)}`];
    return pinFooter(lines, footer, height);
  }
}
