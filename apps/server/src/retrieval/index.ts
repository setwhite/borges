import type { Anchor } from "../contracts/evidence-ir.js";

export type RetrievalMode = "hybrid" | "hyperedge" | "rg";

export interface SearchRequest {
  query: string;
  sourceIds: string[];
  mode: RetrievalMode;
  topK: number;
  tenantId?: string;
  aclTags?: string[];
}

export interface SearchHit {
  chunkId: string;
  documentId: string;
  sourceId: string;
  content: string;
  score: number;
  anchor: Anchor;
}

export interface RetrievalSeam {
  search(request: SearchRequest): Promise<SearchHit[]>;
}
