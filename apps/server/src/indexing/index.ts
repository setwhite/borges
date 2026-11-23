import type { Anchor, EvidenceIR } from "../contracts/evidence-ir.js";
import type { DbTransaction } from "../storage/db.js";
import { events, chunks, entities, eventEntities } from "../storage/schema.js";
import { type ChunkerOptions, chunkEvidence } from "./chunker.js";
import {
  type EmbeddingProvider,
  type HyperedgeExtractor,
  createDefaultEmbeddingProvider,
  createDefaultHyperedgeExtractor,
} from "./providers.js";

export interface PrepareIndexInput {
  sourceId: string;
  tenantId: string;
  aclTags: string[];
  evidence: EvidenceIR;
  extractHyperedge: boolean;
}

export interface PreparedChunk {
  seq: number;
  content: string;
  contextHeader: string;
  searchText: string;
  anchor: Anchor;
  embedding: number[];
}

export interface PreparedEvent {
  chunkSeq: number;
  summary: string;
  embedding: number[];
  entityNames: string[];
}

export interface PreparedEntity {
  name: string;
  entityType: string;
}

export interface PreparedIndex {
  chunks: PreparedChunk[];
  events: PreparedEvent[];
  entities: PreparedEntity[];
}

export interface PersistIndexInput {
  documentId: string;
  sourceId: string;
  tenantId: string;
  aclTags: string[];
  prepared: PreparedIndex;
}

export interface IndexingResult {
  chunkCount: number;
  eventCount: number;
}

export interface DocumentIndexer {
  prepare(input: PrepareIndexInput): Promise<PreparedIndex>;
  persist(tx: DbTransaction, input: PersistIndexInput): Promise<IndexingResult>;
}

export interface IndexingDependencies {
  embeddingProvider: EmbeddingProvider;
  hyperedgeExtractor?: HyperedgeExtractor;
  chunker?: Partial<ChunkerOptions>;
}

const EMBEDDING_BATCH_SIZE = 64;

export function createDocumentIndexer(
  deps: IndexingDependencies,
): DocumentIndexer {
  return {
    prepare: (input) => prepareIndex(deps, input),
    persist: (tx, input) => persistIndex(tx, input),
  };
}

export function createDefaultDocumentIndexer(
  env: NodeJS.ProcessEnv = process.env,
): DocumentIndexer {
  return createDocumentIndexer({
    embeddingProvider: createDefaultEmbeddingProvider(env),
  });
}

async function prepareIndex(
  deps: IndexingDependencies,
  input: PrepareIndexInput,
): Promise<PreparedIndex> {
  const drafts = chunkEvidence(input.evidence, deps.chunker);
  const chunkEmbeddings = await embedInBatches(
    deps.embeddingProvider,
    drafts.map((draft) => draft.searchText),
  );
  const preparedChunks: PreparedChunk[] = drafts.map((draft, index) => ({
    ...draft,
    embedding: requireEmbedding(chunkEmbeddings, index),
  }));
  if (!input.extractHyperedge) {
    return { chunks: preparedChunks, events: [], entities: [] };
  }
  const extractor =
    deps.hyperedgeExtractor ?? createDefaultHyperedgeExtractor();
  const extractions = await Promise.all(
    preparedChunks.map(async (chunk) => ({
      chunkSeq: chunk.seq,
      extraction: await extractor.extract({
        title: input.evidence.documentMeta.title,
        contextHeader: chunk.contextHeader,
        content: chunk.content,
      }),
    })),
  );
  const eventDrafts: Omit<PreparedEvent, "embedding">[] = [];
  const entityTypes = new Map<string, string>();
  for (const { chunkSeq, extraction } of extractions) {
    const entityTypeByName = new Map(
      extraction.entities.map((entity) => [entity.name, entity.entityType]),
    );
    for (const event of extraction.events) {
      const entityNames = [...new Set(event.entityNames)];
      for (const name of entityNames) {
        if (!entityTypes.has(name)) {
          entityTypes.set(name, entityTypeByName.get(name) ?? "unknown");
        }
      }
      eventDrafts.push({ chunkSeq, summary: event.summary, entityNames });
    }
  }
  const eventEmbeddings = await embedInBatches(
    deps.embeddingProvider,
    eventDrafts.map((event) => event.summary),
  );
  return {
    chunks: preparedChunks,
    events: eventDrafts.map((event, index) => ({
      ...event,
      embedding: requireEmbedding(eventEmbeddings, index),
    })),
    entities: [...entityTypes].map(([name, entityType]) => ({
      name,
      entityType,
    })),
  };
}

async function persistIndex(
  tx: DbTransaction,
  input: PersistIndexInput,
): Promise<IndexingResult> {
  const { prepared } = input;
  if (prepared.chunks.length === 0) {
    return { chunkCount: 0, eventCount: 0 };
  }
  const insertedChunks = await tx
    .insert(chunks)
    .values(
      prepared.chunks.map((chunk) => ({
        documentId: input.documentId,
        sourceId: input.sourceId,
        tenantId: input.tenantId,
        acl: input.aclTags,
        seq: chunk.seq,
        content: chunk.content,
        contextHeader: chunk.contextHeader,
        searchText: chunk.searchText,
        anchor: chunk.anchor,
        embedding: chunk.embedding,
        isActive: true,
      })),
    )
    .returning({ id: chunks.id, seq: chunks.seq });
  const chunkIdBySeq = new Map(insertedChunks.map((row) => [row.seq, row.id]));
  const eventCount = await persistEvents(tx, input, chunkIdBySeq);
  return { chunkCount: insertedChunks.length, eventCount };
}

async function persistEvents(
  tx: DbTransaction,
  input: PersistIndexInput,
  chunkIdBySeq: Map<number, string>,
): Promise<number> {
  const { prepared } = input;
  if (prepared.events.length === 0) {
    return 0;
  }
  const entityTypeByName = new Map(
    prepared.entities.map((entity) => [entity.name, entity.entityType]),
  );
  let eventCount = 0;
  for (const event of prepared.events) {
    const chunkId = chunkIdBySeq.get(event.chunkSeq);
    if (!chunkId) {
      throw new Error(
        `prepared event references unknown chunk seq ${event.chunkSeq}`,
      );
    }
    const [insertedEvent] = await tx
      .insert(events)
      .values({
        chunkId,
        documentId: input.documentId,
        sourceId: input.sourceId,
        tenantId: input.tenantId,
        acl: input.aclTags,
        summary: event.summary,
        embedding: event.embedding,
        isActive: true,
      })
      .returning({ id: events.id });
    if (!insertedEvent) {
      throw new Error("failed to insert event");
    }
    eventCount += 1;
    for (const entityName of event.entityNames) {
      const entityType = entityTypeByName.get(entityName) ?? "unknown";
      const [insertedEntity] = await tx
        .insert(entities)
        .values({
          sourceId: input.sourceId,
          tenantId: input.tenantId,
          acl: input.aclTags,
          name: entityName,
          entityType,
        })
        .onConflictDoUpdate({
          target: [entities.sourceId, entities.name],
          set: { entityType },
        })
        .returning({ id: entities.id });
      if (!insertedEntity) {
        throw new Error(`failed to upsert entity ${entityName}`);
      }
      await tx
        .insert(eventEntities)
        .values({
          eventId: insertedEvent.id,
          entityId: insertedEntity.id,
          tenantId: input.tenantId,
          acl: input.aclTags,
        })
        .onConflictDoNothing();
    }
  }
  return eventCount;
}

async function embedInBatches(
  provider: EmbeddingProvider,
  texts: string[],
): Promise<number[][]> {
  const vectors: number[][] = [];
  for (let start = 0; start < texts.length; start += EMBEDDING_BATCH_SIZE) {
    const batch = texts.slice(start, start + EMBEDDING_BATCH_SIZE);
    const batchVectors = await provider.embed(batch);
    if (batchVectors.length !== batch.length) {
      throw new Error(
        `embedding provider returned ${batchVectors.length} vectors for ${batch.length} texts`,
      );
    }
    vectors.push(...batchVectors);
  }
  return vectors;
}

function requireEmbedding(vectors: number[][], index: number): number[] {
  const vector = vectors[index];
  if (!vector) {
    throw new Error(`missing embedding vector at index ${index}`);
  }
  return vector;
}

export { chunkEvidence } from "./chunker.js";
export type { ChunkDraft, ChunkerOptions } from "./chunker.js";
export {
  createDefaultEmbeddingProvider,
  createOpenAiEmbeddingProvider,
  createOpenAiHyperedgeExtractor,
  EMBEDDING_DIMENSIONS,
} from "./providers.js";
export type {
  EmbeddingProvider,
  ExtractedEntity,
  ExtractedEvent,
  HyperedgeExtraction,
  HyperedgeExtractionInput,
  HyperedgeExtractor,
  OpenAiEmbeddingConfig,
  OpenAiHyperedgeConfig,
} from "./providers.js";
