import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { FastifyInstance } from "fastify";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import type { AskResponse } from "../src/agent/index.js";
import type {
  IngestionJobView,
  SourceFilter,
  SourceView,
  SubmitDocumentInput,
} from "../src/ingestion/index.js";
import {
  type InterfaceDependencies,
  createCli,
  createHttpApp,
  createMcpServer,
} from "../src/interfaces/index.js";
import {
  RetrievalError,
  type SearchHit,
  type SearchRequest,
} from "../src/retrieval/index.js";

const SOURCE_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const DOCUMENT_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const CHUNK_ID = "2c1b3d4e-1234-4abc-9def-0123456789ab";
const JOB_ID = "3d2c1b0a-9876-4fed-8cba-0123456789cd";

const sourceFixture: SourceView = {
  sourceId: SOURCE_ID,
  name: "handbook",
  tenantId: "default",
  aclTags: ["finance"],
  extractHyperedge: true,
  createdAt: "2025-01-01T00:00:00.000Z",
};

const hitFixture: SearchHit = {
  chunkId: CHUNK_ID,
  documentId: DOCUMENT_ID,
  sourceId: SOURCE_ID,
  content: "Quarterly revenue reached 42 million.",
  score: 0.93,
  anchor: { kind: "page", pageNumber: 3, sectionPath: ["Overview"] },
};

const askFixture: AskResponse = {
  answer: "Quarterly revenue reached 42 million.",
  citations: [
    {
      chunkId: CHUNK_ID,
      sourceId: SOURCE_ID,
      anchor: { kind: "page", pageNumber: 3, sectionPath: ["Overview"] },
    },
  ],
  refused: false,
};

const jobFixture: IngestionJobView = {
  jobId: JOB_ID,
  documentId: DOCUMENT_ID,
  sourceId: SOURCE_ID,
  status: "READY",
  errorCode: null,
  errorMessage: null,
};

interface RecordedCalls {
  sourceFilters: (SourceFilter | undefined)[];
  documents: SubmitDocumentInput[];
  searches: SearchRequest[];
}

const calls: RecordedCalls = {
  sourceFilters: [],
  documents: [],
  searches: [],
};

let retrievalError: unknown = null;

const deps: InterfaceDependencies = {
  ingestion: {
    listSources: async (filter) => {
      calls.sourceFilters.push(filter);
      return [sourceFixture];
    },
    submitDocument: async (input) => {
      calls.documents.push(input);
      return jobFixture;
    },
    getJob: async (jobId) => (jobId === JOB_ID ? jobFixture : null),
    deleteDocument: async () => {},
  },
  retrieval: {
    search: async (request) => {
      calls.searches.push(request);
      if (retrievalError) {
        throw retrievalError;
      }
      return [hitFixture];
    },
  },
  agent: {
    ask: async () => askFixture,
  },
};

let app: FastifyInstance;

function resetCalls(): void {
  calls.sourceFilters.length = 0;
  calls.documents.length = 0;
  calls.searches.length = 0;
  retrievalError = null;
}

beforeAll(async () => {
  app = await createHttpApp({ deps });
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  resetCalls();
});

describe("InterfaceSeam HTTP", () => {
  it("serves an OpenAPI document covering the REST endpoints", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/openapi.json",
    });

    expect(response.statusCode).toBe(200);
    const document = response.json() as {
      openapi?: string;
      paths?: Record<string, unknown>;
    };
    expect(document.openapi).toBeTruthy();
    expect(document.paths).toHaveProperty("/sources");
    expect(document.paths).toHaveProperty("/search");
    expect(document.paths).toHaveProperty("/ask");
  });

  it("lists sources through the ingestion seam", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/sources?tenantId=default&aclTags=finance",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([sourceFixture]);
    expect(calls.sourceFilters).toEqual([
      { tenantId: "default", aclTags: ["finance"] },
    ]);
  });

  it("searches through the retrieval seam and defaults topK", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/search",
      payload: {
        query: "revenue",
        sourceIds: [SOURCE_ID],
        mode: "hybrid",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([hitFixture]);
    expect(calls.searches).toEqual([
      {
        query: "revenue",
        sourceIds: [SOURCE_ID],
        mode: "hybrid",
        topK: 10,
      },
    ]);
  });

  it("answers through the agent seam", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/ask",
      payload: { query: "revenue?", sourceIds: [SOURCE_ID] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(askFixture);
  });

  it("accepts topK up to 1000 and rejects anything above it", async () => {
    const accepted = await app.inject({
      method: "POST",
      url: "/search",
      payload: {
        query: "revenue",
        sourceIds: [SOURCE_ID],
        mode: "hybrid",
        topK: 1000,
      },
    });

    expect(accepted.statusCode).toBe(200);
    expect(calls.searches).toEqual([
      {
        query: "revenue",
        sourceIds: [SOURCE_ID],
        mode: "hybrid",
        topK: 1000,
      },
    ]);

    calls.searches.length = 0;
    const rejected = await app.inject({
      method: "POST",
      url: "/search",
      payload: {
        query: "revenue",
        sourceIds: [SOURCE_ID],
        mode: "hybrid",
        topK: 1001,
      },
    });

    expect(rejected.statusCode).toBe(400);
    expect(errorOf(rejected).code).toBe("invalid_request");
    expect(calls.searches).toEqual([]);
  });

  it("rejects an invalid search body with a structured 400", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/search",
      payload: { query: "revenue", sourceIds: [SOURCE_ID] },
    });

    expect(response.statusCode).toBe(400);
    expect(errorOf(response).code).toBe("invalid_request");
    expect(errorOf(response).message).toBeTruthy();
  });

  it("maps malformed and empty JSON bodies to a structured 400", async () => {
    const malformed = await app.inject({
      method: "POST",
      url: "/search",
      headers: { "content-type": "application/json" },
      payload: '{"query": "revenue",',
    });

    expect(malformed.statusCode).toBe(400);
    expect(errorOf(malformed).code).toBe("invalid_request");
    expect(errorOf(malformed).message).toBeTruthy();

    const empty = await app.inject({
      method: "POST",
      url: "/search",
      headers: { "content-type": "application/json" },
      payload: "",
    });

    expect(empty.statusCode).toBe(400);
    expect(errorOf(empty).code).toBe("invalid_request");
    expect(errorOf(empty).message).toBeTruthy();
  });

  it("returns a structured 404 for unknown routes and methods", async () => {
    const unknown = await app.inject({ method: "GET", url: "/nope" });

    expect(unknown.statusCode).toBe(404);
    expect(errorOf(unknown).code).toBe("not_found");
    expect(errorOf(unknown).message).toBeTruthy();

    const wrongMethod = await app.inject({
      method: "PUT",
      url: "/search",
      payload: {},
    });

    expect(wrongMethod.statusCode).toBe(404);
    expect(errorOf(wrongMethod).code).toBe("not_found");
  });

  it("rejects coerced types and unknown fields instead of rewriting them", async () => {
    const bodies = [
      { query: "revenue", sourceIds: [SOURCE_ID], mode: "hybrid", topK: true },
      { query: "revenue", sourceIds: "abc", mode: "hybrid" },
      {
        query: "revenue",
        sourceIds: [SOURCE_ID],
        mode: "hybrid",
        tenantid: "other",
      },
    ];

    for (const payload of bodies) {
      const response = await app.inject({
        method: "POST",
        url: "/search",
        payload,
      });

      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
      expect(errorOf(response).code).toBe("invalid_request");
    }
    expect(calls.searches).toEqual([]);
  });
});

describe("InterfaceSeam MCP", () => {
  let server: ReturnType<typeof createMcpServer>;
  let client: Client;

  beforeEach(async () => {
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    server = createMcpServer(deps);
    await server.connect(serverTransport);
    client = new Client({ name: "borges-test", version: "0.0.0" });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  it("returns domain sources from the list_sources tool", async () => {
    const result = await client.callTool({
      name: "list_sources",
      arguments: { tenantId: "default", aclTags: ["finance"] },
    });

    expect(toolPayload(result)).toEqual([sourceFixture]);
    expect(calls.sourceFilters).toEqual([
      { tenantId: "default", aclTags: ["finance"] },
    ]);
  });

  it("returns domain hits from the search tool", async () => {
    const result = await client.callTool({
      name: "search",
      arguments: {
        query: "revenue",
        sourceIds: [SOURCE_ID],
        mode: "hybrid",
        topK: 3,
      },
    });

    expect(toolPayload(result)).toEqual([hitFixture]);
    expect(calls.searches).toEqual([
      {
        query: "revenue",
        sourceIds: [SOURCE_ID],
        mode: "hybrid",
        topK: 3,
      },
    ]);
  });

  it("returns the domain answer from the ask tool", async () => {
    const result = await client.callTool({
      name: "ask",
      arguments: { query: "revenue?", sourceIds: [SOURCE_ID] },
    });

    expect(toolPayload(result)).toEqual(askFixture);
  });

  it("keeps domain error codes in MCP tool errors", async () => {
    retrievalError = new RetrievalError(
      "rerank_timeout",
      "hybrid",
      "rerank timed out",
    );

    const result = await client.callTool({
      name: "search",
      arguments: {
        query: "revenue",
        sourceIds: [SOURCE_ID],
        mode: "hybrid",
      },
    });

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(toolPayload(result)).toEqual({
      error: { code: "rerank_timeout", message: "rerank timed out" },
    });
  });
});

describe("InterfaceSeam CLI", () => {
  it("prints the JSON envelope for sources list", async () => {
    const { code, output } = await runCli(["sources", "list"]);

    expect(code).toBe(0);
    expect(JSON.parse(output)).toEqual({ ok: true, data: [sourceFixture] });
  });

  it("prints the JSON envelope for ingest", async () => {
    const { code, output } = await runCli([
      "ingest",
      "--source-id",
      SOURCE_ID,
      "--file",
      "/tmp/handbook.md",
      "--title",
      "handbook.md",
    ]);

    expect(code).toBe(0);
    expect(JSON.parse(output)).toEqual({ ok: true, data: jobFixture });
    expect(calls.documents).toEqual([
      {
        sourceId: SOURCE_ID,
        filePath: "/tmp/handbook.md",
        title: "handbook.md",
      },
    ]);
  });

  it("prints human-readable text with --format text", async () => {
    const { code, output } = await runCli([
      "search",
      "--query",
      "revenue",
      "--source-id",
      SOURCE_ID,
      "--format",
      "text",
    ]);

    expect(code).toBe(0);
    expect(output).toContain(hitFixture.content);
    expect(output).toContain("page 3");
    expect(output.trimStart().startsWith("{")).toBe(false);
  });

  it("rejects an out-of-range --top-k with invalid_request before calling retrieval", async () => {
    const { code, output } = await runCli([
      "search",
      "--query",
      "revenue",
      "--source-id",
      SOURCE_ID,
      "--top-k",
      "100000",
    ]);

    expect(code).not.toBe(0);
    const envelope = JSON.parse(output) as {
      ok?: boolean;
      error?: { code?: string; message?: string };
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe("invalid_request");
    expect(calls.searches).toEqual([]);
  });

  it("returns a non-zero exit code and a JSON error envelope for invalid arguments", async () => {
    const { code, output } = await runCli(["search", "--query", "revenue"]);

    expect(code).not.toBe(0);
    const envelope = JSON.parse(output) as {
      ok?: boolean;
      error?: { code?: string; message?: string };
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe("invalid_request");
    expect(envelope.error?.message).toContain("--source-id");
  });
});

async function runCli(
  argv: string[],
): Promise<{ code: number; output: string }> {
  const chunks: string[] = [];
  const cli = createCli(deps, { stdout: (chunk) => chunks.push(chunk) });
  const code = await cli.run(argv);
  return { code, output: chunks.join("") };
}

function errorOf(response: { json(): unknown }): {
  code?: string;
  message?: string;
} {
  const body = response.json();
  if (typeof body !== "object" || body === null) {
    return {};
  }
  const error = (body as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) {
    return {};
  }
  const { code, message } = error as { code?: unknown; message?: unknown };
  return {
    ...(typeof code === "string" ? { code } : {}),
    ...(typeof message === "string" ? { message } : {}),
  };
}

function toolPayload(result: unknown): unknown {
  const rawContent =
    typeof result === "object" && result !== null
      ? (result as { content?: unknown }).content
      : undefined;
  const content = Array.isArray(rawContent) ? rawContent : [];
  const textBlock = content.find(
    (block): block is { type: "text"; text: string } =>
      typeof block === "object" &&
      block !== null &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string",
  );
  if (!textBlock) {
    throw new Error("MCP tool result has no text content");
  }
  return JSON.parse(textBlock.text);
}
