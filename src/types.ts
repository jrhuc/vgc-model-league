export type Pid = 'p1' | 'p2';
export type JsonObject = Record<string, unknown>;
export type ExperimentMode = 'rotation' | 'exhibition' | 'tournament' | 'draft';

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
}

export interface Completion {
  text: string;
  usage: Record<string, number>;
  toolCalls: ToolCall[];
  /** Provider reasoning / thinking summary when exposed by the AI SDK. */
  reasoning?: string;
}

export interface ProviderMessage extends JsonObject {
  role: 'user' | 'assistant' | 'tool';
  content?: string | null;
  toolCallId?: string;
  name?: string;
  toolCalls?: ToolCall[];
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
