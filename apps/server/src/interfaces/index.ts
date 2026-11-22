import type { AgentSeam } from "../agent/index.js";
import type { IngestionSeam } from "../ingestion/index.js";
import type { RetrievalSeam } from "../retrieval/index.js";

export interface InterfaceDependencies {
  ingestion: IngestionSeam;
  retrieval: RetrievalSeam;
  agent: AgentSeam;
}
