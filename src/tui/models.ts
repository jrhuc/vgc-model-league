import type { DiscoveredModel, ProviderOption } from '../model-catalog.js';
import { discoverModels, PROVIDER_OPTIONS } from '../model-catalog.js';
import { parseSpec } from '../providers.js';
import type { App, Screen } from './app.js';
import type { Key } from './term.js';
import { accent, accentBold, bad, bold, dim, good, inverse, SPINNER_FRAMES, warn } from './term.js';
import { pinFooter, rule } from './widgets.js';

export class ProviderScreen implements Screen {
  private cursor = 0;
  private message = '';

  constructor(
    private readonly app: App,
    private readonly back: Screen,
    private readonly done: Screen,
    private readonly onSelect: (spec: string) => void,
  ) {}

  key(key: Key): void {
    if (key.name === 'ctrl-c' || (key.name === 'char' && key.char === 'q')) {
      this.app.quit();
      return;
    }
    if (key.name === 'escape') {
      this.app.setScreen(this.back);
      return;
    }
    this.message = '';
    if (key.name === 'up') this.cursor = (this.cursor + PROVIDER_OPTIONS.length - 1) % PROVIDER_OPTIONS.length;
    else if (key.name === 'down' || key.name === 'tab') this.cursor = (this.cursor + 1) % PROVIDER_OPTIONS.length;
    else if (key.name === 'home') this.cursor = 0;
    else if (key.name === 'end') this.cursor = PROVIDER_OPTIONS.length - 1;
    else if (key.name === 'enter') this.open(PROVIDER_OPTIONS[this.cursor]!);
    else if (key.name === 'char' && key.char === 'k') this.connect(PROVIDER_OPTIONS[this.cursor]!, true);
    this.app.paint();
  }

  private open(provider: ProviderOption): void {
    if (provider.id === 'random') {
      this.onSelect('random');
      this.app.setScreen(this.done);
      return;
    }
    if (provider.requiresKey && provider.envKey && !process.env[provider.envKey]) {
      this.connect(provider, false);
      return;
    }
    this.openCatalog(provider);
  }

  private connect(provider: ProviderOption, replace: boolean): void {
    if (!provider.envKey) {
      this.message = `${provider.label} does not use a saved API key.`;
      return;
    }
    this.app.setScreen(
      new CredentialScreen(
        this.app,
        this,
        provider,
        () => this.openCatalog(provider),
        replace && Boolean(process.env[provider.envKey]),
      ),
    );
  }

  private openCatalog(provider: ProviderOption): void {
    if (provider.discovery === 'list') {
      this.app.setScreen(new ModelCatalogScreen(this.app, this, this.done, provider, this.onSelect));
      return;
    }
    this.app.setScreen(new ManualModelScreen(this.app, this, this.done, provider, this.onSelect));
  }

  render(width: number, height = 24): string[] {
    const lines = [
      '',
      `  ${accentBold('VGCBENCH')}  ${bold('CONNECTIONS')}  ${dim('provider → model')}`,
      `  ${dim('Choose where a contender runs. Live catalogs replace guessed model IDs.')}`,
      '',
      rule('PROVIDERS', width),
    ];
    const slots = Math.max(4, height - 10);
    const start = Math.max(0, Math.min(this.cursor - Math.floor(slots / 2), PROVIDER_OPTIONS.length - slots));
    const shown = PROVIDER_OPTIONS.slice(start, start + slots);
    if (start > 0) lines.push(`    ${dim(`↑ ${start} providers`)}`);
    for (const [offset, provider] of shown.entries()) {
      const index = start + offset;
      const status = (() => {
        if (!provider.envKey) return dim(provider.id === 'random' ? 'baseline' : 'manual');
        if (process.env[provider.envKey]) return good('● connected');
        if (!provider.requiresKey) return warn('◇ key optional');
        return bad('○ connect');
      })();
      const detail = `${provider.label.padEnd(16)} ${status}  ${dim(provider.description)}`;
      lines.push(index === this.cursor ? `  ${accent('▸')} ${inverse(` ${detail} `)}` : `    ${detail}`);
    }
    if (start + shown.length < PROVIDER_OPTIONS.length)
      lines.push(`    ${dim(`↓ ${PROVIDER_OPTIONS.length - start - shown.length} providers`)}`);
    if (this.message) lines.push('', `  ${bad(this.message)}`);
    return pinFooter(lines, ['', `  ${dim('↑↓ move · enter open · k set/replace key · esc back · q quit')}`], height);
  }
}

export class CredentialScreen implements Screen {
  private buffer = '';
  private message = '';

  constructor(
    private readonly app: App,
    private readonly back: Screen,
    private readonly provider: ProviderOption,
    private readonly onConnected: () => void,
    private readonly replacing = false,
  ) {}

  key(key: Key): void {
    if (key.name === 'ctrl-c') {
      this.app.quit();
      return;
    }
    if (key.name === 'escape') {
      this.app.setScreen(this.back);
      return;
    }
    if (key.name === 'enter') {
      const value = this.buffer.trim();
      if (!value) this.message = 'Paste an API key, or press esc to keep the current connection.';
      else if (this.provider.envKey) {
        process.env[this.provider.envKey] = value;
        this.buffer = '';
        this.message = '';
        this.onConnected();
        return;
      }
    } else if (key.name === 'backspace' || key.name === 'delete') this.buffer = this.buffer.slice(0, -1);
    else if (key.name === 'space') this.buffer += ' ';
    else if (key.name === 'char' && this.buffer.length < 1000) this.buffer += key.char!;
    this.app.paint();
  }

  render(width: number, height = 24): string[] {
    const masked = this.buffer ? '•'.repeat(Math.min(48, this.buffer.length)) : dim('paste key here');
    const source = this.provider.envKey ? process.env[this.provider.envKey] : undefined;
    const lines = [
      '',
      `  ${accentBold('VGCBENCH')}  ${bold(this.replacing ? 'REPLACE CONNECTION' : 'CONNECT PROVIDER')}`,
      '',
      rule(this.provider.label.toUpperCase(), width),
      `  ${bold('Environment variable')}  ${this.provider.envKey ?? 'none'}`,
      `  ${bold('Current status')}        ${source ? good('● connected for this process') : bad('○ not connected')}`,
      '',
      `  ${accent('▸')} ${masked}${this.buffer ? accent('▏') : ''}`,
      '',
      `  ${dim('The key stays in this vgcbench process only. It is never written to config, results, or disk.')}`,
      `  ${dim('You can also launch vgcbench with the environment variable already set.')}`,
    ];
    if (this.message) lines.push('', `  ${bad(this.message)}`);
    return pinFooter(lines, ['', `  ${dim('enter connect · esc cancel · backspace erase')}`], height);
  }
}

export class ModelCatalogScreen implements Screen {
  private state: 'idle' | 'loading' | 'ready' | 'error' = 'idle';
  private models: DiscoveredModel[] = [];
  private query = '';
  private cursor = 0;
  private message = '';
  private controller: AbortController | undefined;
  private timer: NodeJS.Timeout | undefined;
  private frame = 0;
  private generation = 0;

  constructor(
    private readonly app: App,
    private readonly back: Screen,
    private readonly done: Screen,
    private readonly provider: ProviderOption,
    private readonly onSelect: (spec: string) => void,
  ) {}

  enter(): void {
    if (this.state === 'idle') void this.load();
  }

  leave(): void {
    this.controller?.abort();
    clearInterval(this.timer);
    this.timer = undefined;
  }

  private async load(): Promise<void> {
    this.controller?.abort();
    clearInterval(this.timer);
    const generation = ++this.generation;
    this.controller = new AbortController();
    this.state = 'loading';
    this.message = '';
    this.frame = 0;
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
      this.app.paint();
    }, 80);
    this.app.paint();
    try {
      this.models = await discoverModels(
        this.provider,
        this.provider.envKey ? process.env[this.provider.envKey] : undefined,
        {
          signal: this.controller.signal,
        },
      );
      if (generation !== this.generation) return;
      this.state = 'ready';
      this.cursor = 0;
      if (!this.models.length) this.message = 'The provider returned no chat-capable models. Enter an ID manually.';
    } catch (error) {
      if (generation !== this.generation || this.controller.signal.aborted) return;
      this.state = 'error';
      this.message = error instanceof Error ? error.message : String(error);
    } finally {
      if (generation === this.generation && this.timer) {
        clearInterval(this.timer);
        this.timer = undefined;
        this.app.paint();
      }
    }
  }

  private filtered(): DiscoveredModel[] {
    const query = this.query.trim().toLowerCase();
    if (!query) return this.models;
    return this.models.filter(
      (model) =>
        model.id.toLowerCase().includes(query) ||
        model.displayName?.toLowerCase().includes(query) ||
        model.description?.toLowerCase().includes(query),
    );
  }

  key(key: Key): void {
    if (key.name === 'ctrl-c') {
      this.app.quit();
      return;
    }
    if (key.name === 'escape') {
      this.app.setScreen(this.back);
      return;
    }
    if (key.name === 'char' && key.char === 'r' && this.state === 'error') {
      void this.load();
      return;
    }
    if (
      key.name === 'char' &&
      key.char === 'm' &&
      (this.state === 'error' || (this.state === 'ready' && this.models.length === 0 && this.query === ''))
    ) {
      this.app.setScreen(new ManualModelScreen(this.app, this.back, this.done, this.provider, this.onSelect));
      return;
    }
    if (key.name === 'char' && key.char === 'k' && this.state === 'error' && this.provider.envKey) {
      this.app.setScreen(
        new CredentialScreen(
          this.app,
          this,
          this.provider,
          () =>
            this.app.setScreen(new ModelCatalogScreen(this.app, this.back, this.done, this.provider, this.onSelect)),
          Boolean(process.env[this.provider.envKey]),
        ),
      );
      return;
    }
    const models = this.filtered();
    if (this.state === 'ready') {
      if (key.name === 'up' && models.length) this.cursor = (this.cursor + models.length - 1) % models.length;
      else if ((key.name === 'down' || key.name === 'tab') && models.length)
        this.cursor = (this.cursor + 1) % models.length;
      else if (key.name === 'home') this.cursor = 0;
      else if (key.name === 'end') this.cursor = Math.max(0, models.length - 1);
      else if (key.name === 'enter' && models[this.cursor]) {
        this.onSelect(`${this.provider.id}:${models[this.cursor]!.id}`);
        this.app.setScreen(this.done);
        return;
      } else if (key.name === 'backspace' || key.name === 'delete') {
        this.query = this.query.slice(0, -1);
        this.cursor = 0;
      } else if (key.name === 'space') {
        this.query += ' ';
        this.cursor = 0;
      } else if (key.name === 'char') {
        this.query += key.char!;
        this.cursor = 0;
      }
    }
    this.app.paint();
  }

  render(width: number, height = 24): string[] {
    const lines = [
      '',
      `  ${accentBold('VGCBENCH')}  ${bold(this.provider.label.toUpperCase())}  ${dim('live model catalog')}`,
      `  ${dim(`${this.provider.envKey ?? 'public'} · type to filter · model IDs come from the provider API`)}`,
      '',
      rule('MODELS', width),
    ];
    if (this.state === 'loading') {
      lines.push('', `  ${accent(SPINNER_FRAMES[this.frame]!)} Fetching models from ${this.provider.label}…`);
    } else if (this.state === 'error') {
      lines.push('', `  ${bad('Catalog request failed')}`, `  ${this.message}`);
      lines.push('', `  ${dim('r retries · k replaces the API key · m enters a model ID manually')}`);
    } else {
      const models = this.filtered();
      lines.push(
        `  ${accent('filter')}  ${this.query}${accent('▏')}  ${dim(`${models.length} / ${this.models.length}`)}`,
      );
      lines.push('');
      const slots = Math.max(3, height - 12);
      this.cursor = Math.min(this.cursor, Math.max(0, models.length - 1));
      const start = Math.max(0, Math.min(this.cursor - Math.floor(slots / 2), models.length - slots));
      for (const [offset, model] of models.slice(start, start + slots).entries()) {
        const index = start + offset;
        const label = `${model.id}${model.displayName && model.displayName !== model.id ? `  ${dim(model.displayName)}` : ''}${model.description ? `  ${dim(model.description)}` : ''}`;
        lines.push(index === this.cursor ? `  ${accent('▸')} ${inverse(` ${label} `)}` : `    ${label}`);
      }
      if (!models.length) {
        const hint = this.models.length
          ? 'No matches. Backspace to widen the filter.'
          : 'The provider returned no usable models. Press m to enter an ID manually.';
        lines.push(`    ${dim(hint)}`);
      }
    }
    if (this.message && this.state === 'ready') lines.push('', `  ${warn(this.message)}`);
    const help =
      this.state === 'error'
        ? 'r retry · k replace key · m manual · esc providers'
        : this.models.length
          ? '↑↓ move · type filter · enter add · esc providers'
          : 'm manual · esc providers';
    return pinFooter(lines, ['', `  ${dim(help)}`], height);
  }
}

export class ManualModelScreen implements Screen {
  private buffer = '';
  private message = '';

  constructor(
    private readonly app: App,
    private readonly back: Screen,
    private readonly done: Screen,
    private readonly provider: ProviderOption,
    private readonly onSelect: (spec: string) => void,
  ) {}

  key(key: Key): void {
    if (key.name === 'ctrl-c') {
      this.app.quit();
      return;
    }
    if (key.name === 'escape') {
      this.app.setScreen(this.back);
      return;
    }
    if (key.name === 'enter') {
      const value = this.buffer.trim();
      const spec = this.provider.id === 'compat' ? value : `${this.provider.id}:${value}`;
      try {
        parseSpec(spec);
        this.onSelect(spec);
        this.app.setScreen(this.done);
        return;
      } catch (error) {
        this.message = error instanceof Error ? error.message : String(error);
      }
    } else if (key.name === 'backspace' || key.name === 'delete') this.buffer = this.buffer.slice(0, -1);
    else if (key.name === 'space') this.buffer += ' ';
    else if (key.name === 'char' && this.buffer.length < 300) this.buffer += key.char!;
    this.app.paint();
  }

  render(width: number, height = 24): string[] {
    const custom = this.provider.id === 'compat';
    const lines = [
      '',
      `  ${accentBold('VGCBENCH')}  ${bold('MANUAL MODEL')}`,
      '',
      rule(this.provider.label.toUpperCase(), width),
      `  ${dim(custom ? 'Enter the full custom provider spec.' : `Enter the model ID after ${this.provider.id}:`)}`,
      '',
      `  ${accent('▸')} ${custom ? '' : dim(`${this.provider.id}:`)}${this.buffer}${accent('▏')}`,
      '',
      `  ${dim(custom ? 'Format: compat:<base-url>:<model-id>' : 'Use the exact model ID from the provider dashboard or documentation.')}`,
    ];
    if (this.message) lines.push('', `  ${bad(this.message)}`);
    return pinFooter(lines, ['', `  ${dim('enter add · esc back · backspace erase')}`], height);
  }
}
