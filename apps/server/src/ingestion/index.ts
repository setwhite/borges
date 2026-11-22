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
