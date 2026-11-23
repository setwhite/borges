export class IngestionFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message || code);
    this.name = "IngestionFailure";
  }
}

export function toIngestionFailure(
  error: unknown,
  fallbackCode = "ingestion_failed",
): IngestionFailure {
  if (error instanceof IngestionFailure) {
    return error;
  }
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.trim().length > 0) {
      return new IngestionFailure(code, error.message.trim() || code);
    }
    return new IngestionFailure(
      fallbackCode,
      error.message.trim() || error.name,
    );
  }
  const message = String(error).trim();
  return new IngestionFailure(fallbackCode, message || fallbackCode);
}
