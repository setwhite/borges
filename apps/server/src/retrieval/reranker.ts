import { z } from "zod";
import {
  RetrievalError,
  type RetrievalMode,
  toRetrievalError,
} from "./errors.js";
import type { ChunkCandidate, SearchHit } from "./hit.js";

export interface RerankInput {
  mode: RetrievalMode;
  query: string;
  documents: string[];
}

export interface RerankScore {
  index: number;
  score: number;
}

export interface Reranker {
  rerank(input: RerankInput): Promise<RerankScore[]>;
}

export interface OpenAiRerankConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const RerankResponseSchema = z.object({
  results: z
    .array(
      z.object({
        index: z.number().int().nonnegative(),
        relevance_score: z.number(),
      }),
    )
    .min(1),
});

export function createOpenAiReranker(config: OpenAiRerankConfig): Reranker {
  const endpoint = resolveRerankEndpoint(config.baseUrl);
  const timeoutMs = config.timeoutMs ?? 30_000;
  const fetchImpl = config.fetchImpl ?? fetch;
  return {
    rerank: async (input) => {
      if (input.documents.length === 0) {
        return [];
      }
      const response = await request(
        () =>
          fetchImpl(endpoint, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${config.apiKey}`,
            },
            body: JSON.stringify({
              model: config.model,
              query: input.query,
              documents: input.documents,
              top_n: input.documents.length,
            }),
            signal: AbortSignal.timeout(timeoutMs),
          }),
        input.mode,
      );
      if (!response.ok) {
        throw new RetrievalError(
          "rerank_failed",
          input.mode,
          `rerank request failed with status ${response.status}${await responseDetail(response)}`,
        );
      }
      const payload = await request(() => response.json(), input.mode);
      const parsed = RerankResponseSchema.safeParse(payload);
      if (!parsed.success) {
        throw new RetrievalError(
          "rerank_failed",
          input.mode,
          `rerank response has an invalid shape: ${parsed.error.message}`,
        );
      }
      for (const result of parsed.data.results) {
        if (result.index >= input.documents.length) {
          throw new RetrievalError(
            "rerank_failed",
            input.mode,
            `rerank response index out of range: ${result.index}`,
          );
        }
      }
      return parsed.data.results.map((result) => ({
        index: result.index,
        score: result.relevance_score,
      }));
    },
  };
}

export function createDefaultReranker(
  env: NodeJS.ProcessEnv = process.env,
): Reranker {
  const baseUrl = env.RERANK_BASE_URL;
  const apiKey = env.RERANK_API_KEY;
  const model = env.RERANK_MODEL;
  if (!baseUrl || !apiKey || !model) {
    throw new Error(
      "RERANK_BASE_URL, RERANK_API_KEY and RERANK_MODEL are required",
    );
  }
  return createOpenAiReranker({
    baseUrl,
    apiKey,
    model,
    timeoutMs: timeoutFromEnv(env.RERANK_TIMEOUT_MS, 30_000),
  });
}

interface RerankCandidatesInput {
  reranker: Reranker;
  mode: RetrievalMode;
  query: string;
  candidates: ChunkCandidate[];
  topK: number;
}

export async function rerankCandidates(
  input: RerankCandidatesInput,
): Promise<SearchHit[]> {
  if (input.candidates.length === 0) {
    return [];
  }
  let scores: RerankScore[];
  try {
    scores = await input.reranker.rerank({
      mode: input.mode,
      query: input.query,
      documents: input.candidates.map((candidate) => candidate.content),
    });
  } catch (error) {
    throw toRetrievalError(error, "rerank_failed", input.mode);
  }
  if (scores.length === 0) {
    throw new RetrievalError(
      "rerank_failed",
      input.mode,
      "rerank returned no scores for the candidate set",
    );
  }
  return scores
    .flatMap((score) => {
      const candidate = input.candidates[score.index];
      return candidate ? [{ candidate, score }] : [];
    })
    .sort(
      (left, right) =>
        right.score.score - left.score.score ||
        left.score.index - right.score.index,
    )
    .slice(0, input.topK)
    .map(({ candidate, score }) => ({ ...candidate, score: score.score }));
}

async function request<T>(
  call: () => Promise<T>,
  mode: RetrievalMode,
): Promise<T> {
  try {
    return await call();
  } catch (error) {
    const timedOut =
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError");
    throw new RetrievalError(
      timedOut ? "rerank_timeout" : "rerank_failed",
      mode,
      `rerank request failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function resolveRerankEndpoint(baseUrl: string): string {
  const trimmed = trimTrailingSlash(baseUrl);
  return /\/reranks?$/.test(trimmed) ? trimmed : `${trimmed}/rerank`;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

async function responseDetail(response: Response): Promise<string> {
  try {
    const body = await response.text();
    return body ? `: ${body.slice(0, 500)}` : "";
  } catch {
    return "";
  }
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
