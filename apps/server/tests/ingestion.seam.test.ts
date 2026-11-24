import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { EvidenceIR } from "../src/contracts/evidence-ir.js";
import {
  type DocumentIndexer,
  type EmbeddingProvider,
  type HyperedgeExtraction,
  type HyperedgeExtractionInput,
  type HyperedgeExtractor,
  createDocumentIndexer,
} from "../src/indexing/index.js";
import {
  type IngestionSeam,
  type ParserWorker,
  createIngestionService,
} from "../src/ingestion/index.js";
import {
  type Database,
  type DbClient,
  createDatabase,
} from "../src/storage/db.js";
import {
  events,
  chunks,
  documents,
  entities,
  eventEntities,
  sources,
} from "../src/storage/schema.js";

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://borges:borges@127.0.0.1:5432/borges";

let database: Database;
let db: DbClient;
let workDirectory: string;
let mirrorRoot: string;
const createdSourceIds: string[] = [];
const createdDirectories: string[] = [];

class CountingEmbeddingProvider implements EmbeddingProvider {
  calls = 0;
  texts: string[] = [];

  async embed(texts: string[]): Promise<number[][]> {
    this.calls += 1;
    this.texts.push(...texts);
    return texts.map((text) => {
      const digest = createHash("sha256").update(text).digest();
      const vector = new Array<number>(1536).fill(0);
      for (let index = 0; index < 8; index += 1) {
        vector[index] = (digest[index] ?? 0) / 255 + 0.001;
      }
      return vector;
    });
  }
}

class RecordingExtractor implements HyperedgeExtractor {
  calls: string[] = [];

  async extract(input: HyperedgeExtractionInput): Promise<HyperedgeExtraction> {
    this.calls.push(input.content);
    const excerpt = input.content.slice(0, 20);
    return {
      events: [
        {
          summary: `event one for ${excerpt}`,
          entityNames: ["Acme Corp"],
        },
        {
          summary: `event two for ${excerpt}`,
          entityNames: ["Acme Corp", "Revenue"],
        },
      ],
      entities: [
        { name: "Acme Corp", entityType: "organization" },
        { name: "Revenue", entityType: "metric" },
      ],
    };
  }
}

class RejectingParser implements ParserWorker {
  calls: string[] = [];

  async parse(filePath: string): Promise<EvidenceIR> {
    this.calls.push(filePath);
    throw Object.assign(new Error("stub parser rejected the file"), {
      code: "corrupted_file",
    });
  }
}

interface ServiceOverrides {
  embedding?: EmbeddingProvider;
  extractor?: HyperedgeExtractor;
  parser?: ParserWorker;
  indexer?: DocumentIndexer;
  mirrorRoot?: string;
}

function createService(overrides: ServiceOverrides = {}): IngestionSeam {
  const indexer =
    overrides.indexer ??
    createDocumentIndexer({
      embeddingProvider: overrides.embedding ?? new CountingEmbeddingProvider(),
      hyperedgeExtractor: overrides.extractor ?? new RecordingExtractor(),
      chunker: { maxChars: 600 },
    });
  return createIngestionService({
    db,
    mirrorRoot: overrides.mirrorRoot ?? mirrorRoot,
    parser: overrides.parser ?? new RejectingParser(),
    indexer,
  });
}

async function createSource(extractHyperedge = false): Promise<string> {
  const sourceId = randomUUID();
  await db.insert(sources).values({
    id: sourceId,
    name: `test-${sourceId}`,
    extractHyperedge,
  });
  createdSourceIds.push(sourceId);
  return sourceId;
}

async function createCaseDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(workDirectory, "case-"));
  createdDirectories.push(directory);
  return directory;
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

async function countChunks(documentId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(chunks)
    .where(eq(chunks.documentId, documentId));
  return row?.count ?? 0;
}

async function countEvents(documentId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(events)
    .where(eq(events.documentId, documentId));
  return row?.count ?? 0;
}

async function countDocuments(sourceId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(documents)
    .where(eq(documents.sourceId, sourceId));
  return row?.count ?? 0;
}

async function countEntities(sourceId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(entities)
    .where(eq(entities.sourceId, sourceId));
  return row?.count ?? 0;
}

async function countEventEntities(sourceId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(eventEntities)
    .innerJoin(events, eq(eventEntities.eventId, events.id))
    .where(eq(events.sourceId, sourceId));
  return row?.count ?? 0;
}

async function bm25ActiveChunkCount(
  sourceId: string,
  term: string,
): Promise<number> {
  const result = await db.execute(
    sql`select count(*)::int as count from chunks where search_text @@@ ${term} and is_active = true and source_id = ${sourceId}`,
  );
  const row = (result.rows as { count: number }[])[0];
  return row?.count ?? 0;
}

function requireDocumentId(
  documentId: string | null,
): asserts documentId is string {
  if (!documentId) {
    throw new Error("expected a document id");
  }
}

beforeAll(async () => {
  database = createDatabase(DATABASE_URL);
  db = database.db;
  await db.execute(sql`select 1`);
  workDirectory = await mkdtemp(path.join(tmpdir(), "borges-ingestion-"));
  mirrorRoot = path.join(workDirectory, "mirror");
});

afterEach(async () => {
  for (const sourceId of createdSourceIds.splice(0)) {
    await db.delete(sources).where(eq(sources.id, sourceId));
  }
  for (const directory of createdDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

afterAll(async () => {
  await database.close();
  await rm(workDirectory, { recursive: true, force: true });
});

describe("IngestionSeam", () => {
  it("reuses the active document when the same content is submitted twice", async () => {
    const sourceId = await createSource(false);
    const directory = await createCaseDirectory();
    const filePath = await writeCaseFile(
      directory,
      "notes.md",
      "# Idempotent\n\nalpha paragraph with idempotenttoken\n",
    );
    const embedding = new CountingEmbeddingProvider();
    const service = createService({ embedding });

    const first = await service.submitDocument({ sourceId, filePath });
    expect(first.status).toBe("READY");
    requireDocumentId(first.documentId);
    const firstChunkCount = await countChunks(first.documentId);
    expect(firstChunkCount).toBeGreaterThan(0);
    const embeddingCallsAfterFirst = embedding.calls;

    const second = await service.submitDocument({ sourceId, filePath });
    expect(second.status).toBe("READY");
    expect(second.jobId).not.toBe(first.jobId);
    expect(second.documentId).toBe(first.documentId);
    expect(embedding.calls).toBe(embeddingCallsAfterFirst);
    expect(await countDocuments(sourceId)).toBe(1);
    expect(await countChunks(first.documentId)).toBe(firstChunkCount);

    const persisted = await service.getJob(second.jobId);
    expect(persisted?.status).toBe("READY");
    expect(persisted?.documentId).toBe(first.documentId);
  });

  it("atomically replaces same-title versions and hides old chunks and events from active BM25", async () => {
    const sourceId = await createSource(true);
    const directory = await createCaseDirectory();
    const filePath = path.join(directory, "report.md");
    await writeFile(
      filePath,
      "# Legacy\n\nlegacyonlytoken appears in the first version.",
      "utf8",
    );
    const service = createService();

    const first = await service.submitDocument({ sourceId, filePath });
    expect(first.status).toBe("READY");
    requireDocumentId(first.documentId);

    await writeFile(
      filePath,
      "# Fresh\n\nfreshonlytoken appears in the second version.",
      "utf8",
    );
    const second = await service.submitDocument({ sourceId, filePath });
    expect(second.status).toBe("READY");
    requireDocumentId(second.documentId);
    expect(second.documentId).not.toBe(first.documentId);

    const versionRows = await db
      .select({
        id: documents.id,
        version: documents.version,
        isActive: documents.isActive,
      })
      .from(documents)
      .where(eq(documents.sourceId, sourceId));
    expect(
      versionRows.find((row) => row.id === first.documentId),
    ).toMatchObject({ version: 1, isActive: false });
    expect(
      versionRows.find((row) => row.id === second.documentId),
    ).toMatchObject({ version: 2, isActive: true });

    const oldChunks = await db
      .select({ isActive: chunks.isActive })
      .from(chunks)
      .where(eq(chunks.documentId, first.documentId));
    expect(oldChunks.length).toBeGreaterThan(0);
    expect(oldChunks.every((chunk) => chunk.isActive === false)).toBe(true);

    const newChunks = await db
      .select({ isActive: chunks.isActive })
      .from(chunks)
      .where(eq(chunks.documentId, second.documentId));
    expect(newChunks.length).toBeGreaterThan(0);
    expect(newChunks.every((chunk) => chunk.isActive)).toBe(true);

    const oldEvents = await db
      .select({ isActive: events.isActive })
      .from(events)
      .where(eq(events.documentId, first.documentId));
    expect(oldEvents.length).toBeGreaterThan(0);
    expect(oldEvents.every((event) => event.isActive === false)).toBe(true);
    expect(await countEvents(second.documentId)).toBeGreaterThan(0);
    expect(await countEventEntities(sourceId)).toBeGreaterThan(0);

    const entityNames = await db
      .select({ name: entities.name })
      .from(entities)
      .where(eq(entities.sourceId, sourceId));
    expect(entityNames.map((entity) => entity.name).sort()).toEqual([
      "Acme Corp",
      "Revenue",
    ]);

    expect(await bm25ActiveChunkCount(sourceId, "legacyonlytoken")).toBe(0);
    expect(
      await bm25ActiveChunkCount(sourceId, "freshonlytoken"),
    ).toBeGreaterThan(0);
  });

  it("leaves the previous mirror untouched when a same-title update fails to persist", async () => {
    const sourceId = await createSource(false);
    const directory = await createCaseDirectory();
    const filePath = path.join(directory, "versioned.md");
    const v1Content = "# Mirror v1\n\nfirstversiontoken";
    await writeFile(filePath, v1Content, "utf8");
    const baseIndexer = createDocumentIndexer({
      embeddingProvider: new CountingEmbeddingProvider(),
      hyperedgeExtractor: new RecordingExtractor(),
      chunker: { maxChars: 600 },
    });
    const service = createService({ indexer: baseIndexer });

    const first = await service.submitDocument({ sourceId, filePath });
    expect(first.status).toBe("READY");
    requireDocumentId(first.documentId);
    const mirrorPath = path.join(mirrorRoot, sourceId, "versioned.md");
    expect(await readFile(mirrorPath, "utf8")).toBe(v1Content);

    const v2Content = "# Mirror v2\n\nsecondversiontoken";
    await writeFile(filePath, v2Content, "utf8");
    const failingService = createService({
      indexer: {
        prepare: (input) => baseIndexer.prepare(input),
        persist: async () => {
          throw new Error("stub persist failure");
        },
      },
    });
    const failed = await failingService.submitDocument({ sourceId, filePath });

    expect(failed.status).toBe("FAILED");
    expect(failed.errorCode).toBe("ingestion_failed");
    const activeDocuments = await db
      .select({
        id: documents.id,
        version: documents.version,
        isActive: documents.isActive,
      })
      .from(documents)
      .where(
        and(eq(documents.sourceId, sourceId), eq(documents.isActive, true)),
      );
    expect(activeDocuments).toEqual([
      { id: first.documentId, version: 1, isActive: true },
    ]);
    expect(await countDocuments(sourceId)).toBe(1);
    expect(await readFile(mirrorPath, "utf8")).toBe(v1Content);
  });

  it("fails without throwing when the mirror root is not a directory", async () => {
    const sourceId = await createSource(true);
    const directory = await createCaseDirectory();
    const filePath = path.join(directory, "mirror-target.md");
    const v1Content = "# Mirror target\n\nmirrorfirsttoken";
    await writeFile(filePath, v1Content, "utf8");
    const brokenRoot = path.join(directory, "mirror-root-file");
    await writeFile(brokenRoot, "not a directory", "utf8");

    const initialFailure = await createService({
      mirrorRoot: brokenRoot,
    }).submitDocument({ sourceId, filePath });
    expect(initialFailure.status).toBe("FAILED");
    expect(initialFailure.documentId).toBeNull();
    expect(initialFailure.errorCode).toBeTruthy();
    expect(await countDocuments(sourceId)).toBe(0);

    const first = await createService().submitDocument({ sourceId, filePath });
    expect(first.status).toBe("READY");
    requireDocumentId(first.documentId);

    const v2Content = "# Mirror target\n\nmirrorsecondtoken";
    await writeFile(filePath, v2Content, "utf8");
    const updateFailure = await createService({
      mirrorRoot: brokenRoot,
    }).submitDocument({ sourceId, filePath });
    expect(updateFailure.status).toBe("FAILED");
    expect(updateFailure.documentId).toBeNull();
    expect(updateFailure.errorCode).toBeTruthy();

    const activeDocuments = await db
      .select({
        id: documents.id,
        version: documents.version,
        isActive: documents.isActive,
      })
      .from(documents)
      .where(
        and(eq(documents.sourceId, sourceId), eq(documents.isActive, true)),
      );
    expect(activeDocuments).toEqual([
      { id: first.documentId, version: 1, isActive: true },
    ]);
    expect(await countDocuments(sourceId)).toBe(1);
    const activeChunks = await db
      .select({ isActive: chunks.isActive })
      .from(chunks)
      .where(eq(chunks.documentId, first.documentId));
    expect(activeChunks.length).toBeGreaterThan(0);
    expect(activeChunks.every((chunk) => chunk.isActive)).toBe(true);
    const activeEvents = await db
      .select({ isActive: events.isActive })
      .from(events)
      .where(eq(events.documentId, first.documentId));
    expect(activeEvents.length).toBeGreaterThan(0);
    expect(activeEvents.every((event) => event.isActive)).toBe(true);
    expect(
      await readFile(
        path.join(mirrorRoot, sourceId, "mirror-target.md"),
        "utf8",
      ),
    ).toBe(v1Content);
  });

  it("rejects a title longer than the mirror path segment limit", async () => {
    const sourceId = await createSource(false);
    const directory = await createCaseDirectory();
    const filePath = await writeCaseFile(
      directory,
      "long-title.md",
      "# Long title\n\ninvalidtitletoken",
    );

    const job = await createService().submitDocument({
      sourceId,
      filePath,
      title: "a".repeat(300),
    });

    expect(job.status).toBe("FAILED");
    expect(job.errorCode).toBe("invalid_title");
    expect(await countDocuments(sourceId)).toBe(0);
  });

  it("isolates a broken file failure from a healthy file in the same batch", async () => {
    const sourceId = await createSource(false);
    const directory = await createCaseDirectory();
    const brokenPath = path.join(directory, "broken.pdf");
    await writeFile(brokenPath, "%PDF-1.4 broken", "utf8");
    const healthyPath = await writeCaseFile(
      directory,
      "healthy.md",
      "# Healthy\n\nhealthyonlytoken is indexed.",
    );
    const parser = new RejectingParser();
    const service = createService({ parser });

    const [brokenJob, healthyJob] = await Promise.all([
      service.submitDocument({ sourceId, filePath: brokenPath }),
      service.submitDocument({ sourceId, filePath: healthyPath }),
    ]);

    expect(brokenJob.status).toBe("FAILED");
    expect(brokenJob.documentId).toBeNull();
    expect(brokenJob.errorCode).toBe("corrupted_file");
    expect(healthyJob.status).toBe("READY");
    expect(healthyJob.errorCode).toBeNull();
    expect(parser.calls).toEqual([brokenPath]);

    const persistedBroken = await service.getJob(brokenJob.jobId);
    expect(persistedBroken?.status).toBe("FAILED");
    expect(persistedBroken?.errorCode).toBeTruthy();
    expect(persistedBroken?.errorMessage).toBeTruthy();

    requireDocumentId(healthyJob.documentId);
    expect(await countChunks(healthyJob.documentId)).toBeGreaterThan(0);
  });

  it("does not call the hyperedge extractor when extraction is disabled", async () => {
    const sourceId = await createSource(false);
    const directory = await createCaseDirectory();
    const filePath = await writeCaseFile(
      directory,
      "plain.md",
      "# Plain\n\nplain content without hyperedges.",
    );
    const extractor = new RecordingExtractor();
    const service = createService({ extractor });

    const job = await service.submitDocument({ sourceId, filePath });

    expect(job.status).toBe("READY");
    requireDocumentId(job.documentId);
    expect(extractor.calls).toHaveLength(0);
    expect(await countEvents(job.documentId)).toBe(0);
    expect(await countEntities(sourceId)).toBe(0);
    expect(await countEventEntities(sourceId)).toBe(0);
  });

  it("lists sources with the same tenant and acl filtering rules as retrieval", async () => {
    const publicSourceId = await createSource(false);
    const financeSourceId = randomUUID();
    const legalSourceId = randomUUID();
    const otherTenantSourceId = randomUUID();
    await db.insert(sources).values([
      {
        id: financeSourceId,
        name: "finance",
        tenantId: "acme",
        acl: ["finance"],
      },
      {
        id: legalSourceId,
        name: "legal",
        tenantId: "acme",
        acl: ["legal"],
      },
      {
        id: otherTenantSourceId,
        name: "other",
        tenantId: "other",
        acl: ["finance"],
      },
    ]);
    createdSourceIds.push(financeSourceId, legalSourceId, otherTenantSourceId);
    const service = createService();
    const created = new Set([
      publicSourceId,
      financeSourceId,
      legalSourceId,
      otherTenantSourceId,
    ]);
    const visibleIds = async (filter?: {
      tenantId?: string;
      aclTags?: string[];
    }) =>
      (await service.listSources(filter))
        .map((source) => source.sourceId)
        .filter((sourceId) => created.has(sourceId))
        .sort();

    expect(await visibleIds()).toEqual([publicSourceId]);
    expect(
      await visibleIds({ tenantId: "acme", aclTags: ["finance"] }),
    ).toEqual([financeSourceId]);
    // An empty tag list keeps retrieval's public-only rule: acl-protected
    // sources stay hidden until the caller presents a matching tag.
    expect(await visibleIds({ tenantId: "acme" })).toEqual([]);
    expect(
      await visibleIds({ tenantId: "other", aclTags: ["finance"] }),
    ).toEqual([otherTenantSourceId]);
    expect(await visibleIds({ tenantId: "missing" })).toEqual([]);

    const [finance] = await service.listSources({
      tenantId: "acme",
      aclTags: ["finance"],
    });
    expect(finance).toMatchObject({
      sourceId: financeSourceId,
      name: "finance",
      tenantId: "acme",
      aclTags: ["finance"],
      extractHyperedge: false,
    });
    expect(Number.isNaN(Date.parse(finance?.createdAt ?? ""))).toBe(false);
  });

  it("deletes database rows and the sandbox mirror file", async () => {
    const sourceId = await createSource(false);
    const directory = await createCaseDirectory();
    const content = "# Delete me\n\ndeleteme content";
    const filePath = await writeCaseFile(directory, "delete-me.md", content);
    const service = createService();

    const job = await service.submitDocument({ sourceId, filePath });
    expect(job.status).toBe("READY");
    requireDocumentId(job.documentId);

    const mirrorPath = path.join(mirrorRoot, sourceId, "delete-me.md");
    expect(await readFile(mirrorPath, "utf8")).toBe(content);

    await service.deleteDocument(job.documentId);

    expect(await countDocuments(sourceId)).toBe(0);
    expect(await countChunks(job.documentId)).toBe(0);
    expect(existsSync(mirrorPath)).toBe(false);
  });

  it("rejects a mirror path that escapes the source directory", async () => {
    const sourceId = await createSource(false);
    const directory = await createCaseDirectory();
    const filePath = await writeCaseFile(
      directory,
      "escape.md",
      "# Escape\n\nescape content",
    );
    const service = createService();

    const job = await service.submitDocument({
      sourceId,
      filePath,
      title: "../escape.md",
    });

    expect(job.status).toBe("FAILED");
    expect(job.errorCode).toBe("mirror_path_escape");
    expect(await countDocuments(sourceId)).toBe(0);
    expect(existsSync(path.join(mirrorRoot, "escape.md"))).toBe(false);
  });
});
