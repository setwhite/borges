import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";

const PROVIDER_ID = "borges-openai-compatible";
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 8_192;

export interface OpenAiCompatibleRuntime {
  model: Model<Api>;
  streamFn: StreamFn;
}

export function createOpenAiCompatibleRuntime(
  env: NodeJS.ProcessEnv = process.env,
): OpenAiCompatibleRuntime {
  const apiKey = env.OPENAI_API_KEY?.trim();
  const baseUrl = env.OPENAI_BASE_URL?.trim();
  const modelId = env.LLM_MODEL?.trim();
  if (!apiKey || !baseUrl || !modelId) {
    throw new Error(
      "OPENAI_API_KEY, OPENAI_BASE_URL and LLM_MODEL are required",
    );
  }
  const model: Model<"openai-completions"> = {
    id: modelId,
    name: modelId,
    api: "openai-completions",
    provider: PROVIDER_ID,
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  };
  const provider = createProvider({
    id: PROVIDER_ID,
    name: "Borges OpenAI-compatible model",
    baseUrl,
    auth: {
      apiKey: {
        name: "OpenAI API key",
        resolve: async () => ({ auth: { apiKey } }),
      },
    },
    models: [model],
    api: openAICompletionsApi(),
  });
  const models = createModels();
  models.setProvider(provider);
  return { model, streamFn: models.streamSimple.bind(models) };
}
