import { z } from "zod";

/**
 * OpenAI Chat Completions API surface.
 *
 * Conduit is a *drop-in* proxy, so the contract here mirrors OpenAI's
 * `/v1/chat/completions`. We validate the load-bearing fields (model, messages)
 * and `.passthrough()` everything else, so provider-specific or
 * newer-than-us parameters flow through untouched rather than being rejected.
 */

export const chatMessageSchema = z
  .object({
    role: z.enum(["system", "user", "assistant", "tool", "function", "developer"]),
    content: z.union([z.string(), z.array(z.any()), z.null()]).optional(),
    name: z.string().optional(),
    tool_calls: z.array(z.any()).optional(),
    tool_call_id: z.string().optional(),
  })
  .passthrough();

export const chatCompletionRequestSchema = z
  .object({
    model: z.string().min(1, "`model` is required"),
    messages: z.array(chatMessageSchema).min(1, "`messages` must not be empty"),
    temperature: z.number().min(0).max(2).optional(),
    top_p: z.number().min(0).max(1).optional(),
    n: z.number().int().positive().optional(),
    stream: z.boolean().optional(),
    stream_options: z
      .object({ include_usage: z.boolean().optional() })
      .passthrough()
      .optional(),
    stop: z.union([z.string(), z.array(z.string())]).optional(),
    max_tokens: z.number().int().positive().optional(),
    max_completion_tokens: z.number().int().positive().optional(),
    presence_penalty: z.number().min(-2).max(2).optional(),
    frequency_penalty: z.number().min(-2).max(2).optional(),
    seed: z.number().int().optional(),
    user: z.string().optional(),
    tools: z.array(z.any()).optional(),
    tool_choice: z.any().optional(),
    response_format: z.any().optional(),
  })
  .passthrough();

export type ChatCompletionRequest = z.infer<typeof chatCompletionRequestSchema>;
export type ChatMessage = z.infer<typeof chatMessageSchema>;

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatCompletionChoice {
  index: number;
  message: {
    role: "assistant";
    content: string | null;
    tool_calls?: unknown[];
    refusal?: string | null;
  };
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | "function_call" | null;
  logprobs?: null;
}

export interface ChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage: TokenUsage;
  system_fingerprint?: string;
}

export interface ChatCompletionChunkChoice {
  index: number;
  delta: {
    role?: "assistant";
    content?: string | null;
    tool_calls?: unknown[];
    refusal?: string | null;
  };
  finish_reason: ChatCompletionChoice["finish_reason"];
  logprobs?: null;
}

export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: ChatCompletionChunkChoice[];
  usage?: TokenUsage | null;
  system_fingerprint?: string;
}

/** The OpenAI error envelope, returned verbatim so clients' error handling works. */
export interface OpenAIErrorBody {
  error: {
    message: string;
    type: string;
    param: string | null;
    code: string | null;
  };
}

/** `/v1/models` list item. */
export interface ModelObject {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
}
