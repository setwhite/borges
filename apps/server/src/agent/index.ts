import type { Anchor } from "../contracts/evidence-ir.js";

export interface Citation {
  chunkId: string;
  sourceId: string;
  anchor: Anchor;
}

export interface AskRequest {
  query: string;
  sourceIds: string[];
  tenantId?: string;
  aclTags?: string[];
}

export interface AskResponse {
  answer: string;
  citations: Citation[];
  refused: boolean;
}

export interface AgentSeam {
  ask(request: AskRequest): Promise<AskResponse>;
}
