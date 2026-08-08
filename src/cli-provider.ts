import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ReasoningLevel } from './providers.js';
import type { CompleteOptions, Completion, Provider, ProviderMessage } from './types.js';

const DEFAULT_TIMEOUT_S = 600;
const MAX_BUFFER = 16 * 1024 * 1024;

/** CLI subprocesses inherit only runtime configuration and the listed provider credentials: this
 * intentionally excludes application VGC_* settings and unrelated parent-process secrets. */
const CLI_ENV_KEYS = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'TMPDIR',
  'TMP',
  'TEMP',
  'SystemRoot',
  'WINDIR',
  'ComSpec',
  'PATHEXT',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_ADDRESS',
  'LC_COLLATE',
  'LC_CTYPE',
  'LC_IDENTIFICATION',
  'LC_MEASUREMENT',
  'LC_MESSAGES',
  'LC_MONETARY',
  'LC_NAME',
  'LC_NUMERIC',
  'LC_PAPER',
  'LC_TELEPHONE',
  'LC_TIME',
  'HOSTNAME',
  'SHELL',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_CONFIG_DIR',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'OPENAI_COMPAT_API_KEY',
  'OPENROUTER_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'XAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'CEREBRAS_API_KEY',
  'META_MODEL_API_KEY',
  'KIMI_API_KEY',
  'MOONSHOT_API_KEY',
  'ZAI_API_KEY',
  'OPENCODE_API_KEY',
  'AI_GATEWAY_API_KEY',
] as const;

export function cliEnvironment(parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of CLI_ENV_KEYS) {
    const value = parent[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

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
  if (options.signal?.aborted) return Promise.reject(new Error(`${label} call aborted`));
  return new Promise<string>((resolve, reject) => {
    let child: ReturnType<typeof execFile>;
    let settled = false;
    const abort = () => child.kill('SIGKILL');
    const cleanup = () => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener('abort', abort);
      child.removeListener('close', cleanup);
    };
    child = execFile(
      bin,
      args,
      {
        timeout: seconds * 1000,
        killSignal: 'SIGKILL',
        maxBuffer: MAX_BUFFER,
        cwd,
        env: cliEnvironment(),
      },
      (error, stdout, stderr) => {
        cleanup();
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
    child.once('close', cleanup);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
  });
}

export class CliProvider implements Provider {
  constructor(
    private readonly flavor: 'omp' | 'claude-cli',
    private readonly model: string,
    private readonly reasoning?: ReasoningLevel,
  ) {}

  async complete(system: string, messages: ProviderMessage[], options: CompleteOptions = {}): Promise<Completion> {
    if (options.signal?.aborted) throw new Error(`${this.flavor}:${this.model} call aborted`);
    if (options.tools?.length)
      system = `${system}\n\nTool calls are unavailable in this session. Never emit a tool call or describe one; compute any estimates yourself and reply directly in the required JSON format.`;
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vgc-cli-'));
    const promptPath = path.join(workDir, 'prompt.md');
    fs.writeFileSync(promptPath, renderMessages(messages), { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(promptPath, 0o600);
    const [bin, args] =
      this.flavor === 'omp'
        ? [
            process.env.VGC_OMP_BIN ?? path.join(os.homedir(), '.bun', 'bin', 'omp'),
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
            process.env.VGC_CLAUDE_BIN ?? 'claude',
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
