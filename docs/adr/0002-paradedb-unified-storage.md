# ADR-0002 采用 ParadeDB 作为一体化存储底座

## 决定

采用 ParadeDB 官方 Docker 镜像（内置 PostgreSQL、`pgvector` 与 `pg_search` BM25 扩展）作为唯一持久化与检索存储；所有核心表从首期起预留 `tenant_id` 与 `acl` 字段，通过 `drizzle-orm` 管理 Schema 与迁移。

## 为什么

- 单一 PostgreSQL 实例同时承载信源元数据、`IngestionJob` 状态机、向量索引、原生 BM25 词法索引以及 `Event` / `Entity` 关系表，文档版本替换与索引更新可在同一事务内保证强一致。
- 避免额外部署和维护独立向量库或搜索引擎（如 Qdrant、Elasticsearch），也无需自研中文分词与倒排索引；该组合已有 [WeKnora 默认检索存储](https://weknora.weixin.qq.com/docs/03-features/05-retrieval-engines.html) 的生产验证。
- 预留 `tenant_id` 与 `acl` 字段可让未来多租户与 RBAC 预过滤在单库内直接完成，无需迁移存储架构。

## 代价

- 部署强依赖 ParadeDB 镜像或支持 `pgvector` 与 `pg_search` 的 PostgreSQL 环境，无法直接运行在未装扩展的普通托管库上。
- 带选择性过滤条件执行 HNSW 向量查询时，必须显式开启 `pgvector >= 0.8` 的 `iterative_scan` 参数并严格对齐索引类型转换表达式，否则会漏召回或退化为全表扫描。
