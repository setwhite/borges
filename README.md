# borges

> 施工中：Phase 1 正在开发，接口、表结构与契约都可能随时变动。

Borges 是一个本地优先的多模态知识库。它把 PDF 与音频解析成统一的 Evidence IR，写入 Postgres（pgvector + ParadeDB pg_search），再通过三种检索模式与 agent 接口返回带页码、时间或行号锚点的结果。

## 进度

- [x] todo-01 双栈骨架：ParadeDB 迁移、7 张核心表含 tenant_id 与 acl
- [x] todo-02 解析服务：本地 FastAPI worker，MinerU PDF 与 DeepSeek ASR 两个插件
- [ ] todo-03 入库与索引（AC3、AC4）
- [ ] todo-04 三模式检索：hybrid / hyperedge / rg（AC5）
- [ ] todo-05 Pi Agent 接口：HTTP、MCP、CLI（AC6、AC7）

## 组成

| 路径 | 说明 |
| --- | --- |
| `apps/server` | TypeScript 服务端，按 ingestion / indexing / retrieval / agent / interfaces 切片 |
| `workers/parser` | Python + FastAPI 无状态解析 worker，只产出 Evidence IR |
| `schemas/evidence-ir.schema.json` | 双端共享的契约，Pydantic 与 zod 都按它校验 |
| `docs/` | 规格、架构、todo、审计报告 |

## 快速开始

前置：Node 22、pnpm 9、uv、Docker、ripgrep。

```bash
pnpm install
(cd workers/parser && uv sync)
cp .env.example .env      # 填 DEEPSEEK_API_KEY / MINERU_API_TOKEN
just db-up                # 启动 ParadeDB 容器
just db-migrate
just check                # 双端全部门禁
```

单独起解析服务：

```bash
just parser-serve         # 只监听 127.0.0.1:8001
curl -s -X POST http://127.0.0.1:8001/parse \
  -H 'content-type: application/json' \
  -d '{"filePath":"C:/path/to/sample.pdf"}'
```

## 文档

- [Phase 1 验收标准](docs/specs/phase1-core.md)：AC1–AC7
- [架构与不变量](docs/ARCHITECTURE.md)：seam 边界、锚点保真、过滤召回安全
- [开发计划](docs/todos/)：按 AC 拆分的 todo

## 许可证

[AGPL-3.0](LICENSE)。可以自用、修改、分发；如果把修改后的版本作为网络服务对外提供，必须同样以 AGPL-3.0 公开源码。商业授权可另行洽谈。
