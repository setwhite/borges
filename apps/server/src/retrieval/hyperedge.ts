import { sql } from "drizzle-orm";
import type { DbClient, DbTransaction } from "../storage/db.js";
import { toRetrievalError } from "./errors.js";
import {
  type ChunkCandidate,
  type ChunkRow,
  type SearchHit,
  candidateFromRow,
} from "./hit.js";
import {
  type SearchScope,
  applyHnswSettings,
  candidatePoolSize,
  scopePredicate,
  textList,
  uuidList,
  vectorLiteral,
} from "./prefilter.js";
import { type Reranker, rerankCandidates } from "./reranker.js";

const SEED_EVENT_LIMIT = 12;
const SEED_ENTITY_LIMIT = 12;
const MAX_ENTITY_TOKENS = 8;

interface HyperedgeSearchInput {
  db: DbClient;
  scope: SearchScope;
  query: string;
  queryVector: number[];
  topK: number;
  reranker: Reranker;
}

export async function hyperedgeSearch(
  input: HyperedgeSearchInput,
): Promise<SearchHit[]> {
  const candidateLimit = candidatePoolSize(input.topK);
  let candidates: ChunkCandidate[];
  try {
    candidates = await expandFromSeeds(input, candidateLimit);
  } catch (error) {
    throw toRetrievalError(error, "hyperedge_failed", "hyperedge");
  }
  return await rerankCandidates({
    reranker: input.reranker,
    mode: "hyperedge",
    query: input.query,
    candidates,
    topK: input.topK,
  });
}

async function expandFromSeeds(
  input: HyperedgeSearchInput,
  limit: number,
): Promise<ChunkCandidate[]> {
  return await input.db.transaction(async (tx) => {
    await applyHnswSettings(tx, limit);
    const seedEventIds = await selectSeedEvents(tx, input);
    const seedEntityIds = await selectSeedEntities(tx, input);
    if (seedEventIds.length === 0 && seedEntityIds.length === 0) {
      return [];
    }
    const linkedEntityIds = await selectEventEntityIds(tx, seedEventIds);
    const entityIds = [...new Set([...seedEntityIds, ...linkedEntityIds])];
    const result = await tx.execute<ChunkRow>(sql`
      with neighbour_event as (
        select ee.event_id, count(distinct ee.entity_id)::int as shared_count
        from event_entities ee
        where ee.entity_id = any(${uuidList(entityIds)})
        group by ee.event_id
      ),
      candidate_event as (
        select event_id, shared_count from neighbour_event
        union all
        select seed.id, 0 from unnest(${uuidList(seedEventIds)}) as seed(id)
      )
      select c.id as chunk_id, c.document_id, c.source_id, c.content, c.anchor
      from candidate_event ce
      join events ev on ev.id = ce.event_id and ev.is_active = true
      join chunks c on c.id = ev.chunk_id and c.is_active = true
      where ${scopePredicate("c", input.scope)}
      group by c.id, c.document_id, c.source_id, c.content, c.anchor
      order by max(ce.shared_count) desc, c.id
      limit ${limit}
    `);
    return result.rows.map(candidateFromRow);
  });
}

async function selectSeedEvents(
  tx: DbTransaction,
  input: HyperedgeSearchInput,
): Promise<string[]> {
  const result = await tx.execute<{ id: string }>(sql`
    select ev.id
    from events ev
    where ev.embedding is not null
      and ${scopePredicate("ev", input.scope)}
    order by ev.embedding <=> ${vectorLiteral(input.queryVector)}::vector
    limit ${SEED_EVENT_LIMIT}
  `);
  return result.rows.map((row) => row.id);
}

async function selectSeedEntities(
  tx: DbTransaction,
  input: HyperedgeSearchInput,
): Promise<string[]> {
  const tokens = entityTokens(input.query);
  if (tokens.length === 0) {
    return [];
  }
  const result = await tx.execute<{ id: string }>(sql`
    select e.id
    from entities e
    where ${scopePredicate("e", input.scope, { isActive: false })}
      and exists (
        select 1
        from unnest(${textList(tokens)}) as token(value)
        where position(lower(token.value) in lower(e.name)) > 0
      )
    limit ${SEED_ENTITY_LIMIT}
  `);
  return result.rows.map((row) => row.id);
}

async function selectEventEntityIds(
  tx: DbTransaction,
  seedEventIds: string[],
): Promise<string[]> {
  if (seedEventIds.length === 0) {
    return [];
  }
  const result = await tx.execute<{ entity_id: string }>(sql`
    select distinct ee.entity_id
    from event_entities ee
    where ee.event_id = any(${uuidList(seedEventIds)})
  `);
  return result.rows.map((row) => row.entity_id);
}

function entityTokens(query: string): string[] {
  const tokens = new Set<string>();
  for (const token of query.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (token.length >= 2) {
      tokens.add(token);
    }
  }
  return [...tokens].slice(0, MAX_ENTITY_TOKENS);
}
