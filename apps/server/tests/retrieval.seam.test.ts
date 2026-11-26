import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { EvidenceIR } from "../src/contracts/evidence-ir.js";
import {
  EMBEDDING_DIMENSIONS,
  type EmbeddingProvider,
  type HyperedgeExtraction,
  type HyperedgeExtractionInput,
  type HyperedgeExtractor,
  createDocumentIndexer,
} from "../src/indexing/index.js";
import {
  type ParserWorker,
  type SubmitDocumentInput,
  createIngestionService,
} from "../src/ingestion/index.js";
import {
  type RerankInput,
  type RerankScore,
  type Reranker,
  RetrievalError,
  type RetrievalErrorCode,
  type RetrievalMode,
  type SearchHit,
  createOpenAiReranker,
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

const PDF_TOKEN = "novapdf";
const AUDIO_TOKEN = "novaaudio";
const CODE_TOKEN = "novacode";
const SHARED_ENTITY = "Orion Gateway";
const STUB_CONTENT_HASH = "a".repeat(64);
const MODES: RetrievalMode[] = ["hybrid", "hyperedge", "rg"];

const PDF_TEXT =
  "Quarterly revenue reached 42 million. novapdf marks the audited figure.";
const AUDIO_TEXT =
  "Speaker confirms the pilot launch timing. novaaudio is the transcript marker.";
const CODE_ONE_TEXT = [
  "export function orionRetryBudget(): number {",
  "  return 3; // novacode retry budget",
  "}",
].join("\n");
const CODE_TWO_TEXT = [
  "export function ledgerSettlement(): string {",
  '  return "orion ledger"; // settlement path',
  "}",
].join("\n");

let database: Database;
let db: DbClient;
let workDirectory: string;
let mirrorRoot: string;
const createdSourceIds: string[] = [];

class TokenEmbeddingProvider implements EmbeddingProvider {
  failure: Error | null = null;
  calls = 0;

  async embed(texts: string[]): Promise<number[][]> {
    if (this.failure) {
      throw this.failure;
    }
    this.calls += 1;
    return texts.map(tokenVector);
  }
}

class OverlapReranker implements Reranker {
  readonly calls: RerankInput[] = [];

  async rerank(input: RerankInput): Promise<RerankScore[]> {
    this.calls.push(input);
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

class SharedEntityExtractor implements HyperedgeExtractor {
  async extract(input: HyperedgeExtractionInput): Promise<HyperedgeExtraction> {
    return {
      events: [
        {
          summary: input.content.slice(0, 160),
          entityNames: [SHARED_ENTITY],
        },
      ],
      entities: [{ name: SHARED_ENTITY, entityType: "service" }],
    };
  }
}

interface CorpusOptions {
  aclTags?: string[] | undefined;
  embedding?: TokenEmbeddingProvider | undefined;
  reranker?: Reranker | undefined;
  parser?: ParserWorker | undefined;
  rgPath?: string | undefined;
  rgTimeoutMs?: number | undefined;
  includeCode?: boolean;
  fillers?: number;
}

interface Corpus {
  embedding: TokenEmbeddingProvider;
  search(input: {
    mode: RetrievalMode;
    query: string;
    topK: number;
    sourceIds?: string[];
    tenantId?: string;
    aclTags?: string[];
  }): Promise<SearchHit[]>;
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

function stubParser(): ParserWorker {
  return {
    parse: async (filePath) => {
      const extension = path.extname(filePath).toLowerCase();
      if (extension === ".pdf") {
        return {
          documentMeta: {
            title: "quarterly.pdf",
            mediaType: "application/pdf",
            contentHash: STUB_CONTENT_HASH,
            parserEngine: "mineru",
          },
          segments: [
            {
              text: PDF_TEXT,
              anchor: {
                kind: "page",
                pageNumber: 3,
                sectionPath: ["Overview"],
              },
            },
          ],
        } satisfies EvidenceIR;
      }
      if (extension === ".wav") {
        return {
          documentMeta: {
            title: "briefing.wav",
            mediaType: "audio/wav",
            contentHash: STUB_CONTENT_HASH,
            parserEngine: "deepseek-asr",
          },
          segments: [
            {
              text: AUDIO_TEXT,
              anchor: {
                kind: "time",
                startMs: 9000,
                endMs: 24000,
                speaker: "Nova",
              },
            },
          ],
        } satisfies EvidenceIR;
      }
      throw new Error(`stub parser received an unexpected file: ${filePath}`);
    },
  };
}

async function createSource(extractHyperedge: boolean): Promise<string> {
  const sourceId = randomUUID();
  await db.insert(sources).values({
    id: sourceId,
    name: `retrieval-${sourceId}`,
    extractHyperedge,
  });
  createdSourceIds.push(sourceId);
  return sourceId;
}

async function writeCaseFile(
  directory: string,
  fileName: string,
  content: string,
): Promise<string> {
  const filePath = path.join(directory, fileName);
  await writeFile(filePath, content, "utf8");
  return filePath;
}

async function seedCorpus(options: CorpusOptions = {}): Promise<Corpus> {
  const sourceId = await createSource(true);
  const embedding = options.embedding ?? new TokenEmbeddingProvider();
  const reranker = options.reranker ?? new OverlapReranker();
  const ingestion = createIngestionService({
    db,
    mirrorRoot,
    parser: options.parser ?? stubParser(),
    indexer: createDocumentIndexer({
      embeddingProvider: embedding,
      hyperedgeExtractor: new SharedEntityExtractor(),
      chunker: { maxChars: 600 },
    }),
  });
  const directory = await mkdtemp(path.join(workDirectory, "case-"));
  const files = [
    await writeCaseFile(directory, "quarterly.pdf", "%PDF-1.7 stub"),
    await writeCaseFile(directory, "briefing.wav", "RIFF stub"),
  ];
  if (options.includeCode ?? true) {
    files.push(
      await writeCaseFile(directory, "code-one.ts", CODE_ONE_TEXT),
      await writeCaseFile(directory, "code-two.ts", CODE_TWO_TEXT),
    );
  }
  for (let index = 0; index < (options.fillers ?? 0); index += 1) {
    files.push(
      await writeCaseFile(
        directory,
        `filler-${index}.ts`,
        `export const filler${index} = { marker: "${CODE_TOKEN}" };`,
      ),
    );
  }
  for (const filePath of files) {
    const input: SubmitDocumentInput = { sourceId, filePath };
    if (options.aclTags) {
      input.aclTags = options.aclTags;
    }
    const job = await ingestion.submitDocument(input);
    expect(job, JSON.stringify(job)).toMatchObject({ status: "READY" });
  }
  const retrieval = createRetrievalService({
    db,
    embeddingProvider: embedding,
    reranker,
    mirrorRoot,
    rgPath: options.rgPath ?? "rg",
    ...(options.rgTimeoutMs === undefined
      ? {}
      : { rgTimeoutMs: options.rgTimeoutMs }),
  });
  return {
    embedding,
    search: (input) =>
      retrieval.search({
        sourceIds: [sourceId],
        ...input,
      }),
  };
}

async function expectRetrievalError(
  promise: Promise<unknown>,
  expected: { code: RetrievalErrorCode; mode: RetrievalMode },
): Promise<void> {
  const error = await promise.then(
    () => {
      throw new Error("expected the search to fail, but it resolved");
    },
    (rejected: unknown) => rejected,
  );
  expect(error).toBeInstanceOf(RetrievalError);
  expect(error).toMatchObject(expected);
}

function failingFetch(status: number): typeof fetch {
  return async () => new Response("upstream unavailable", { status });
}

function invalidRerankShapeFetch(): typeof fetch {
  return async () =>
    new Response(JSON.stringify({ results: [{ index: 0 }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
}

function createRerankerWithFetch(fetchImpl: typeof fetch): Reranker {
  return createOpenAiReranker({
    baseUrl: "http://rerank.invalid",
    apiKey: "test-key",
    model: "test-model",
    fetchImpl,
  });
}

async function createDirectorySymlink(
  target: string,
  linkPath: string,
): Promise<void> {
  await mkdir(path.dirname(linkPath), { recursive: true });
  try {
    await symlink(target, linkPath, "dir");
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code !== "EPERM" && code !== "EACCES" && code !== "UNKNOWN") {
      throw error;
    }
    await symlink(target, linkPath, "junction");
  }
}

beforeAll(async () => {
  database = createDatabase(DATABASE_URL);
  db = database.db;
  await db.execute(sql`select 1`);
  workDirectory = await mkdtemp(path.join(tmpdir(), "borges-retrieval-"));
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

describe("RetrievalSeam", () => {
  it("returns page, time and line anchors with verbatim chunk content in hybrid mode", async () => {
    const corpus = await seedCorpus();

    const pageHits = await corpus.search({
      mode: "hybrid",
      query: PDF_TOKEN,
      topK: 3,
    });
    expect(pageHits[0]?.anchor).toEqual({
      kind: "page",
      pageNumber: 3,
      sectionPath: ["Overview"],
    });
    expect(pageHits[0]?.content).toBe(PDF_TEXT);

    const timeHits = await corpus.search({
      mode: "hybrid",
      query: AUDIO_TOKEN,
      topK: 3,
    });
    expect(timeHits[0]?.anchor).toEqual({
      kind: "time",
      startMs: 9000,
      endMs: 24000,
      speaker: "Nova",
    });
    expect(timeHits[0]?.content).toBe(AUDIO_TEXT);

    const lineHits = await corpus.search({
      mode: "hybrid",
      query: CODE_TOKEN,
      topK: 3,
    });
    expect(lineHits[0]?.anchor).toEqual({
      kind: "line",
      filePath: "code-one.ts",
      startLine: 1,
      endLine: 3,
    });
    expect(lineHits[0]?.content).toBe(CODE_ONE_TEXT);
    expect(lineHits[0]?.content).not.toContain("Document:");
    expect(lineHits[0]?.score).toBe(1);
  });

  it("returns page, time and line anchors in hyperedge mode", async () => {
    const corpus = await seedCorpus();

    const pageHits = await corpus.search({
      mode: "hyperedge",
      query: PDF_TOKEN,
      topK: 4,
    });
    expect(pageHits[0]?.anchor).toEqual({
      kind: "page",
      pageNumber: 3,
      sectionPath: ["Overview"],
    });
    expect(pageHits[0]?.content).toBe(PDF_TEXT);

    const timeHits = await corpus.search({
      mode: "hyperedge",
      query: AUDIO_TOKEN,
      topK: 4,
    });
    expect(timeHits[0]?.anchor).toEqual({
      kind: "time",
      startMs: 9000,
      endMs: 24000,
      speaker: "Nova",
    });
    expect(timeHits[0]?.content).toBe(AUDIO_TEXT);

    const lineHits = await corpus.search({
      mode: "hyperedge",
      query: CODE_TOKEN,
      topK: 4,
    });
    expect(lineHits[0]?.anchor).toEqual({
      kind: "line",
      filePath: "code-one.ts",
      startLine: 1,
      endLine: 3,
    });
  });

  it("maps ripgrep matches back to line anchors in rg mode", async () => {
    const corpus = await seedCorpus();

    const hits = await corpus.search({
      mode: "rg",
      query: CODE_TOKEN,
      topK: 5,
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      content: CODE_ONE_TEXT,
      score: 1,
      anchor: {
        kind: "line",
        filePath: "code-one.ts",
        startLine: 2,
        endLine: 2,
      },
    });
  });

  it("expands a hyperedge seed to a neighbouring document sharing an entity", async () => {
    // Twelve filler documents outrank code-two.ts as seeds, so the only way its
    // chunk can be recalled is the shared-entity expansion in SQL.
    const corpus = await seedCorpus({ fillers: 12 });

    const hits = await corpus.search({
      mode: "hyperedge",
      query: CODE_TOKEN,
      topK: 20,
    });
    const seed = hits.find(
      (hit) =>
        hit.anchor.kind === "line" && hit.anchor.filePath === "code-one.ts",
    );
    const neighbour = hits.find(
      (hit) =>
        hit.anchor.kind === "line" && hit.anchor.filePath === "code-two.ts",
    );

    expect(seed).toMatchObject({ content: CODE_ONE_TEXT });
    expect(neighbour).toMatchObject({
      content: CODE_TWO_TEXT,
      anchor: {
        kind: "line",
        filePath: "code-two.ts",
        startLine: 1,
        endLine: 3,
      },
    });
    expect(neighbour?.documentId).not.toBe(seed?.documentId);
  });

  it("keeps hybrid search working when topK pushes the candidate pool past the hnsw.ef_search ceiling", async () => {
    // topK 300 asks for a pool of 1200 candidates, above the pgvector ceiling.
    const corpus = await seedCorpus();

    const hits = await corpus.search({
      mode: "hybrid",
      query: CODE_TOKEN,
      topK: 300,
    });

    expect(hits.map((hit) => hit.content)).toContain(CODE_ONE_TEXT);
  });

  it("keeps hyperedge search working when topK pushes the candidate pool past the hnsw.ef_search ceiling", async () => {
    const corpus = await seedCorpus();

    const hits = await corpus.search({
      mode: "hyperedge",
      query: CODE_TOKEN,
      topK: 300,
    });

    expect(hits.map((hit) => hit.content)).toContain(CODE_ONE_TEXT);
  });

  it("returns no hits in any mode when tenantId or aclTags do not match", async () => {
    const corpus = await seedCorpus({ aclTags: ["finance"] });

    for (const mode of MODES) {
      expect(
        await corpus.search({
          mode,
          query: CODE_TOKEN,
          topK: 5,
          aclTags: ["finance"],
        }),
      ).not.toHaveLength(0);

      expect(await corpus.search({ mode, query: CODE_TOKEN, topK: 5 })).toEqual(
        [],
      );

      expect(
        await corpus.search({
          mode,
          query: CODE_TOKEN,
          topK: 5,
          aclTags: ["legal"],
        }),
      ).toEqual([]);

      expect(
        await corpus.search({
          mode,
          query: CODE_TOKEN,
          topK: 5,
          tenantId: "other-tenant",
          aclTags: ["finance"],
        }),
      ).toEqual([]);
    }
  });

  it("matches a hybrid query that contains code and log punctuation", async () => {
    const corpus = await seedCorpus();

    const hits = await corpus.search({
      mode: "hybrid",
      query: "orionRetryBudget(): number [0]",
      topK: 5,
    });

    expect(hits.map((hit) => hit.content)).toContain(CODE_ONE_TEXT);
  });

  it("keeps hybrid search working when the query is only query syntax characters", async () => {
    const corpus = await seedCorpus();

    const hits = await corpus.search({ mode: "hybrid", query: "(", topK: 5 });

    expect(hits.every((hit) => hit.score === 0)).toBe(true);
  });

  it("surfaces an embedding failure instead of returning an empty list", async () => {
    const corpus = await seedCorpus();
    corpus.embedding.failure = new Error("stub embedding endpoint is down");

    await expectRetrievalError(
      corpus.search({ mode: "hybrid", query: CODE_TOKEN, topK: 5 }),
      { code: "embedding_failed", mode: "hybrid" },
    );
    await expectRetrievalError(
      corpus.search({ mode: "hyperedge", query: CODE_TOKEN, topK: 5 }),
      { code: "embedding_failed", mode: "hyperedge" },
    );
  });

  it("surfaces a rerank failure instead of returning an empty list", async () => {
    const failing = await seedCorpus({
      reranker: createRerankerWithFetch(failingFetch(503)),
    });
    await expectRetrievalError(
      failing.search({ mode: "hybrid", query: CODE_TOKEN, topK: 5 }),
      { code: "rerank_failed", mode: "hybrid" },
    );

    const malformed = await seedCorpus({
      reranker: createRerankerWithFetch(invalidRerankShapeFetch()),
    });
    await expectRetrievalError(
      malformed.search({ mode: "hyperedge", query: CODE_TOKEN, topK: 5 }),
      { code: "rerank_failed", mode: "hyperedge" },
    );
  });

  it("surfaces a ripgrep pattern failure instead of returning an empty list", async () => {
    const corpus = await seedCorpus();

    await expectRetrievalError(
      corpus.search({ mode: "rg", query: "(", topK: 5 }),
      { code: "rg_invalid_pattern", mode: "rg" },
    );
  });

  it("surfaces a missing ripgrep executable instead of returning an empty list", async () => {
    const corpus = await seedCorpus({ rgPath: "borges-ripgrep-not-installed" });

    await expectRetrievalError(
      corpus.search({ mode: "rg", query: CODE_TOKEN, topK: 5 }),
      { code: "rg_unavailable", mode: "rg" },
    );
  });

  it("surfaces a ripgrep timeout instead of returning an empty list", async () => {
    const corpus = await seedCorpus({ rgTimeoutMs: 1 });

    await expectRetrievalError(
      corpus.search({ mode: "rg", query: CODE_TOKEN, topK: 5 }),
      { code: "rg_timeout", mode: "rg" },
    );
  });

  it("rejects a source id that escapes the mirror root", async () => {
    const corpus = await seedCorpus();

    await expectRetrievalError(
      corpus.search({
        mode: "rg",
        query: CODE_TOKEN,
        topK: 5,
        sourceIds: ["../../etc"],
      }),
      { code: "rg_sandbox_escape", mode: "rg" },
    );
  });

  it("rejects a mirror directory that is a symlink outside the mirror root", async () => {
    const sourceId = await createSource(false);
    const outside = await mkdtemp(path.join(workDirectory, "outside-"));
    await writeCaseFile(
      outside,
      "escape.ts",
      `const escape = "${CODE_TOKEN}";`,
    );
    await createDirectorySymlink(outside, path.join(mirrorRoot, sourceId));

    const retrieval = createRetrievalService({
      db,
      embeddingProvider: new TokenEmbeddingProvider(),
      reranker: new OverlapReranker(),
      mirrorRoot,
    });

    await expectRetrievalError(
      retrieval.search({
        mode: "rg",
        query: CODE_TOKEN,
        sourceIds: [sourceId],
        topK: 5,
      }),
      { code: "rg_sandbox_escape", mode: "rg" },
    );
  });

  it("returns no hits when the source has no mirror directory", async () => {
    const corpus = await seedCorpus({ includeCode: false });

    expect(
      await corpus.search({ mode: "rg", query: PDF_TOKEN, topK: 5 }),
    ).toEqual([]);
  });
});
