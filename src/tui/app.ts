import type { Key } from './term.js';
import { decodeKeys, truncateDisplay } from './term.js';

export interface Screen {
  render(width: number, height: number): string[];
  key(key: Key): void;
  enter?(): void;
  leave?(): void;
}

export class App {
  private screen: Screen | undefined;
  private painting = false;
  private finished!: () => void;
  readonly done = new Promise<void>((resolve) => {
    this.finished = resolve;
  });

  constructor(private readonly output: NodeJS.WriteStream = process.stdout) {}

  get width(): number {
    return this.output.columns || 80;
  }

  get height(): number {
    return this.output.rows || 24;
  }

  setScreen(screen: Screen): void {
    this.screen?.leave?.();
    this.screen = screen;
    screen.enter?.();
    this.paint();
  }

  paint(): void {
    if (this.painting || !this.screen) return;
    this.painting = true;
    queueMicrotask(() => {
      this.painting = false;
      if (!this.screen) return;
      const lines = this.screen.render(this.width, this.height).slice(0, this.height);
      const frame = lines.map((line) => `${truncateDisplay(line, this.width)}\x1b[K`).join('\r\n');
      this.output.write(`\x1b[H${frame}\x1b[J`);
    });
  }

  quit(): void {
    this.screen?.leave?.();
    this.screen = undefined;
    this.finished();
  }

  private handleData = (data: Buffer): void => {
    for (const key of decodeKeys(data.toString('utf8'))) {
      if (!this.screen) return;
      this.screen.key(key);
    }
  };

  private handleResize = (): void => {
    this.output.write('\x1b[2J');
    this.paint();
  };

  async run(first: Screen, input: NodeJS.ReadStream = process.stdin): Promise<void> {
    this.output.write('\x1b[?1049h\x1b[?25l\x1b[2J');
    input.setRawMode(true);
    input.resume();
    input.on('data', this.handleData);
    this.output.on('resize', this.handleResize);
    try {
      this.setScreen(first);
      await this.done;
    } finally {
      input.off('data', this.handleData);
      this.output.off('resize', this.handleResize);
      input.setRawMode(false);
      input.pause();
      this.output.write('\x1b[?25h\x1b[?1049l');
    }
  }
}
