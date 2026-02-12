/**
 * llm.mock.ts - Mock LLM implementation for testing
 *
 * Provides deterministic responses for CI testing without requiring
 * actual model downloads or API calls.
 */

import type {
  LLM,
  EmbeddingResult,
  GenerateResult,
  RerankResult,
  RerankDocument,
  Queryable,
  EmbedOptions,
  GenerateOptions,
  RerankOptions,
  ModelInfo,
} from "./llm.js";

/**
 * Mock LLM implementation for testing
 * Provides deterministic responses without requiring real models or API calls
 */
export class MockLLM implements LLM {
  private readonly mockEmbeddingDimension = 768; // Match embeddinggemma dimension

  /**
   * Generate a deterministic embedding based on text content
   */
  async embed(text: string, options?: EmbedOptions): Promise<EmbeddingResult | null> {
    // Create deterministic embedding based on text hash
    const hash = this.simpleHash(text);
    const embedding = this.generateDeterministicEmbedding(hash);

    return {
      embedding,
      model: "mock-embedding-model",
    };
  }

  /**
   * Batch embed multiple texts
   */
  async embedBatch(texts: string[]): Promise<(EmbeddingResult | null)[]> {
    return Promise.all(texts.map(text => this.embed(text)));
  }

  /**
   * Generate text completion
   */
  async generate(prompt: string, options?: GenerateOptions): Promise<GenerateResult | null> {
    // Return mock generated text based on prompt
    let text = "";
    
    if (prompt.toLowerCase().includes("expand") || prompt.toLowerCase().includes("query")) {
      // Mock query expansion
      text = 'lex: "search terms for keyword"\nvec: "semantic meaning of query"\nhyde: "hypothetical document about topic"';
    } else {
      text = `Mock generated response for: ${prompt.substring(0, 50)}...`;
    }

    return {
      text,
      model: "mock-generation-model",
      done: true,
    };
  }

  /**
   * Check if a model exists
   */
  async modelExists(model: string): Promise<ModelInfo> {
    // Mock always returns true
    return {
      exists: true,
      name: model,
    };
  }

  /**
   * Expand a search query into multiple variations
   */
  async expandQuery(query: string, options?: { context?: string, includeLexical?: boolean }): Promise<Queryable[]> {
    const includeLexical = options?.includeLexical !== false;
    
    const expansions: Queryable[] = [];
    
    // Add lexical variations
    if (includeLexical) {
      expansions.push({
        type: "lex",
        text: `${query} keywords`,
        weight: 1.0,
      });
    }
    
    // Add vector semantic expansion
    expansions.push({
      type: "vec",
      text: `semantic meaning of ${query}`,
      weight: 1.0,
    });
    
    // Add HyDE hypothetical document
    expansions.push({
      type: "hyde",
      text: `A document about ${query} that explains the concepts and provides examples`,
      weight: 0.8,
    });

    return expansions;
  }

  /**
   * Rerank documents by relevance to a query
   */
  async rerank(query: string, documents: RerankDocument[], options?: RerankOptions): Promise<RerankResult> {
    if (documents.length === 0) {
      return {
        results: [],
        model: "mock-rerank-model",
      };
    }

    // Create deterministic scores based on text similarity
    const results = documents.map((doc, index) => {
      // Simple scoring: check for query terms in text
      const queryLower = query.toLowerCase();
      const textLower = doc.text.toLowerCase();
      
      let score = 0.5; // Base score
      
      // Boost score if query terms appear in text
      const queryWords = queryLower.split(/\s+/);
      for (const word of queryWords) {
        if (word.length > 2 && textLower.includes(word)) {
          score += 0.1;
        }
      }
      
      // Cap at 1.0
      score = Math.min(score, 1.0);
      
      // Add small deterministic variation based on index
      score = score - (index * 0.01);
      
      return {
        file: doc.file,
        score: Math.max(0, Math.min(1, score)),
        index,
      };
    });

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);

    return {
      results,
      model: "mock-rerank-model",
    };
  }

  /**
   * Dispose of resources (no-op for mock)
   */
  async dispose(): Promise<void> {
    // Nothing to dispose
  }

  /**
   * Simple hash function for deterministic embedding generation
   */
  private simpleHash(text: string): number {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash);
  }

  /**
   * Generate deterministic embedding based on hash
   */
  private generateDeterministicEmbedding(seed: number): number[] {
    const embedding: number[] = [];
    
    // Use seed to generate deterministic random-looking values
    let state = seed;
    const lcg = (a: number, c: number, m: number) => {
      state = (a * state + c) % m;
      return state / m;
    };
    
    // Parameters for Linear Congruential Generator
    const a = 1664525;
    const c = 1013904223;
    const m = 2 ** 32;
    
    for (let i = 0; i < this.mockEmbeddingDimension; i++) {
      // Generate value between -1 and 1
      const value = lcg(a, c, m) * 2 - 1;
      embedding.push(value);
    }
    
    // Normalize to unit vector (common for embeddings)
    const magnitude = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0));
    return embedding.map(val => val / magnitude);
  }
}

/**
 * Get mock LLM instance for testing
 */
export function getMockLLM(): LLM {
  return new MockLLM();
}

/**
 * Check if mock mode is enabled via environment
 */
export function isMockLLMEnabled(): boolean {
  return Bun.env.QMD_MOCK_LLM === "true" || Bun.env.CI === "true";
}
