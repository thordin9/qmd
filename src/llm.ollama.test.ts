import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  OllamaLLM,
  getDefaultLLM,
  getDefaultLLMProvider,
  disposeDefaultLLM,
  resetDefaultLLMForTests,
} from "./llm.js";

function jsonResponse(body: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const originalFetch = globalThis.fetch;

describe("Ollama provider", () => {
  beforeEach(() => {
    delete process.env.QMD_LLM_PROVIDER;
    delete process.env.QMD_OLLAMA_API_KEY;
    delete process.env.OLLAMA_API_KEY;
    delete process.env.QMD_OLLAMA_API_KEY_FILE;
    delete process.env.QMD_OLLAMA_BASE_URL;
    delete process.env.QMD_OLLAMA_EMBED_MODEL;
    delete process.env.QMD_OLLAMA_GENERATE_MODEL;
    delete process.env.QMD_OLLAMA_RERANK_MODEL;
    resetDefaultLLMForTests();
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await disposeDefaultLLM();
    resetDefaultLLMForTests();
  });

  test("uses Ollama provider when QMD_LLM_PROVIDER=ollama", () => {
    process.env.QMD_LLM_PROVIDER = "ollama";

    const llm = getDefaultLLM();

    expect(getDefaultLLMProvider()).toBe("ollama");
    expect(llm).toBeInstanceOf(OllamaLLM);
  });

  test("prints remote notice only once per process", () => {
    // Reset state to ensure we haven't printed the notice yet
    resetDefaultLLMForTests();
    
    process.env.QMD_LLM_PROVIDER = "ollama";

    const stderrAny = process.stderr as any;
    const originalWrite = stderrAny.write;
    const writes: string[] = [];
    stderrAny.write = (chunk: any) => {
      writes.push(String(chunk));
      // Swallow the write to avoid emitting to real stderr during tests
      return true;
    };

    try {
      // First call should print notice
      getDefaultLLM();
      // Second call should not print notice (same provider, no reset)
      getDefaultLLM();
    } finally {
      stderrAny.write = originalWrite;
    }

    const notices = writes.filter(line => line.includes("Ollama"));
    expect(notices.length).toBe(1);
  });

  test("embed sends Ollama embeddings request", async () => {
    const calls: Array<{ url: string; body: any; headers: Record<string, string> }> = [];
    globalThis.fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const parsedBody = JSON.parse(String(init?.body || "{}"));
      calls.push({
        url: String(url),
        body: parsedBody,
        headers: init?.headers as Record<string, string>,
      });
      return jsonResponse({
        embeddings: [[0.5, 0.25, -0.1]],
        model: "nomic-embed-text",
      });
    };

    const llm = new OllamaLLM({
      baseUrl: "http://localhost:11434",
      embedModel: "nomic-embed-text",
    });

    const result = await llm.embed("hello world");

    expect(result).not.toBeNull();
    expect(result!.embedding).toEqual([0.5, 0.25, -0.1]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://localhost:11434/api/embed");
    expect(calls[0]!.body.model).toBe("nomic-embed-text");
    expect(calls[0]!.body.input).toEqual(["hello world"]);
  });

  test("embed includes auth header when API key provided", async () => {
    const calls: Array<{ url: string; body: any; headers: Record<string, string> }> = [];
    globalThis.fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const parsedBody = JSON.parse(String(init?.body || "{}"));
      calls.push({
        url: String(url),
        body: parsedBody,
        headers: init?.headers as Record<string, string>,
      });
      return jsonResponse({
        embeddings: [[0.5, 0.25, -0.1]],
      });
    };

    const llm = new OllamaLLM({
      apiKey: "test-api-key",
      baseUrl: "http://localhost:11434",
    });

    await llm.embed("test");

    expect(calls[0]!.headers.Authorization).toBe("Bearer test-api-key");
  });

  test("embed does not include auth header when no API key", async () => {
    const calls: Array<{ url: string; body: any; headers: Record<string, string> }> = [];
    globalThis.fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const parsedBody = JSON.parse(String(init?.body || "{}"));
      calls.push({
        url: String(url),
        body: parsedBody,
        headers: init?.headers as Record<string, string>,
      });
      return jsonResponse({
        embeddings: [[0.5, 0.25, -0.1]],
      });
    };

    const llm = new OllamaLLM({
      baseUrl: "http://localhost:11434",
    });

    await llm.embed("test");

    expect(calls[0]!.headers.Authorization).toBeUndefined();
  });

  test("embedBatch sends batch request with multiple inputs", async () => {
    const calls: Array<{ url: string; body: any }> = [];
    globalThis.fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const parsedBody = JSON.parse(String(init?.body || "{}"));
      calls.push({ url: String(url), body: parsedBody });
      return jsonResponse({
        embeddings: [
          [0.5, 0.25, -0.1],
          [0.3, 0.15, -0.05],
        ],
      });
    };

    const llm = new OllamaLLM();
    const results = await llm.embedBatch(["text1", "text2"]);

    expect(results).toHaveLength(2);
    expect(results[0]?.embedding).toEqual([0.5, 0.25, -0.1]);
    expect(results[1]?.embedding).toEqual([0.3, 0.15, -0.05]);
    expect(calls[0]!.body.input).toEqual(["text1", "text2"]);
  });

  test("generate sends Ollama generate request", async () => {
    const calls: Array<{ url: string; body: any }> = [];
    globalThis.fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const parsedBody = JSON.parse(String(init?.body || "{}"));
      calls.push({ url: String(url), body: parsedBody });
      return jsonResponse({
        model: "llama3.2",
        response: "Hello! How can I help?",
        done: true,
      });
    };

    const llm = new OllamaLLM();
    const result = await llm.generate("Say hello");

    expect(result).not.toBeNull();
    expect(result!.text).toBe("Hello! How can I help?");
    expect(result!.done).toBe(true);
    expect(calls[0]!.url).toBe("http://localhost:11434/api/generate");
    expect(calls[0]!.body.prompt).toBe("Say hello");
    expect(calls[0]!.body.stream).toBe(false);
  });

  test("expandQuery uses generate endpoint", async () => {
    globalThis.fetch = async (): Promise<Response> => {
      return jsonResponse({
        response: "lex: authentication methods\nvec: login systems\nhyde: Information about authentication",
        done: true,
      });
    };

    const llm = new OllamaLLM();
    const queries = await llm.expandQuery("authentication");

    expect(queries.length).toBeGreaterThanOrEqual(2);
    // Check that we got some queries back (the exact types depend on parsing)
    expect(queries.some(q => q.text.includes("authentication"))).toBe(true);
  });

  test("rerank computes cosine similarity scores", async () => {
    globalThis.fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const parsedBody = JSON.parse(String(init?.body || "{}"));
      // Return embeddings for query and documents
      const input = parsedBody.input;
      if (Array.isArray(input)) {
        // Batch request - return embeddings for all inputs
        const embeddings = input.map((_, i) => {
          // Query gets [1, 0, 0], docs get different vectors
          if (i === 0) return [1, 0, 0]; // query
          if (i === 1) return [0.9, 0.1, 0]; // doc1 - high similarity
          if (i === 2) return [0, 1, 0]; // doc2 - low similarity
          return [0, 0, 1];
        });
        return jsonResponse({ embeddings });
      }
      return jsonResponse({ embeddings: [[1, 0, 0]] });
    };

    const llm = new OllamaLLM();
    const result = await llm.rerank("query", [
      { file: "doc1.md", text: "similar" },
      { file: "doc2.md", text: "different" },
    ]);

    expect(result.results).toHaveLength(2);
    // Results should be sorted by score descending
    expect(result.results[0]!.file).toBe("doc1.md");
    expect(result.results[0]!.score).toBeGreaterThan(result.results[1]!.score);
  });

  test("handles network errors gracefully", async () => {
    globalThis.fetch = async (): Promise<Response> => {
      throw new Error("Network error");
    };

    const llm = new OllamaLLM();
    const result = await llm.embed("test");

    expect(result).toBeNull();
  });

  test("handles API errors gracefully", async () => {
    globalThis.fetch = async (): Promise<Response> => {
      return new Response("Server error", { status: 500 });
    };

    const llm = new OllamaLLM();
    const result = await llm.embed("test");

    expect(result).toBeNull();
  });

  test("respects custom base URL", async () => {
    const calls: string[] = [];
    globalThis.fetch = async (url: string | URL | Request): Promise<Response> => {
      calls.push(String(url));
      return jsonResponse({ embeddings: [[0.5]] });
    };

    const llm = new OllamaLLM({
      baseUrl: "https://custom-ollama.example.com",
    });

    await llm.embed("test");

    expect(calls[0]).toBe("https://custom-ollama.example.com/api/embed");
  });

  test("respects custom models", async () => {
    const calls: Array<{ body: any }> = [];
    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const parsedBody = JSON.parse(String(init?.body || "{}"));
      calls.push({ body: parsedBody });
      return jsonResponse({ embeddings: [[0.5]] });
    };

    const llm = new OllamaLLM({
      embedModel: "custom-embed-model",
    });

    await llm.embed("test");

    expect(calls[0]!.body.model).toBe("custom-embed-model");
  });

  test("reads API key from environment variable", () => {
    process.env.QMD_OLLAMA_API_KEY = "env-key";

    const llm = new OllamaLLM();
    
    // We can't directly access private apiKey, but we can test by making a request
    globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer env-key");
      return jsonResponse({ embeddings: [[0.5]] });
    };

    llm.embed("test");
  });

  test("uses default base URL when not specified", async () => {
    const llm = new OllamaLLM();
    
    globalThis.fetch = async (url: string | URL | Request): Promise<Response> => {
      expect(String(url)).toContain("http://localhost:11434");
      return jsonResponse({ embeddings: [[0.5]] });
    };

    await llm.embed("test");
  });

  test("throws error when explicitly configured API key file is empty", async () => {
    const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const tempDir = await mkdtemp(join(tmpdir(), "qmd-test-"));
    const emptyKeyFile = join(tempDir, "empty.key");
    await writeFile(emptyKeyFile, "", "utf-8");

    try {
      // Explicitly setting QMD_OLLAMA_API_KEY_FILE should error on empty file
      process.env.QMD_OLLAMA_API_KEY_FILE = emptyKeyFile;
      expect(() => new OllamaLLM()).toThrow(/is empty/);
    } finally {
      delete process.env.QMD_OLLAMA_API_KEY_FILE;
      await rm(tempDir, { recursive: true });
    }
  });
});
