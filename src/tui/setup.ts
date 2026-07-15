import fs from 'node:fs';
import path from 'node:path';

import { RESULTS_PATH, TEAMS_DIR } from '../paths.js';
import type { ProviderSpec, ReasoningLevel } from '../providers.js';
import { envKeyName, parseSpec, REASONING_LEVELS, reasoningLevels } from '../providers.js';
import { loadRows } from '../records.js';
import type { App, Screen } from './app.js';
import { RunScreen } from './run.js';
import { StandingsScreen } from './standings.js';
import type { Key } from './term.js';
import { accent, accentBold, bad, bold, dim, good, warn } from './term.js';
import { rule } from './widgets.js';

export interface RunConfig {
  models: string[];
  seriesPerPair: number;
  pool: string;
  concurrency: number;
  seed?: number;
  reasoning?: ReasoningLevel;
}

interface ModelEntry {
  spec: string;
  selected: boolean;
  note?: string;
}

interface PoolInfo {
  name: string;
  id: string;
  format: string;
  teamCount: number;
}

const CURATED = [
  'anthropic:claude-sonnet-5',
  'anthropic:claude-opus-4-8',
  'anthropic:claude-haiku-4-5',
  'openai:gpt-5.2',
  'google:gemini-3-pro',
  'random',
];

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

export function recentSpecs(recordsPath = RESULTS_PATH, limit = 6): string[] {
  const seen: string[] = [];
  for (const row of loadRows(recordsPath).reverse()) {
    for (const spec of Object.values(row.players ?? {})) {
      if (seen.includes(spec) || CURATED.includes(spec)) continue;
      try {
        parseSpec(spec);
        seen.push(spec);
      } catch {}
    }
    if (seen.length >= limit) break;
  }
  return seen.slice(0, limit);
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

type Item =
  | { kind: 'model'; index: number }
  | { kind: 'add' | 'pool' | 'reasoning' | 'series' | 'concurrency' | 'seed' | 'start' };

export class SetupScreen implements Screen {
  private models: ModelEntry[];
  private pools: PoolInfo[];
  private poolIndex: number;
  private reasoningIndex = 0;
  private seriesPerPair = 2;
  private concurrency = 2;
  private seedText = '';
  private cursor = 0;
  private editing: 'custom' | null = null;
  private editBuffer = '';
  private message = '';

  constructor(private readonly app: App) {
    this.models = [...CURATED, ...recentSpecs()].map((spec) => ({ spec, selected: false }));
    this.pools = listPools();
    if (!this.pools.length) this.pools = [{ name: 'test', id: 'test', format: '?', teamCount: 0 }];
    const preferred = this.pools.findIndex((pool) => pool.name !== 'test');
    this.poolIndex = preferred >= 0 ? preferred : 0;
  }

  private items(): Item[] {
    return [
      ...this.models.map((_, index) => ({ kind: 'model', index }) as Item),
      { kind: 'add' },
      { kind: 'pool' },
      { kind: 'reasoning' },
      { kind: 'series' },
      { kind: 'concurrency' },
      { kind: 'seed' },
      { kind: 'start' },
    ];
  }

  private selectedSpecs(): string[] {
    return this.models.filter((entry) => entry.selected).map((entry) => entry.spec);
  }

  private reasoningOptions(): Array<ReasoningLevel | undefined> {
    return [undefined, ...allowedReasoning(this.selectedSpecs())];
  }

  private config(): RunConfig {
    const reasoning = this.reasoningOptions()[this.reasoningIndex];
    return {
      models: this.selectedSpecs(),
      seriesPerPair: this.seriesPerPair,
      pool: this.pools[this.poolIndex]!.name,
      concurrency: this.concurrency,
      ...(this.seedText === '' ? {} : { seed: Number(this.seedText) }),
      ...(reasoning === undefined ? {} : { reasoning }),
    };
  }

  private keyStatus(): Array<{ name: string; present: boolean }> {
    const names = new Map<string, boolean>();
    for (const spec of this.selectedSpecs()) {
      try {
        const name = envKeyName(parseSpec(spec));
        if (name) names.set(name, Boolean(process.env[name]));
      } catch {}
    }
    return [...names.entries()].map(([name, present]) => ({ name, present }));
  }

  private start(): void {
    const config = this.config();
    if (config.models.length < 2) {
      this.message = 'select at least two models';
      return;
    }
    const missing = this.keyStatus().filter((status) => !status.present && status.name !== 'OPENAI_COMPAT_API_KEY');
    if (missing.length) {
      this.message = `missing ${missing.map((status) => status.name).join(', ')}`;
      return;
    }
    this.message = '';
    this.app.setScreen(new RunScreen(this.app, this, config));
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
    const items = this.items();
    const item = items[this.cursor]!;
    this.message = '';
    if (key.name === 'up') this.cursor = (this.cursor + items.length - 1) % items.length;
    else if (key.name === 'down' || key.name === 'tab') this.cursor = (this.cursor + 1) % items.length;
    else if (key.name === 'space' && item.kind === 'model') this.toggle(item.index);
    else if (key.name === 'enter') {
      if (item.kind === 'model') this.toggle(item.index);
      else if (item.kind === 'add') {
        this.editing = 'custom';
        this.editBuffer = '';
      } else if (item.kind === 'start') this.start();
      else this.adjust(item, 1);
    } else if (key.name === 'left' || key.name === 'right') this.adjust(item, key.name === 'right' ? 1 : -1);
    else if (key.name === 'backspace' && item.kind === 'seed') this.seedText = this.seedText.slice(0, -1);
    else if (key.name === 'char' && item.kind === 'seed' && /\d/.test(key.char!) && this.seedText.length < 15)
      this.seedText += key.char!;
    else if (key.name === 'char' && key.char === 'a') {
      this.editing = 'custom';
      this.editBuffer = '';
    } else if (key.name === 'char' && key.char === 's') this.app.setScreen(new StandingsScreen(this.app, this));
    else if ((key.name === 'char' && key.char === 'q') || key.name === 'escape') this.app.quit();
    this.app.paint();
  }

  private toggle(index: number): void {
    this.models[index]!.selected = !this.models[index]!.selected;
    this.reasoningIndex = Math.min(this.reasoningIndex, this.reasoningOptions().length - 1);
  }

  private adjust(item: Item, direction: number): void {
    if (item.kind === 'pool') this.poolIndex = (this.poolIndex + this.pools.length + direction) % this.pools.length;
    else if (item.kind === 'reasoning') {
      const count = this.reasoningOptions().length;
      this.reasoningIndex = (this.reasoningIndex + count + direction) % count;
    } else if (item.kind === 'series') this.seriesPerPair = Math.max(1, this.seriesPerPair + direction);
    else if (item.kind === 'concurrency') this.concurrency = Math.min(8, Math.max(1, this.concurrency + direction));
  }

  private editKey(key: Key): void {
    if (key.name === 'escape') {
      this.editing = null;
      this.message = '';
    } else if (key.name === 'enter') {
      const spec = this.editBuffer.trim();
      if (spec) {
        try {
          parseSpec(spec);
          if (!this.models.some((entry) => entry.spec === spec)) this.models.push({ spec, selected: true });
          else this.models.find((entry) => entry.spec === spec)!.selected = true;
          this.cursor = this.models.findIndex((entry) => entry.spec === spec);
          this.editing = null;
          this.message = '';
        } catch (error) {
          this.message = error instanceof Error ? error.message : String(error);
        }
      } else this.editing = null;
    } else if (key.name === 'backspace') this.editBuffer = this.editBuffer.slice(0, -1);
    else if (key.name === 'space') this.editBuffer += ' ';
    else if (key.name === 'char') this.editBuffer += key.char!;
    this.app.paint();
  }

  render(width: number): string[] {
    const items = this.items();
    const focused = items[this.cursor]!;
    const lines: string[] = [];
    lines.push('');
    lines.push(`  ${accentBold('vgcbench')}  ${dim('LLM VGC Bo3 benchmark on the real Showdown simulator')}`);
    lines.push('');
    lines.push(rule('MODELS', width));
    for (const [index, entry] of this.models.entries()) {
      const isFocused = focused.kind === 'model' && focused.index === index;
      const marker = isFocused ? accent('▸') : ' ';
      const box = entry.selected ? good('◉') : dim('○');
      const label = entry.selected ? bold(entry.spec) : entry.spec;
      lines.push(`  ${marker} ${box} ${isFocused ? accent(entry.spec) : label}`);
    }
    if (this.editing === 'custom') {
      lines.push(
        `  ${accent('▸')} ${accent('add:')} ${this.editBuffer}${accent('▏')} ${dim('(enter to confirm, esc to cancel)')}`,
      );
    } else {
      const isFocused = focused.kind === 'add';
      lines.push(
        `  ${isFocused ? accent('▸') : ' '}   ${isFocused ? accent('+ add model spec…') : dim('+ add model spec…')}`,
      );
    }
    lines.push('');
    lines.push(rule('OPTIONS', width));
    const pool = this.pools[this.poolIndex]!;
    const reasoning = this.reasoningOptions()[this.reasoningIndex];
    const reasoningLabel = reasoning ?? 'provider default';
    lines.push(this.field(focused, 'pool', 'pool', pool.name, `${pool.teamCount} teams · ${pool.format}`));
    lines.push(
      this.field(
        focused,
        'reasoning',
        'reasoning',
        reasoningLabel,
        this.reasoningOptions().length === 1 && this.selectedSpecs().some((spec) => spec !== 'random')
          ? 'selected models share no reasoning levels'
          : '',
      ),
    );
    lines.push(
      this.field(
        focused,
        'series',
        'series per pair',
        String(this.seriesPerPair),
        this.seriesPerPair % 2 ? warn('odd count leaves the last matchup unmirrored') : '',
      ),
    );
    lines.push(this.field(focused, 'concurrency', 'concurrency', String(this.concurrency), ''));
    lines.push(
      this.field(
        focused,
        'seed',
        'seed',
        this.seedText === '' ? 'random' : this.seedText,
        focused.kind === 'seed' ? 'type digits to pin' : '',
      ),
    );
    lines.push('');
    const keyStatus = this.keyStatus();
    if (keyStatus.length) {
      lines.push(
        `  ${keyStatus
          .map((status) =>
            status.present ? `${good('●')} ${dim(status.name)}` : `${bad('○')} ${bad(`${status.name} missing`)}`,
          )
          .join('   ')}`,
      );
      lines.push('');
    }
    const isStart = focused.kind === 'start';
    const startLabel = '▶ start run';
    lines.push(`  ${isStart ? accent('▸') : ' '} ${isStart ? accentBold(startLabel) : bold(startLabel)}`);
    lines.push('');
    const config = this.config();
    if (config.models.length >= 2) lines.push(`  ${dim(`$ ${commandPreview(config)}`)}`);
    else lines.push(`  ${dim('select at least two models to build a run')}`);
    if (this.message) {
      lines.push('');
      lines.push(`  ${bad(this.message)}`);
    }
    lines.push('');
    lines.push(`  ${dim('↑↓ move · space toggle · ←→ adjust · enter select · a add · s standings · q quit')}`);
    return lines;
  }

  private field(focused: Item, kind: string, label: string, value: string, note: string): string {
    const isFocused = focused.kind === kind;
    const marker = isFocused ? accent('▸') : ' ';
    const shown = isFocused ? `${accent('‹')} ${accentBold(value)} ${accent('›')}` : `  ${bold(value)}  `;
    const paddedLabel = label.padEnd(16);
    return `  ${marker} ${isFocused ? accent(paddedLabel) : paddedLabel}${shown}${note ? `  ${dim(note)}` : ''}`;
  }
}
