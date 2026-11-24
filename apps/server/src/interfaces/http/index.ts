import fastifySwagger from "@fastify/swagger";
import Fastify, {
  type FastifyBaseLogger,
  type FastifyError,
  type FastifyInstance,
} from "fastify";
import type { AskRequest } from "../../agent/index.js";
import type {
  SourceFilter,
  SubmitDocumentInput,
} from "../../ingestion/index.js";
import type { RetrievalMode, SearchRequest } from "../../retrieval/index.js";
import type { InterfaceDependencies } from "../dependencies.js";
import { toInterfaceError } from "../errors.js";

export interface HttpAppOptions {
  deps: InterfaceDependencies;
  loggerInstance?: FastifyBaseLogger;
}

interface SourceQuery {
  tenantId?: string;
  aclTags?: string | string[];
}

interface SubmitDocumentBody {
  sourceId: string;
  filePath: string;
  title?: string;
  tenantId?: string;
  aclTags?: string[];
}

interface JobParams {
  jobId: string;
}

interface DocumentParams {
  documentId: string;
}

interface SearchBody {
  query: string;
  sourceIds: string[];
  mode: RetrievalMode;
  topK?: number;
  tenantId?: string;
  aclTags?: string[];
}

interface AskBody {
  query: string;
  sourceIds: string[];
  tenantId?: string;
  aclTags?: string[];
}

const DEFAULT_TOP_K = 10;
const AJV_OPTIONS = {
  customOptions: { coerceTypes: false, removeAdditional: false },
} as const;

const aclTagsSchema = {
  type: "array",
  items: { type: "string", minLength: 1 },
} as const;

const aclTagsQuerySchema = {
  anyOf: [aclTagsSchema, { type: "string", minLength: 1 }],
} as const;

const sourceQuerySchema = {
  type: "object",
  properties: {
    tenantId: { type: "string", minLength: 1 },
    aclTags: aclTagsQuerySchema,
  },
  additionalProperties: false,
} as const;

const submitDocumentSchema = {
  type: "object",
  required: ["sourceId", "filePath"],
  properties: {
    sourceId: { type: "string", minLength: 1 },
    filePath: { type: "string", minLength: 1 },
    title: { type: "string", minLength: 1 },
    tenantId: { type: "string", minLength: 1 },
    aclTags: aclTagsSchema,
  },
  additionalProperties: false,
} as const;

const searchSchema = {
  type: "object",
  required: ["query", "sourceIds", "mode"],
  properties: {
    query: { type: "string", minLength: 1 },
    sourceIds: {
      type: "array",
      items: { type: "string", minLength: 1 },
      minItems: 1,
    },
    mode: { type: "string", enum: ["hybrid", "hyperedge", "rg"] },
    topK: { type: "integer", minimum: 1, maximum: 100 },
    tenantId: { type: "string", minLength: 1 },
    aclTags: aclTagsSchema,
  },
  additionalProperties: false,
} as const;

const askSchema = {
  type: "object",
  required: ["query", "sourceIds"],
  properties: {
    query: { type: "string", minLength: 1 },
    sourceIds: {
      type: "array",
      items: { type: "string", minLength: 1 },
      minItems: 1,
    },
    tenantId: { type: "string", minLength: 1 },
    aclTags: aclTagsSchema,
  },
  additionalProperties: false,
} as const;

export async function createHttpApp(
  options: HttpAppOptions,
): Promise<FastifyInstance> {
  const app = options.loggerInstance
    ? Fastify({
        loggerInstance: options.loggerInstance,
        ajv: AJV_OPTIONS,
      })
    : Fastify({ logger: false, ajv: AJV_OPTIONS });
  await app.register(fastifySwagger, {
    openapi: {
      info: {
        title: "Borges API",
        description:
          "Thin HTTP shell over the ingestion, retrieval and agent seams.",
        version: "0.1.0",
      },
    },
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const mapped = toInterfaceError(error);
    if (mapped.status >= 500) {
      request.log.error({ err: error }, "request failed");
    }
    return reply
      .status(mapped.status)
      .send({ error: { code: mapped.code, message: mapped.message } });
  });

  app.setNotFoundHandler((request, reply) =>
    reply.status(404).send({
      error: {
        code: "not_found",
        message: `route not found: ${request.method} ${request.url}`,
      },
    }),
  );

  app.get("/openapi.json", { schema: { hide: true } }, async () =>
    app.swagger(),
  );

  app.get("/health", async () => ({ status: "ok" }));

  app.get<{ Querystring: SourceQuery }>(
    "/sources",
    { schema: { querystring: sourceQuerySchema } },
    async (request) =>
      await options.deps.ingestion.listSources(
        sourceFilter(request.query.tenantId, request.query.aclTags),
      ),
  );

  app.post<{ Body: SubmitDocumentBody }>(
    "/documents",
    { schema: { body: submitDocumentSchema } },
    async (request) =>
      await options.deps.ingestion.submitDocument(
        submitDocumentInput(request.body),
      ),
  );

  app.get<{ Params: JobParams }>("/jobs/:jobId", async (request, reply) => {
    const job = await options.deps.ingestion.getJob(request.params.jobId);
    if (!job) {
      return reply.status(404).send({
        error: {
          code: "job_not_found",
          message: `ingestion job not found: ${request.params.jobId}`,
        },
      });
    }
    return job;
  });

  app.delete<{ Params: DocumentParams }>(
    "/documents/:documentId",
    async (request, reply) => {
      await options.deps.ingestion.deleteDocument(request.params.documentId);
      return reply.status(204).send();
    },
  );

  app.post<{ Body: SearchBody }>(
    "/search",
    { schema: { body: searchSchema } },
    async (request) =>
      await options.deps.retrieval.search(searchRequest(request.body)),
  );

  app.post<{ Body: AskBody }>(
    "/ask",
    { schema: { body: askSchema } },
    async (request) => await options.deps.agent.ask(askRequest(request.body)),
  );

  return app;
}

function sourceFilter(
  tenantId: string | undefined,
  aclTags: string | string[] | undefined,
): SourceFilter {
  const normalized =
    aclTags === undefined || Array.isArray(aclTags) ? aclTags : [aclTags];
  return {
    ...(tenantId === undefined ? {} : { tenantId }),
    ...(normalized === undefined ? {} : { aclTags: normalized }),
  };
}

function submitDocumentInput(body: SubmitDocumentBody): SubmitDocumentInput {
  return {
    sourceId: body.sourceId,
    filePath: body.filePath,
    ...(body.title === undefined ? {} : { title: body.title }),
    ...(body.tenantId === undefined ? {} : { tenantId: body.tenantId }),
    ...(body.aclTags === undefined ? {} : { aclTags: body.aclTags }),
  };
}

function searchRequest(body: SearchBody): SearchRequest {
  return {
    query: body.query,
    sourceIds: body.sourceIds,
    mode: body.mode,
    topK: body.topK ?? DEFAULT_TOP_K,
    ...(body.tenantId === undefined ? {} : { tenantId: body.tenantId }),
    ...(body.aclTags === undefined ? {} : { aclTags: body.aclTags }),
  };
}

function askRequest(body: AskBody): AskRequest {
  return {
    query: body.query,
    sourceIds: body.sourceIds,
    ...(body.tenantId === undefined ? {} : { tenantId: body.tenantId }),
    ...(body.aclTags === undefined ? {} : { aclTags: body.aclTags }),
  };
}
