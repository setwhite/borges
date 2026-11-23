export type RetrievalMode = "hybrid" | "hyperedge" | "rg";

export type RetrievalErrorCode =
  | "invalid_request"
  | "embedding_failed"
  | "bm25_failed"
  | "dense_failed"
  | "hyperedge_failed"
  | "rerank_failed"
  | "rerank_timeout"
  | "rg_failed"
  | "rg_unavailable"
  | "rg_invalid_pattern"
  | "rg_timeout"
  | "rg_sandbox_escape";

export class RetrievalError extends Error {
  readonly code: RetrievalErrorCode;
  readonly mode: RetrievalMode;

  constructor(
    code: RetrievalErrorCode,
    mode: RetrievalMode,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "RetrievalError";
    this.code = code;
    this.mode = mode;
  }
}

export function toRetrievalError(
  error: unknown,
  code: RetrievalErrorCode,
  mode: RetrievalMode,
): RetrievalError {
  if (error instanceof RetrievalError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return new RetrievalError(code, mode, message, { cause: error });
}
