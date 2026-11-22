# todo-01 基础设施与契约骨架

- [x] 已完成
- Spec: docs/specs/phase1-core.md
- 验收: AC1

## 交付物

- 初始化 `pnpm` workspace 与 `workers/parser`（`uv`）双栈目录骨架，创建根目录 `justfile` 提供 `just check` 统一门禁入口。
- 编写 ParadeDB Docker Compose 配置与 `drizzle-orm` 初始迁移（含 `sources`、`documents`、`ingestion_jobs`、`chunks`、`events`、`entities`、`event_entities` 表及 `tenant_id`/`acl` 预留列、`pgvector` 与 `pg_search` 索引）。
- 编写 `schemas/evidence-ir.schema.json` 及 TS（`zod`）与 Python（`pydantic` v2）双端契约校验单测。
- 配置 `dependency-cruiser` 架构边界规则并跑通双端空白基线 QA。

## 前置

无
