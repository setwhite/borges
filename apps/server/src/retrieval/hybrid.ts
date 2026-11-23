import { sql } from "drizzle-orm";
import type { DbClient } from "../storage/db.js";
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
  vectorLiteral,
} from "./prefilter.js";
import { type Reranker, rerankCandidates } from "./reranker.js";

const RRF_K = 60;

interface HybridSearchInput {
  db: DbClient;
  scope: SearchScope;
  query: string;
  queryVector: number[];
  topK: number;
  reranker: Reranker;
}

export async function hybridSearch(
  input: HybridSearchInput,
): Promise<SearchHit[]> {
  const candidateLimit = candidatePoolSize(input.topK);
  const [lexical, dense] = await Promise.allSettled([
    lexicalCandidates(input, candidateLimit),
    denseCandidates(input, candidateLimit),
  ]);
  if (lexical.status === "rejected") {
    throw toRetrievalError(lexical.reason, "bm25_failed", "hybrid");
  }
  if (dense.status === "rejected") {
    throw toRetrievalError(dense.reason, "dense_failed", "hybrid");
  }
  return await rerankCandidates({
    reranker: input.reranker,
    mode: "hybrid",
    query: input.query,
    candidates: fuseByReciprocalRank([lexical.value, dense.value]),
    topK: input.topK,
  });
}

async function lexicalCandidates(
  input: HybridSearchInput,
  limit: number,
): Promise<ChunkCandidate[]> {
  const result = await input.db.execute<ChunkRow>(sql`
    select c.id as chunk_id, c.document_id, c.source_id, c.content, c.anchor
    from chunks c
    where c.search_text @@@ ${input.query}
      and ${scopePredicate("c", input.scope)}
    order by paradedb.score(c.id) desc, c.id
    limit ${limit}
  `);
  return result.rows.map(candidateFromRow);
}

async function denseCandidates(
  input: HybridSearchInput,
  limit: number,
): Promise<ChunkCandidate[]> {
  const vector = vectorLiteral(input.queryVector);
  return await input.db.transaction(async (tx) => {
    await applyHnswSettings(tx, limit);
    const result = await tx.execute<ChunkRow>(sql`
      select c.id as chunk_id, c.document_id, c.source_id, c.content, c.anchor
      from chunks c
      where c.embedding is not null
        and ${scopePredicate("c", input.scope)}
      order by c.embedding <=> ${vector}::vector
      limit ${limit}
    `);
    return result.rows.map(candidateFromRow);
  });
}

function fuseByReciprocalRank(lists: ChunkCandidate[][]): ChunkCandidate[] {
  const fused = new Map<string, { candidate: ChunkCandidate; score: number }>();
  for (const list of lists) {
    list.forEach((candidate, index) => {
      const entry = fused.get(candidate.chunkId) ?? { candidate, score: 0 };
      entry.score += 1 / (RRF_K + index + 1);
      fused.set(candidate.chunkId, entry);
    });
  }
  return [...fused.values()]
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.candidate.chunkId.localeCompare(right.candidate.chunkId),
    )
    .map((entry) => entry.candidate);
}
