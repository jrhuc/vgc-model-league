import type { DiscoveredModel, ProviderOption } from './provider-registry.js';
import { readCappedText, redactSecrets } from './sanitize.js';
import { asStrings, isRecord } from './value.js';

export async function discoverModels(
  provider: ProviderOption,
  apiKey: string | undefined,
  options: { fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<DiscoveredModel[]> {
  if (provider.discovery === 'manual') {
    throw new Error(`${provider.label} uses manual model IDs`);
  }
  if (provider.discovery === 'none') throw new Error(`${provider.label} does not have a model catalog`);
  if (!provider.baseUrl) throw new Error('unsupported model catalog provider');
  if (!apiKey) throw new Error(`Missing ${provider.envKey ?? 'API key'} for ${provider.label} model discovery`);

  const request = options.fetch ?? fetch;
  const signal = options.signal ?? AbortSignal.timeout(20_000);
  const response = await request(`${provider.baseUrl}/models`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
    signal,
  });
  const body = await responseBody(response, provider.label, apiKey);
  const models: DiscoveredModel[] = [];
  for (const entry of recordArray(body, 'data', provider.label)) {
    if (!isTextModel(entry)) continue;
    const model = modelFromRecord(entry);
    if (model) models.push(model);
  }
  return normalizeModels(models);
}

type UnknownRecord = Record<string, unknown>;

async function responseBody(response: Response, provider: string, apiKey: string): Promise<UnknownRecord> {
  const raw = await readCappedText(response, 1_000_000);
  if (raw === undefined) throw new Error(`${provider} model catalog response was too large`);
  if (!response.ok) {
    const status = response.statusText ? `${response.status} ${response.statusText}` : String(response.status);
    throw new Error(`${provider} model discovery failed (${status})${raw ? `: ${errorDetail(raw, apiKey)}` : ''}`);
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed)) return parsed;
  } catch {}
  throw new Error(`${provider} returned an invalid model catalog response`);
}

function errorDetail(raw: string, apiKey: string): string {
  let detail = raw;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed)) {
      if (isRecord(parsed.error)) detail = stringValue(parsed.error.message) ?? JSON.stringify(parsed.error);
      else detail = stringValue(parsed.error) ?? stringValue(parsed.message) ?? raw;
    }
  } catch {}
  return redactSecrets(detail, [apiKey]).slice(0, 500);
}

function recordArray(record: UnknownRecord, key: string, provider: string): UnknownRecord[] {
  const value = record[key];
  if (!Array.isArray(value)) throw new Error(`${provider} returned an invalid model catalog response`);
  return value.filter(isRecord);
}

function modelFromRecord(record: UnknownRecord): DiscoveredModel | undefined {
  const id = stringValue(record.id)?.trim();
  if (!id || /[\p{Cc}\p{Cf}]/u.test(id)) return undefined;
  const displayName = stringValue(record.name)
    ?.replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .trim();
  const supportsReasoning = asStrings(record.supported_parameters).includes('reasoning');
  return {
    id,
    ...(displayName && displayName !== id ? { displayName } : {}),
    ...(supportsReasoning ? { supportsReasoning: true } : {}),
  };
}

function normalizeModels(models: readonly DiscoveredModel[]): DiscoveredModel[] {
  const unique = new Map<string, DiscoveredModel>();
  for (const model of models) {
    const existing = unique.get(model.id);
    if (!existing) unique.set(model.id, model);
    else {
      unique.set(model.id, {
        id: model.id,
        ...(existing.displayName || model.displayName
          ? { displayName: existing.displayName ?? model.displayName }
          : {}),
        ...(existing.supportsReasoning || model.supportsReasoning ? { supportsReasoning: true } : {}),
      });
    }
  }
  return [...unique.values()].sort((left, right) => left.id.localeCompare(right.id));
}

/** OpenRouter entries carry an architecture block; plain OpenAI-style catalogs fall back to id filtering. */
function isTextModel(record: UnknownRecord): boolean {
  const architecture = record.architecture;
  if (!isRecord(architecture)) return isGenerativeModel(record);
  const outputs = asStrings(architecture.output_modalities).map((value) => value.toLowerCase());
  if (outputs.length > 0) return outputs.includes('text');
  const modality = stringValue(architecture.modality)?.toLowerCase();
  if (!modality) return isGenerativeModel(record);
  const separator = modality.lastIndexOf('->');
  return (separator >= 0 ? modality.slice(separator + 2) : modality).includes('text');
}

function isGenerativeModel(record: UnknownRecord): boolean {
  const id = stringValue(record.id)?.toLowerCase();
  return Boolean(
    id &&
      !/(?:embedding|moderation|whisper|dall-e|transcription|computer-use|(?:^|[-_/])(?:tts|image|audio|realtime|sora)(?:[-_/]|$))/.test(
        id,
      ),
  );
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}
