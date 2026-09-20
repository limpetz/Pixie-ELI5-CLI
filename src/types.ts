export type ProviderKind = "ollama" | "openai";

export interface ProviderConfig {
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  apiKey?: string;
}

export interface PixieConfig {
  provider: ProviderConfig;
  fallback: ProviderConfig | null;
  /** The only folder Pixie is allowed to touch. */
  workspace: string;
  /** Beginner mode: plain-English explanations and extra confirmations. */
  beginnerMode: boolean;
  temperature: number;
  /** Max tool rounds per user request (safety stop). */
  maxToolRounds: number;
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCallRequest {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  ok: boolean;
  output: string;
}

/** Receives streamed text chunks as the model generates them. */
export type TokenCallback = (text: string) => void;

export interface ToolCallResponse {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** What a chat backend returns for one model call. */
export interface ChatResponse {
  content: string;
  toolCalls: ToolCallResponse[];
}

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** For assistant messages: requested tool calls. */
  toolCalls?: ToolCallRequest[];
  /** For role === "tool": which call this answers. */
  toolCallId?: string;
  name?: string;
}
