import { describe, expect, it } from "vitest";
import { createOpenAiReranker } from "../src/retrieval/index.js";

function rerankResponse(): Response {
  return new Response(
    JSON.stringify({
      results: [
        { index: 1, relevance_score: 0.91 },
        { index: 0, relevance_score: 0.12 },
      ],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("createOpenAiReranker", () => {
  it("appends /rerank when the base url does not name the endpoint", async () => {
    const urls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      urls.push(String(input));
      return rerankResponse();
    };
    const reranker = createOpenAiReranker({
      baseUrl: "https://rerank.example/v1/",
      apiKey: "test-key",
      model: "rerank-model",
      fetchImpl,
    });

    const scores = await reranker.rerank({
      mode: "hybrid",
      query: "query",
      documents: ["first", "second"],
    });

    expect(urls).toEqual(["https://rerank.example/v1/rerank"]);
    expect(scores).toEqual([
      { index: 1, score: 0.91 },
      { index: 0, score: 0.12 },
    ]);
  });

  it("uses a base url that already names /reranks as the full endpoint", async () => {
    const urls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      urls.push(String(input));
      return rerankResponse();
    };
    const reranker = createOpenAiReranker({
      baseUrl: "https://dashscope.example/compatible-api/v1/reranks",
      apiKey: "test-key",
      model: "gte-rerank-v2",
      fetchImpl,
    });

    await reranker.rerank({
      mode: "hyperedge",
      query: "query",
      documents: ["first", "second"],
    });

    expect(urls).toEqual([
      "https://dashscope.example/compatible-api/v1/reranks",
    ]);
  });
});
