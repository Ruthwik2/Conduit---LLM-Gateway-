import { describe, it, expect } from "vitest";
import { HashingEmbedder } from "../../src/cache/embeddings.js";

function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

describe("HashingEmbedder", () => {
  const embedder = new HashingEmbedder(256);

  it("exposes dimensions and a stable id", () => {
    expect(embedder.dimensions).toBe(256);
    expect(embedder.id).toBe("hash-256");
  });

  it("produces unit-length vectors (so cosine == dot product)", async () => {
    const v = await embedder.embed("a moderately sized sentence with several words");
    expect(dot(v, v)).toBeCloseTo(1, 6);
  });

  it("maps identical text to cosine 1.0", async () => {
    const a = await embedder.embed("What is the capital of France?");
    const b = await embedder.embed("What is the capital of France?");
    expect(dot(a, b)).toBeCloseTo(1, 6);
  });

  it("treats punctuation-only differences as identical (re-asks)", async () => {
    const a = await embedder.embed("What is the capital of France?");
    const b = await embedder.embed("What is the capital of France???");
    expect(dot(a, b)).toBeCloseTo(1, 6);
  });

  it("scores prompts sharing most words as highly similar", async () => {
    const a = await embedder.embed("the cat sat on the mat");
    const b = await embedder.embed("the cat sat on the rug");
    const sim = dot(a, b);
    expect(sim).toBeGreaterThan(0.6);
    expect(sim).toBeLessThan(1);
  });

  it("scores unrelated prompts as low similarity", async () => {
    const a = await embedder.embed("quantum chromodynamics lecture notes");
    const b = await embedder.embed("banana bread recipe with walnuts");
    expect(Math.abs(dot(a, b))).toBeLessThan(0.3);
  });

  it("returns a zero vector for empty text without throwing", async () => {
    const v = await embedder.embed("");
    expect(v).toHaveLength(256);
    expect(dot(v, v)).toBe(0);
  });
});
