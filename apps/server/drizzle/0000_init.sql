CREATE EXTENSION IF NOT EXISTS pgcrypto;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_search;
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE ingestion_job_status AS ENUM ('PENDING', 'PARSING', 'INDEXING', 'READY', 'FAILED');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL DEFAULT 'default',
  acl text[] NOT NULL DEFAULT ARRAY[]::text[],
  name text NOT NULL,
  extract_hyperedge boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  tenant_id text NOT NULL DEFAULT 'default',
  acl text[] NOT NULL DEFAULT ARRAY[]::text[],
  title text NOT NULL,
  media_type text NOT NULL,
  content_hash text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  is_active boolean NOT NULL DEFAULT true,
  parser_engine text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS documents_active_hash_idx
  ON documents (source_id, content_hash)
  WHERE is_active = true;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS documents_active_title_idx
  ON documents (source_id, title)
  WHERE is_active = true;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS ingestion_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid REFERENCES documents(id) ON DELETE SET NULL,
  source_id uuid NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  tenant_id text NOT NULL DEFAULT 'default',
  acl text[] NOT NULL DEFAULT ARRAY[]::text[],
  status ingestion_job_status NOT NULL DEFAULT 'PENDING',
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  tenant_id text NOT NULL DEFAULT 'default',
  acl text[] NOT NULL DEFAULT ARRAY[]::text[],
  seq integer NOT NULL,
  content text NOT NULL,
  context_header text NOT NULL DEFAULT '',
  search_text text NOT NULL,
  anchor jsonb NOT NULL,
  embedding vector(1536),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS chunks_embedding_hnsw_idx
  ON chunks USING hnsw (embedding vector_cosine_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS chunks_search_bm25_idx
  ON chunks USING bm25 (id, search_text, tenant_id, source_id)
  WITH (key_field = 'id');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chunk_id uuid NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  tenant_id text NOT NULL DEFAULT 'default',
  acl text[] NOT NULL DEFAULT ARRAY[]::text[],
  summary text NOT NULL,
  embedding vector(1536),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS events_embedding_hnsw_idx
  ON events USING hnsw (embedding vector_cosine_ops);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS entities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  tenant_id text NOT NULL DEFAULT 'default',
  acl text[] NOT NULL DEFAULT ARRAY[]::text[],
  name text NOT NULL,
  entity_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS entities_source_name_idx
  ON entities (source_id, name);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS event_entities (
  event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  entity_id uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  tenant_id text NOT NULL DEFAULT 'default',
  acl text[] NOT NULL DEFAULT ARRAY[]::text[],
  PRIMARY KEY (event_id, entity_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS event_entities_entity_idx
  ON event_entities (entity_id, event_id);
