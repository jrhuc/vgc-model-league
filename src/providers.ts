import Anthropic from '@anthropic-ai/sdk';
import type { Content, GenerateContentConfig } from '@google/genai';
import { FunctionCallingConfigMode, GoogleGenAI } from '@google/genai';
import OpenAI from 'openai';
import type {
  CompleteOptions,
  Completion,
  JsonObject,
  Provider,
  ProviderMessage,
  ToolCall,
  ToolDefinition,
} from './types.js';

import { isRecord } from './value.js';

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

function anthropicTools(tools: ToolDefinition[] = []): Anthropic.Tool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters as Anthropic.Tool.InputSchema,
  }));
}

export class AnthropicProvider implements Provider {
  private client?: Anthropic;
  private supportsTemperature = true;

  constructor(
    readonly model: string,
    private readonly apiKey?: string,
    readonly reasoning?: ReasoningLevel,
  ) {}

  private getClient(): Anthropic {
    const key = this.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error('Missing ANTHROPIC_API_KEY');
    if (!this.client) this.client = new Anthropic({ apiKey: key, maxRetries: 0, timeout: 120_000 });
    return this.client;
  }

  async complete(system: string, messages: ProviderMessage[], options: CompleteOptions = {}): Promise<Completion> {
    const converted: Anthropic.MessageParam[] = [];
    for (const message of messages) {
      if (message.role === 'tool') {
        const block: Anthropic.ToolResultBlockParam = {
          type: 'tool_result',
          tool_use_id: message.toolCallId ?? '',
          content: message.content ?? '',
        };
        const previous = converted.at(-1);
        if (previous?.role === 'user' && Array.isArray(previous.content)) previous.content.push(block);
        else converted.push({ role: 'user', content: [block] });
      } else if (message.role === 'assistant' && message.toolCalls?.length) {
        const content: Anthropic.ContentBlockParam[] = [];
        if (message.content) content.push({ type: 'text', text: message.content });
        content.push(
          ...message.toolCalls.map((call) => ({
            type: 'tool_use' as const,
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
    const params: Record<string, unknown> = {
      model: this.model,
      system,
      max_tokens: options.maxTokens ?? 1200,
      messages: converted,
    };
    const tools = anthropicTools(options.tools);
    if (tools.length) {
      params.tools = tools;
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
    let response: Anthropic.Message;
    while (true) {
      try {
        response = await this.getClient().messages.create(
          params as unknown as Anthropic.MessageCreateParamsNonStreaming,
          options.timeout === undefined ? undefined : { timeout: Math.max(1, options.timeout * 1000) },
        );
        break;
      } catch (error) {
        if (
          error instanceof Anthropic.BadRequestError &&
          String(error).toLowerCase().includes('temperature') &&
          'temperature' in params
        ) {
          delete params.temperature;
          this.supportsTemperature = false;
          continue;
        }
        throw error;
      }
    }
    const toolCalls: ToolCall[] = response.content.flatMap((block) =>
      block.type === 'tool_use' ? [{ id: block.id, name: block.name, arguments: parseToolArguments(block.input) }] : [],
    );
    return {
      text: response.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join(''),
      usage: { input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens },
      toolCalls,
    };
  }
}

function openaiTools(tools: ToolDefinition[] = []): OpenAI.Chat.ChatCompletionTool[] {
  return tools.map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters, strict: true },
  }));
}

export class OpenAIProvider implements Provider {
  private client?: OpenAI;
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

  private getClient(): OpenAI {
    if (this.client) return this.client;
    const envKey = this.config.envKey ?? (this.config.baseUrl ? 'OPENAI_COMPAT_API_KEY' : 'OPENAI_API_KEY');
    const apiKey =
      this.config.apiKey ?? process.env[envKey] ?? (envKey === 'OPENAI_COMPAT_API_KEY' ? 'none' : undefined);
    if (!apiKey) throw new Error(`Missing ${envKey}`);
    this.client = new OpenAI({ apiKey, baseURL: this.config.baseUrl, maxRetries: 0, timeout: 120_000 });
    return this.client;
  }

  async complete(system: string, messages: ProviderMessage[], options: CompleteOptions = {}): Promise<Completion> {
    const converted: OpenAI.Chat.ChatCompletionMessageParam[] = [{ role: 'system', content: system }];
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
    const params: Record<string, unknown> = { model: this.model, messages: converted };
    params[this.usesMaxCompletionTokens ? 'max_completion_tokens' : 'max_tokens'] = options.maxTokens ?? 1200;
    if (this.supportsTemperature) params.temperature = options.temperature ?? 0.6;
    const tools = openaiTools(options.tools);
    if (tools.length) {
      params.tools = tools;
      if (options.toolChoice) params.tool_choice = options.toolChoice;
    }
    if (this.config.reasoning) {
      if (this.config.reasoningStyle === 'deepseek' && this.config.reasoning === 'off')
        params.extra_body = { thinking: { type: 'disabled' } };
      else params.reasoning_effort = this.config.reasoning === 'off' ? 'none' : this.config.reasoning;
    }
    let response: OpenAI.Chat.ChatCompletion;
    while (true) {
      try {
        response = await this.getClient().chat.completions.create(
          params as unknown as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
          options.timeout === undefined ? undefined : { timeout: Math.max(1, options.timeout * 1000) },
        );
        break;
      } catch (error) {
        if (!(error instanceof OpenAI.BadRequestError)) throw error;
        const message = String(error).toLowerCase();
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
    const message = response.choices[0]?.message;
    return {
      text: message?.content ?? '',
      usage: {
        input_tokens: response.usage?.prompt_tokens ?? 0,
        output_tokens: response.usage?.completion_tokens ?? 0,
      },
      toolCalls:
        message?.tool_calls?.flatMap((call) =>
          call.type === 'function'
            ? [{ id: call.id, name: call.function.name, arguments: parseToolArguments(call.function.arguments) }]
            : [],
        ) ?? [],
    };
  }
}

export class GoogleProvider implements Provider {
  private client?: GoogleGenAI;

  constructor(
    readonly model: string,
    private readonly apiKey?: string,
    readonly reasoning?: ReasoningLevel,
  ) {}

  private getClient(): GoogleGenAI {
    const key = this.apiKey ?? process.env.GEMINI_API_KEY;
    if (!key) throw new Error('Missing GEMINI_API_KEY');
    if (!this.client) this.client = new GoogleGenAI({ apiKey: key });
    return this.client;
  }

  async complete(system: string, messages: ProviderMessage[], options: CompleteOptions = {}): Promise<Completion> {
    const contents: Content[] = [];
    const callNames: Record<string, string> = {};
    for (let index = 0; index < messages.length; ) {
      const message = messages[index]!;
      if (message.role === 'tool') {
        const parts = [];
        while (messages[index]?.role === 'tool') {
          const tool = messages[index++]!;
          const name = callNames[tool.toolCallId ?? ''] ?? tool.name ?? '';
          parts.push({ functionResponse: { name, response: { result: tool.content ?? '' } } });
        }
        contents.push({ role: 'user', parts });
      } else if (message.role === 'assistant' && message.toolCalls?.length) {
        const parts: NonNullable<Content['parts']> = message.content ? [{ text: message.content }] : [];
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
    const config: Record<string, unknown> = {
      systemInstruction: system,
      temperature: options.temperature ?? 0.6,
      maxOutputTokens: options.maxTokens ?? 1200,
    };
    if (options.tools?.length) {
      config.tools = [
        {
          functionDeclarations: options.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parametersJsonSchema: tool.parameters,
          })),
        },
      ];
      config.toolConfig = {
        functionCallingConfig: {
          mode:
            options.toolChoice === 'none'
              ? FunctionCallingConfigMode.NONE
              : options.toolChoice === 'required'
                ? FunctionCallingConfigMode.ANY
                : FunctionCallingConfigMode.AUTO,
        },
      };
    }
    if (options.timeout !== undefined)
      config.httpOptions = { timeout: Math.max(1, options.timeout * 1000), retryOptions: { attempts: 1 } };
    if (this.reasoning === 'off') config.thinkingConfig = { thinkingBudget: 0 };
    else if (this.reasoning && this.model.toLowerCase().includes('2.5')) {
      const budget = this.reasoning === 'high' ? 16_000 : googleThinkingBudgetMax(this.model.toLowerCase());
      config.maxOutputTokens = Math.max(options.maxTokens ?? 1200, budget + 1200);
      config.thinkingConfig = { thinkingBudget: budget };
    } else if (this.reasoning) config.thinkingConfig = { thinkingLevel: this.reasoning };
    const response = await this.getClient().models.generateContent({
      model: this.model,
      contents,
      config: config as GenerateContentConfig,
    });
    return {
      text: response.text ?? '',
      usage: {
        input_tokens: response.usageMetadata?.promptTokenCount ?? 0,
        output_tokens: response.usageMetadata?.candidatesTokenCount ?? 0,
      },
      toolCalls: (response.functionCalls ?? []).map((call, index) => ({
        id: `call_${index}`,
        name: call.name ?? '',
        arguments: parseToolArguments(call.args),
      })),
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
