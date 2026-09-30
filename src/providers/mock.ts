import type { ChatCompletionChunk, ChatCompletionRequest } from "../types/openai.js";
import type { FailureKind, ProviderResult } from "../types/internal.js";
import { chatCompletionId, unixSeconds } from "../util/id.js";
import { ProviderError } from "./errors.js";
import type { ChatProvider, ProviderCallContext } from "./provider.js";

export interface MockBehavior {
  /** Fail every call with this kind of error. `null` = behave normally. */
  failWith?: FailureKind | null;
  /** Fail only the first N calls, then recover (simulates a transient blip). */
  failFirst?: number;
  /** Artificial latency added to every call, milliseconds. */
  latencyMs?: number;
  /** Streaming only: pause between content chunks, milliseconds. Makes streams
   *  arrive paced like a real model instead of as an instantaneous burst. */
  chunkDelayMs?: number;
  /** Fixed reply text. Defaults to a deterministic echo of the last message. */
  reply?: string;
  /** Tokens to report; defaults to a rough length-based estimate. */
  usage?: { prompt: number; completion: number };
}

/**
 * A fully in-process provider with no network dependency. It can be told to
 * fail on demand, which is how the integration test proves that failover hides
 * a dead primary, and how the local `docker compose` demo runs without real API
 * keys.
 */
export class MockProvider implements ChatProvider {
  readonly vendor = "mock";
  private callCount = 0;

  constructor(
    readonly name: string,
    private behavior: MockBehavior = {},
  ) {}

  /** Mutate behavior at runtime (used by tests + the demo control endpoint). */
  setBehavior(patch: MockBehavior): void {
    this.behavior = { ...this.behavior, ...patch };
  }

  getBehavior(): Readonly<MockBehavior> {
    return this.behavior;
  }

  private shouldFail(): FailureKind | null {
    const n = ++this.callCount;
    if (this.behavior.failFirst && n <= this.behavior.failFirst) {
      return this.behavior.failWith ?? "server_error";
    }
    if (this.behavior.failFirst) return null; // recovered
    return this.behavior.failWith ?? null;
  }

  private throwFor(kind: FailureKind): never {
    const status =
      kind === "rate_limit" ? 429 : kind === "server_error" ? 503 : kind === "client_error" ? 400 : undefined;
    throw new ProviderError({
      message: `[mock:${this.name}] forced ${kind}`,
      kind,
      retriable: kind !== "client_error",
      countsAgainstHealth: kind !== "client_error",
      provider: this.name,
      status,
    });
  }

  private buildReply(req: ChatCompletionRequest): { text: string; prompt: number; completion: number } {
    const last = [...req.messages].reverse().find((m) => m.role === "user");
    const lastText = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");
    const text = this.behavior.reply ?? `Echo from ${this.name}: ${lastText}`;
    const prompt = this.behavior.usage?.prompt ?? estimateTokens(JSON.stringify(req.messages));
    const completion = this.behavior.usage?.completion ?? estimateTokens(text);
    return { text, prompt, completion };
  }

  /** Abort-aware sleep tied to the call's signal. */
  private async wait(ms: number, ctx: ProviderCallContext): Promise<void> {
    if (ms <= 0) return;
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(t);
        reject(new DOMException("Aborted", "AbortError"));
      };
      const t = setTimeout(() => {
        ctx.signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      if (ctx.signal.aborted) return onAbort();
      ctx.signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private async delay(ctx: ProviderCallContext): Promise<void> {
    return this.wait(this.behavior.latencyMs ?? 0, ctx);
  }

  async complete(req: ChatCompletionRequest, ctx: ProviderCallContext): Promise<ProviderResult> {
    const start = performance.now();
    const fail = this.shouldFail();
    await this.delay(ctx);
    if (fail) this.throwFor(fail);

    const { text, prompt, completion } = this.buildReply(req);
    return {
      response: {
        id: chatCompletionId(),
        object: "chat.completion",
        created: unixSeconds(),
        model: ctx.upstreamModel,
        choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
        usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
      },
      latencyMs: performance.now() - start,
    };
  }

  async *stream(req: ChatCompletionRequest, ctx: ProviderCallContext): AsyncIterable<ChatCompletionChunk> {
    const fail = this.shouldFail();
    await this.delay(ctx);
    if (fail) this.throwFor(fail);

    const { text, prompt, completion } = this.buildReply(req);
    const id = chatCompletionId();
    const created = unixSeconds();
    const base = { id, object: "chat.completion.chunk" as const, created, model: ctx.upstreamModel };

    yield { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] };
    const chunkDelay = this.behavior.chunkDelayMs ?? 0;
    for (const piece of text.match(/\S+\s*/g) ?? []) {
      if (ctx.signal.aborted) throw new DOMException("Aborted", "AbortError");
      yield { ...base, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] };
      if (chunkDelay > 0) await this.wait(chunkDelay, ctx);
    }
    yield { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
    yield {
      ...base,
      choices: [],
      usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
    };
  }
}

/** Crude token estimate (~4 chars/token) — only used by the mock. */
function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
