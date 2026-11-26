import {
  Agent,
  type AgentMessage,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import {
  type RerankScore,
  type Reranker,
  type RetrievalSeam,
  type SearchHit,
  createDefaultReranker,
} from "../retrieval/index.js";
import { AgentError } from "./errors.js";
import { createOpenAiCompatibleRuntime } from "./model.js";
import { AGENT_SYSTEM_PROMPT, parseModelAnswer } from "./prompt.js";
import { createRetrievalTools } from "./tools.js";
import type { AgentSeam, AskRequest, AskResponse, Citation } from "./types.js";

const DEFAULT_REFUSAL_THRESHOLD = 0.2;
const DEFAULT_TOP_K = 5;
const DEFAULT_MAX_TOOL_CALLS = 8;

const NO_EVIDENCE_ANSWER =
  "No supporting evidence was found in the selected sources, so this question cannot be answered.";
const LOW_RELEVANCE_ANSWER =
  "The retrieved evidence is below the relevance threshold, so this question cannot be answered.";
const UNVERIFIABLE_CITATIONS_ANSWER =
  "The proposed answer could not be verified against the retrieved chunks, so this question cannot be answered.";
const TOOL_LIMIT_REASON =
  "Tool call budget exhausted; refuse instead of searching again.";

export interface AgentDependencies {
  retrieval: RetrievalSeam;
  reranker?: Reranker;
  model: Model<Api>;
  streamFn: StreamFn;
  refusalThreshold?: number;
  defaultTopK?: number;
  maxToolCalls?: number;
}

export interface DefaultAgentDependencies {
  retrieval: RetrievalSeam;
  reranker?: Reranker;
  env?: NodeJS.ProcessEnv;
}

export function createAgentService(dependencies: AgentDependencies): AgentSeam {
  const refusalThreshold =
    dependencies.refusalThreshold ?? DEFAULT_REFUSAL_THRESHOLD;
  const defaultTopK = dependencies.defaultTopK ?? DEFAULT_TOP_K;
  const maxToolCalls = dependencies.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
  assertThreshold(refusalThreshold);
  assertPositiveInteger(defaultTopK, "defaultTopK");
  assertPositiveInteger(maxToolCalls, "maxToolCalls");

  return {
    ask: async (request) => {
      validateRequest(request);
      const hitMap = new Map<string, SearchHit>();
      const rgHits = new Map<string, SearchHit>();
      let semanticMaxScore = 0;
      let hasSemanticHit = false;
      let toolCallCount = 0;
      const tools = createRetrievalTools({
        retrieval: dependencies.retrieval,
        sourceIds: request.sourceIds,
        ...(request.tenantId === undefined
          ? {}
          : { tenantId: request.tenantId }),
        ...(request.aclTags === undefined ? {} : { aclTags: request.aclTags }),
        defaultTopK,
        onHits: (hits, mode) => {
          for (const hit of hits) {
            hitMap.set(hit.chunkId, hit);
            if (mode === "rg") {
              rgHits.set(hit.chunkId, hit);
            } else {
              hasSemanticHit = true;
              semanticMaxScore = Math.max(semanticMaxScore, hit.score);
            }
          }
        },
      });
      const agent = new Agent({
        initialState: {
          systemPrompt: AGENT_SYSTEM_PROMPT,
          model: dependencies.model,
          tools,
        },
        streamFn: dependencies.streamFn,
        beforeToolCall: async () => {
          toolCallCount += 1;
          if (toolCallCount > maxToolCalls) {
            return { block: true, reason: TOOL_LIMIT_REASON, terminate: true };
          }
          return undefined;
        },
      });
      await agent.prompt({
        role: "user",
        content: request.query,
        timestamp: Date.now(),
      });
      const message = lastAssistantMessage(agent.state.messages);
      if (!message) {
        throw new AgentError(
          "model_failed",
          "agent produced no assistant message",
        );
      }
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        throw new AgentError(
          "model_failed",
          message.errorMessage ??
            `model stopped with reason ${message.stopReason}`,
        );
      }
      const answer = parseModelAnswer(assistantText(message));
      if (hitMap.size === 0) {
        return refuse(NO_EVIDENCE_ANSWER);
      }
      const rgScores = await rerankRgHits(
        dependencies.reranker,
        rgHits,
        request.query,
      );
      if (rgScores === null && !hasSemanticHit) {
        return refuse(LOW_RELEVANCE_ANSWER);
      }
      const maxScore = Math.max(semanticMaxScore, maxRerankScore(rgScores));
      if (maxScore < refusalThreshold) {
        return refuse(LOW_RELEVANCE_ANSWER);
      }
      if (!answer) {
        return refuse(UNVERIFIABLE_CITATIONS_ANSWER);
      }
      if (answer.refused) {
        return refuse(answer.answer.trim() || NO_EVIDENCE_ANSWER);
      }
      const citations = resolveCitations(
        answer.citationChunkIds,
        hitMap,
        rgHits,
        rgScores,
        refusalThreshold,
      );
      if (citations.length === 0 || answer.answer.trim().length === 0) {
        return refuse(UNVERIFIABLE_CITATIONS_ANSWER);
      }
      return { answer: answer.answer.trim(), citations, refused: false };
    },
  };
}

export function createDefaultAgentService(
  dependencies: DefaultAgentDependencies,
): AgentSeam {
  const env = dependencies.env ?? process.env;
  const runtime = createOpenAiCompatibleRuntime(env);
  const threshold = env.AGENT_REFUSAL_THRESHOLD?.trim();
  return createAgentService({
    retrieval: dependencies.retrieval,
    reranker: dependencies.reranker ?? createDefaultReranker(env),
    model: runtime.model,
    streamFn: runtime.streamFn,
    ...(threshold ? { refusalThreshold: parseThreshold(threshold) } : {}),
  });
}

async function rerankRgHits(
  reranker: Reranker | undefined,
  hits: ReadonlyMap<string, SearchHit>,
  query: string,
): Promise<Map<string, number> | null> {
  if (!reranker || hits.size === 0) {
    return null;
  }
  const entries = [...hits.values()];
  let results: RerankScore[];
  try {
    results = await reranker.rerank({
      mode: "rg",
      query,
      documents: entries.map((hit) => hit.content),
    });
  } catch (error) {
    throw new AgentError(
      "rerank_failed",
      `rg evidence rerank failed: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  const scores = new Map<string, number>();
  for (const result of results) {
    const hit = entries[result.index];
    if (!hit || !Number.isFinite(result.score)) {
      continue;
    }
    scores.set(hit.chunkId, result.score);
  }
  return scores;
}

function maxRerankScore(scores: ReadonlyMap<string, number> | null): number {
  if (!scores) {
    return 0;
  }
  let maxScore = 0;
  for (const score of scores.values()) {
    maxScore = Math.max(maxScore, score);
  }
  return maxScore;
}

function resolveCitations(
  chunkIds: readonly string[],
  hitMap: ReadonlyMap<string, SearchHit>,
  rgHits: ReadonlyMap<string, SearchHit>,
  rgScores: ReadonlyMap<string, number> | null,
  refusalThreshold: number,
): Citation[] {
  const seen = new Set<string>();
  const citations: Citation[] = [];
  for (const chunkId of chunkIds) {
    if (seen.has(chunkId)) {
      continue;
    }
    seen.add(chunkId);
    const hit = hitMap.get(chunkId);
    if (!hit) {
      continue;
    }
    if (rgHits.has(chunkId)) {
      const score = rgScores?.get(chunkId);
      if (score === undefined || score < refusalThreshold) {
        continue;
      }
    }
    citations.push({
      chunkId: hit.chunkId,
      sourceId: hit.sourceId,
      anchor: hit.anchor,
    });
  }
  return citations;
}

function refuse(answer: string): AskResponse {
  return { answer, citations: [], refused: true };
}

function validateRequest(request: AskRequest): void {
  if (request.query.trim().length === 0) {
    throw new AgentError(
      "invalid_request",
      "query must contain non-whitespace characters",
    );
  }
  if (request.sourceIds.length === 0) {
    throw new AgentError("invalid_request", "sourceIds must not be empty");
  }
}

function lastAssistantMessage(
  messages: AgentMessage[],
): AssistantMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant") {
      return message;
    }
  }
  return null;
}

function assistantText(message: AssistantMessage): string {
  return message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("");
}

function assertThreshold(value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new AgentError(
      "model_config_invalid",
      `refusalThreshold must be a number between 0 and 1, received ${value}`,
    );
  }
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new AgentError(
      "model_config_invalid",
      `${name} must be a positive integer, received ${value}`,
    );
  }
}

function parseThreshold(value: string): number {
  const parsed = Number(value);
  assertThreshold(parsed);
  return parsed;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
