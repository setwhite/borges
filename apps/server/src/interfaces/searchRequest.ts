import { RetrievalError } from "../retrieval/index.js";
import type { RetrievalMode, SearchRequest } from "../retrieval/index.js";

export const DEFAULT_TOP_K = 10;
export const MIN_TOP_K = 1;
export const MAX_TOP_K = 1000;

interface SearchRequestInput {
  query: string;
  sourceIds: readonly string[];
  mode: RetrievalMode;
  topK?: number | undefined;
  tenantId?: string | undefined;
  aclTags?: readonly string[] | undefined;
}

export function buildSearchRequest(input: SearchRequestInput): SearchRequest {
  return {
    query: input.query,
    sourceIds: [...input.sourceIds],
    mode: input.mode,
    topK: resolveTopK(input.topK, input.mode),
    ...(input.tenantId === undefined ? {} : { tenantId: input.tenantId }),
    ...(input.aclTags === undefined ? {} : { aclTags: [...input.aclTags] }),
  };
}

export function isValidTopK(topK: number): boolean {
  return Number.isInteger(topK) && topK >= MIN_TOP_K && topK <= MAX_TOP_K;
}

function resolveTopK(topK: number | undefined, mode: RetrievalMode): number {
  const resolved = topK ?? DEFAULT_TOP_K;
  if (!isValidTopK(resolved)) {
    throw new RetrievalError(
      "invalid_request",
      mode,
      `topK must be an integer between ${MIN_TOP_K} and ${MAX_TOP_K}, received ${resolved}`,
    );
  }
  return resolved;
}
