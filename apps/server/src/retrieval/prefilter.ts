import { type SQL, sql } from "drizzle-orm";
import type { DbTransaction } from "../storage/db.js";

const DEFAULT_TENANT_ID = "default";

const CANDIDATE_POOL_FLOOR = 20;
const CANDIDATE_POOL_MULTIPLIER = 4;
const HNSW_EF_SEARCH_FLOOR = 64;
const HNSW_EF_SEARCH_CEILING = 1000;

export interface SearchScope {
  tenantId: string;
  aclTags: string[];
  sourceIds: string[];
}

interface SearchScopeInput {
  tenantId?: string | undefined;
  aclTags?: string[] | undefined;
  sourceIds: string[];
}

export function resolveScope(input: SearchScopeInput): SearchScope {
  const tenantId = input.tenantId?.trim() ?? "";
  return {
    tenantId: tenantId.length > 0 ? tenantId : DEFAULT_TENANT_ID,
    aclTags: unique(input.aclTags ?? []),
    sourceIds: unique(input.sourceIds),
  };
}

export function uuidList(values: readonly string[]): SQL {
  const items = sql.join(
    values.map((value) => sql`${value}::uuid`),
    sql`, `,
  );
  return sql`ARRAY[${items}]::uuid[]`;
}

export function textList(values: readonly string[]): SQL {
  const items = sql.join(
    values.map((value) => sql`${value}::text`),
    sql`, `,
  );
  return sql`ARRAY[${items}]::text[]`;
}

export function scopePredicate(
  alias: string,
  scope: SearchScope,
  options: { isActive?: boolean } = {},
): SQL {
  const column = (name: string) => sql.raw(`${alias}.${name}`);
  const activeOnly =
    (options.isActive ?? true) ? [sql`${column("is_active")} = true`] : [];
  return sql.join(
    [
      sql`${column("tenant_id")} = ${scope.tenantId}`,
      ...activeOnly,
      sql`(${column("acl")} && ${textList(scope.aclTags)} or cardinality(${column("acl")}) = 0)`,
      sql`${column("source_id")} = ANY(${uuidList(scope.sourceIds)})`,
    ],
    sql` and `,
  );
}

export function candidatePoolSize(topK: number): number {
  return Math.max(CANDIDATE_POOL_FLOOR, topK * CANDIDATE_POOL_MULTIPLIER);
}

export function vectorLiteral(values: readonly number[]): string {
  return `[${values.join(",")}]`;
}

export async function applyHnswSettings(
  tx: DbTransaction,
  candidateLimit: number,
): Promise<void> {
  await tx.execute(sql`set local hnsw.iterative_scan = strict_order`);
  await tx.execute(
    sql.raw(`set local hnsw.ef_search = ${clampEfSearch(candidateLimit)}`),
  );
}

function clampEfSearch(candidateLimit: number): number {
  return Math.min(
    HNSW_EF_SEARCH_CEILING,
    Math.max(HNSW_EF_SEARCH_FLOOR, Math.trunc(candidateLimit)),
  );
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
