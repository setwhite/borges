export type IngestionErrorCode = "source_not_found";

export class IngestionError extends Error {
  readonly code: IngestionErrorCode;

  constructor(code: IngestionErrorCode, message: string) {
    super(message);
    this.name = "IngestionError";
    this.code = code;
  }
}
