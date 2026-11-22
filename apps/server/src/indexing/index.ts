import type { EvidenceIR } from "../contracts/evidence-ir.js";

export interface IndexDocumentInput {
  documentId: string;
  sourceId: string;
  tenantId: string;
  aclTags: string[];
  evidence: EvidenceIR;
  extractHyperedge: boolean;
}

export interface IndexingResult {
  chunkCount: number;
  eventCount: number;
}

export interface IndexingService {
  indexDocument(input: IndexDocumentInput): Promise<IndexingResult>;
}
