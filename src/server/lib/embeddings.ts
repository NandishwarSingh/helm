import "server-only";

import { env } from "@/env";

/**
 * Text embeddings via OpenRouter (same key as the agent/triage models — no new
 * secret, and the work runs off-box so the VPS never carries an embedding
 * model). We pin 1536 dimensions: text-embedding-3-large's `dimensions` param
 * trims the native 3072 down, which keeps quality high while staying under
 * pgvector's 2000-dim HNSW index ceiling and halving storage.
 */
const ENDPOINT = "https://openrouter.ai/api/v1/embeddings";
const MODEL = "openai/text-embedding-3-large";
export const EMBED_DIMS = 1536;

// OpenRouter/OpenAI accept arrays; batch to keep requests bounded. Each item is
// truncated so one giant email can't blow the token budget.
const MAX_BATCH = 96;
const MAX_CHARS = 6000;

type EmbeddingResponse = {
  data?: { embedding: number[]; index: number }[];
  error?: unknown;
};

/** Embed many texts, preserving input order. Empty input → empty output. */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += MAX_BATCH) {
    const batch = texts
      .slice(i, i + MAX_BATCH)
      .map((text) => text.slice(0, MAX_CHARS) || " ");
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: MODEL, input: batch, dimensions: EMBED_DIMS }),
    });
    if (!response.ok) {
      throw new Error(
        `embeddings ${response.status}: ${(await response.text()).slice(0, 200)}`,
      );
    }
    const json = (await response.json()) as EmbeddingResponse;
    if (!json.data) {
      throw new Error(`embeddings: no data (${JSON.stringify(json).slice(0, 160)})`);
    }
    // The API may return items out of order; sort by index before collecting.
    for (const item of [...json.data].sort((a, b) => a.index - b.index)) {
      out.push(item.embedding);
    }
  }
  return out;
}

/** Embed a single query string. */
export async function embedQuery(text: string): Promise<number[]> {
  const [vector] = await embedTexts([text.trim() || " "]);
  if (!vector) throw new Error("embeddings: empty result");
  return vector;
}

/** Postgres `vector` literal form: `[0.1,0.2,...]`. */
export function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}
