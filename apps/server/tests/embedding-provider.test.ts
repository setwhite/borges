import { describe, expect, it } from "vitest";
import {
  EMBEDDING_DIMENSIONS,
  createOpenAiEmbeddingProvider,
} from "../src/indexing/index.js";

function embeddingResponse(dimensions: number): Response {
  return new Response(
    JSON.stringify({
      data: [
        {
          index: 0,
          embedding: Array.from(
            { length: dimensions },
            (_, index) => index / dimensions,
          ),
        },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("createOpenAiEmbeddingProvider", () => {
  it("returns vectors when the API responds with 1536 dimensions", async () => {
    const requests: { url: string; body: unknown }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body)),
      });
      return embeddingResponse(EMBEDDING_DIMENSIONS);
    };
    const provider = createOpenAiEmbeddingProvider({
      baseUrl: "https://embedding.example/v1/",
      apiKey: "test-key",
      model: "embedding-model",
      fetchImpl,
    });

    const vectors = await provider.embed(["hello"]);

    expect(vectors).toHaveLength(1);
    expect(vectors[0]).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(requests[0]?.url).toBe("https://embedding.example/v1/embeddings");
    expect(requests[0]?.body).toEqual({
      model: "embedding-model",
      input: ["hello"],
    });
  });

  it("fails fast when the returned dimension is not 1536", async () => {
    const fetchImpl: typeof fetch = async () => embeddingResponse(768);
    const provider = createOpenAiEmbeddingProvider({
      baseUrl: "https://embedding.example/v1",
      apiKey: "test-key",
      model: "embedding-model",
      fetchImpl,
    });

    await expect(provider.embed(["hello"])).rejects.toThrow(/1536/);
  });
});
