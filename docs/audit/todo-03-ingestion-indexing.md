# todo-03 入库状态机与索引管线审计报告

结论：通过（第 3 轮；前两轮 3 项缺陷已全部修复并复验）

## 复审记录

- 已修复 — 镜像写入失败不再逃逸：`writeMirrorFile` 移入 try（`apps/server/src/ingestion/index.ts:186`），失败走 `compensateFailedVersion`（:261）：删除新文档（chunks/events 级联）、重新激活旧版本、事务内标 job `FAILED`；READY 置位移到镜像成功之后（:206）。
  - 复验（新建文档）：`{"thrown":null,"job":{"status":"FAILED","code":"ENOTDIR","documentId":null},"documents":0,"chunkRows":0,"mirrorEntries":[]}`。
  - 复验（同名改版）：`documents=[{version:1,isActive:true}]`、`chunkDocs=[v1]`、`allActiveChunks=true`、`allActiveEvents=true`、`oldHits=1`、`newHits=0`、镜像仍是 v1 内容。
  - 复验（重试）：修复镜像根后重试 → `READY` 且镜像存在。
- 已修复 — 超长标题：`resolveMirrorPath` 按 UTF-8 字节校验每段（`apps/server/src/ingestion/mirror.ts:40-47`，上限 255），在写库前调用（index.ts:162）。复验：300 字符标题 → `FAILED` / `invalid_title` / 无文档 / 镜像目录为空。
- 批量隔离在镜像失败下成立：同批提交超长标题文件 + 健康文件 → `{"thrown":null,"long":{"status":"FAILED","code":"invalid_title"},"healthy":{"status":"READY"},"healthyHits":1,"longHits":0}`。
- 前两轮缺陷保持修复：注入 persist 失败时镜像仍是 v1；`.py` 代码块内 `#` 注释不进入 `context_header`（`Section: Install`）。
- `just check-ts` 全绿：biome、tsc、dependency-cruiser 通过，vitest 23 passed（chunker 7、ingestion.seam 9）。

## 验收

- AC3 通过 — 独立脚本（`apps/server/.tmp/reaudit3-t03.test.ts`，跑完已删）经 `IngestionSeam`：`statuses=["READY","READY","READY"]`、`sameDocument=true`、`documents=[{version:1,isActive:false},{version:2,isActive:true}]`、BM25 `firsttoken=0` / `secondtoken=1`。
- AC4 通过 — `{"broken":{"status":"FAILED","code":"corrupted_file","documentId":null},"healthy":{"status":"READY","code":null},"healthyHits":1}`。
- 范围蔓延 — `compose.yaml:7` 新增 `restart: unless-stopped`，与入库/索引无关。

## 安全前提（已证明）

- TS 客户端 ↔ 真实 FastAPI worker：无 token 启动 `workers/parser`（127.0.0.1:8001），客户端收到 503 → `parser_worker_engine_unavailable`；worker 日志 `request_id` 与客户端 `x-request-id` 完全一致。stub 另证 body 恰为 `{"filePath":"…"}`、422 → `parser_worker_corrupted_file`、静默 → `parser_worker_timeout`。
- 失败补偿不留下半成品：新文档分支 `documents=0 / chunkRows=0`；改版分支只保留 v1 且 chunks/events 全部重新激活、BM25 旧词条恢复命中。

## 质量建议

- `apps/server/src/ingestion/failures.ts:15` — `toIngestionFailure` 直接把 Node errno 当错误码（实测 job errorCode = `ENOTDIR`）。— 依据：错误码是领域契约；建议在 `writeMirrorFile` 包装成 `mirror_write_failed`。
- `apps/server/src/indexing/chunker.ts:237` — 表格续块 `anchor.startLine = firstRow.line`，但 `content` 仍含 2 行表头；按 content 偏移回推行号差 2 行。— 依据：Offset Preservation / 锚点可回溯。
- `apps/server/src/indexing/chunker.ts:181` — 受保护区间无长度上界：4000 行 fenced block（`maxChars=400`）实测单块 129,789 字符；被真实 embedding 服务拒绝未实测（无 API Key），记为 unproven 风险。— 依据：资源边界。
- `apps/server/src/ingestion/index.ts:214` — `deleteDocument` 只删 documents，entities 留在库（实测 `before=1, afterDelete=1`）。— 依据：hyperedge 种子可能命中无事件的孤儿实体。
- `apps/server/src/indexing/index.ts:156` — 0 分块时直接返回，document 已插入且 job 最终标 `READY`；实测 `segments: []` → `READY` + 0 chunks，文档不可检索但状态成功。— 依据：状态机语义。
- `apps/server/src/ingestion/index.ts:139` — 预解析判重只按 `content_hash`，忽略 title；同内容换名提交静默沿用旧 title。— 依据：幂等语义可接受，但调用方拿不到「title 未生效」信号。
- `apps/server/src/ingestion/index.ts:349` — 旧版本只把 `events.is_active` 置 false，`event_entities` 没有 `is_active`；T04 的 hyperedge 查询若不经 `events.is_active` 过滤，旧事件仍会被关联表召回。— 依据：Atomic Versioning 的边界。
- `apps/server/src/ingestion/directText.ts:62` — 直读路径整文件 `readFile` 进内存，无大小上限。— 依据：Fail Fast / 资源边界。
- `docs/ARCHITECTURE.md:11` — 模块职责写了「处理超时、重试与单文档失败隔离」，本切片只有超时与隔离，没有重试入口。— 依据：文档与实现漂移。
- unproven 风险 — `compensateFailedVersion`（index.ts:261）无条件重新激活 `previousDocumentId`；若期间有并发同名任务提交了更新版本，可能撞上 `documents_active_title_idx` 并抛出。无稳定复现手段，仅记录。
