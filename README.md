# borges

> 施工中：Phase 1 正在开发，接口、表结构与契约都可能随时变动。

Borges 是一个本地优先的多模态知识库。它把 PDF 与音频解析成统一的 Evidence IR，写入 Postgres（pgvector + ParadeDB pg_search），再通过三种检索模式与 agent 接口返回带页码、时间或行号锚点的结果。

## 进度

- [x] [todo-01 双栈骨架](docs/todos/todo-01-foundation.md)：ParadeDB 迁移、7 张核心表含 tenant_id 与 acl
- [x] [todo-02 解析服务](docs/todos/todo-02-parser-worker.md)：本地 FastAPI worker，MinerU PDF 与 DeepSeek ASR 两个插件
- [x] [todo-03 入库与索引](docs/todos/todo-03-ingestion-indexing.md)：状态机、版本替换、分块与索引
- [x] [todo-04 三模式检索](docs/todos/todo-04-tri-mode-retrieval.md)：hybrid / hyperedge / rg
- [ ] [todo-05 Pi Agent 接口](docs/todos/todo-05-pi-agent-interfaces.md)：HTTP、MCP、CLI

验收标准见 [Phase 1 核心闭环规格](docs/specs/phase1-core.md)（AC1–AC7）。

## 组成

| 路径 | 说明 |
| --- | --- |
| `apps/server` | TypeScript 服务端，按 ingestion / indexing / retrieval / agent / interfaces 切片 |
| `workers/parser` | Python + FastAPI 无状态解析 worker，只产出 Evidence IR |
| `schemas/evidence-ir.schema.json` | 双端共享的契约，Pydantic 与 zod 都按它校验 |
| `docs/` | 规格、架构、ADR、术语、todo 与审计报告 |

## 快速开始

前置：Node 22、pnpm 9、uv、Docker、ripgrep。

```bash
pnpm install
(cd workers/parser && uv sync)
cp .env.example .env      # 填密钥，见「配置」
just db-up                # 启动 ParadeDB 容器
just db-migrate
just check                # 双端 QA 门禁
```

单独起解析服务：

```bash
just parser-serve         # 只监听 127.0.0.1:8001
curl -s -X POST http://127.0.0.1:8001/parse \
  -H 'content-type: application/json' \
  -d '{"filePath":"C:/path/to/sample.pdf"}'
```

## 配置

`cp .env.example .env` 后按文件内注释填写。最小可运行需要：

- `DATABASE_URL`：ParadeDB 连接串，默认指向 `just db-up` 起的容器。
- `EMBEDDING_API_KEY` / `EMBEDDING_BASE_URL` / `EMBEDDING_MODEL`：入库与检索共用，三项必填，缺项在构造时抛错。
- `RERANK_API_KEY` / `RERANK_BASE_URL` / `RERANK_MODEL`：`hybrid` 与 `hyperedge` 精排必填，构造检索引擎时统一校验，只用 `rg` 也不例外。
- `MINERU_API_TOKEN`、`DEEPSEEK_API_KEY`：解析 worker 的两个上游凭据。
- `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `LLM_MODEL`：仅当信源开启 `extract_hyperedge` 时调用。

## 文档

- [架构与不变量](docs/ARCHITECTURE.md)：模块边界、测试 seam、质量门禁
- [领域术语表](docs/GLOSSARY.md)：信源、分块、上下文头等术语与代码标识
- [ADR](docs/adr/)：TypeScript + Python 分工、ParadeDB、Evidence IR、三模式检索四条决策

## 许可证

[AGPL-3.0](LICENSE)。可以自用、修改、分发；如果把修改后的版本作为网络服务对外提供，必须同样以 AGPL-3.0 公开源码。商业授权可另行洽谈。
