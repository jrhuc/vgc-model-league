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
