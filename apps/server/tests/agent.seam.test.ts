import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type AssistantMessage,
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  AgentError,
  type AgentSeam,
  createAgentService,
  createDefaultAgentService,
  createOpenAiCompatibleRuntime,
} from "../src/agent/index.js";
import {
  EMBEDDING_DIMENSIONS,
  type EmbeddingProvider,
  createDocumentIndexer,
} from "../src/indexing/index.js";
import { createIngestionService } from "../src/ingestion/index.js";
import {
  type RerankInput,
  type RerankScore,
  type Reranker,
  RetrievalError,
  type RetrievalSeam,
  type SearchHit,
  createRetrievalService,
} from "../src/retrieval/index.js";
import {
  type Database,
  type DbClient,
  createDatabase,
} from "../src/storage/db.js";
import { sources } from "../src/storage/schema.js";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://borges:borges@127.0.0.1:5432/borges";

const AGENT_TOKEN = "orionbudget";
const FILE_NAME = "agent-notes.ts";
const FILE_CONTENT = [
  "export function orionRetryBudget(): number {",
  "  return 3; // orionbudget capitalGainsRate marker",
  "}",
].join("\n");
const EXPECTED_ANCHOR = {
  kind: "line" as const,
  filePath: FILE_NAME,
  startLine: 1,
  endLine: 3,
};

let database: Database;
let db: DbClient;
let workDirectory: string;
let mirrorRoot: string;
const createdSourceIds: string[] = [];

class TokenEmbeddingProvider implements EmbeddingProvider {
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(tokenVector);
  }
}

class OverlapReranker implements Reranker {
  async rerank(input: RerankInput): Promise<RerankScore[]> {
    const queryTokens = new Set(tokenize(input.query));
    return input.documents.map((document, index) => {
      const documentTokens = new Set(tokenize(document));
      const overlap = [...queryTokens].filter((token) =>
        documentTokens.has(token),
      ).length;
      return { index, score: overlap };
    });
  }
}

class RecordingReranker extends OverlapReranker {
  readonly calls: RerankInput[] = [];

  override async rerank(input: RerankInput): Promise<RerankScore[]> {
    this.calls.push(input);
    return await super.rerank(input);
  }
}

interface KnowledgeBase {
  sourceId: string;
  retrieval: RetrievalSeam;
  chunk: SearchHit;
}

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function tokenVector(text: string): number[] {
  const vector: number[] = new Array(EMBEDDING_DIMENSIONS).fill(0);
  for (const token of tokenize(text)) {
    const digest = createHash("sha256").update(token).digest();
    const bucket = digest.readUInt32BE(0) % EMBEDDING_DIMENSIONS;
    vector[bucket] = (vector[bucket] ?? 0) + 1;
  }
  if (!vector.some((value) => value !== 0)) {
    vector[0] = 1;
  }
  return vector;
}

async function seedKnowledgeBase(): Promise<KnowledgeBase> {
  const sourceId = randomUUID();
  await db.insert(sources).values({ id: sourceId, name: `agent-${sourceId}` });
  createdSourceIds.push(sourceId);
  const directory = await mkdtemp(path.join(workDirectory, "case-"));
  const filePath = path.join(directory, FILE_NAME);
  await writeFile(filePath, FILE_CONTENT, "utf8");
  const embedding = new TokenEmbeddingProvider();
  const ingestion = createIngestionService({
    db,
    mirrorRoot,
    indexer: createDocumentIndexer({
      embeddingProvider: embedding,
      chunker: { maxChars: 600 },
    }),
  });
  const job = await ingestion.submitDocument({ sourceId, filePath });
  expect(job, JSON.stringify(job)).toMatchObject({ status: "READY" });
  const retrieval = createRetrievalService({
    db,
    embeddingProvider: embedding,
    reranker: new OverlapReranker(),
    mirrorRoot,
  });
  const hits = await retrieval.search({
    query: AGENT_TOKEN,
    sourceIds: [sourceId],
    mode: "hybrid",
    topK: 5,
  });
  const chunk = hits[0];
  if (!chunk) {
    throw new Error("seed corpus produced no hybrid hits");
  }
  expect(chunk.anchor).toEqual(EXPECTED_ANCHOR);
  expect(chunk.content).toBe(FILE_CONTENT);
  return { sourceId, retrieval, chunk };
}

function createScriptedAgent(
  retrieval: RetrievalSeam,
  responses: AssistantMessage[],
  reranker?: Reranker,
): { agent: AgentSeam; callCount: () => number } {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(responses);
  const model = models.getModel(faux.provider.id, faux.getModel().id);
  if (!model) {
    throw new Error("faux provider model was not registered");
  }
  return {
    agent: createAgentService({
      retrieval,
      ...(reranker === undefined ? {} : { reranker }),
      model,
      streamFn: models.streamSimple.bind(models),
    }),
    callCount: () => faux.state.callCount,
  };
}

function finalAnswer(payload: {
  answer: string;
  citationChunkIds: string[];
  refused: boolean;
}): AssistantMessage {
  return fauxAssistantMessage(JSON.stringify(payload));
}

beforeAll(async () => {
  database = createDatabase(DATABASE_URL);
  db = database.db;
  await db.execute(sql`select 1`);
  workDirectory = await mkdtemp(path.join(tmpdir(), "borges-agent-"));
  mirrorRoot = path.join(workDirectory, "mirror");
  await mkdir(mirrorRoot, { recursive: true });
});

afterEach(async () => {
  for (const sourceId of createdSourceIds.splice(0)) {
    await db.delete(sources).where(eq(sources.id, sourceId));
  }
});

afterAll(async () => {
  await database.close();
  await rm(workDirectory, { recursive: true, force: true });
});

describe("AgentSeam", () => {
  it("builds the default OpenAI-compatible model runtime from env", () => {
    const runtime = createOpenAiCompatibleRuntime({
      OPENAI_API_KEY: "test-key",
      OPENAI_BASE_URL: "http://127.0.0.1:9/v1",
      LLM_MODEL: "test-model",
    });

    expect(runtime.model).toMatchObject({
      id: "test-model",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:9/v1",
    });
    expect(typeof runtime.streamFn).toBe("function");
  });

  it("answers a corpus question through the Pi agent tool loop with backfilled citations", async () => {
    const knowledgeBase = await seedKnowledgeBase();
    const { agent, callCount } = createScriptedAgent(knowledgeBase.retrieval, [
      fauxAssistantMessage(
        fauxToolCall("search_hybrid", { query: AGENT_TOKEN }),
      ),
      finalAnswer({
        answer: "The retry budget is 3.",
        citationChunkIds: [knowledgeBase.chunk.chunkId],
        refused: false,
      }),
    ]);

    const response = await agent.ask({
      query: "What is the retry budget?",
      sourceIds: [knowledgeBase.sourceId],
    });

    expect(callCount()).toBe(2);
    expect(response.refused).toBe(false);
    expect(response.answer).toBe("The retry budget is 3.");
    expect(response.citations).toEqual([
      {
        chunkId: knowledgeBase.chunk.chunkId,
        sourceId: knowledgeBase.sourceId,
        anchor: EXPECTED_ANCHOR,
      },
    ]);
  });

  it("refuses and drops citations when the model cites a chunk outside the tool results", async () => {
    const knowledgeBase = await seedKnowledgeBase();
    const hallucinatedChunkId = randomUUID();
    const { agent } = createScriptedAgent(knowledgeBase.retrieval, [
      fauxAssistantMessage(
        fauxToolCall("search_hybrid", { query: AGENT_TOKEN }),
      ),
      finalAnswer({
        answer: "The retry budget is 9.",
        citationChunkIds: [hallucinatedChunkId],
        refused: false,
      }),
    ]);

    const response = await agent.ask({
      query: "What is the retry budget?",
      sourceIds: [knowledgeBase.sourceId],
    });

    expect(response.refused).toBe(true);
    expect(response.citations).toEqual([]);
    expect(response.answer).not.toContain("9");
  });

  it("refuses an unrelated rg literal hit after reranking it", async () => {
    const knowledgeBase = await seedKnowledgeBase();
    const reranker = new RecordingReranker();
    const { agent } = createScriptedAgent(
      knowledgeBase.retrieval,
      [
        fauxAssistantMessage(fauxToolCall("search_rg", { query: "capital" })),
        finalAnswer({
          answer: "The capital of France is Paris.",
          citationChunkIds: [knowledgeBase.chunk.chunkId],
          refused: false,
        }),
      ],
      reranker,
    );

    const response = await agent.ask({
      query: "What is the capital of France?",
      sourceIds: [knowledgeBase.sourceId],
    });

    expect(reranker.calls).toHaveLength(1);
    expect(reranker.calls[0]?.mode).toBe("rg");
    expect(reranker.calls[0]?.query).toBe("What is the capital of France?");
    expect(reranker.calls[0]?.documents.join("\n")).toContain(
      "capitalGainsRate",
    );
    expect(response.refused).toBe(true);
    expect(response.citations).toEqual([]);
    expect(response.answer).toContain("relevance threshold");
    expect(response.answer).not.toContain("Paris");
  });

  it("refuses rg-only evidence when no reranker is injected", async () => {
    const knowledgeBase = await seedKnowledgeBase();
    const { agent } = createScriptedAgent(knowledgeBase.retrieval, [
      fauxAssistantMessage(fauxToolCall("search_rg", { query: "capital" })),
      finalAnswer({
        answer: "The capital of France is Paris.",
        citationChunkIds: [knowledgeBase.chunk.chunkId],
        refused: false,
      }),
    ]);

    const response = await agent.ask({
      query: "What is the capital of France?",
      sourceIds: [knowledgeBase.sourceId],
    });

    expect(response.refused).toBe(true);
    expect(response.citations).toEqual([]);
    expect(response.answer).toContain("relevance threshold");
  });

  it("drops an rg citation whose reranked score is below the threshold", async () => {
    const lowHit: SearchHit = {
      chunkId: "11111111-1111-4111-8111-111111111111",
      documentId: "22222222-2222-4222-8222-222222222222",
      sourceId: "33333333-3333-4333-8333-333333333333",
      content: "export const capitalGainsRate = 0.2;",
      score: 1,
      anchor: { kind: "line", filePath: "tax.ts", startLine: 1, endLine: 1 },
    };
    const relevantHit: SearchHit = {
      ...lowHit,
      chunkId: "44444444-4444-4444-8444-444444444444",
      content: "Paris is the capital of France.",
    };
    const retrieval: RetrievalSeam = {
      search: async (request) =>
        request.mode === "rg" ? [lowHit, relevantHit] : [],
    };
    const reranker: Reranker = {
      rerank: async (input) =>
        input.documents.map((document, index) => ({
          index,
          score: document.includes("Paris") ? 0.9 : 0.05,
        })),
    };
    const { agent } = createScriptedAgent(
      retrieval,
      [
        fauxAssistantMessage(fauxToolCall("search_rg", { query: "capital" })),
        finalAnswer({
          answer: "Paris is the capital of France.",
          citationChunkIds: [lowHit.chunkId],
          refused: false,
        }),
      ],
      reranker,
    );

    const response = await agent.ask({
      query: "What is the capital of France?",
      sourceIds: [lowHit.sourceId],
    });

    expect(response.refused).toBe(true);
    expect(response.citations).toEqual([]);
    expect(response.answer).toContain("could not be verified");
  });

  it("refuses when every tool call returns no hits", async () => {
    const knowledgeBase = await seedKnowledgeBase();
    const { agent } = createScriptedAgent(knowledgeBase.retrieval, [
      fauxAssistantMessage(
        fauxToolCall("search_rg", { query: "absolutelynotpresent" }),
      ),
      finalAnswer({
        answer: "The answer is somewhere.",
        citationChunkIds: [knowledgeBase.chunk.chunkId],
        refused: false,
      }),
    ]);

    const response = await agent.ask({
      query: "Find absolutelynotpresent",
      sourceIds: [knowledgeBase.sourceId],
    });

    expect(response.refused).toBe(true);
    expect(response.citations).toEqual([]);
  });

  it("refuses when the best hit scores below the refusal threshold", async () => {
    const knowledgeBase = await seedKnowledgeBase();
    const { agent } = createScriptedAgent(knowledgeBase.retrieval, [
      fauxAssistantMessage(
        fauxToolCall("search_hybrid", { query: "marinebiology" }),
      ),
      finalAnswer({
        answer: "Marine biology studies ocean life.",
        citationChunkIds: [knowledgeBase.chunk.chunkId],
        refused: false,
      }),
    ]);

    const response = await agent.ask({
      query: "What is marine biology?",
      sourceIds: [knowledgeBase.sourceId],
    });

    expect(response.refused).toBe(true);
    expect(response.citations).toEqual([]);
  });

  it("wraps an rg rerank failure in an AgentError while keeping the upstream cause", async () => {
    const hit: SearchHit = {
      chunkId: "55555555-5555-4555-8555-555555555555",
      documentId: "66666666-6666-4666-8666-666666666666",
      sourceId: "77777777-7777-4777-8777-777777777777",
      content: "export const capitalGainsRate = 0.2;",
      score: 1,
      anchor: { kind: "line", filePath: "tax.ts", startLine: 1, endLine: 1 },
    };
    const retrieval: RetrievalSeam = {
      search: async (request) => (request.mode === "rg" ? [hit] : []),
    };
    const reranker: Reranker = {
      rerank: async () => {
        throw new RetrievalError("rerank_timeout", "rg", "rerank timed out");
      },
    };
    const { agent } = createScriptedAgent(
      retrieval,
      [
        fauxAssistantMessage(fauxToolCall("search_rg", { query: "capital" })),
        finalAnswer({
          answer: "The capital gains rate is 0.2.",
          citationChunkIds: [hit.chunkId],
          refused: false,
        }),
      ],
      reranker,
    );

    const error = await agent
      .ask({
        query: "What is the capital gains rate?",
        sourceIds: [hit.sourceId],
      })
      .then(
        () => {
          throw new Error("expected ask to reject");
        },
        (rejected: unknown) => rejected,
      );

    expect(error).toBeInstanceOf(AgentError);
    expect(error).toMatchObject({ code: "rerank_failed" });
    expect((error as AgentError).cause).toMatchObject({
      name: "RetrievalError",
      code: "rerank_timeout",
    });
  });

  it("rejects an AGENT_REFUSAL_THRESHOLD outside 0..1 when building the default service", () => {
    let thrown: unknown;
    try {
      createDefaultAgentService({
        retrieval: { search: async () => [] },
        reranker: { rerank: async () => [] },
        env: {
          OPENAI_API_KEY: "test-key",
          OPENAI_BASE_URL: "http://127.0.0.1:9/v1",
          LLM_MODEL: "test-model",
          AGENT_REFUSAL_THRESHOLD: "1.5",
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AgentError);
    expect(thrown).toMatchObject({
      code: "model_config_invalid",
      message: expect.stringContaining("refusalThreshold"),
    });
  });

  it("keeps a model-declared refusal with empty citations", async () => {
    const knowledgeBase = await seedKnowledgeBase();
    const { agent } = createScriptedAgent(knowledgeBase.retrieval, [
      fauxAssistantMessage(
        fauxToolCall("search_hybrid", { query: AGENT_TOKEN }),
      ),
      finalAnswer({
        answer: "The evidence does not answer this question.",
        citationChunkIds: [knowledgeBase.chunk.chunkId],
        refused: true,
      }),
    ]);

    const response = await agent.ask({
      query: "What is the retry budget?",
      sourceIds: [knowledgeBase.sourceId],
    });

    expect(response.refused).toBe(true);
    expect(response.citations).toEqual([]);
    expect(response.answer).toBe("The evidence does not answer this question.");
  });
});
