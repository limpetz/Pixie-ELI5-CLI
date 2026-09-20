import type { ChatMessage, ChatResponse, PixieConfig, TokenCallback, ToolSchema } from "./types.js";
import { ollamaChat } from "./ollama.js";
import { openaiChat } from "./openai.js";

/** Sends the conversation to the model, falling back to the secondary provider on failure. */
export async function chat(
  cfg: PixieConfig,
  messages: ChatMessage[],
  tools: ToolSchema[],
  onToken?: TokenCallback,
): Promise<ChatResponse> {
  try {
    return cfg.provider.kind === "ollama"
      ? await ollamaChat(cfg.provider, messages, tools, cfg.temperature, onToken)
      : await openaiChat(cfg.provider, messages, tools, cfg.temperature, onToken);
  } catch (err) {
    if (!cfg.fallback) throw err;
    process.stderr.write(
      `\n  ⚠  Primary model unreachable (${err instanceof Error ? err.message : String(err)}).\n  →  Switching to fallback: ${cfg.fallback.model}\n\n`,
    );
    return cfg.fallback.kind === "ollama"
      ? await ollamaChat(cfg.fallback, messages, tools, cfg.temperature, onToken)
      : await openaiChat(cfg.fallback, messages, tools, cfg.temperature, onToken);
  }
}
