import { readCappedText } from './sanitize.js';

export interface ProviderOption {
  id: string;
  label: string;
  description: string;
  envKey?: string;
  baseUrl?: string;
  discovery: 'list' | 'manual' | 'none';
  requiresKey: boolean;
  models?: readonly DiscoveredModel[];
}

export interface DiscoveredModel {
  id: string;
  displayName?: string;
  description?: string;
}

export const PROVIDER_OPTIONS: readonly ProviderOption[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    description: 'Claude models from Anthropic',
    envKey: 'ANTHROPIC_API_KEY',
    baseUrl: 'https://api.anthropic.com/v1',
    discovery: 'list',
    requiresKey: true,
  },
  {
    id: 'openai',
    label: 'OpenAI',
    description: 'GPT and reasoning models from OpenAI',
    envKey: 'OPENAI_API_KEY',
    baseUrl: 'https://api.openai.com/v1',
    discovery: 'list',
    requiresKey: true,
  },
  {
    id: 'google',
    label: 'Google',
    description: 'Gemini models from Google AI',
    envKey: 'GEMINI_API_KEY',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    discovery: 'list',
    requiresKey: true,
  },
  {
    id: 'xai',
    label: 'xAI',
    description: 'Grok models from xAI',
    envKey: 'XAI_API_KEY',
    baseUrl: 'https://api.x.ai/v1',
    discovery: 'list',
    requiresKey: true,
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    description: 'Chat and reasoning models from DeepSeek',
    envKey: 'DEEPSEEK_API_KEY',
    baseUrl: 'https://api.deepseek.com',
    discovery: 'list',
    requiresKey: true,
  },
  {
    id: 'kimi',
    label: 'Kimi',
    description: 'Kimi and Moonshot models',
    envKey: 'MOONSHOT_API_KEY',
    baseUrl: 'https://api.moonshot.ai/v1',
    discovery: 'list',
    requiresKey: true,
  },
  {
    id: 'cerebras',
    label: 'Cerebras',
    description: 'Fast inference models from Cerebras',
    envKey: 'CEREBRAS_API_KEY',
    baseUrl: 'https://api.cerebras.ai/v1',
    discovery: 'list',
    requiresKey: true,
  },
  {
    id: 'meta',
    label: 'Meta',
    description: 'Muse Spark models from Meta',
    envKey: 'META_MODEL_API_KEY',
    baseUrl: 'https://api.meta.ai/v1',
    discovery: 'manual',
    requiresKey: true,
    models: [{ id: 'muse-spark-1.1', displayName: 'Muse Spark 1.1' }],
  },
  {
    id: 'zai',
    label: 'Z.ai',
    description: 'Enter a Z.ai model ID',
    envKey: 'ZAI_API_KEY',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    discovery: 'manual',
    requiresKey: true,
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    description: 'Text-generation models available through OpenRouter',
    envKey: 'OPENROUTER_API_KEY',
    baseUrl: 'https://openrouter.ai/api/v1',
    discovery: 'list',
    requiresKey: true,
  },
  {
    id: 'opencode-go',
    label: 'OpenCode Go',
    description: 'Models available through OpenCode Go',
    envKey: 'OPENCODE_API_KEY',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    discovery: 'list',
    requiresKey: true,
  },
  {
    id: 'opencode-zen',
    label: 'OpenCode Zen',
    description: 'Models available through OpenCode Zen',
    envKey: 'OPENCODE_API_KEY',
    baseUrl: 'https://opencode.ai/zen/v1',
    discovery: 'list',
    requiresKey: true,
  },
  {
    id: 'vercel',
    label: 'Vercel AI Gateway',
    description: 'Models available through Vercel AI Gateway',
    envKey: 'AI_GATEWAY_API_KEY',
    baseUrl: 'https://ai-gateway.vercel.sh/v1',
    discovery: 'list',
    requiresKey: true,
  },
  {
    id: 'compat',
    label: 'OpenAI-compatible',
    description: 'Enter an endpoint and model ID',
    envKey: 'OPENAI_COMPAT_API_KEY',
    discovery: 'manual',
    requiresKey: false,
  },
  {
    id: 'random',
    label: 'Random baseline',
    description: 'Choose legal moves at random',
    discovery: 'none',
    requiresKey: false,
  },
];

export function providerOption(id: string): ProviderOption | undefined {
  return PROVIDER_OPTIONS.find((provider) => provider.id === id);
}

export async function discoverModels(
  provider: ProviderOption,
  apiKey: string | undefined,
  options: { fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<DiscoveredModel[]> {
  if (provider.models?.length) return normalizeModels(provider.models.map((model) => ({ ...model })));
  if (provider.discovery === 'manual') {
    throw new Error(`${provider.label} does not provide reliable model discovery; enter a model ID manually`);
  }
  if (provider.discovery === 'none') throw new Error(`${provider.label} does not have a model catalog`);
  if (!apiKey && provider.id !== 'openrouter') {
    throw new Error(`Missing ${provider.envKey ?? 'API key'} for ${provider.label} model discovery`);
  }

  const request = options.fetch ?? fetch;
  const signal = options.signal ?? AbortSignal.timeout(20_000);
  if (provider.id === 'openrouter' && apiKey) await validateOpenRouterKey(request, provider, apiKey, signal);
  let models: DiscoveredModel[];
  if (provider.id === 'anthropic') models = await discoverAnthropic(request, apiKey ?? '', signal);
  else if (provider.id === 'google') models = await discoverGoogle(request, apiKey ?? '', signal);
  else models = await discoverOpenAICompatible(request, provider, apiKey, signal);
  return normalizeModels(models);
}

type UnknownRecord = Record<string, unknown>;

async function discoverAnthropic(
  request: typeof fetch,
  apiKey: string,
  signal: AbortSignal | undefined,
): Promise<DiscoveredModel[]> {
  const models: DiscoveredModel[] = [];
  let afterId: string | undefined;
  const seenPages = new Set<string>();

  while (true) {
    const url = new URL('https://api.anthropic.com/v1/models');
    if (afterId) url.searchParams.set('after_id', afterId);
    const response = await request(
      url,
      requestInit(
        {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        signal,
      ),
    );
    const body = await responseBody(response, 'Anthropic', apiKey);
    const data = recordArray(body, 'data', 'Anthropic');
    for (const entry of data) {
      const discovered = modelFromRecord(entry, ['display_name']);
      if (discovered) models.push(discovered);
    }

    if (body.has_more !== true) break;
    const lastId = stringValue(body.last_id);
    if (!lastId || seenPages.has(lastId)) throw new Error('Anthropic returned invalid model pagination data');
    seenPages.add(lastId);
    afterId = lastId;
  }

  return models;
}

async function discoverGoogle(
  request: typeof fetch,
  apiKey: string,
  signal: AbortSignal | undefined,
): Promise<DiscoveredModel[]> {
  const models: DiscoveredModel[] = [];
  let pageToken: string | undefined;
  const seenPages = new Set<string>();

  while (true) {
    const url = new URL('https://generativelanguage.googleapis.com/v1beta/models');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const response = await request(url, requestInit({ 'x-goog-api-key': apiKey }, signal));
    const body = await responseBody(response, 'Google', apiKey);
    const entries = recordArray(body, 'models', 'Google');
    for (const entry of entries) {
      const methods = stringArray(entry.supportedGenerationMethods);
      if (!methods.includes('generateContent')) continue;
      const rawId = stringValue(entry.name);
      if (!rawId) continue;
      const id = rawId.startsWith('models/') ? rawId.slice('models/'.length) : rawId;
      const model = makeModel(id, stringValue(entry.displayName), stringValue(entry.description));
      if (model) models.push(model);
    }

    const nextToken = stringValue(body.nextPageToken);
    if (!nextToken) break;
    if (seenPages.has(nextToken)) throw new Error('Google returned invalid model pagination data');
    seenPages.add(nextToken);
    pageToken = nextToken;
  }

  return models;
}

async function validateOpenRouterKey(
  request: typeof fetch,
  provider: ProviderOption,
  apiKey: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (!provider.baseUrl) throw new Error('OpenRouter does not define an API endpoint');
  const response = await request(
    `${provider.baseUrl.replace(/\/$/, '')}/key`,
    requestInit({ Authorization: `Bearer ${apiKey}` }, signal),
  );
  const raw = await readCappedText(response, 100_000);
  if (raw === undefined) throw new Error('OpenRouter API key validation response was too large');
  if (response.ok) return;
  const detail = errorDetail(raw, apiKey);
  const status = response.statusText ? `${response.status} ${response.statusText}` : String(response.status);
  throw new Error(`OpenRouter API key validation failed (${status})${detail ? `: ${detail}` : ''}`);
}

async function discoverOpenAICompatible(
  request: typeof fetch,
  provider: ProviderOption,
  apiKey: string | undefined,
  signal: AbortSignal | undefined,
): Promise<DiscoveredModel[]> {
  if (!provider.baseUrl) throw new Error(`${provider.label} does not define a model catalog endpoint`);
  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const response = await request(`${provider.baseUrl.replace(/\/$/, '')}/models`, requestInit(headers, signal));
  const body = await responseBody(response, provider.label, apiKey);
  const entries = recordArray(body, 'data', provider.label);
  const models: DiscoveredModel[] = [];
  for (const entry of entries) {
    const supported =
      provider.id === 'openai'
        ? isOpenAIChatModel(entry)
        : provider.id === 'openrouter'
          ? isOpenRouterTextModel(entry)
          : isGenerativeModel(entry);
    if (!supported) continue;
    const discovered = modelFromRecord(entry, ['name', 'display_name']);
    if (discovered) models.push(discovered);
  }
  return models;
}

function requestInit(headers: Record<string, string>, signal: AbortSignal | undefined): RequestInit {
  const init: RequestInit = { method: 'GET', headers };
  if (signal) init.signal = signal;
  return init;
}

async function responseBody(response: Response, provider: string, apiKey: string | undefined): Promise<UnknownRecord> {
  const raw = await readCappedText(response, 1_000_000);
  if (raw === undefined) throw new Error(`${provider} model catalog response was too large`);
  if (!response.ok) {
    const detail = errorDetail(raw, apiKey);
    const status = response.statusText ? `${response.status} ${response.statusText}` : String(response.status);
    throw new Error(`${provider} model discovery failed (${status})${detail ? `: ${detail}` : ''}`);
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed)) return parsed;
  } catch {}
  throw new Error(`${provider} returned an invalid model catalog response`);
}

function errorDetail(raw: string, apiKey: string | undefined): string {
  let detail = raw;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed)) {
      if (isRecord(parsed.error)) detail = stringValue(parsed.error.message) ?? JSON.stringify(parsed.error);
      else detail = stringValue(parsed.error) ?? stringValue(parsed.message) ?? raw;
    }
  } catch {}
  detail = detail
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (apiKey) detail = detail.split(apiKey).join('[redacted]');
  return detail.slice(0, 500);
}

function recordArray(record: UnknownRecord, key: string, provider: string): UnknownRecord[] {
  const value = record[key];
  if (!Array.isArray(value)) throw new Error(`${provider} returned an invalid model catalog response`);
  return value.filter(isRecord);
}

function modelFromRecord(record: UnknownRecord, displayNameKeys: readonly string[]): DiscoveredModel | undefined {
  const id = stringValue(record.id);
  if (!id) return undefined;
  let displayName: string | undefined;
  for (const key of displayNameKeys) {
    displayName = stringValue(record[key]);
    if (displayName) break;
  }
  return makeModel(id, displayName, modelDescription(record));
}

function modelDescription(record: UnknownRecord): string | undefined {
  const metadata: string[] = [];
  const owner = stringValue(record.owned_by);
  if (owner) metadata.push(`Owner: ${owner}`);
  const contextLength = record.context_length;
  if (typeof contextLength === 'number' && Number.isFinite(contextLength) && contextLength > 0) {
    metadata.push(`${Math.floor(contextLength).toLocaleString('en-US')} token context`);
  }
  return metadata.length > 0 ? metadata.join(' · ') : stringValue(record.description);
}

function makeModel(
  rawId: string,
  rawDisplayName: string | undefined,
  rawDescription: string | undefined,
): DiscoveredModel | undefined {
  const id = rawId.trim();
  if (!id || /[\p{Cc}\p{Cf}]/u.test(id)) return undefined;
  const model: DiscoveredModel = { id };
  const displayName = rawDisplayName?.replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim();
  const description = rawDescription
    ?.replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .trim()
    .slice(0, 300);
  if (displayName && displayName !== id) model.displayName = displayName;
  if (description) model.description = description;
  return model;
}

function normalizeModels(models: readonly DiscoveredModel[]): DiscoveredModel[] {
  const unique = new Map<string, DiscoveredModel>();
  for (const model of models) {
    const existing = unique.get(model.id);
    if (!existing) unique.set(model.id, model);
    else {
      if (!existing.displayName && model.displayName) existing.displayName = model.displayName;
      if (!existing.description && model.description) existing.description = model.description;
    }
  }
  return [...unique.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function isOpenAIChatModel(record: UnknownRecord): boolean {
  const id = stringValue(record.id)?.toLowerCase();
  if (!id || !/^(?:ft:)?(?:gpt-|chatgpt-|o[134](?:-|$))/.test(id) || !isGenerativeModel(record)) return false;
  return !/(?:instruct|deep-research|(?:^|[-.])pro(?:[-.]|$))/.test(id);
}

function isGenerativeModel(record: UnknownRecord): boolean {
  const id = stringValue(record.id)?.toLowerCase();
  if (!id) return false;
  return !/(?:embedding|moderation|whisper|dall-e|transcription|computer-use|(?:^|[-_/])(?:tts|image|audio|realtime|sora)(?:[-_/]|$))/.test(
    id,
  );
}

function isOpenRouterTextModel(record: UnknownRecord): boolean {
  const architecture = record.architecture;
  if (!isRecord(architecture)) return isGenerativeModel(record);
  const outputs = stringArray(architecture.output_modalities).map((value) => value.toLowerCase());
  if (outputs.length > 0) return outputs.includes('text');
  const modality = stringValue(architecture.modality)?.toLowerCase();
  if (!modality) return isGenerativeModel(record);
  const separator = modality.lastIndexOf('->');
  const output = separator >= 0 ? modality.slice(separator + 2) : modality;
  return output.includes('text');
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
