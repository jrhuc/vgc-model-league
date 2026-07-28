import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ReasoningLevel } from './providers.js';
import type { CompleteOptions, Completion, Provider, ProviderMessage } from './types.js';

const OMP_BIN = process.env.VGC_OMP_BIN ?? path.join(os.homedir(), '.bun', 'bin', 'omp');
const CLAUDE_BIN = process.env.VGC_CLAUDE_BIN ?? 'claude';
const DEFAULT_TIMEOUT_S = 600;
const MAX_BUFFER = 16 * 1024 * 1024;

function renderMessages(messages: ProviderMessage[]): string {
  const first = messages[0];
  if (messages.length === 1 && first?.role === 'user') return first.content ?? '';
  const parts = messages.map((message) => {
    const label = message.role === 'assistant' ? 'Your earlier reply' : 'User message';
    return `### ${label}\n\n${message.content ?? ''}`;
  });
  return `${parts.join('\n\n')}\n\nContinue the conversation: reply now to the last user message.`;
}

function runCli(bin: string, args: string[], label: string, cwd: string, options: CompleteOptions): Promise<string> {
  const seconds = options.timeout ?? DEFAULT_TIMEOUT_S;
  return new Promise<string>((resolve, reject) => {
    const child = execFile(
      bin,
      args,
      { timeout: seconds * 1000, killSignal: 'SIGKILL', maxBuffer: MAX_BUFFER, cwd },
      (error, stdout, stderr) => {
        if (error && (error as { killed?: boolean }).killed && options.signal?.aborted)
          return reject(new Error(`${label} call aborted`));
        if (error && (error as { killed?: boolean }).killed)
          return reject(new Error(`${label} timed out after ${seconds}s`));
        if (error) {
          const detail = stderr.trim().split('\n').slice(-4).join(' ').slice(0, 600);
          return reject(new Error(`${label} failed: ${detail || error.message}`));
        }
        resolve(stdout.trim());
      },
    );
    options.signal?.addEventListener('abort', () => child.kill('SIGKILL'), { once: true });
  });
}

export class CliProvider implements Provider {
  constructor(
    private readonly flavor: 'omp' | 'claude-cli',
    private readonly model: string,
    private readonly reasoning?: ReasoningLevel,
  ) {}

  async complete(system: string, messages: ProviderMessage[], options: CompleteOptions = {}): Promise<Completion> {
    if (options.tools?.length)
      system = `${system}\n\nTool calls are unavailable in this session. Never emit a tool call or describe one; compute any estimates yourself and reply directly in the required JSON format.`;
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-cli-'));
    const promptPath = path.join(workDir, 'prompt.md');
    fs.writeFileSync(promptPath, renderMessages(messages), 'utf8');
    const [bin, args] =
      this.flavor === 'omp'
        ? [
            OMP_BIN,
            [
              '-p',
              '--no-session',
              '--no-pty',
              '--no-tools',
              '--no-lsp',
              '--no-extensions',
              '--no-skills',
              '--no-rules',
              '--no-title',
              '--model',
              this.model,
              '--system-prompt',
              system,
              ...(this.reasoning ? ['--thinking', this.reasoning] : []),
              `@${promptPath}`,
            ],
          ]
        : [
            CLAUDE_BIN,
            [
              '-p',
              '--model',
              this.model,
              '--system-prompt',
              system,
              '--tools',
              '',
              '--no-session-persistence',
              '--setting-sources',
              '',
              fs.readFileSync(promptPath, 'utf8'),
            ],
          ];
    try {
      const text = await runCli(bin, args, `${this.flavor}:${this.model}`, workDir, options);
      return { text, usage: {}, toolCalls: [] };
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  }
}
