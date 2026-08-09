type ProviderId = 'openrouter' | 'prime' | 'random';

export interface ProviderOption {
  readonly id: ProviderId;
  readonly label: string;
  readonly description: string;
  readonly envKey?: 'OPENROUTER_API_KEY' | 'PRIME_API_KEY';
  readonly baseUrl?: 'https://openrouter.ai/api/v1' | 'https://api.pinference.ai/api/v1';
  readonly discovery: 'list' | 'manual' | 'none';
  readonly requiresKey: boolean;
}

export interface DiscoveredModel {
  readonly id: string;
  readonly displayName?: string;
  readonly supportsReasoning?: boolean;
}

export const PROVIDER_OPTIONS: readonly ProviderOption[] = [
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
    id: 'prime',
    label: 'Prime Inference',
    description: 'Enter a Prime Inference model ID',
    envKey: 'PRIME_API_KEY',
    baseUrl: 'https://api.pinference.ai/api/v1',
    discovery: 'manual',
    requiresKey: true,
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
