export type Pid = 'p1' | 'p2';
export type JsonObject = Record<string, unknown>;
export type ExperimentMode = 'rotation' | 'exhibition' | 'tournament' | 'draft';

export interface ContributorAttribution {
  provider: 'github';
  subject: string;
  login: string;
}

export interface PlayerOptions {
  name: string;
  team: string;
}

export interface BattleRequest extends JsonObject {
  wait?: boolean;
  teamPreview?: boolean;
  maxChosenTeamSize?: number;
  forceSwitch?: boolean[];
  active?: Array<JsonObject | null>;
  side?: {
    pokemon?: JsonObject[];
  };
  timer?: {
    turnSeconds?: number;
    seconds?: number;
  };
}

export type TimerScale = number | 'off';

export interface AgentContext {
  povLines: string[];
  error?: string;
}

export interface BattleAgent {
  act(request: BattleRequest, context: AgentContext): Promise<string> | string;
  observe(lines: string[]): Promise<void> | void;
  abandonDecision?(): void;
}

export interface BattleOutcome {
  winner: string | null;
  turns: number;
  log: string[];
  pov: Record<Pid, string[]>;
  errors: Record<Pid, number>;
  fallbacks: Record<Pid, number>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonObject;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: JsonObject;
  /** Provider metadata that must be replayed with the call (e.g. Gemini 3 thought signatures). */
  providerMetadata?: JsonObject;
}

export interface Completion {
  text: string;
  usage: Record<string, number>;
  toolCalls: ToolCall[];
  finishReason?: string;
  reasoning?: string;
  /** AI SDK response messages, replayed verbatim so provider metadata (e.g. Gemini thought signatures) survives. */
  responseMessages?: JsonObject[];
}

export interface ProviderMessage extends JsonObject {
  role: 'user' | 'assistant' | 'tool';
  content?: string | null;
  toolCallId?: string;
  name?: string;
  toolCalls?: ToolCall[];
  /** Raw AI SDK messages sent in place of this message when present. */
  raw?: JsonObject[];
}

export interface CompleteOptions {
  maxTokens?: number;
  temperature?: number;
  timeout?: number;
  tools?: ToolDefinition[];
  toolChoice?: 'auto' | 'none' | 'required';
  signal?: AbortSignal;
}

export interface Provider {
  complete(system: string, messages: ProviderMessage[], options?: CompleteOptions): Promise<Completion>;
}

export type ProviderFailureKind =
  | 'quota'
  | 'rate_limit'
  | 'timeout'
  | 'truncation'
  | 'upstream'
  | 'network'
  | 'request';

export interface ProviderFailure {
  kind: ProviderFailureKind;
  summary: string;
  terminal: boolean;
  retryable?: boolean;
  pausable?: boolean;
}
