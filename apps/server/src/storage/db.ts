import { type NodePgDatabase, drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.js";

export type DbClient = NodePgDatabase<typeof schema>;
type TransactionCallback = Parameters<DbClient["transaction"]>[0];
export type DbTransaction = Parameters<TransactionCallback>[0];

export interface Database {
  db: DbClient;
  close(): Promise<void>;
}

export function createDatabase(
  connectionString: string | undefined = process.env.DATABASE_URL,
): Database {
  if (!connectionString) {
    throw new Error("DATABASE_URL is required to create a database connection");
  }
  const pool = new Pool({ connectionString });
  const db = drizzle(pool, { schema });
  return {
    db,
    close: async () => {
      await pool.end();
    },
  };
}
