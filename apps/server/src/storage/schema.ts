import { sql } from "drizzle-orm";
import {
  boolean,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
  vector,
} from "drizzle-orm/pg-core";
import type { Anchor } from "../contracts/evidence-ir.js";

export const ingestionJobStatusEnum = pgEnum("ingestion_job_status", [
  "PENDING",
  "PARSING",
  "INDEXING",
  "READY",
  "FAILED",
]);

export const sources = pgTable("sources", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: text("tenant_id").notNull().default("default"),
  acl: text("acl").array().notNull().default(sql`ARRAY[]::text[]`),
  name: text("name").notNull(),
  extractHyperedge: boolean("extract_hyperedge").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const documents = pgTable("documents", {
  id: uuid("id").defaultRandom().primaryKey(),
  sourceId: uuid("source_id")
    .notNull()
    .references(() => sources.id, { onDelete: "cascade" }),
  tenantId: text("tenant_id").notNull().default("default"),
  acl: text("acl").array().notNull().default(sql`ARRAY[]::text[]`),
  title: text("title").notNull(),
  mediaType: text("media_type").notNull(),
  contentHash: text("content_hash").notNull(),
  version: integer("version").notNull().default(1),
  isActive: boolean("is_active").notNull().default(true),
  parserEngine: text("parser_engine").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const ingestionJobs = pgTable("ingestion_jobs", {
  id: uuid("id").defaultRandom().primaryKey(),
  documentId: uuid("document_id").references(() => documents.id, {
    onDelete: "set null",
  }),
  sourceId: uuid("source_id")
    .notNull()
    .references(() => sources.id, { onDelete: "cascade" }),
  tenantId: text("tenant_id").notNull().default("default"),
  acl: text("acl").array().notNull().default(sql`ARRAY[]::text[]`),
  status: ingestionJobStatusEnum("status").notNull().default("PENDING"),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const chunks = pgTable("chunks", {
  id: uuid("id").defaultRandom().primaryKey(),
  documentId: uuid("document_id")
    .notNull()
    .references(() => documents.id, { onDelete: "cascade" }),
  sourceId: uuid("source_id")
    .notNull()
    .references(() => sources.id, { onDelete: "cascade" }),
  tenantId: text("tenant_id").notNull().default("default"),
  acl: text("acl").array().notNull().default(sql`ARRAY[]::text[]`),
  seq: integer("seq").notNull(),
  content: text("content").notNull(),
  contextHeader: text("context_header").notNull().default(""),
  searchText: text("search_text").notNull(),
  anchor: jsonb("anchor").$type<Anchor>().notNull(),
  embedding: vector("embedding", { dimensions: 1536 }),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const events = pgTable("events", {
  id: uuid("id").defaultRandom().primaryKey(),
  chunkId: uuid("chunk_id")
    .notNull()
    .references(() => chunks.id, { onDelete: "cascade" }),
  documentId: uuid("document_id")
    .notNull()
    .references(() => documents.id, { onDelete: "cascade" }),
  sourceId: uuid("source_id")
    .notNull()
    .references(() => sources.id, { onDelete: "cascade" }),
  tenantId: text("tenant_id").notNull().default("default"),
  acl: text("acl").array().notNull().default(sql`ARRAY[]::text[]`),
  summary: text("summary").notNull(),
  embedding: vector("embedding", { dimensions: 1536 }),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const entities = pgTable("entities", {
  id: uuid("id").defaultRandom().primaryKey(),
  sourceId: uuid("source_id")
    .notNull()
    .references(() => sources.id, { onDelete: "cascade" }),
  tenantId: text("tenant_id").notNull().default("default"),
  acl: text("acl").array().notNull().default(sql`ARRAY[]::text[]`),
  name: text("name").notNull(),
  entityType: text("entity_type").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const eventEntities = pgTable(
  "event_entities",
  {
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    entityId: uuid("entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    tenantId: text("tenant_id").notNull().default("default"),
    acl: text("acl").array().notNull().default(sql`ARRAY[]::text[]`),
  },
  (table) => [primaryKey({ columns: [table.eventId, table.entityId] })],
);
