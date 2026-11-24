import { AgentError } from "../agent/index.js";
import { IngestionError } from "../ingestion/index.js";
import { RetrievalError } from "../retrieval/index.js";

interface InterfaceErrorPayload {
  status: number;
  code: string;
  message: string;
}

const MAX_MESSAGE_LENGTH = 500;

export function toInterfaceError(error: unknown): InterfaceErrorPayload {
  if (error instanceof RetrievalError) {
    return {
      status: retrievalStatus(error.code),
      code: error.code,
      message: error.message,
    };
  }
  if (error instanceof IngestionError) {
    return {
      status: error.code === "source_not_found" ? 404 : 400,
      code: error.code,
      message: error.message,
    };
  }
  if (error instanceof AgentError) {
    return {
      status: agentStatus(error.code),
      code: error.code,
      message: error.message,
    };
  }
  const clientError = toClientError(error);
  if (clientError) {
    return clientError;
  }
  if (error instanceof Error) {
    return {
      status: 500,
      code: "internal_error",
      message: truncate(error.message || error.name),
    };
  }
  return {
    status: 500,
    code: "internal_error",
    message: "internal server error",
  };
}

function retrievalStatus(code: RetrievalError["code"]): number {
  switch (code) {
    case "invalid_request":
    case "rg_invalid_pattern":
    case "rg_sandbox_escape":
      return 400;
    case "rg_unavailable":
      return 503;
    case "rg_timeout":
    case "rerank_timeout":
      return 504;
    default:
      return 502;
  }
}

function agentStatus(code: AgentError["code"]): number {
  switch (code) {
    case "invalid_request":
      return 400;
    case "model_config_invalid":
      return 500;
    case "model_failed":
      return 502;
  }
}

function toClientError(error: unknown): InterfaceErrorPayload | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  if (typeof statusCode !== "number" || statusCode < 400 || statusCode > 499) {
    return null;
  }
  const message = (error as { message?: unknown }).message;
  return {
    status: statusCode,
    code: "invalid_request",
    message: truncate(
      typeof message === "string" && message.length > 0
        ? message
        : "invalid request",
    ),
  };
}

function truncate(message: string): string {
  return message.length > MAX_MESSAGE_LENGTH
    ? `${message.slice(0, MAX_MESSAGE_LENGTH)}...`
    : message;
}
