# todo-03 入库状态机与索引管线

- [ ] 未开始
- Spec: docs/specs/phase1-core.md
- 验收: AC3、AC4

## 交付物

- 实现 `apps/server/src/ingestion/`：SHA-256 幂等判重、同名文档原子版本替换、显式 `IngestionJob` 状态机、纯文本/代码直读与只读沙箱镜像同步、调用本地 FastAPI Worker（带超时与 `x-request-id` 透传）。
- 实现 `apps/server/src/indexing/`：受保护区间识别、Markdown 跨块表格表头自动补齐、独立 `context_header` 生成落库、向量与 BM25 写入、可选 `Event`/`Entity` 抽取入库。
- 在 `IngestionSeam` 补齐幂等、版本替换与单文件故障隔离测试。

## 前置

- `docs/todos/todo-02-parser-worker.md`
