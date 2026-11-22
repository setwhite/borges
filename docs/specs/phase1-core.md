# Phase 1 核心闭环规格

## 问题

构建 Borges 第一阶段端到端闭环：支持本地 PDF、本地音频与纯文本/代码文件经统一证据包入库至 ParadeDB，提供 `hybrid`、`hyperedge` 与 `rg` 三模式检索，并由 Pi SDK 智能体对外提供带强制引用与拒答能力的 HTTP、MCP 与 CLI 入口。

## 契约

- 跨语言证据包 `EvidenceIR`
  - 定义位于 `schemas/evidence-ir.schema.json`，包含 `documentMeta`（`title`、`mediaType`、`contentHash`、`parserEngine`）与 `segments[]`。
  - 每个 `segment` 包含 `text` 与强类型联合字段 `anchor`，不合法状态不可表达：
    - 文档页码锚点：`{ kind: "page", pageNumber: number, sectionPath: string[] }`
    - 音视频时间锚点：`{ kind: "time", startMs: number, endMs: number, speaker?: string }`
    - 文本与代码行号锚点：`{ kind: "line", filePath: string, startLine: number, endLine: number }`
- 本地 FastAPI 解析服务契约
  - `GET /health` 返回服务状态与各已注册解析引擎的可用性列表（引擎名、支持扩展名、`available` 与不可用原因）。
  - `POST /parse` 接收本地文件路径与可选引擎名，返回 `EvidenceIR` JSON；遇到不支持格式、损坏文件或上游 API 超时时返回非 2xx 状态码与结构化错误体 `{ code, message, retryable }`。
- 入库状态机与版本控制
  - `IngestionJob.status` 为显式枚举：`PENDING | PARSING | INDEXING | READY | FAILED`。
  - 同信源下 `content_hash` 相同的重复提交保持幂等，不生成重复文档与分块。
  - 同信源下同名文档内容变更时版本号加 1，旧版本分块与事件关联在同一事务内原子失效，仅新版本参与检索。
- 分块与索引契约
  - 分块前识别受保护区间（代码块、表格、公式），不从中间切开；Markdown 表格跨块时前置补齐表头行。
  - `chunks.content` 只存逐字原文，`chunks.context_header` 单独落库；向量与 BM25 索引拼接两者。
  - `extractHyperedge` 为文档/信源级可选开关，开启时抽取 `Event`、`Entity` 与关联表，关闭时不产生额外 LLM 抽取调用。
- 检索契约 `search(SearchRequest)`
  - 入参：`query`、`sourceIds`、`mode: "hybrid" | "hyperedge" | "rg"`、`topK`、预留过滤字段 `tenantId` 与 `aclTags`。
  - `hybrid`：并行执行 `pg_search` BM25 与 `pgvector` Dense（事务内设 `hnsw.iterative_scan = strict_order`），应用层 RRF 融合后经 Rerank 返回。
  - `hyperedge`：先召回种子实体与事件，再通过 SQL 沿共享实体扩展局部超边，精排后统一映射回原始 `Chunk`。
  - `rg`：通过 `execFile("rg", ["--json", ...])` 仅扫描目标 `sourceIds` 对应只读沙箱镜像，返回带 `line` 锚点的命中片段。
  - 任一召回路径或外部 Rerank 失败时显式返回结构化错误，不静默降级为空结果。
- 智能体与三入口契约
  - `ask(AskRequest)` 经 Pi SDK 驱动多轮工具调用，自主路由或组合 `hybrid`、`hyperedge` 与 `rg`。
  - 输出包含 `answer`、`citations[]`（每条绑定 `chunkId`、`sourceId` 与原始 `anchor`）与显式布尔字段 `refused`。
  - 当检索命中为空或最高相关性低于拒答阈值时，返回 `refused: true` 与空 `citations`，禁止编造事实或引用。
  - `borges` CLI 默认输出稳定 JSON 信封并将错误码映射为非零退出码，`--format text` 输出人类可读文本；MCP Server 暴露 `search`、`ask` 与 `list_sources` 工具。

## 验收

- AC1：在仓库根目录运行 `just check`，TypeScript 侧（`biome check`、`tsc --noEmit`、`dependency-cruiser`、`vitest run`）与 Python 侧（`ruff check`、`ruff format --check`、`basedpyright`、`pytest`）全部通过；ParadeDB 迁移后 `pgvector` 与 `pg_search` 扩展可用，核心表均包含 `tenant_id` 与 `acl` 列。失败判据：任一检查非零退出或缺失预留列。
- AC2：在 `ParserWorkerSeam` 分别调用 `GET /health` 与 `POST /parse`（输入样例 PDF 与样例音频），返回 `200` 且响应体通过 `schemas/evidence-ir.schema.json` 校验，PDF 片段带合法 `pageNumber >= 1`，音频片段满足 `startMs < endMs`；传入损坏文件时返回 4xx/5xx 与 `{ code, message, retryable }`。失败判据：Schema 校验失败、锚点非法或错误体缺失字段。
- AC3：经 `IngestionSeam` 向同一信源重复提交相同文件两次，数据库仅保留 1 条文档记录与 1 份分块；提交同名修改版文件后，检索旧版独有词条返回 0 条，检索新版独有词条命中新版本分块。失败判据：出现重复分块或旧版本仍可被召回。
- AC4：经 `IngestionSeam` 同批提交 1 个损坏文件与 1 个正常文件，损坏文件的 `IngestionJob` 最终状态为 `FAILED` 且含非空错误码，正常文件流转至 `READY` 并可被检索。失败判据：整批中断或状态未落盘。
- AC5：经 `RetrievalSeam` 对已入库的 PDF、音频与代码语料分别执行 `hybrid`、`hyperedge` 与 `rg` 检索，三种模式均返回带完整对应 `anchor`（`page` / `time` / `line`）的命中列表；传入不匹配的 `tenantId` 或 `aclTags` 时返回 0 条；模拟某路检索故障时抛出明确错误而非返回空数组。失败判据：任一模式无命中、锚点缺失、预过滤失效或异常被静默吞掉。
- AC6：经 `AgentSeam` 提问语料内事实，返回 `refused: false` 且 `citations` 非空，每条引用的 `chunkId` 与 `anchor` 均与库内记录一致；提问语料外无关问题时返回 `refused: true` 且 `citations` 为空。失败判据：出现无法回溯的幻觉引用或库外问题未拒答。
- AC7：经 `InterfaceSeam` 分别调用 HTTP REST API、MCP Server（`list_sources` / `search` / `ask`）与 `borges` CLI（默认 JSON 输出与 `--format text`），三者返回与领域层一致的结构化数据；CLI 传入非法参数时返回非零退出码与 JSON 错误信封。失败判据：协议字段漂移或错误退出码为 0。

## 不做的

- 不做 Web 前端工作台与桌面客户端。
- 不做用户登录、多租户鉴权与 RBAC 管理后台（仅在 Schema 与检索查询中预留 `tenant_id` 与 `acl` 字段）。
- Phase 1 不做本地视频抽帧流水线、在线视频链接抓取、Office 文档（Docling / MarkItDown）与独立图片解析，全部留待 Phase 2 挂载到同一 `ParserWorkerSeam`。
- Phase 1 不做离线定量评测看板（Eval Harness）与智能体写操作审批流（HITL）。
