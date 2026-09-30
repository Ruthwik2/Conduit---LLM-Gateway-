import { describe, it, expect } from "vitest";
import { exactCacheKey, semanticBucket, promptText } from "../../src/cache/key.js";
import type { ChatCompletionRequest } from "../../src/types/openai.js";

function req(overrides: Partial<ChatCompletionRequest> = {}): ChatCompletionRequest {
  return {
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: "What is the capital of France?" }],
    ...overrides,
  } as ChatCompletionRequest;
}

describe("exactCacheKey", () => {
  it("is identical for the same answer-affecting request", () => {
    expect(exactCacheKey(req())).toBe(exactCacheKey(req()));
  });

  it("ignores transport-only fields (stream, user)", () => {
    const a = exactCacheKey(req());
    const b = exactCacheKey(req({ stream: true, user: "alice" } as Partial<ChatCompletionRequest>));
    expect(a).toBe(b);
  });

  it("changes when an answer-affecting param changes (temperature)", () => {
    const a = exactCacheKey(req());
    const b = exactCacheKey(req({ temperature: 0.9 }));
    expect(a).not.toBe(b);
  });

  it("is stable regardless of message whitespace padding", () => {
    const a = exactCacheKey(req());
    const b = exactCacheKey(
      req({ messages: [{ role: "user", content: "  What is the capital of France?  " }] }),
    );
    expect(a).toBe(b);
  });

  it("differs across models", () => {
    expect(exactCacheKey(req())).not.toBe(exactCacheKey(req({ model: "gpt-4o" })));
  });

  it("differs when messages differ", () => {
    const a = exactCacheKey(req());
    const b = exactCacheKey(req({ messages: [{ role: "user", content: "capital of Spain?" }] }));
    expect(a).not.toBe(b);
  });
});

describe("semanticBucket", () => {
  it("matches for same model + params, ignoring prompt text", () => {
    const a = semanticBucket(req({ messages: [{ role: "user", content: "alpha" }] }));
    const b = semanticBucket(req({ messages: [{ role: "user", content: "totally different" }] }));
    expect(a).toBe(b);
  });

  it("separates different models", () => {
    expect(semanticBucket(req())).not.toBe(semanticBucket(req({ model: "gpt-4o" })));
  });

  it("separates different temperatures (so t=0 answers never serve t=1.5)", () => {
    expect(semanticBucket(req({ temperature: 0 }))).not.toBe(
      semanticBucket(req({ temperature: 1.5 })),
    );
  });

  it("is a short fixed-width hash", () => {
    expect(semanticBucket(req())).toHaveLength(16);
  });
});

describe("promptText", () => {
  it("tags each message with its role", () => {
    const text = promptText(
      req({
        messages: [
          { role: "system", content: "be terse" },
          { role: "user", content: "hi" },
        ],
      }),
    );
    expect(text).toBe("system: be terse\nuser: hi");
  });
});

describe("cache scoping", () => {
  it("an empty scope is identical to the unscoped key (shared-cache default)", () => {
    expect(exactCacheKey(req(), "")).toBe(exactCacheKey(req()));
    expect(semanticBucket(req(), "")).toBe(semanticBucket(req()));
  });

  it("different scopes never collide, and scoped never collides with shared", () => {
    expect(exactCacheKey(req(), "vk_a")).not.toBe(exactCacheKey(req(), "vk_b"));
    expect(exactCacheKey(req(), "vk_a")).not.toBe(exactCacheKey(req()));
    expect(semanticBucket(req(), "vk_a")).not.toBe(semanticBucket(req(), "vk_b"));
    expect(semanticBucket(req(), "vk_a")).not.toBe(semanticBucket(req()));
  });

  it("the same scope still collides for identical requests (hits work within a tenant)", () => {
    expect(exactCacheKey(req(), "vk_a")).toBe(exactCacheKey(req(), "vk_a"));
  });
});
