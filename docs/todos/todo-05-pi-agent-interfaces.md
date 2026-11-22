# todo-05 Pi SDK 智能体与三入口协议层

- [ ] 未开始
- Spec: docs/specs/phase1-core.md
- 验收: AC6、AC7

## 交付物

- 实现 `apps/server/src/agent/`：基于 Pi SDK（`pi-ai` / `pi-agent-core`）封装多轮检索分析循环，注册 `hybrid`、`hyperedge` 与 `rg` 工具，落实强制 `Citation` 回溯校验与低相关性拒答守卫。
- 实现 `apps/server/src/interfaces/http/`（Fastify REST + OpenAPI）、`interfaces/mcp/`（`@modelcontextprotocol/sdk` MCP Server）与 `interfaces/cli/`（Agent-First `borges` CLI，默认 JSON 信封 + `--format text`）。
- 在 `AgentSeam` 与 `InterfaceSeam` 补齐引用、拒答与协议契约测试，跑通全量 `just check`。

## 前置

- `docs/todos/todo-04-tri-mode-retrieval.md`
