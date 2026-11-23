import type { Anchor } from "../contracts/evidence-ir.js";

export interface SearchHit {
  chunkId: string;
  documentId: string;
  sourceId: string;
  content: string;
  score: number;
  anchor: Anchor;
}

export type ChunkRow = {
  chunk_id: string;
  document_id: string;
  source_id: string;
  content: string;
  anchor: Anchor;
};

export type ChunkCandidate = Omit<SearchHit, "score">;

export function candidateFromRow(row: ChunkRow): ChunkCandidate {
  return {
    chunkId: row.chunk_id,
    documentId: row.document_id,
    sourceId: row.source_id,
    content: row.content,
    anchor: row.anchor,
  };
}
