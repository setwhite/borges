import type { AgentTool } from "@earendil-works/pi-agent-core";
import { z } from "zod";
import type {
  RetrievalMode,
  RetrievalSeam,
  SearchHit,
} from "../retrieval/index.js";

const ToolParametersSchema = z.object({
  query: z.string().trim().min(1),
  topK: z.number().int().min(1).max(20).optional(),
});

const TOOL_PARAMETERS = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "Natural-language query or exact literal to search for.",
    },
    topK: {
      type: "integer",
      minimum: 1,
      maximum: 20,
      description: "Maximum number of evidence chunks to return.",
    },
  },
  required: ["query"],
  additionalProperties: false,
} as const;

interface ToolDefinition {
  name: string;
  mode: RetrievalMode;
  label: string;
  description: string;
}

const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: "search_hybrid",
    mode: "hybrid",
    label: "Hybrid search",
    description:
      "Search the knowledge base with BM25 plus dense vectors. Use for conceptual questions and paraphrased topics.",
  },
  {
    name: "search_hyperedge",
    mode: "hyperedge",
    label: "Hyperedge search",
    description:
      "Search events and entities linked across documents. Use for relationship, timeline and who-did-what questions.",
  },
  {
    name: "search_rg",
    mode: "rg",
    label: "Exact text search",
    description:
      "Search source mirrors with ripgrep. Use for exact identifiers, function names, error strings and code snippets.",
  },
];

interface RetrievalToolInput {
  retrieval: RetrievalSeam;
  sourceIds: string[];
  tenantId?: string;
  aclTags?: string[];
  defaultTopK: number;
  onHits(hits: SearchHit[], mode: RetrievalMode): void;
}

export function createRetrievalTools(input: RetrievalToolInput): AgentTool[] {
  return TOOL_DEFINITIONS.map((definition) => ({
    name: definition.name,
    label: definition.label,
    description: definition.description,
    parameters: TOOL_PARAMETERS,
    execute: async (_toolCallId: string, params: unknown) => {
      const parsed = ToolParametersSchema.parse(params);
      const hits = await input.retrieval.search({
        query: parsed.query,
        sourceIds: input.sourceIds,
        mode: definition.mode,
        topK: parsed.topK ?? input.defaultTopK,
        ...(input.tenantId === undefined ? {} : { tenantId: input.tenantId }),
        ...(input.aclTags === undefined ? {} : { aclTags: input.aclTags }),
      });
      input.onHits(hits, definition.mode);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(hits) }],
        details: { mode: definition.mode, hitCount: hits.length },
      };
    },
  }));
}
