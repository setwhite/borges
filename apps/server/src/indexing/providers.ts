import { z } from "zod";

export const EMBEDDING_DIMENSIONS = 1536;

export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
}

export interface HyperedgeExtractionInput {
  title: string;
  contextHeader: string;
  content: string;
}

export interface ExtractedEntity {
  name: string;
  entityType: string;
}

export interface ExtractedEvent {
  summary: string;
  entityNames: string[];
}

export interface HyperedgeExtraction {
  events: ExtractedEvent[];
  entities: ExtractedEntity[];
}

export interface HyperedgeExtractor {
  extract(input: HyperedgeExtractionInput): Promise<HyperedgeExtraction>;
}

export interface OpenAiEmbeddingConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface OpenAiHyperedgeConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const EmbeddingResponseSchema = z.object({
  data: z
    .array(
      z.object({
        index: z.number().int().nonnegative(),
        embedding: z.array(z.number()),
      }),
    )
    .min(1),
});

const ChatCompletionResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string().nullable() }),
      }),
    )
    .min(1),
});

const RawExtractionSchema = z.object({
  events: z
    .array(
      z.object({
        summary: z.string(),
        entityNames: z.array(z.string()).optional(),
      }),
    )
    .default([]),
  entities: z
    .array(
      z.object({
        name: z.string(),
        entityType: z.string(),
      }),
    )
    .default([]),
});

const EXTRACTION_SYSTEM_PROMPT = [
  "You extract a hyperedge from one document chunk.",
  "Return JSON only, matching this shape:",
  '{"events":[{"summary":"...","entityNames":["..."]}],"entities":[{"name":"...","entityType":"..."}]}',
  "Each event must be a self-contained semantic record grounded in the chunk.",
  "Only list entities that appear in the chunk. Keep the chunk language.",
  "Return at most 8 events and 12 entities.",
].join("\n");

export function createOpenAiEmbeddingProvider(
  config: OpenAiEmbeddingConfig,
): EmbeddingProvider {
  const endpoint = `${trimTrailingSlash(config.baseUrl)}/embeddings`;
  const timeoutMs = config.timeoutMs ?? 30_000;
  const fetchImpl = config.fetchImpl ?? fetch;
  return {
    embed: async (texts) => {
      if (texts.length === 0) {
        return [];
      }
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({ model: config.model, input: texts }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        throw new Error(
          `embedding request failed with status ${response.status}${await responseDetail(response)}`,
        );
      }
      const payload = EmbeddingResponseSchema.parse(await response.json());
      if (payload.data.length !== texts.length) {
        throw new Error(
          `embedding response count mismatch: expected ${texts.length}, received ${payload.data.length}`,
        );
      }
      return [...payload.data]
        .sort((left, right) => left.index - right.index)
        .map((item, position) => {
          if (item.index !== position) {
            throw new Error(
              `embedding response index mismatch at position ${position}: received ${item.index}`,
            );
          }
          if (item.embedding.length !== EMBEDDING_DIMENSIONS) {
            throw new Error(
              `embedding dimension mismatch at position ${position}: expected ${EMBEDDING_DIMENSIONS}, received ${item.embedding.length}`,
            );
          }
          for (const value of item.embedding) {
            if (!Number.isFinite(value)) {
              throw new Error(
                `embedding vector at position ${position} contains a non-finite value`,
              );
            }
          }
          return item.embedding;
        });
    },
  };
}

export function createOpenAiHyperedgeExtractor(
  config: OpenAiHyperedgeConfig,
): HyperedgeExtractor {
  const endpoint = `${trimTrailingSlash(config.baseUrl)}/chat/completions`;
  const timeoutMs = config.timeoutMs ?? 60_000;
  const fetchImpl = config.fetchImpl ?? fetch;
  return {
    extract: async (input) => {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
            {
              role: "user",
              content: [
                `Document: ${input.title}`,
                `Context: ${input.contextHeader}`,
                "Chunk:",
                input.content,
              ].join("\n"),
            },
          ],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        throw new Error(
          `hyperedge extraction request failed with status ${response.status}${await responseDetail(response)}`,
        );
      }
      const completion = ChatCompletionResponseSchema.parse(
        await response.json(),
      );
      const content = completion.choices[0]?.message.content;
      if (!content) {
        throw new Error("hyperedge extraction returned an empty message");
      }
      const raw = RawExtractionSchema.parse(parseJsonContent(content));
      return normalizeExtraction(raw);
    },
  };
}

export function createDefaultEmbeddingProvider(
  env: NodeJS.ProcessEnv = process.env,
): EmbeddingProvider {
  const baseUrl = env.EMBEDDING_BASE_URL;
  const apiKey = env.EMBEDDING_API_KEY;
  const model = env.EMBEDDING_MODEL;
  if (!baseUrl || !apiKey || !model) {
    throw new Error(
      "EMBEDDING_BASE_URL, EMBEDDING_API_KEY and EMBEDDING_MODEL are required",
    );
  }
  return createOpenAiEmbeddingProvider({
    baseUrl,
    apiKey,
    model,
    timeoutMs: timeoutFromEnv(env.EMBEDDING_TIMEOUT_MS, 30_000),
  });
}

export function createDefaultHyperedgeExtractor(
  env: NodeJS.ProcessEnv = process.env,
): HyperedgeExtractor {
  const baseUrl = env.OPENAI_BASE_URL;
  const apiKey = env.OPENAI_API_KEY;
  const model = env.LLM_MODEL;
  if (!baseUrl || !apiKey || !model) {
    throw new Error(
      "OPENAI_BASE_URL, OPENAI_API_KEY and LLM_MODEL are required",
    );
  }
  return createOpenAiHyperedgeExtractor({
    baseUrl,
    apiKey,
    model,
    timeoutMs: timeoutFromEnv(env.LLM_TIMEOUT_MS, 60_000),
  });
}

function normalizeExtraction(
  raw: z.infer<typeof RawExtractionSchema>,
): HyperedgeExtraction {
  const entities = new Map<string, string>();
  for (const entity of raw.entities) {
    const name = entity.name.trim();
    const entityType = entity.entityType.trim();
    if (name && entityType && !entities.has(name)) {
      entities.set(name, entityType);
    }
  }
  const events: ExtractedEvent[] = [];
  for (const event of raw.events) {
    const summary = event.summary.trim();
    if (!summary) {
      continue;
    }
    const entityNames = [
      ...new Set(
        (event.entityNames ?? []).map((name) => name.trim()).filter(Boolean),
      ),
    ];
    for (const name of entityNames) {
      if (!entities.has(name)) {
        entities.set(name, "unknown");
      }
    }
    events.push({ summary, entityNames });
  }
  const referenced = new Set(events.flatMap((event) => event.entityNames));
  return {
    events,
    entities: [...entities]
      .filter(([name]) => referenced.has(name))
      .map(([name, entityType]) => ({ name, entityType })),
  };
}

function parseJsonContent(content: string): unknown {
  const trimmed = content.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return JSON.parse(fenced?.[1] ?? trimmed);
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
