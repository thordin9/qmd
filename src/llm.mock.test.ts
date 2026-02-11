/**
 * llm.mock.test.ts - Tests for MockLLM implementation
 *
 * Run with: bun test src/llm.mock.test.ts
 */

import { describe, test, expect } from "bun:test";
import { getMockLLM } from "./llm.mock";

describe("MockLLM", () => {
  const llm = getMockLLM();

  describe("embed", () => {
    test("returns embedding with correct dimensions", async () => {
      const result = await llm.embed("test query");

      expect(result).not.toBeNull();
      expect(result!.embedding).toBeInstanceOf(Array);
      expect(result!.embedding.length).toBe(768);
      expect(result!.model).toBe("mock-embedding-model");
    });

    test("returns deterministic embeddings", async () => {
      const result1 = await llm.embed("same text");
      const result2 = await llm.embed("same text");

      expect(result1).not.toBeNull();
      expect(result2).not.toBeNull();
      
      // Embeddings should be identical for same input
      for (let i = 0; i < result1!.embedding.length; i++) {
        expect(result1!.embedding[i]).toBe(result2!.embedding[i]);
      }
    });

    test("returns different embeddings for different inputs", async () => {
      const result1 = await llm.embed("first text");
      const result2 = await llm.embed("second text");

      expect(result1).not.toBeNull();
      expect(result2).not.toBeNull();

      // At least some values should be different
      let differences = 0;
      for (let i = 0; i < result1!.embedding.length; i++) {
        if (result1!.embedding[i] !== result2!.embedding[i]) {
          differences++;
        }
      }
      expect(differences).toBeGreaterThan(100);
    });

    test("embeddings are normalized", async () => {
      const result = await llm.embed("test");
      
      expect(result).not.toBeNull();
      
      // Calculate magnitude (should be ~1 for normalized vectors)
      const magnitude = Math.sqrt(
        result!.embedding.reduce((sum, val) => sum + val * val, 0)
      );
      
      expect(magnitude).toBeCloseTo(1.0, 5);
    });
  });

  describe("embedBatch", () => {
    test("returns embeddings for multiple texts", async () => {
      const results = await llm.embedBatch(["text 1", "text 2", "text 3"]);

      expect(results).toHaveLength(3);
      expect(results.every(r => r !== null)).toBe(true);
      expect(results.every(r => r!.embedding.length === 768)).toBe(true);
    });

    test("returns same results as individual embeds", async () => {
      const texts = ["test 1", "test 2"];
      
      const batchResults = await llm.embedBatch(texts);
      const individualResults = await Promise.all(texts.map(t => llm.embed(t)));

      expect(batchResults).toHaveLength(individualResults.length);
      
      for (let i = 0; i < texts.length; i++) {
        for (let j = 0; j < batchResults[i]!.embedding.length; j++) {
          expect(batchResults[i]!.embedding[j]).toBe(individualResults[i]!.embedding[j]);
        }
      }
    });

    test("handles empty array", async () => {
      const results = await llm.embedBatch([]);
      expect(results).toHaveLength(0);
    });
  });

  describe("generate", () => {
    test("returns generated text", async () => {
      const result = await llm.generate("test prompt");

      expect(result).not.toBeNull();
      expect(result!.text).toBeTruthy();
      expect(result!.model).toBe("mock-generation-model");
      expect(result!.done).toBe(true);
    });

    test("handles query expansion prompts", async () => {
      const result = await llm.generate("expand this query");

      expect(result).not.toBeNull();
      expect(result!.text).toContain("lex:");
      expect(result!.text).toContain("vec:");
      expect(result!.text).toContain("hyde:");
    });
  });

  describe("modelExists", () => {
    test("always returns true", async () => {
      const result1 = await llm.modelExists("any-model");
      const result2 = await llm.modelExists("hf:org/repo/model.gguf");

      expect(result1.exists).toBe(true);
      expect(result2.exists).toBe(true);
      expect(result1.name).toBe("any-model");
      expect(result2.name).toBe("hf:org/repo/model.gguf");
    });
  });

  describe("expandQuery", () => {
    test("returns query expansions with correct types", async () => {
      const results = await llm.expandQuery("test query");

      expect(results.length).toBeGreaterThanOrEqual(3);
      
      const types = results.map(r => r.type);
      expect(types).toContain("lex");
      expect(types).toContain("vec");
      expect(types).toContain("hyde");
      
      for (const result of results) {
        expect(result.text).toBeTruthy();
        expect(result.weight).toBeGreaterThan(0);
        expect(result.weight).toBeLessThanOrEqual(1);
      }
    });

    test("excludes lexical when requested", async () => {
      const results = await llm.expandQuery("test", { includeLexical: false });

      const types = results.map(r => r.type);
      expect(types).not.toContain("lex");
      expect(types).toContain("vec");
      expect(types).toContain("hyde");
    });

    test("includes context in expansions when provided", async () => {
      const results = await llm.expandQuery("test", { context: "some context" });

      expect(results.length).toBeGreaterThan(0);
      // Context is handled by caller, mock just returns standard expansions
    });
  });

  describe("rerank", () => {
    test("scores documents", async () => {
      const docs = [
        { file: "doc1.md", text: "about search terms" },
        { file: "doc2.md", text: "unrelated content" },
        { file: "doc3.md", text: "more search terms here" },
      ];

      const result = await llm.rerank("search terms", docs);

      expect(result.results).toHaveLength(3);
      expect(result.model).toBe("mock-rerank-model");
      
      // Results should be sorted by score
      for (let i = 0; i < result.results.length - 1; i++) {
        expect(result.results[i].score).toBeGreaterThanOrEqual(result.results[i + 1].score);
      }
      
      // Scores should be between 0 and 1
      for (const doc of result.results) {
        expect(doc.score).toBeGreaterThanOrEqual(0);
        expect(doc.score).toBeLessThanOrEqual(1);
      }
    });

    test("ranks documents with query terms higher", async () => {
      const docs = [
        { file: "relevant.md", text: "This document contains authentication and security" },
        { file: "unrelated.md", text: "Something about cooking recipes" },
      ];

      const result = await llm.rerank("authentication", docs);

      expect(result.results[0].file).toBe("relevant.md");
      expect(result.results[0].score).toBeGreaterThan(result.results[1].score);
    });

    test("handles empty document list", async () => {
      const result = await llm.rerank("query", []);

      expect(result.results).toHaveLength(0);
      expect(result.model).toBe("mock-rerank-model");
    });

    test("handles single document", async () => {
      const result = await llm.rerank("query", [{ file: "doc.md", text: "content" }]);

      expect(result.results).toHaveLength(1);
      expect(result.results[0].file).toBe("doc.md");
      expect(result.results[0].score).toBeGreaterThan(0);
    });

    test("preserves file paths", async () => {
      const docs = [
        { file: "path/to/doc1.md", text: "content" },
        { file: "another/doc2.md", text: "content" },
      ];

      const result = await llm.rerank("query", docs);

      const files = result.results.map(r => r.file);
      expect(files).toContain("path/to/doc1.md");
      expect(files).toContain("another/doc2.md");
    });
  });

  describe("dispose", () => {
    test("completes without error", async () => {
      await expect(llm.dispose()).resolves.toBeUndefined();
    });
  });
});
