import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { AskRequest } from "../../agent/index.js";
import type { SourceFilter } from "../../ingestion/index.js";
import type { RetrievalMode, SearchRequest } from "../../retrieval/index.js";
import type { InterfaceDependencies } from "../dependencies.js";
import { toInterfaceError } from "../errors.js";

const DEFAULT_TOP_K = 10;

interface ListSourcesInput {
  tenantId?: string | undefined;
  aclTags?: string[] | undefined;
}

interface SearchToolInput {
  query: string;
  sourceIds: string[];
  mode: RetrievalMode;
  topK?: number | undefined;
  tenantId?: string | undefined;
  aclTags?: string[] | undefined;
}

interface AskToolInput {
  query: string;
  sourceIds: string[];
  tenantId?: string | undefined;
  aclTags?: string[] | undefined;
}

export function createMcpServer(deps: InterfaceDependencies): McpServer {
  const server = new McpServer({ name: "borges", version: "0.1.0" });

  server.registerTool(
    "list_sources",
    {
      title: "List sources",
      description:
        "List knowledge base sources visible for the given tenant and ACL tags.",
      inputSchema: {
        tenantId: z.string().min(1).optional(),
        aclTags: z.array(z.string().min(1)).optional(),
      },
    },
    async (input: ListSourcesInput) =>
      await toolResult(() => deps.ingestion.listSources(sourceFilter(input))),
  );

  server.registerTool(
    "search",
    {
      title: "Search",
      description:
        "Search chunks with hybrid, hyperedge or ripgrep retrieval and return anchors.",
      inputSchema: {
        query: z.string().min(1),
        sourceIds: z.array(z.string().min(1)).min(1),
        mode: z.enum(["hybrid", "hyperedge", "rg"]),
        topK: z.number().int().min(1).max(100).optional(),
        tenantId: z.string().min(1).optional(),
        aclTags: z.array(z.string().min(1)).optional(),
      },
    },
    async (input: SearchToolInput) =>
      await toolResult(() => deps.retrieval.search(searchRequest(input))),
  );

  server.registerTool(
    "ask",
    {
      title: "Ask",
      description:
        "Answer a question through the agent with verified citations and explicit refusal.",
      inputSchema: {
        query: z.string().min(1),
        sourceIds: z.array(z.string().min(1)).min(1),
        tenantId: z.string().min(1).optional(),
        aclTags: z.array(z.string().min(1)).optional(),
      },
    },
    async (input: AskToolInput) =>
      await toolResult(() => deps.agent.ask(askRequest(input))),
  );

  return server;
}

async function toolResult(
  work: () => Promise<unknown>,
): Promise<CallToolResult> {
  try {
    return {
      content: [{ type: "text", text: JSON.stringify(await work()) }],
    };
  } catch (error) {
    const mapped = toInterfaceError(error);
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: { code: mapped.code, message: mapped.message },
          }),
        },
      ],
    };
  }
}

function sourceFilter(input: ListSourcesInput): SourceFilter {
  return {
    ...(input.tenantId === undefined ? {} : { tenantId: input.tenantId }),
    ...(input.aclTags === undefined ? {} : { aclTags: input.aclTags }),
  };
}

function searchRequest(input: SearchToolInput): SearchRequest {
  return {
    query: input.query,
    sourceIds: input.sourceIds,
    mode: input.mode,
    topK: input.topK ?? DEFAULT_TOP_K,
    ...(input.tenantId === undefined ? {} : { tenantId: input.tenantId }),
    ...(input.aclTags === undefined ? {} : { aclTags: input.aclTags }),
  };
}

function askRequest(input: AskToolInput): AskRequest {
  return {
    query: input.query,
    sourceIds: input.sourceIds,
    ...(input.tenantId === undefined ? {} : { tenantId: input.tenantId }),
    ...(input.aclTags === undefined ? {} : { aclTags: input.aclTags }),
  };
}
