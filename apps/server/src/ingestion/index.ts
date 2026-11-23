import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import path from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { EvidenceIR } from "../contracts/evidence-ir.js";
import {
  type DocumentIndexer,
  type PreparedIndex,
  createDefaultDocumentIndexer,
} from "../indexing/index.js";
import type { DbClient, DbTransaction } from "../storage/db.js";
import {
  events,
  chunks,
  documents,
  ingestionJobs,
  sources,
} from "../storage/schema.js";
import {
  DIRECT_TEXT_PARSER_ENGINE,
  type SourceFormat,
  readDirectTextEvidence,
  resolveSourceFormat,
} from "./directText.js";
import { IngestionFailure, toIngestionFailure } from "./failures.js";
import {
  defaultMirrorRoot,
  deleteMirrorFile,
  validateMirrorPath,
  writeMirrorFile,
} from "./mirror.js";
import {
  type ParserWorker,
  createDefaultParserWorkerClient,
} from "./parserWorker.js";

export type IngestionJobStatus =
  | "PENDING"
  | "PARSING"
  | "INDEXING"
  | "READY"
  | "FAILED";

export interface SubmitDocumentInput {
  sourceId: string;
  filePath: string;
  title?: string;
  tenantId?: string;
  aclTags?: string[];
}

export interface IngestionJobView {
  jobId: string;
  documentId: string | null;
  sourceId: string;
  status: IngestionJobStatus;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface IngestionSeam {
  submitDocument(input: SubmitDocumentInput): Promise<IngestionJobView>;
  getJob(jobId: string): Promise<IngestionJobView | null>;
  deleteDocument(documentId: string): Promise<void>;
}

export interface IngestionDependencies {
  db: DbClient;
  parser?: ParserWorker;
  indexer?: DocumentIndexer;
  mirrorRoot?: string;
}

type QueryExecutor = DbClient | DbTransaction;

interface PersistVersionResult {
  newDocumentId: string;
  previousDocumentId: string | null;
  createdNewDocument: boolean;
}

const JOB_TRANSITIONS: Record<
  IngestionJobStatus,
  readonly IngestionJobStatus[]
> = {
  PENDING: ["PARSING", "FAILED"],
  PARSING: ["INDEXING", "READY", "FAILED"],
  INDEXING: ["READY", "FAILED"],
  READY: [],
  FAILED: [],
};

const MAX_ERROR_MESSAGE_LENGTH = 2000;

export function createIngestionService(
  dependencies: IngestionDependencies,
): IngestionSeam {
  const { db } = dependencies;
  const parser = dependencies.parser ?? createDefaultParserWorkerClient();
  const indexer = dependencies.indexer ?? createDefaultDocumentIndexer();
  const mirrorRoot = dependencies.mirrorRoot ?? defaultMirrorRoot();

  async function submitDocument(
    input: SubmitDocumentInput,
  ): Promise<IngestionJobView> {
    const [source] = await db
      .select({
        tenantId: sources.tenantId,
        acl: sources.acl,
        extractHyperedge: sources.extractHyperedge,
      })
      .from(sources)
      .where(eq(sources.id, input.sourceId))
      .limit(1);
    if (!source) {
      throw new Error(`source not found: ${input.sourceId}`);
    }
    const title = input.title ?? path.basename(input.filePath);
    const tenantId = input.tenantId ?? source.tenantId;
    const aclTags = input.aclTags ?? source.acl;
    const [createdJob] = await db
      .insert(ingestionJobs)
      .values({
        sourceId: input.sourceId,
        tenantId,
        acl: aclTags,
        status: "PENDING",
      })
      .returning({ id: ingestionJobs.id });
    if (!createdJob) {
      throw new Error("failed to create ingestion job");
    }
    const jobId = createdJob.id;
    let mirrorText: string | null = null;
    let persisted: PersistVersionResult | null = null;
    try {
      await setJobStatus(db, jobId, "PARSING");
      const contentHash = await sha256File(input.filePath);
      const reusableDocumentId = await findActiveDocumentByHash(
        db,
        input.sourceId,
        contentHash,
      );
      if (reusableDocumentId) {
        await markJobReady(db, jobId, reusableDocumentId);
        return await requireJob(jobId);
      }
      const format = resolveSourceFormat(input.filePath);
      const parsed = await parseEvidence(
        format,
        input.filePath,
        title,
        contentHash,
      );
      await setJobStatus(db, jobId, "INDEXING");
      const evidence = withDocumentIdentity(
        parsed.evidence,
        title,
        contentHash,
      );
      if (parsed.mirrorText !== null) {
        validateMirrorPath({
          mirrorRoot,
          sourceId: input.sourceId,
          relativePath: title,
        });
      }
      const prepared = await indexer.prepare({
        sourceId: input.sourceId,
        tenantId,
        aclTags,
        evidence,
        extractHyperedge: source.extractHyperedge,
      });
      mirrorText = parsed.mirrorText;
      persisted = await persistVersion({
        sourceId: input.sourceId,
        tenantId,
        aclTags,
        title,
        contentHash,
        mediaType: evidence.documentMeta.mediaType,
        parserEngine: evidence.documentMeta.parserEngine,
        prepared,
      });
      if (mirrorText !== null) {
        await writeMirrorFile({
          mirrorRoot,
          sourceId: input.sourceId,
          relativePath: title,
          content: mirrorText,
        });
      }
    } catch (error) {
      const failure = toIngestionFailure(error);
      if (persisted) {
        await compensateFailedVersion(jobId, persisted, failure);
      } else {
        await markJobFailed(db, jobId, failure);
      }
      return await requireJob(jobId);
    }
    if (!persisted) {
      throw new Error("indexing did not produce a document");
    }
    await markJobReady(db, jobId, persisted.newDocumentId);
    return await requireJob(jobId);
  }

  async function getJob(jobId: string): Promise<IngestionJobView | null> {
    return readJob(db, jobId);
  }

  async function deleteDocument(documentId: string): Promise<void> {
    const [document] = await db
      .select({
        sourceId: documents.sourceId,
        title: documents.title,
        parserEngine: documents.parserEngine,
      })
      .from(documents)
      .where(eq(documents.id, documentId))
      .limit(1);
    if (!document) {
      return;
    }
    if (document.parserEngine === DIRECT_TEXT_PARSER_ENGINE) {
      await deleteMirrorFile({
        mirrorRoot,
        sourceId: document.sourceId,
        relativePath: document.title,
      });
    }
    await db.delete(documents).where(eq(documents.id, documentId));
  }

  async function parseEvidence(
    format: SourceFormat,
    filePath: string,
    title: string,
    contentHash: string,
  ): Promise<{ evidence: EvidenceIR; mirrorText: string | null }> {
    if (format.kind === "unsupported") {
      throw new IngestionFailure(
        "unsupported_format",
        `unsupported file type: ${path.extname(filePath) || filePath}`,
      );
    }
    if (format.kind === "parser") {
      return { evidence: await parser.parse(filePath), mirrorText: null };
    }
    const evidence = await readDirectTextEvidence({
      filePath,
      title,
      contentHash,
      mediaType: format.mediaType,
    });
    return { evidence, mirrorText: evidence.segments[0]?.text ?? null };
  }

  async function compensateFailedVersion(
    jobId: string,
    persisted: PersistVersionResult,
    failure: IngestionFailure,
  ): Promise<void> {
    await db.transaction(async (tx) => {
      if (persisted.createdNewDocument) {
        await tx
          .delete(documents)
          .where(eq(documents.id, persisted.newDocumentId));
      }
      if (persisted.previousDocumentId) {
        const previousDocumentId = persisted.previousDocumentId;
        await tx
          .update(documents)
          .set({ isActive: true })
          .where(eq(documents.id, previousDocumentId));
        await tx
          .update(chunks)
          .set({ isActive: true })
          .where(eq(chunks.documentId, previousDocumentId));
        await tx
          .update(events)
          .set({ isActive: true })
          .where(eq(events.documentId, previousDocumentId));
      }
      await markJobFailed(tx, jobId, failure);
    });
  }

  async function persistVersion(input: {
    sourceId: string;
    tenantId: string;
    aclTags: string[];
    title: string;
    contentHash: string;
    mediaType: string;
    parserEngine: string;
    prepared: PreparedIndex;
  }): Promise<PersistVersionResult> {
    return await db.transaction(async (tx) => {
      await tx.execute(
        sql`select id from sources where id = ${input.sourceId} for update`,
      );
      const concurrentDocumentId = await findActiveDocumentByHash(
        tx,
        input.sourceId,
        input.contentHash,
      );
      if (concurrentDocumentId) {
        return {
          newDocumentId: concurrentDocumentId,
          previousDocumentId: null,
          createdNewDocument: false,
        };
      }
      const sameTitleDocuments = await tx
        .select({
          id: documents.id,
          version: documents.version,
          isActive: documents.isActive,
        })
        .from(documents)
        .where(
          and(
            eq(documents.sourceId, input.sourceId),
            eq(documents.title, input.title),
          ),
        );
      const activeDocumentIds = sameTitleDocuments
        .filter((document) => document.isActive)
        .map((document) => document.id);
      const previousDocumentId = activeDocumentIds[0] ?? null;
      const nextVersion =
        sameTitleDocuments.reduce(
          (highest, document) => Math.max(highest, document.version),
          0,
        ) + 1;
      if (activeDocumentIds.length > 0) {
        await tx
          .update(documents)
          .set({ isActive: false })
          .where(inArray(documents.id, activeDocumentIds));
        await tx
          .update(chunks)
          .set({ isActive: false })
          .where(inArray(chunks.documentId, activeDocumentIds));
        await tx
          .update(events)
          .set({ isActive: false })
          .where(inArray(events.documentId, activeDocumentIds));
      }
      const [document] = await tx
        .insert(documents)
        .values({
          sourceId: input.sourceId,
          tenantId: input.tenantId,
          acl: input.aclTags,
          title: input.title,
          mediaType: input.mediaType,
          contentHash: input.contentHash,
          version: nextVersion,
          isActive: true,
          parserEngine: input.parserEngine,
        })
        .returning({ id: documents.id });
      if (!document) {
        throw new Error("failed to insert document");
      }
      await indexer.persist(tx, {
        documentId: document.id,
        sourceId: input.sourceId,
        tenantId: input.tenantId,
        aclTags: input.aclTags,
        prepared: input.prepared,
      });
      return {
        newDocumentId: document.id,
        previousDocumentId,
        createdNewDocument: true,
      };
    });
  }

  async function requireJob(jobId: string): Promise<IngestionJobView> {
    const job = await readJob(db, jobId);
    if (!job) {
      throw new Error(`ingestion job not found: ${jobId}`);
    }
    return job;
  }

  return { submitDocument, getJob, deleteDocument };
}

async function readJob(
  executor: QueryExecutor,
  jobId: string,
): Promise<IngestionJobView | null> {
  const [job] = await executor
    .select({
      id: ingestionJobs.id,
      documentId: ingestionJobs.documentId,
      sourceId: ingestionJobs.sourceId,
      status: ingestionJobs.status,
      errorCode: ingestionJobs.errorCode,
      errorMessage: ingestionJobs.errorMessage,
    })
    .from(ingestionJobs)
    .where(eq(ingestionJobs.id, jobId))
    .limit(1);
  if (!job) {
    return null;
  }
  return {
    jobId: job.id,
    documentId: job.documentId,
    sourceId: job.sourceId,
    status: job.status,
    errorCode: job.errorCode,
    errorMessage: job.errorMessage,
  };
}

async function findActiveDocumentByHash(
  executor: QueryExecutor,
  sourceId: string,
  contentHash: string,
): Promise<string | null> {
  const [document] = await executor
    .select({ id: documents.id })
    .from(documents)
    .where(
      and(
        eq(documents.sourceId, sourceId),
        eq(documents.contentHash, contentHash),
        eq(documents.isActive, true),
      ),
    )
    .limit(1);
  return document?.id ?? null;
}

async function setJobStatus(
  executor: QueryExecutor,
  jobId: string,
  next: IngestionJobStatus,
): Promise<void> {
  const current = await readJobStatus(executor, jobId);
  assertTransition(current, next);
  await executor
    .update(ingestionJobs)
    .set({ status: next, updatedAt: new Date() })
    .where(eq(ingestionJobs.id, jobId));
}

async function markJobReady(
  executor: QueryExecutor,
  jobId: string,
  documentId: string,
): Promise<void> {
  const current = await readJobStatus(executor, jobId);
  assertTransition(current, "READY");
  await executor
    .update(ingestionJobs)
    .set({
      status: "READY",
      documentId,
      errorCode: null,
      errorMessage: null,
      updatedAt: new Date(),
    })
    .where(eq(ingestionJobs.id, jobId));
}

async function markJobFailed(
  executor: QueryExecutor,
  jobId: string,
  failure: IngestionFailure,
): Promise<void> {
  const current = await readJobStatus(executor, jobId);
  if (current === "READY" || current === "FAILED") {
    return;
  }
  await executor
    .update(ingestionJobs)
    .set({
      status: "FAILED",
      errorCode: failure.code,
      errorMessage: failure.message.slice(0, MAX_ERROR_MESSAGE_LENGTH),
      updatedAt: new Date(),
    })
    .where(eq(ingestionJobs.id, jobId));
}

async function readJobStatus(
  executor: QueryExecutor,
  jobId: string,
): Promise<IngestionJobStatus> {
  const [job] = await executor
    .select({ status: ingestionJobs.status })
    .from(ingestionJobs)
    .where(eq(ingestionJobs.id, jobId))
    .limit(1);
  if (!job) {
    throw new Error(`ingestion job not found: ${jobId}`);
  }
  return job.status;
}

function assertTransition(
  current: IngestionJobStatus,
  next: IngestionJobStatus,
): void {
  if (!JOB_TRANSITIONS[current].includes(next)) {
    throw new Error(`illegal ingestion job transition: ${current} -> ${next}`);
  }
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function withDocumentIdentity(
  evidence: EvidenceIR,
  title: string,
  contentHash: string,
): EvidenceIR {
  return {
    documentMeta: { ...evidence.documentMeta, title, contentHash },
    segments: evidence.segments,
  };
}

export type { ParserWorker } from "./parserWorker.js";
