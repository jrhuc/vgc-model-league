import type { CompleteOptions, Completion, JsonObject, Provider, ProviderMessage, ToolCall } from './types.js';

import { isRecord, text } from './value.js';

export const REASONING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

export const USAGE =
  'Usage: anthropic:<model>, openai:<model>, google:<model>, xai:<model>, deepseek:<model>, meta:<model>, kimi:<model>, zai:<model>, openrouter:<model>, cerebras:<model>, compat:<base_url>:<model>, or random';

export const COMPAT_BASE_URLS: Record<string, string> = {
  xai: 'https://api.x.ai/v1',
  deepseek: 'https://api.deepseek.com',
  meta: 'https://api.meta.ai/v1',
  kimi: 'https://api.moonshot.ai/v1',
  zai: 'https://api.z.ai/api/paas/v4',
  openrouter: 'https://openrouter.ai/api/v1',
  cerebras: 'https://api.cerebras.ai/v1',
};

const COMPAT_ENV_KEYS: Record<string, string> = Object.fromEntries(
  Object.keys(COMPAT_BASE_URLS).map((provider) => [provider, `${provider.toUpperCase()}_API_KEY`]),
);
COMPAT_ENV_KEYS.meta = 'META_MODEL_API_KEY';
COMPAT_ENV_KEYS.kimi = 'MOONSHOT_API_KEY';

export interface ProviderSpec {
  provider: string;
  model: string;
  baseUrl?: string;
}

export function envKeyName(spec: ProviderSpec): string | undefined {
  if (spec.provider === 'random') return undefined;
  if (spec.provider === 'anthropic') return 'ANTHROPIC_API_KEY';
  if (spec.provider === 'openai') return 'OPENAI_API_KEY';
  if (spec.provider === 'google') return 'GEMINI_API_KEY';
  if (spec.provider === 'compat') return 'OPENAI_COMPAT_API_KEY';
  return COMPAT_ENV_KEYS[spec.provider];
}

export function parseSpec(value: string): ProviderSpec {
  if (value === 'random') return { provider: 'random', model: 'random' };
  for (const provider of ['anthropic', 'openai', 'google']) {
    if (value.startsWith(`${provider}:`) && value.length > provider.length + 1)
      return { provider, model: value.slice(provider.length + 1) };
  }
  for (const [provider, baseUrl] of Object.entries(COMPAT_BASE_URLS)) {
    if (value.startsWith(`${provider}:`) && value.length > provider.length + 1)
      return { provider, model: value.slice(provider.length + 1), baseUrl };
  }
  if (value.startsWith('compat:')) {
    const rest = value.slice(7);
    const separator = rest.lastIndexOf(':');
    const baseUrl = rest.slice(0, separator);
    const model = rest.slice(separator + 1);
    if (separator > 0 && baseUrl.includes('://') && model) return { provider: 'compat', model, baseUrl };
  }
  throw new Error(USAGE);
}

export function reasoningLevels(spec: ProviderSpec): ReasoningLevel[] {
  const model = spec.model.toLowerCase();
  if (spec.provider === 'meta' && model.includes('muse-spark'))
    return ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];
  if (spec.provider === 'anthropic') {
    const opus = /opus-(\d+)[.-](\d+)/.exec(model);
    const sonnet = /sonnet-(\d+)/.exec(model);
    if (
      (opus && (Number(opus[1]) > 4 || (Number(opus[1]) === 4 && Number(opus[2]) >= 7))) ||
      (sonnet && Number(sonnet[1]) >= 5) ||
      model.includes('fable-5')
    )
      return ['low', 'medium', 'high', 'xhigh', 'max'];
    if (['opus-4-6', 'opus-4.6', 'sonnet-4-6', 'sonnet-4.6'].some((name) => model.includes(name)))
      return ['low', 'medium', 'high', 'max'];
    return [];
  }
  if (spec.provider === 'openai') return openaiReasoningLevels(model);
  if (spec.provider === 'google') {
    if (model.includes('gemini-3')) {
      if (model.includes('flash-image')) return ['minimal', 'high'];
      if (model.includes('pro-image')) return ['high'];
      if (model.includes('flash')) return ['minimal', 'low', 'medium', 'high'];
      const minor = /gemini-3\.(\d+)/.exec(model);
      return minor && Number(minor[1]) >= 1 ? ['low', 'medium', 'high'] : ['low', 'high'];
    }
    return model.includes('gemini-2.5') ? ['high', 'max'] : [];
  }
  if (spec.provider === 'xai') {
    if (model.includes('grok-4.3')) return ['off', 'low', 'medium', 'high'];
    if (model.includes('grok-4')) return ['low', 'medium', 'high'];
    if (model.includes('grok-3-mini')) return ['low', 'high'];
    return [];
  }
  if (spec.provider === 'deepseek' && model.includes('deepseek')) return ['off', 'high', 'max'];
  if (spec.provider === 'cerebras') {
    if (model.includes('gpt-oss')) return ['low', 'medium', 'high'];
    if (model.includes('glm')) return ['off'];
  }
  return spec.provider === 'compat' ? [...REASONING_LEVELS] : [];
}

function openaiReasoningLevels(model: string): ReasoningLevel[] {
  if (model.includes('deep-research')) return ['medium'];
  if (!/(?:^|\/)gpt-5(?:[.-]|$)/.test(model))
    return /(?:^|\/)(?:o1|o3|o4)(?:[.-]|$)/.test(model) ? ['low', 'medium', 'high'] : [];
  const versionMatch = /(?:^|\/)gpt-5[.-](\d+)(?:[.-]|$)/.exec(model);
  const version = versionMatch ? Number(versionMatch[1]) : undefined;
  if (model.includes('-chat')) return version === undefined ? [] : ['medium'];
  if (/(?:^|\/)gpt-5[.-]?pro(?:[.-]|$)/.test(model)) return ['high'];
  if (/(?:^|\/)gpt-5[.-]\d+[.-]pro(?:[.-]|$)/.test(model)) return ['medium', 'high', 'xhigh'];
  if (model.includes('codex')) {
    if (version !== undefined && version >= 3) return ['off', 'low', 'medium', 'high', 'xhigh'];
    if (model.includes('codex-max') || (version !== undefined && version >= 2))
      return ['low', 'medium', 'high', 'xhigh'];
    return ['low', 'medium', 'high'];
  }
  if (version === 1) return ['off', 'low', 'medium', 'high'];
  if (version !== undefined && version >= 6) return ['low', 'medium', 'high', 'xhigh', 'max'];
  if (version !== undefined && version >= 2) return ['off', 'low', 'medium', 'high', 'xhigh'];
  return ['minimal', 'low', 'medium', 'high'];
}

export function validateReasoning(spec: ProviderSpec, level?: ReasoningLevel): void {
  if (!level || spec.provider === 'random') return;
  const supported = reasoningLevels(spec);
  if (!supported.includes(level))
    throw new Error(
      `${spec.provider}:${spec.model} does not support reasoning=${level}; supported: ${supported.join(', ') || 'no configurable levels'}`,
    );
}

function parseToolArguments(value: unknown): JsonObject {
  if (isRecord(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function assistantToolMessage(completion: Completion): ProviderMessage {
  return {
    role: 'assistant',
    content: completion.text || null,
    toolCalls: completion.toolCalls.map((call, index) => ({ ...call, id: call.id || `call_${index}` })),
  };
}

export function toolResultMessage(callId: string, content: string): ProviderMessage {
  return { role: 'tool', toolCallId: callId, content };
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: JsonObject,
  timeoutSeconds: number,
): Promise<JsonObject> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Math.max(100, timeoutSeconds * 1000)),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError')
      throw new ApiError(0, `request to ${url} timed out after ${timeoutSeconds}s`);
    throw error;
  }
  const raw = await response.text();
  if (!response.ok)
    throw new ApiError(response.status, `${response.status} ${response.statusText}: ${raw.slice(0, 2000)}`);
  const data: unknown = JSON.parse(raw);
  if (!isRecord(data)) throw new ApiError(response.status, `unexpected response from ${url}`);
  return data;
}

function usageNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

const DEFAULT_TIMEOUT = 120;

export class AnthropicProvider implements Provider {
  private supportsTemperature = true;

  constructor(
    readonly model: string,
    private readonly apiKey?: string,
    readonly reasoning?: ReasoningLevel,
  ) {}

  private key(): string {
    const key = this.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error('Missing ANTHROPIC_API_KEY');
    return key;
  }

  async complete(system: string, messages: ProviderMessage[], options: CompleteOptions = {}): Promise<Completion> {
    const converted: JsonObject[] = [];
    for (const message of messages) {
      if (message.role === 'tool') {
        const block = { type: 'tool_result', tool_use_id: message.toolCallId ?? '', content: message.content ?? '' };
        const previous = converted.at(-1);
        if (previous?.role === 'user' && Array.isArray(previous.content)) previous.content.push(block);
        else converted.push({ role: 'user', content: [block] });
      } else if (message.role === 'assistant' && message.toolCalls?.length) {
        const content: JsonObject[] = [];
        if (message.content) content.push({ type: 'text', text: message.content });
        content.push(
          ...message.toolCalls.map((call) => ({
            type: 'tool_use',
            id: call.id,
            name: call.name,
            input: call.arguments,
          })),
        );
        converted.push({ role: 'assistant', content });
      } else {
        converted.push({ role: message.role === 'assistant' ? 'assistant' : 'user', content: message.content ?? '' });
      }
    }
    const params: JsonObject = {
      model: this.model,
      system,
      max_tokens: options.maxTokens ?? 1200,
      messages: converted,
    };
    if (options.tools?.length) {
      params.tools = options.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters,
      }));
      if (options.toolChoice === 'auto' || options.toolChoice === 'none')
        params.tool_choice = { type: options.toolChoice };
    }
    if (!this.reasoning) {
      if (this.supportsTemperature) params.temperature = options.temperature ?? 0.6;
    } else if (this.reasoning === 'off') {
      if (this.supportsTemperature) params.temperature = options.temperature ?? 0.6;
      params.thinking = { type: 'disabled' };
    } else {
      params.thinking = { type: 'adaptive' };
      params.output_config = { effort: this.reasoning };
    }
    let response: JsonObject;
    while (true) {
      try {
        response = await postJson(
          'https://api.anthropic.com/v1/messages',
          { 'x-api-key': this.key(), 'anthropic-version': '2023-06-01' },
          params,
          options.timeout ?? DEFAULT_TIMEOUT,
        );
        break;
      } catch (error) {
        if (
          error instanceof ApiError &&
          error.status === 400 &&
          error.message.toLowerCase().includes('temperature') &&
          'temperature' in params
        ) {
          delete params.temperature;
          this.supportsTemperature = false;
          continue;
        }
        throw error;
      }
    }
    const blocks = Array.isArray(response.content) ? response.content.filter(isRecord) : [];
    const usage = isRecord(response.usage) ? response.usage : {};
    return {
      text: blocks.flatMap((block) => (block.type === 'text' ? [text(block.text)] : [])).join(''),
      usage: { input_tokens: usageNumber(usage.input_tokens), output_tokens: usageNumber(usage.output_tokens) },
      toolCalls: blocks.flatMap((block) =>
        block.type === 'tool_use'
          ? [{ id: text(block.id), name: text(block.name), arguments: parseToolArguments(block.input) }]
          : [],
      ),
    };
  }
}

export class OpenAIProvider implements Provider {
  private supportsTemperature = true;
  private usesMaxCompletionTokens = true;

  constructor(
    readonly model: string,
    private readonly config: {
      baseUrl?: string | undefined;
      apiKey?: string | undefined;
      envKey?: string | undefined;
      reasoning?: ReasoningLevel | undefined;
      reasoningStyle?: 'openai' | 'deepseek' | undefined;
    } = {},
  ) {}

  private key(): string {
    const envKey = this.config.envKey ?? (this.config.baseUrl ? 'OPENAI_COMPAT_API_KEY' : 'OPENAI_API_KEY');
    const apiKey =
      this.config.apiKey ?? process.env[envKey] ?? (envKey === 'OPENAI_COMPAT_API_KEY' ? 'none' : undefined);
    if (!apiKey) throw new Error(`Missing ${envKey}`);
    return apiKey;
  }

  async complete(system: string, messages: ProviderMessage[], options: CompleteOptions = {}): Promise<Completion> {
    const converted: JsonObject[] = [{ role: 'system', content: system }];
    for (const message of messages) {
      if (message.role === 'tool')
        converted.push({ role: 'tool', tool_call_id: message.toolCallId ?? '', content: message.content ?? '' });
      else if (message.role === 'assistant' && message.toolCalls?.length)
        converted.push({
          role: 'assistant',
          content: message.content ?? null,
          tool_calls: message.toolCalls.map((call) => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.arguments) },
          })),
        });
      else
        converted.push({ role: message.role === 'assistant' ? 'assistant' : 'user', content: message.content ?? '' });
    }
    const params: JsonObject = { model: this.model, messages: converted };
    params[this.usesMaxCompletionTokens ? 'max_completion_tokens' : 'max_tokens'] = options.maxTokens ?? 1200;
    if (this.supportsTemperature) params.temperature = options.temperature ?? 0.6;
    if (options.tools?.length) {
      params.tools = options.tools.map((tool) => ({
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.parameters, strict: true },
      }));
      if (options.toolChoice) params.tool_choice = options.toolChoice;
    }
    if (this.config.reasoning) {
      if (this.config.reasoningStyle === 'deepseek' && this.config.reasoning === 'off')
        params.thinking = { type: 'disabled' };
      else params.reasoning_effort = this.config.reasoning === 'off' ? 'none' : this.config.reasoning;
    }
    const base = (this.config.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    let response: JsonObject;
    while (true) {
      try {
        response = await postJson(
          `${base}/chat/completions`,
          { authorization: `Bearer ${this.key()}` },
          params,
          options.timeout ?? DEFAULT_TIMEOUT,
        );
        break;
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 400) throw error;
        const message = error.message.toLowerCase();
        let changed = false;
        if (message.includes('temperature') && 'temperature' in params) {
          delete params.temperature;
          this.supportsTemperature = false;
          changed = true;
        }
        if (message.includes('max_completion_tokens') && 'max_completion_tokens' in params) {
          params.max_tokens = params.max_completion_tokens;
          delete params.max_completion_tokens;
          this.usesMaxCompletionTokens = false;
          changed = true;
        }
        if (!changed) throw error;
      }
    }
    const choices = Array.isArray(response.choices) ? response.choices.filter(isRecord) : [];
    const message = isRecord(choices[0]?.message) ? choices[0].message : {};
    const usage = isRecord(response.usage) ? response.usage : {};
    const toolCalls: ToolCall[] = (
      Array.isArray(message.tool_calls) ? message.tool_calls.filter(isRecord) : []
    ).flatMap((call) => {
      if (call.type !== 'function' || !isRecord(call.function)) return [];
      return [
        {
          id: text(call.id),
          name: text(call.function.name),
          arguments: parseToolArguments(call.function.arguments),
        },
      ];
    });
    return {
      text: text(message.content),
      usage: { input_tokens: usageNumber(usage.prompt_tokens), output_tokens: usageNumber(usage.completion_tokens) },
      toolCalls,
    };
  }
}

export class GoogleProvider implements Provider {
  constructor(
    readonly model: string,
    private readonly apiKey?: string,
    readonly reasoning?: ReasoningLevel,
  ) {}

  private key(): string {
    const key = this.apiKey ?? process.env.GEMINI_API_KEY;
    if (!key) throw new Error('Missing GEMINI_API_KEY');
    return key;
  }

  async complete(system: string, messages: ProviderMessage[], options: CompleteOptions = {}): Promise<Completion> {
    const contents: JsonObject[] = [];
    const callNames: Record<string, string> = {};
    for (let index = 0; index < messages.length; ) {
      const message = messages[index]!;
      if (message.role === 'tool') {
        const parts: JsonObject[] = [];
        while (messages[index]?.role === 'tool') {
          const tool = messages[index++]!;
          const name = callNames[tool.toolCallId ?? ''] ?? tool.name ?? '';
          parts.push({ functionResponse: { name, response: { result: tool.content ?? '' } } });
        }
        contents.push({ role: 'user', parts });
      } else if (message.role === 'assistant' && message.toolCalls?.length) {
        const parts: JsonObject[] = message.content ? [{ text: message.content }] : [];
        for (const call of message.toolCalls) {
          callNames[call.id] = call.name;
          parts.push({ functionCall: { name: call.name, args: call.arguments } });
        }
        contents.push({ role: 'model', parts });
        index += 1;
      } else {
        contents.push({ role: message.role === 'user' ? 'user' : 'model', parts: [{ text: message.content ?? '' }] });
        index += 1;
      }
    }
    const config: JsonObject = {
      temperature: options.temperature ?? 0.6,
      maxOutputTokens: options.maxTokens ?? 1200,
    };
    if (this.reasoning === 'off') config.thinkingConfig = { thinkingBudget: 0 };
    else if (this.reasoning && this.model.toLowerCase().includes('2.5')) {
      const budget = this.reasoning === 'high' ? 16_000 : googleThinkingBudgetMax(this.model.toLowerCase());
      config.maxOutputTokens = Math.max(options.maxTokens ?? 1200, budget + 1200);
      config.thinkingConfig = { thinkingBudget: budget };
    } else if (this.reasoning) config.thinkingConfig = { thinkingLevel: this.reasoning };
    const params: JsonObject = {
      systemInstruction: { parts: [{ text: system }] },
      contents,
      generationConfig: config,
    };
    if (options.tools?.length) {
      params.tools = [
        {
          functionDeclarations: options.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parametersJsonSchema: tool.parameters,
          })),
        },
      ];
      params.toolConfig = {
        functionCallingConfig: {
          mode: options.toolChoice === 'none' ? 'NONE' : options.toolChoice === 'required' ? 'ANY' : 'AUTO',
        },
      };
    }
    const response = await postJson(
      `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`,
      { 'x-goog-api-key': this.key() },
      params,
      options.timeout ?? DEFAULT_TIMEOUT,
    );
    const candidates = Array.isArray(response.candidates) ? response.candidates.filter(isRecord) : [];
    const content = isRecord(candidates[0]?.content) ? candidates[0].content : {};
    const parts = Array.isArray(content.parts) ? content.parts.filter(isRecord) : [];
    const usage = isRecord(response.usageMetadata) ? response.usageMetadata : {};
    return {
      text: parts.flatMap((part) => (typeof part.text === 'string' ? [part.text] : [])).join(''),
      usage: {
        input_tokens: usageNumber(usage.promptTokenCount),
        output_tokens: usageNumber(usage.candidatesTokenCount),
      },
      toolCalls: parts.flatMap((part, index) =>
        isRecord(part.functionCall)
          ? [
              {
                id: `call_${index}`,
                name: text(part.functionCall.name),
                arguments: parseToolArguments(part.functionCall.args),
              },
            ]
          : [],
      ),
    };
  }
}

function googleThinkingBudgetMax(model: string): number {
  return model.includes('2.5') && model.includes('pro') && !model.includes('flash') ? 32_768 : 24_576;
}

export function makeProvider(
  spec: ProviderSpec,
  options: { apiKey?: string | undefined; reasoning?: ReasoningLevel | undefined } = {},
): Provider {
  validateReasoning(spec, options.reasoning);
  if (spec.provider === 'anthropic') return new AnthropicProvider(spec.model, options.apiKey, options.reasoning);
  if (spec.provider === 'openai')
    return new OpenAIProvider(spec.model, { apiKey: options.apiKey, reasoning: options.reasoning });
  if (spec.provider === 'google') return new GoogleProvider(spec.model, options.apiKey, options.reasoning);
  if (spec.provider === 'random') throw new Error('random provider is handled separately');
  if (spec.provider === 'compat') {
    if (!spec.baseUrl) throw new Error('compat provider requires base_url');
    return new OpenAIProvider(spec.model, {
      baseUrl: spec.baseUrl,
      apiKey: options.apiKey,
      reasoning: options.reasoning,
    });
  }
  if (spec.baseUrl && COMPAT_BASE_URLS[spec.provider])
    return new OpenAIProvider(spec.model, {
      baseUrl: spec.baseUrl,
      apiKey: options.apiKey,
      envKey: COMPAT_ENV_KEYS[spec.provider],
      reasoning: options.reasoning,
      reasoningStyle: spec.provider === 'deepseek' ? 'deepseek' : 'openai',
    });
  throw new Error(USAGE);
}
