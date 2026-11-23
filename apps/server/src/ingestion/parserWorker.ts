import { randomUUID } from "node:crypto";
import { type EvidenceIR, EvidenceIRSchema } from "../contracts/evidence-ir.js";
import { IngestionFailure } from "./failures.js";

export interface ParserWorker {
  parse(filePath: string): Promise<EvidenceIR>;
}

interface ParserWorkerConfig {
  baseUrl: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

function createParserWorkerClient(config: ParserWorkerConfig): ParserWorker {
  const endpoint = `${trimTrailingSlash(config.baseUrl)}/parse`;
  const fetchImpl = config.fetchImpl ?? fetch;
  return {
    parse: async (filePath) => {
      const requestId = randomUUID();
      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-request-id": requestId,
          },
          body: JSON.stringify({ filePath }),
          signal: AbortSignal.timeout(config.timeoutMs),
        });
      } catch (error) {
        if (isTimeout(error)) {
          throw new IngestionFailure(
            "parser_worker_timeout",
            `parser worker did not respond within ${config.timeoutMs}ms (request ${requestId})`,
          );
        }
        throw new IngestionFailure(
          "parser_worker_unreachable",
          `parser worker request failed: ${errorMessage(error)} (request ${requestId})`,
        );
      }
      if (!response.ok) {
        const remote = await readErrorBody(response);
        throw new IngestionFailure(
          `parser_worker_${remote.code}`,
          `${remote.message} (request ${requestId})`,
        );
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new IngestionFailure(
          "parser_worker_invalid_json",
          `parser worker returned non-JSON body (request ${requestId})`,
        );
      }
      const parsed = EvidenceIRSchema.safeParse(payload);
      if (!parsed.success) {
        throw new IngestionFailure(
          "invalid_evidence_ir",
          `${parsed.error.message} (request ${requestId})`,
        );
      }
      return parsed.data;
    },
  };
}

export function createDefaultParserWorkerClient(
  env: NodeJS.ProcessEnv = process.env,
): ParserWorker {
  return createParserWorkerClient({
    baseUrl: env.PARSER_WORKER_URL ?? "http://127.0.0.1:8001",
    timeoutMs: timeoutFromEnv(env.PARSER_TIMEOUT_MS, 180_000),
  });
}

async function readErrorBody(
  response: Response,
): Promise<{ code: string; message: string }> {
  try {
    const payload: unknown = await response.json();
    if (
      typeof payload === "object" &&
      payload !== null &&
      "code" in payload &&
      "message" in payload
    ) {
      const code = (payload as { code: unknown }).code;
      const message = (payload as { message: unknown }).message;
      if (typeof code === "string" && code.trim().length > 0) {
        return {
          code: code.trim(),
          message:
            typeof message === "string" ? message : `HTTP ${response.status}`,
        };
      }
    }
  } catch {
    // Fall through to the status-only error below.
  }
  return { code: String(response.status), message: `HTTP ${response.status}` };
}

function isTimeout(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function timeoutFromEnv(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`invalid timeout value: ${value}`);
  }
  return parsed;
}
