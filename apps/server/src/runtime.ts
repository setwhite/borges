import type { FastifyInstance } from "fastify";
import { type Logger, pino } from "pino";
import { type AgentSeam, createDefaultAgentService } from "./agent/index.js";
import {
  type IngestionSeam,
  createIngestionService,
} from "./ingestion/index.js";
import type { InterfaceDependencies } from "./interfaces/dependencies.js";
import { createHttpApp } from "./interfaces/http/index.js";
import {
  type Reranker,
  type RetrievalSeam,
  createDefaultReranker,
  createDefaultRetrievalService,
} from "./retrieval/index.js";
import { type Database, createDatabase } from "./storage/db.js";

export interface AppRuntimeOptions {
  env?: NodeJS.ProcessEnv;
}

export interface AppRuntime {
  deps: InterfaceDependencies;
  database: Database;
  logger: Logger;
  http(): Promise<FastifyInstance>;
  close(): Promise<void>;
}

export function createAppRuntime(options: AppRuntimeOptions = {}): AppRuntime {
  const env = options.env ?? process.env;
  const database = createDatabase(env.DATABASE_URL);
  const logger = pino({ level: env.LOG_LEVEL ?? "info" }, pino.destination(2));
  const ingestion = memoize<IngestionSeam>(() =>
    createIngestionService({ db: database.db, env }),
  );
  const reranker = memoize<Reranker>(() => createDefaultReranker(env));
  const retrieval = memoize<RetrievalSeam>(() =>
    createDefaultRetrievalService({
      db: database.db,
      env,
      reranker: reranker(),
    }),
  );
  const agent = memoize<AgentSeam>(() =>
    createDefaultAgentService({
      retrieval: retrieval(),
      env,
      reranker: reranker(),
    }),
  );
  const deps: InterfaceDependencies = {
    get ingestion() {
      return ingestion();
    },
    get retrieval() {
      return retrieval();
    },
    get agent() {
      return agent();
    },
  };
  return {
    deps,
    database,
    logger,
    http: () => createHttpApp({ deps, loggerInstance: logger }),
    close: async () => {
      await database.close();
    },
  };
}

function memoize<T>(factory: () => T): () => T {
  let value: { current: T } | null = null;
  return () => {
    value ??= { current: factory() };
    return value.current;
  };
}
