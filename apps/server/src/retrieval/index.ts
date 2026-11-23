import {
  EMBEDDING_DIMENSIONS,
  type EmbeddingProvider,
  createDefaultEmbeddingProvider,
} from "../indexing/index.js";
import { defaultMirrorRoot } from "../ingestion/index.js";
import type { DbClient } from "../storage/db.js";
import {
  RetrievalError,
  type RetrievalMode,
  toRetrievalError,
} from "./errors.js";
import type { SearchHit } from "./hit.js";
import { hybridSearch } from "./hybrid.js";
import { hyperedgeSearch } from "./hyperedge.js";
import { resolveScope } from "./prefilter.js";
import { type Reranker, createDefaultReranker } from "./reranker.js";
import { rgSearch } from "./rg.js";

export interface SearchRequest {
  query: string;
  sourceIds: string[];
  mode: RetrievalMode;
  topK: number;
  tenantId?: string;
  aclTags?: string[];
}

export interface RetrievalSeam {
  search(request: SearchRequest): Promise<SearchHit[]>;
}

export interface RetrievalDependencies {
  db: DbClient;
  embeddingProvider: EmbeddingProvider;
  reranker: Reranker;
  mirrorRoot: string;
  rgPath?: string;
  rgTimeoutMs?: number;
}

const DEFAULT_RG_TIMEOUT_MS = 10_000;

export function createRetrievalService(
  dependencies: RetrievalDependencies,
): RetrievalSeam {
  const { db } = dependencies;
  const rgPath = dependencies.rgPath ?? "rg";
  const rgTimeoutMs = dependencies.rgTimeoutMs ?? DEFAULT_RG_TIMEOUT_MS;
  return {
    search: async (request) => {
      validateRequest(request);
      const mode = request.mode;
      const scope = resolveScope(request);
      if (scope.sourceIds.length === 0) {
        return [];
      }
      if (mode === "rg") {
        return await rgSearch({
          db,
          scope,
          mirrorRoot: dependencies.mirrorRoot,
          query: request.query,
          topK: request.topK,
          rgPath,
          timeoutMs: rgTimeoutMs,
        });
      }
      const queryVector = await embedQuery(
        dependencies.embeddingProvider,
        request.query,
        mode,
      );
      if (mode === "hybrid") {
        return await hybridSearch({
          db,
          scope,
          query: request.query,
          queryVector,
          topK: request.topK,
          reranker: dependencies.reranker,
        });
      }
      return await hyperedgeSearch({
        db,
        scope,
        query: request.query,
        queryVector,
        topK: request.topK,
        reranker: dependencies.reranker,
      });
    },
  };
}

export interface DefaultRetrievalDependencies {
  db: DbClient;
  env?: NodeJS.ProcessEnv;
}

export function createDefaultRetrievalService(
  dependencies: DefaultRetrievalDependencies,
): RetrievalSeam {
  const env = dependencies.env ?? process.env;
  return createRetrievalService({
    db: dependencies.db,
    embeddingProvider: createDefaultEmbeddingProvider(env),
    reranker: createDefaultReranker(env),
    mirrorRoot: defaultMirrorRoot(env),
    rgTimeoutMs: timeoutFromEnv(env.RG_TIMEOUT_MS, DEFAULT_RG_TIMEOUT_MS),
  });
}

function validateRequest(request: SearchRequest): void {
  if (!isRetrievalMode(request.mode)) {
    throw new RetrievalError(
      "invalid_request",
      request.mode,
      `unsupported retrieval mode: ${String(request.mode)}`,
    );
  }
  if (request.query.trim().length === 0) {
    throw new RetrievalError(
      "invalid_request",
      request.mode,
      "query must contain non-whitespace characters",
    );
  }
  if (!Number.isInteger(request.topK) || request.topK < 1) {
    throw new RetrievalError(
      "invalid_request",
      request.mode,
      `topK must be a positive integer, received ${request.topK}`,
    );
  }
}

async function embedQuery(
  provider: EmbeddingProvider,
  query: string,
  mode: RetrievalMode,
): Promise<number[]> {
  let vectors: number[][];
  try {
    vectors = await provider.embed([query]);
  } catch (error) {
    throw toRetrievalError(error, "embedding_failed", mode);
  }
  const vector = vectors[0];
  if (!vector || vector.length !== EMBEDDING_DIMENSIONS) {
    throw new RetrievalError(
      "embedding_failed",
      mode,
      vector
        ? `embedding provider returned ${vector.length} dimensions for the query, expected ${EMBEDDING_DIMENSIONS}`
        : "embedding provider returned no vector for the query",
    );
  }
  return vector;
}

function isRetrievalMode(value: string): value is RetrievalMode {
  return value === "hybrid" || value === "hyperedge" || value === "rg";
}

function timeoutFromEnv(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`invalid timeout value: ${value}`);
  }
  return parsed;
}

export { RetrievalError } from "./errors.js";
export type { RetrievalErrorCode, RetrievalMode } from "./errors.js";
export type { ChunkCandidate, SearchHit } from "./hit.js";
export type {
  OpenAiRerankConfig,
  RerankInput,
  RerankScore,
  Reranker,
} from "./reranker.js";
export { createOpenAiReranker } from "./reranker.js";
