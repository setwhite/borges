export type AgentErrorCode =
  | "invalid_request"
  | "model_config_invalid"
  | "model_failed";

export class AgentError extends Error {
  readonly code: AgentErrorCode;

  constructor(
    code: AgentErrorCode,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "AgentError";
    this.code = code;
  }
}
