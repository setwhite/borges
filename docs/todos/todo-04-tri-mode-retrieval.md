# todo-04 三模式检索引擎（Hybrid、动态超边与 rg）

- [ ] 未开始
- Spec: docs/specs/phase1-core.md
- 验收: AC5

## 交付物

- 实现 `apps/server/src/retrieval/` 统一 `search` 入口与 `tenantId`/`aclTags` 预过滤。
- 实现 `hybrid` 模式：并行执行 `pg_search` BM25 与 `pgvector` Dense（事务内设 `hnsw.iterative_scan = strict_order`），应用层 RRF 融合后调用 Rerank。
- 实现 `hyperedge` 模式：种子召回、SQL 共享实体动态扩展、精排与原始 `Chunk` 回溯。
- 实现 `rg` 模式：`execFile("rg", ["--json", ...])` 沙箱目录精确检索与 `line` 锚点映射。
- 在 `RetrievalSeam` 补齐三模式召回、预过滤与单路异常传播测试。

## 前置

- `docs/todos/todo-03-ingestion-indexing.md`
