import { appendFileSync } from 'node:fs';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createXai } from '@ai-sdk/xai';
import {
  APICallError,
  generateText,
  type JSONSchema7,
  jsonSchema,
  type LanguageModel,
  type ModelMessage,
  type ToolCallPart,
  type ToolSet,
  tool,
} from 'ai';

import { CliProvider } from './cli-provider.js';
import { PROVIDER_OPTIONS, providerOption } from './provider-registry.js';
import { redactSecrets } from './sanitize.js';
import type { CompleteOptions, Completion, JsonObject, Provider, ProviderFailure, ProviderMessage } from './types.js';

import { isRecord } from './value.js';

/** Gemini signs only the first of parallel function calls; the SDK's documented sentinel handles the rest,
 * so its per-part warning is noise. All other AI SDK warnings still log. */
(globalThis as { AI_SDK_LOG_WARNINGS?: unknown }).AI_SDK_LOG_WARNINGS = (options: {
  warnings: Array<{ message?: string }>;
  provider: string;
  model: string;
}) => {
  for (const warning of options.warnings) {
    const message = warning.message ?? JSON.stringify(warning);
    if (message.includes('skip_thought_signature_validator')) continue;
    console.warn(`AI SDK Warning (${options.provider} / ${options.model}): ${message}`);
  }
};

export const REASONING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ReasoningLevel = (typeof REASONING_LEVELS)[number];

export interface ModelReasoningConfig {
  reasoning?: ReasoningLevel;
  reasoningByModel?: Readonly<Record<string, ReasoningLevel>>;
}

export function reasoningForModel(model: string, config: ModelReasoningConfig): ReasoningLevel | undefined {
  return config.reasoningByModel?.[model] ?? config.reasoning;
}

export function validateModelExecution(
  models: readonly string[],
  config: ModelReasoningConfig & { apiKeys?: Readonly<Record<string, string>> },
): void {
  for (const model of models) validateReasoning(parseSpec(model), reasoningForModel(model, config));
  if (!config.apiKeys) return;
  for (const model of models) {
    if (model !== 'random' && config.apiKeys[model] === undefined)
      throw new Error(`API key missing for ${model}; this run cannot use environment keys`);
  }
}

const USAGE =
  'Usage: anthropic:<model>, openai:<model>, google:<model>, xai:<model>, deepseek:<model>, meta:<model>, kimi:<model>, zai:<model>, openrouter:<model>, opencode-go:<model>, opencode-zen:<model>, vercel:<model>, cerebras:<model>, compat:<base_url>:<model>, omp:<cli-model>, claude-cli:<model>, or random';
export interface ProviderSpec {
  provider: string;
  model: string;
  baseUrl?: string;
}

export function parseSpec(value: string): ProviderSpec {
  if (value === 'random') return { provider: 'random', model: 'random' };
  if (value.startsWith('omp:') && value.length > 4) return { provider: 'omp', model: value.slice(4) };
  if (value.startsWith('claude-cli:') && value.length > 11) return { provider: 'claude-cli', model: value.slice(11) };
  for (const option of PROVIDER_OPTIONS) {
    const provider = option.id;
    if (provider === 'random' || provider === 'compat') continue;
    if (!value.startsWith(`${provider}:`) || value.length <= provider.length + 1) continue;
    const spec: ProviderSpec = { provider, model: value.slice(provider.length + 1) };
    if (provider !== 'anthropic' && provider !== 'openai' && provider !== 'google') {
      if (!option.baseUrl) throw new Error(USAGE);
      spec.baseUrl = option.baseUrl;
    }
    return spec;
  }
  if (value.startsWith('compat:')) {
    const rest = value.slice(7);
    const schemeEnd = rest.indexOf('://') + 3;
    const pathStart = rest.indexOf('/', schemeEnd);
    const separator = pathStart >= 0 ? rest.indexOf(':', pathStart) : rest.lastIndexOf(':');
    const baseUrl = rest.slice(0, separator);
    const model = rest.slice(separator + 1);
    if (separator > 0 && baseUrl.includes('://') && model) return { provider: 'compat', model, baseUrl };
  }
  throw new Error(USAGE);
}

export function reasoningLevels(spec: ProviderSpec): ReasoningLevel[] {
  const model = spec.model.toLowerCase();
  if (spec.provider === 'omp') return [...REASONING_LEVELS];
  if (spec.provider === 'claude-cli') return [];
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
  if (version !== undefined && version >= 6) return ['off', 'low', 'medium', 'high', 'xhigh', 'max'];
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
    ...(completion.responseMessages?.length ? { raw: completion.responseMessages } : {}),
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

const HARD_QUOTA_ERROR =
  /(?:insufficient[_ -]?quota|exceeded your current quota|free[_ -]?tier[_ -]?requests|requests?[_ -]?per[_ -]?day|generateRequestsPerDay|credit balance|billing quota)/i;

export function classifyProviderFailure(error: unknown, spec = 'provider'): ProviderFailure {
  const message = error instanceof Error ? error.message : String(error);
  const status = error instanceof ApiError ? error.status : Number(/\b([45]\d\d)\b/.exec(message)?.[1] ?? 0);
  const provider = spec.split(':', 1)[0] || 'provider';
  const label =
    (
      {
        anthropic: 'Anthropic',
        cerebras: 'Cerebras',
        deepseek: 'DeepSeek',
        google: 'Google',
        kimi: 'Kimi',
        meta: 'Meta',
        openai: 'OpenAI',
        openrouter: 'OpenRouter',
        'opencode-go': 'OpenCode Go',
        xai: 'xAI',
        zai: 'Z.ai',
      } as Record<string, string>
    )[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1);
  const suffix = status ? ` (${status})` : '';
  if (
    /Connect error (?:unauthenticated|unavailable|resource[_ -]?exhausted|internal|aborted|deadline[_ -]?exceeded)/i.test(
      message,
    )
  ) {
    return {
      kind: 'upstream',
      summary: `${label} transport failed transiently.`,
      terminal: false,
      pausable: true,
    };
  }
  if (/Upstream request failed|Inference is temporarily unavailable/i.test(message)) {
    return {
      kind: 'upstream',
      summary: `${label} API is temporarily unavailable${suffix}.`,
      terminal: false,
      pausable: true,
    };
  }
  if (status === 429 && /per[_ -]?minute/i.test(message)) {
    return {
      kind: 'rate_limit',
      summary: `${label} API rate limit was reached (429).`,
      terminal: false,
      pausable: true,
    };
  }
  if (HARD_QUOTA_ERROR.test(message)) {
    const quotaId = /"quotaId"\s*:\s*"([^"]+)"/.exec(message)?.[1];
    return {
      kind: 'quota',
      summary: `${label} API quota is exhausted${quotaId ? ` (${status || 429}; ${quotaId})` : suffix}.`,
      terminal: true,
      pausable: true,
    };
  }
  if ((status === 0 || status === 408) && /(?:timed? ?out|timeout|time exhausted)/i.test(message)) {
    return { kind: 'timeout', summary: `${label} API request timed out.`, terminal: false, pausable: true };
  }
  if (status === 0 && /^reasoning exhausted the \d+-token response budget$/i.test(message.trim())) {
    return {
      kind: 'truncation',
      summary: `${label} API spent the whole response budget on reasoning and returned no answer.`,
      terminal: false,
    };
  }
  if (status === 0 && /^empty response$/i.test(message.trim())) {
    return {
      kind: 'upstream',
      summary: `${label} API returned no usable response.`,
      terminal: true,
      retryable: true,
      pausable: true,
    };
  }
  if (status === 0 && error instanceof ApiError) {
    return { kind: 'network', summary: `${label} API could not be reached.`, terminal: false, pausable: true };
  }
  if (status === 200) {
    return {
      kind: 'upstream',
      summary: `${label} API returned an unusable 200 response.`,
      terminal: false,
      pausable: true,
    };
  }
  if (status === 409 || status === 425) {
    return {
      kind: 'upstream',
      summary: `${label} API request was temporarily blocked (${status}).`,
      terminal: false,
      pausable: true,
    };
  }
  if (status === 429) {
    return {
      kind: 'rate_limit',
      summary: `${label} API rate limit was reached (429).`,
      terminal: false,
      pausable: true,
    };
  }
  if (error instanceof TypeError) {
    return { kind: 'network', summary: `${label} API could not be reached.`, terminal: false, pausable: true };
  }
  if (status >= 500 && status !== 501 && status !== 505) {
    return {
      kind: 'upstream',
      summary: `${label} API is temporarily unavailable (${status}).`,
      terminal: false,
      pausable: true,
    };
  }
  if (status === 401 || status === 403) {
    return { kind: 'request', summary: `${label} API rejected the credentials${suffix}.`, terminal: true };
  }
  if (status === 404) {
    return { kind: 'request', summary: `${label} model or endpoint was not found (404).`, terminal: true };
  }
  return { kind: 'request', summary: `${label} API request failed${suffix}.`, terminal: true };
}

function openRouterErrorStatus(responseBody: string | undefined): number | undefined {
  if (!responseBody) return undefined;
  try {
    const body: unknown = JSON.parse(responseBody);
    if (!isRecord(body) || !isRecord(body.error)) return undefined;
    const code = typeof body.error.code === 'string' ? Number(body.error.code) : body.error.code;
    return Number.isInteger(code) && Number(code) >= 400 && Number(code) <= 599 ? Number(code) : undefined;
  } catch {
    return undefined;
  }
}

const DEFAULT_TIMEOUT = 120;

interface GatewayResponseMeta {
  cost?: number | undefined;
  provider?: string | undefined;
}

function parseRoutingPreferences(): JsonObject | undefined {
  const raw = process.env.VGC_OPENROUTER_PROVIDER;
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('VGC_OPENROUTER_PROVIDER must be JSON, e.g. {"order":["deepinfra"],"ignore":["novita"]}');
  }
  if (!isRecord(parsed)) throw new Error('VGC_OPENROUTER_PROVIDER must be a JSON object of routing preferences');
  return parsed;
}

function openRouterFetch(
  base: typeof fetch | undefined,
  routing: JsonObject | undefined,
  meta: GatewayResponseMeta,
): typeof fetch {
  const inner = base ?? fetch;
  return async (input, init) => {
    let request = init;
    if (typeof request?.body === 'string') {
      try {
        const body = JSON.parse(request.body) as JsonObject;
        body.usage = { include: true };
        if (routing) body.provider = routing;
        if (typeof body.model === 'string' && body.model.startsWith('anthropic/')) markCacheBreakpoints(body);
        request = { ...request, body: JSON.stringify(body) };
      } catch {}
    }
    const response = await inner(input, request);
    if (response.ok && (response.headers.get('content-type') ?? '').includes('json')) {
      try {
        const payload = (await response.clone().json()) as JsonObject;
        if (typeof payload.provider === 'string' && payload.provider) meta.provider = payload.provider;
        if (isRecord(payload.usage) && typeof payload.usage.cost === 'number') meta.cost = payload.usage.cost;
      } catch {}
    }
    return response;
  };
}

/**
 * Anthropic bills every resent prefix token at full price unless an explicit
 * cache_control breakpoint marks it cacheable; OpenRouter only forwards
 * breakpoints written as content-part fields on its chat-completions shape.
 */
function markCacheBreakpoints(body: JsonObject): void {
  if (!Array.isArray(body.messages)) return;
  const mark = (message: JsonObject): boolean => {
    if (typeof message.content === 'string' && message.content) {
      message.content = [{ type: 'text', text: message.content, cache_control: { type: 'ephemeral' } }];
      return true;
    }
    if (Array.isArray(message.content)) {
      for (let index = message.content.length - 1; index >= 0; index -= 1) {
        const part = message.content[index];
        if (isRecord(part) && part.type === 'text' && typeof part.text === 'string' && part.text) {
          part.cache_control = { type: 'ephemeral' };
          return true;
        }
      }
    }
    return false;
  };
  const messages = body.messages.filter(isRecord);
  const system = messages.find((message) => message.role === 'system');
  if (system) mark(system);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && message !== system && message.role !== 'tool' && mark(message)) break;
  }
}

const ANTHROPIC_CACHE_OPTIONS = { anthropic: { cacheControl: { type: 'ephemeral' } } };

function withCacheBreakpoint(messages: ModelMessage[]): ModelMessage[] {
  const marked = [...messages];
  const last = marked[marked.length - 1];
  if (last) marked[marked.length - 1] = { ...last, providerOptions: ANTHROPIC_CACHE_OPTIONS } as ModelMessage;
  return marked;
}

function googleThinkingBudgetMax(model: string): number {
  return model.includes('2.5') && model.includes('pro') && !model.includes('flash') ? 32_768 : 24_576;
}

function convertMessages(messages: ProviderMessage[]): ModelMessage[] {
  const converted: ModelMessage[] = [];
  const callNames = new Map<string, string>();
  for (const message of messages) {
    if (message.role === 'tool') {
      converted.push({
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: message.toolCallId ?? '',
            toolName: callNames.get(message.toolCallId ?? '') ?? message.name ?? '',
            output: { type: 'text', value: message.content ?? '' },
          },
        ],
      });
    } else if (message.role === 'assistant' && message.toolCalls?.length) {
      for (const call of message.toolCalls) callNames.set(call.id, call.name);
      if (message.raw?.length) {
        converted.push(...(message.raw as unknown as ModelMessage[]));
        continue;
      }
      converted.push({
        role: 'assistant',
        content: [
          ...(message.content ? [{ type: 'text' as const, text: message.content }] : []),
          ...message.toolCalls.map((call) => ({
            type: 'tool-call' as const,
            toolCallId: call.id,
            toolName: call.name,
            input: call.arguments,
            ...(call.providerMetadata
              ? { providerOptions: call.providerMetadata as NonNullable<ToolCallPart['providerOptions']> }
              : {}),
          })),
        ],
      });
    } else {
      converted.push({ role: message.role, content: message.content ?? '' });
    }
  }
  return converted;
}

function providerOptions(spec: ProviderSpec, reasoning?: ReasoningLevel) {
  if (reasoning === undefined) return undefined;
  if (spec.provider === 'anthropic') {
    if (reasoning === 'off') return { anthropic: { thinking: { type: 'disabled' } } };
    return { anthropic: { thinking: { type: 'adaptive' }, effort: reasoning } };
  }
  if (spec.provider === 'openai')
    return {
      openai: {
        reasoningEffort: reasoning === 'off' ? 'none' : reasoning,
        ...(reasoning === 'off' ? {} : { reasoningSummary: 'detailed' }),
      },
    };
  if (spec.provider === 'xai') return { xai: { reasoningEffort: reasoning === 'off' ? 'none' : reasoning } };
  if (spec.provider === 'deepseek') {
    if (reasoning === 'off') return { deepseek: { thinking: { type: 'disabled' } } };
    if (reasoning === 'high' || reasoning === 'max') return { deepseek: { reasoningEffort: reasoning } };
    return undefined;
  }
  if (spec.provider === 'google') {
    if (reasoning === 'off') return { google: { thinkingConfig: { thinkingBudget: 0, includeThoughts: false } } };
    if (spec.model.toLowerCase().includes('2.5')) {
      const budget = reasoning === 'high' ? 16_000 : googleThinkingBudgetMax(spec.model.toLowerCase());
      return { google: { thinkingConfig: { thinkingBudget: budget, includeThoughts: true } } };
    }
    return {
      google: {
        thinkingConfig: { thinkingLevel: reasoning, includeThoughts: true },
        thinkingSummaries: 'auto',
      },
    };
  }
  return { [spec.provider]: { reasoningEffort: reasoning === 'off' ? 'none' : reasoning } };
}

export class SdkProvider implements Provider {
  readonly model: string;
  readonly reasoning?: ReasoningLevel | undefined;
  private readonly apiKey: string | undefined;
  private readonly fetch: typeof fetch | undefined;
  private readonly gatewayMeta: GatewayResponseMeta | undefined;
  private supportsTemperature = true;
  private supportsToolChoice = true;

  constructor(
    private readonly spec: ProviderSpec,
    options: { apiKey?: string | undefined; reasoning?: ReasoningLevel | undefined; fetch?: typeof fetch | undefined },
  ) {
    this.model = spec.model;
    this.reasoning = options.reasoning;
    this.apiKey = options.apiKey;
    if (spec.provider === 'openrouter') {
      this.gatewayMeta = {};
      this.fetch = openRouterFetch(options.fetch, parseRoutingPreferences(), this.gatewayMeta);
    } else {
      this.fetch = options.fetch;
    }
  }

  private key(): string {
    const envKey = providerOption(this.spec.provider)?.envKey;
    if (!envKey) throw new Error(USAGE);
    const apiKey = this.apiKey ?? process.env[envKey] ?? (envKey === 'OPENAI_COMPAT_API_KEY' ? 'none' : undefined);
    if (!apiKey) throw new Error(`Missing ${envKey}`);
    return apiKey;
  }

  private languageModel(apiKey: string): LanguageModel {
    const settings = { apiKey, ...(this.fetch ? { fetch: this.fetch } : {}) };
    if (this.spec.provider === 'anthropic') return createAnthropic(settings)(this.model);
    if (this.spec.provider === 'openai') return createOpenAI(settings)(this.model);
    if (this.spec.provider === 'google') return createGoogleGenerativeAI(settings)(this.model);
    if (this.spec.provider === 'xai') return createXai(settings)(this.model);
    if (this.spec.provider === 'deepseek') return createDeepSeek(settings)(this.model);
    if (!this.spec.baseUrl)
      throw new Error(this.spec.provider === 'compat' ? 'compat provider requires base_url' : USAGE);
    return createOpenAICompatible({
      name: this.spec.provider,
      baseURL: this.spec.baseUrl,
      ...settings,
    })(this.model);
  }

  async complete(system: string, messages: ProviderMessage[], options: CompleteOptions = {}): Promise<Completion> {
    const seconds = options.timeout ?? DEFAULT_TIMEOUT;
    const timeout = AbortSignal.timeout(Math.max(100, Math.round(seconds * 1000)));
    const abortSignal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
    const apiKey = this.key();
    const model = this.languageModel(apiKey);
    const tools: ToolSet | undefined = options.tools?.length
      ? (Object.fromEntries(
          options.tools.map((definition) => [
            definition.name,
            tool({
              description: definition.description,
              inputSchema: jsonSchema(definition.parameters as JSONSchema7),
            }),
          ]),
        ) as ToolSet)
      : undefined;
    let maxOutputTokens = options.maxTokens ?? 1200;
    if (
      this.spec.provider === 'google' &&
      this.reasoning &&
      this.reasoning !== 'off' &&
      this.model.toLowerCase().includes('2.5')
    ) {
      const budget = this.reasoning === 'high' ? 16_000 : googleThinkingBudgetMax(this.model.toLowerCase());
      maxOutputTokens = Math.max(maxOutputTokens, budget + 1200);
    }
    let sendTemperature =
      this.supportsTemperature &&
      (this.spec.provider === 'google' || this.reasoning === undefined || this.reasoning === 'off') &&
      !(this.spec.provider === 'openai' && /^(?:gpt-5|o\d)/i.test(this.model));
    const mappedProviderOptions = providerOptions(this.spec, this.reasoning);
    if (this.gatewayMeta) {
      this.gatewayMeta.cost = undefined;
      this.gatewayMeta.provider = undefined;
    }
    while (true) {
      const sendToolChoice = Boolean(options.toolChoice) && this.supportsToolChoice;
      const suppressTools = options.toolChoice === 'none' && !this.supportsToolChoice;
      try {
        const result = await generateText({
          model,
          system:
            this.spec.provider === 'anthropic'
              ? { role: 'system', content: system, providerOptions: ANTHROPIC_CACHE_OPTIONS }
              : system,
          messages:
            this.spec.provider === 'anthropic'
              ? withCacheBreakpoint(convertMessages(messages))
              : convertMessages(messages),
          ...(tools && !suppressTools ? { tools } : {}),
          ...(tools && !suppressTools && sendToolChoice ? { toolChoice: options.toolChoice } : {}),
          maxOutputTokens,
          ...(sendTemperature ? { temperature: options.temperature ?? 0.2 } : {}),
          ...(mappedProviderOptions ? { providerOptions: mappedProviderOptions } : {}),
          maxRetries: 0,
          abortSignal,
        });
        if (result.warnings?.some((warning) => warning.type === 'unsupported' && warning.feature === 'temperature'))
          this.supportsTemperature = false;
        const reasoningText = result.reasoningText?.trim() ?? '';
        const reasoningTokens = result.usage.outputTokenDetails?.reasoningTokens ?? 0;
        return {
          text: result.text,
          finishReason: result.finishReason,
          usage: {
            input_tokens: result.usage.inputTokens ?? 0,
            output_tokens: result.usage.outputTokens ?? 0,
            ...(reasoningTokens > 0 ? { reasoning_tokens: reasoningTokens } : {}),
            ...((result.usage.inputTokenDetails?.cacheReadTokens ?? 0) > 0
              ? { cached_input_tokens: result.usage.inputTokenDetails.cacheReadTokens as number }
              : {}),
            ...(this.gatewayMeta?.cost !== undefined ? { cost: this.gatewayMeta.cost } : {}),
          },
          ...(this.gatewayMeta?.provider ? { provider: this.gatewayMeta.provider } : {}),
          toolCalls: result.toolCalls.map((call) => ({
            id: call.toolCallId,
            name: call.toolName,
            arguments: parseToolArguments(call.input),
            ...(call.providerMetadata ? { providerMetadata: call.providerMetadata as JsonObject } : {}),
          })),
          ...(reasoningText ? { reasoning: reasoningText } : {}),
          ...(result.response.messages.length
            ? { responseMessages: result.response.messages as unknown as JsonObject[] }
            : {}),
        };
      } catch (error) {
        if (options.signal?.aborted) throw error;
        if (timeout.aborted)
          throw new ApiError(0, `request to ${this.spec.provider}:${this.model} timed out after ${seconds}s`);
        if (APICallError.isInstance(error)) {
          const errorText = `${error.message} ${error.responseBody ?? ''}`;
          if (
            error.statusCode === 400 &&
            sendTemperature &&
            (/temperature/i.test(errorText) || /Upstream request failed/i.test(errorText))
          ) {
            this.supportsTemperature = false;
            sendTemperature = false;
            continue;
          }
          if (
            this.supportsToolChoice &&
            /tool_choice/i.test(errorText) &&
            (error.statusCode === 400 || openRouterErrorStatus(error.responseBody) === 400)
          ) {
            this.supportsToolChoice = false;
            continue;
          }
          const detail = redactSecrets(error.responseBody ?? error.message, [apiKey]);
          const inBandStatus =
            this.spec.provider === 'openrouter' ? openRouterErrorStatus(error.responseBody) : undefined;
          const status = inBandStatus ?? error.statusCode ?? 0;
          const debugTarget = process.env.VGC_DEBUG_PROVIDER_ERRORS;
          if (debugTarget) {
            const body = error.requestBodyValues === undefined ? undefined : JSON.stringify(error.requestBodyValues);
            const line = `[provider-debug] ${this.spec.provider}:${this.model} ${status} request=${(body ?? '(unavailable)').replaceAll(apiKey, '[redacted]')}`;
            if (debugTarget === '1') console.error(line);
            else appendFileSync(debugTarget, `${line}\n`);
          }
          throw new ApiError(status, `${this.spec.provider}:${this.model} ${status}: ${detail}`);
        }
        throw error;
      }
    }
  }
}

export function makeProvider(
  spec: ProviderSpec,
  options: {
    apiKey?: string | undefined;
    reasoning?: ReasoningLevel | undefined;
    fetch?: typeof fetch | undefined;
  } = {},
): Provider {
  validateReasoning(spec, options.reasoning);
  if (spec.provider === 'random') throw new Error('random provider is handled separately');
  if (spec.provider === 'omp' || spec.provider === 'claude-cli')
    return new CliProvider(spec.provider, spec.model, options.reasoning);
  if (spec.provider === 'compat' && !spec.baseUrl) throw new Error('compat provider requires base_url');
  if (!providerOption(spec.provider)) throw new Error(USAGE);
  return new SdkProvider(spec, options);
}
