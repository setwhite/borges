# Borges 架构

Borges 是面向企业场景的多模态知识底座与智能体系统。系统采用 TypeScript 主服务承载核心业务与智能体编排，Python 本地解析服务负责异构文档与音视频转换，单一 PostgreSQL 实例承载全部关系数据、向量索引与词法索引。

## 目录与模块职责

按垂直领域切分模块，不按技术层水平切分，禁用 `utils`、`common`、`helpers`、`misc` 目录。跨切面基础设施集中在 `storage/`（Schema 与连接）与 `contracts/`（契约校验），只被垂直切片依赖。

- `apps/server/src/ingestion/`
  - 接收文档提交，计算 SHA-256 判重并维护文档版本号。
  - 驱动 `IngestionJob` 显式状态机，处理超时与单文档失败隔离。
  - 纯文本与代码格式由本模块直读，复杂格式调用本地 FastAPI 解析服务获取 `EvidenceIR`。
  - 为支持 `rg` 检索的信源维护按 `source_id` 隔离的只读原文镜像。
- `apps/server/src/indexing/`
  - 消费 `EvidenceIR`，识别代码块、表格与公式等受保护区间后执行分块。
  - 跨块表格自动补齐表头行，独立生成并落库 `context_header`。
  - 写入向量索引、BM25 词法索引，并按需执行 `Event` 与 `Entity` 抽取入库。
- `apps/server/src/retrieval/`
  - 暴露统一 `search` 入口，按请求路由至 `hybrid`、`hyperedge` 或 `rg` 三种模式。
  - 在查询条件中强制注入 `tenant_id` 与 `acl` 预过滤。
  - 统一返回原始 `Chunk` 内容与定位锚点，任一召回路径报错时显式抛出异常。
- `apps/server/src/agent/`（实现待 todo-05）
  - 基于 [Pi SDK](https://pi.dev/docs/latest/sdk) 驱动多轮检索与分析循环。
  - 根据问题特征自主选择 `hybrid`、`hyperedge` 或 `rg` 工具并执行 Query 改写。
  - 校验回答中的每条 `Citation` 指向真实分块与锚点，证据不足时触发显式拒答。
- `apps/server/src/interfaces/`（实现待 todo-05）
  - 薄外壳层，包含 `http/`（Fastify + OpenAPI）、`mcp/`（MCP Server）与 `cli/`（Agent-First CLI）。
  - 只负责参数解析、协议转换与响应序列化，禁止绕过领域入口直连存储。
- `apps/server/src/storage/`
  - `drizzle-orm` Schema 与连接工厂，是表结构与 `tenant_id`/`acl` 预留列的唯一事实源。
- `apps/server/src/contracts/`
  - `EvidenceIR` 的 zod 契约，字段以 `schemas/evidence-ir.schema.json` 为准。
- `workers/parser/`
  - Python `uv` 维护的本地 FastAPI 解析服务，仅监听 `127.0.0.1`。
  - 维护引擎注册表（引擎名映射至扩展名与解析器类）与可用性探针，只产出 `EvidenceIR` 与原始附件路径，不耦合切块、数据库与主业务模型调用。
- `schemas/evidence-ir.schema.json`
  - 跨语言 `EvidenceIR` 契约的唯一事实源，TypeScript 侧用 `zod`、Python 侧用 `pydantic` v2 对齐校验。

## 技术栈

- Monorepo 与任务入口：`pnpm` workspace、`uv`、`just`（统一 QA 入口 `just check`）。
- 主服务运行时：Node.js 22+、TypeScript 5.x、Fastify（OpenAPI）、`@modelcontextprotocol/sdk`、`commander`、`pino`。
- 智能体运行时：Pi SDK（`pi-ai`、`pi-agent-core`、`@earendil-works/pi-coding-agent`），原生支持 MCP。
- 存储与检索：ParadeDB Docker 镜像（PostgreSQL + `pgvector` + `pg_search` BM25）、`drizzle-orm`、`drizzle-kit`、`pg`。
- 代码精确检索：`ripgrep`（通过 `execFile` 调用 `rg --json`，禁用 shell 拼接）。
- 本地解析服务：Python 3.12+、FastAPI、Uvicorn、`pydantic` v2、`structlog`。
- 解析插件与模型：OpenAI 兼容模型接口（LLM / Embedding / Rerank / VLM）；Phase 1 接入 MinerU API 与云端 ASR API；Phase 2 按需挂载 Docling、MarkItDown、`ffmpeg`、PySceneDetect、`imagehash` 及本地 FunASR / PaddleOCR。
- 接口层与智能体依赖（Fastify、MCP SDK、`commander`、`pino`、Pi SDK）尚未安装，todo-05 接入。

## 核心不变量

- Evidence Fidelity：解析层只产出带定位锚点的 `EvidenceIR`，不提前生成有损摘要替代原文。
- Offset Preservation：`chunks.content` 严格保留逐字原文，`chunks.context_header` 单独落库；索引时拼接两者，溯源与高亮仅依赖 `content` 与原始锚点。
- Filter Recall Safety：带 `source_id`、`tenant_id` 或 `acl` 过滤的向量检索必须在事务内开启 `SET LOCAL hnsw.iterative_scan = strict_order`，并把 `hnsw.ef_search` 设为候选池大小（`max(20, 4 × topK)`，钳制在 64–1000），避免过滤导致 HNSW 漏召回（参考 [WeKnora 检索引擎实践](https://weknora.weixin.qq.com/docs/03-features/05-retrieval-engines.html)）。
- Fail Fast Retrieval：`hybrid` 与 `hyperedge` 路径中任一子查询失败必须显式报错，禁止静默吞错并返回空命中。
- Sandbox Boundary：`rg` 检索必须通过 `execFile` 传参并校验目标目录 `realpath`，严禁跨出对应 `source_id` 镜像目录。
- Atomic Versioning：同名文档更新版本时，旧版本分块失效与新版本分块生效在同一数据库事务内完成。

## Testing Seam 清单

测试只允许经以下公开边界验证行为，禁止 mock 内部协作者或绕过边界查库。

- `ParserWorkerSeam`：本地 FastAPI 服务的 `GET /health` 与 `POST /parse` 接口。
- `IngestionSeam`：`apps/server/src/ingestion/index.ts` 的 `createIngestionService()` 返回的 `submitDocument`、`getJob`、`deleteDocument`。
- `RetrievalSeam`：`apps/server/src/retrieval/index.ts` 的 `createRetrievalService()` 与 `createDefaultRetrievalService()` 返回的 `search`。
- `AgentSeam`：`apps/server/src/agent/index.ts` 的 `ask`（todo-05 实现）。
- `InterfaceSeam`：HTTP REST 端点、MCP 工具调用与 `borges` CLI 命令入口（todo-05 实现）。

## Fitness Functions

- TypeScript 质量门禁：`just check-ts` 跑 `biome check`、`tsc --noEmit`、`depcruise`、`vitest run`。
- 架构规则：`.dependency-cruiser.cjs` 强制禁止循环依赖、跨领域切片 deep import，以及 `interfaces/` 直连 `storage/` 或 `indexing/`。
- Python 质量门禁：`just check-py` 跑 `ruff check`、`ruff format --check`、`basedpyright`、`pytest`。
- 死代码检查：`just check-deadcode` 单独跑 `knip` 与 `vulture`，不并入 `just check`。
- 跨语言契约测试：双端测试共用 `schemas/evidence-ir.schema.json` 验证样例输入输出，任一端字段漂移立即红灯。
