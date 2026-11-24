# todo-05 Pi SDK 智能体与三入口协议层审计报告

结论：通过（第 2 轮；上一轮 4 条实跑缺陷已修复并独立复验）

## 复审记录

- 已修复 — 缺陷 1（畸形/空 JSON body 判 500）：`apps/server/src/interfaces/errors.ts:80` 新增 `toClientError`，把 Fastify 自带的 4xx `statusCode` 归一为 `invalid_request`；`apps/server/src/interfaces/http/index.ts:148` 的错误处理器改为统一走 `toInterfaceError`。
  - 复验：`HTTPPROBE malformed-json 400 {"error":{"code":"invalid_request","message":"Body is not valid JSON but content-type is set to 'application/json'"}}`、`empty-body 400 {"error":{"code":"invalid_request","message":"Body cannot be empty ..."}}`。
- 已修复 — 缺陷 2（404 与错误方法绕过统一信封）：`apps/server/src/interfaces/http/index.ts:158` 新增 `setNotFoundHandler`。
  - 复验：`unknown-route 404 {"error":{"code":"not_found","message":"route not found: GET /nope"}}`、`wrong-method 404 {"error":{"code":"not_found","message":"route not found: PUT /search"}}`。
- 已修复 — 缺陷 3（rg 路由绕过拒答阈值）：`apps/server/src/agent/service.ts:73` 的 `onHits` 带上 mode，rg 命中单独收集；`:123` 用注入的 `Reranker` 按用户问题重排（`:171` `rerankRgHits`）；`:141` 的 `resolveCitations` 对 rg 引用按阈值逐条过滤（`:226`）；无 reranker 时 rg-only 证据直接拒答（`:128`）。配套 `apps/server/src/retrieval/index.ts:98` 给 `DefaultRetrievalDependencies` 增加可选 `reranker`，`:109` 复用它，`:187` 导出 `createDefaultReranker`。
  - 复验（真实库 + 语料 `capitalGainsRate`，问题 "What is the capital of France?"）：hybrid 路线 `RGPROBE hybrid-scores [0]`；rg 路线 `rg-hits [1]`。
  - 复验拒答：不注入 reranker、注入全 0 分 reranker、注入按词重叠打分的 reranker，三条路径都返回 `{"refused":true,"citations":[]}`，答案均为 `below the relevance threshold`。
  - 复验不过度拒答：同一探针换成给相关片段 0.95 分的 reranker，`KEEPPROBE {"answer":"The budget is 3.","citations":[{"chunkId":"11111111-...","anchor":{"kind":"line","filePath":"budget.ts","startLine":1,"endLine":1}}],"refused":false}`。
- 已修复 — 缺陷 4（MCP 丢领域错误码）：`apps/server/src/interfaces/mcp/index.ts:90` 新增 `toolResult`，成功与失败都走 JSON。
  - 复验：`MCPPROBE {"content":[{"type":"text","text":"{\"error\":{\"code\":\"rerank_timeout\",\"message\":\"rerank timed out\"}}"}],"isError":true}`。
- 附带修复 — 上一轮质量建议里的 HTTP 类型强转：`apps/server/src/interfaces/http/index.ts:59` 的 `AJV_OPTIONS` 关闭 `coerceTypes` 与 `removeAdditional`；`:68` 新增 `aclTags` 查询串单值归一。
  - 复验：`topK-true 400 body/topK must be integer`、`sourceIds-string 400 body/sourceIds must be array`、`sourceIds-number 400 body/sourceIds/0 must be string`、`tenant-typo 400 body must NOT have additional properties`。
  - 单值与多值查询仍可用：`ACLPROBE 200 200 [{"aclTags":["finance"]},{"aclTags":["finance","legal"]}]`。
- 新增测试 — `apps/server/tests/agent.seam.test.ts` +3 例（rg 命中重排后拒答、无 reranker 时 rg-only 拒答、低分 rg 引用被剥离）；`apps/server/tests/interfaces.seam.test.ts` +4 例（畸形/空 JSON 400、未知路由/方法 404、类型强转与未知字段拒绝、MCP 保留领域错误码）。
- 范围蔓延：无。第 2 轮改动逐项对应上一轮缺陷：`interfaces/errors.ts`、`interfaces/http/index.ts`、`interfaces/mcp/index.ts`、`agent/service.ts`、`agent/tools.ts`、`retrieval/index.ts`（可选 reranker 注入）与两处 seam 测试；没有新增依赖，`docs/todos/` 未改。

## 验收

- AC6 通过 — `pnpm --filter @borges/server exec vitest run tests/agent.seam.test.ts`：9 passed。覆盖语料内提问的引用回溯、库外 chunkId 剥离、零命中与低分拒答、rg 路由重排拒答、无 reranker 的 rg-only 拒答、低分 rg 引用剥离。
  - 独立查库（`.tmp`，已删）：`AGENTPROBE citation-equals-db => {"sameChunkId":true,"sameSourceId":true,"sameAnchor":true}`，比对对象是 `select id, source_id, anchor from chunks where id = <citation.chunkId>` 的真实行。
  - 独立复验 rg 路由：见复审记录缺陷 3，语料外问题三条 reranker 路径均 `refused:true` 且 `citations:[]`。
- AC7 通过 — `pnpm --filter @borges/server exec vitest run tests/interfaces.seam.test.ts`：16 passed。
  - 主路径一致（真实库 e2e，`.tmp` 已删）：`E2E {"domainHits":1,"domainCitations":1,"http":{"search":true,"sources":true,"ask":true,"askStatus":200},"mcp":{"search":true,"sources":true,"ask":true},"cli":{"code":0,"search":true,"askCode":0,"ask":true},"cliText":{"code":0,"first":"The retry budget is 3."}}`，比较对象是同一 `retrieval.search` / `ingestion.listSources` / `agent.ask` 的直接返回。
  - 错误面（实跑）：畸形或空 JSON body 400、未知路由与错误方法结构化 404、MCP 保留 `rerank_timeout`、CLI 非法参数 exit=1 + JSON 信封、`--help`/`--version` exit=0、真实领域错误 `source_not_found` exit=1。
- 全量门禁 — `just check`：biome、`tsc --noEmit`、depcruise（58 modules / 99 dependencies，无违规）、vitest 65 passed、ruff check、ruff format --check、basedpyright、pytest 25 passed，全部 exit=0。
- 「不做的」边界 — 未越过：没有前端、鉴权、RBAC 或 Phase 2 解析改动；新增依赖仍只有本 todo 的三入口与智能体所需。

## 实跑缺陷与安全前提

- 实跑缺陷：无（上一轮 4 条已修复；本轮用同一批探针复跑，全部转为期望行为）。
- 安全前提（已证明）—
  - `ask` 把 `tenantId`/`aclTags` 原样转发到 `retrieval.search`：`RGPROBE forwarded [{"query":"capital","sourceIds":["79e93ba7-..."],"mode":"rg","topK":5,"tenantId":"acme","aclTags":["finance","legal"]}]`。
  - 引用只能来自本次工具返回的 chunk：库外 chunkId 被剥离并拒答；rg 引用还需通过重排阈值。
  - rg 重排不会过度拒答：相关片段得 0.95 时 `refused:false` 且保留 `line` 锚点。
  - `listSources` 的租户 + ACL 规则与检索一致（`tests/ingestion.seam.test.ts` 10 passed）。
  - `HTTPPROBE` 三类类型强转（`topK: true`、`sourceIds: "abc"`、拼错 `tenantid`）现在全部 400，不再静默重写查询范围。
- 未证明（unproven）—
  - 真实 reranker 的 `relevance_score` 量纲：新守卫用同一阈值判定 rg 引用，若供应商返回 logits 或不同尺度，相关命中可能被误杀；`.env` 的 `RERANK_*` 为空，只能用假 provider 验证机制。
  - 真实 LLM 下 `AGENT_REFUSAL_THRESHOLD=0.2` 的实际拒答分布，以及系统提示词的注入防护；缺 LLM 凭据。

## 质量建议

- `apps/server/src/agent/service.ts:123` — rg 命中的重排在 `ask` 内直接调 `Reranker`，异常未包成 `AgentError`；默认实现抛 `RetrievalError` 能映射 502/504，注入的自定义 reranker 抛普通 `Error` 时会变成 500 `internal_error`。— 依据：错误分类一致性。
- `apps/server/src/retrieval/reranker.ts:97` — `relevance_score` 原样当 0..1 使用，`AGENT_REFUSAL_THRESHOLD` 默认 0.2 隐含尺度假设，没有归一或按供应商配置。— 依据：Surface Uncertainty（上一条 unproven 的根因）。
- `apps/server/src/interfaces/errors.ts:42` — 500 分支仍把内部异常原文回给客户端（`internal_error` + `error.message`）。— 依据：Fail Fast 与信息暴露的平衡。
- `apps/server/src/ingestion/index.ts:252`、`apps/server/src/retrieval/prefilter.ts:60` — ACL 可见性谓词两份实现，规则改一处就静默分叉。— 依据：Duplicated Code / SSOT。
- `apps/server/src/interfaces/http/index.ts:250`、`apps/server/src/interfaces/mcp/index.ts:120`、`apps/server/src/interfaces/cli/index.ts:246` — `searchRequest` 三份拷贝，`DEFAULT_TOP_K` 三处；`topK` 上限不一致：HTTP/MCP ≤100、智能体工具 ≤20（`apps/server/src/agent/tools.ts:24`）、CLI 无上限（实测 `--top-k 100000` exit=0 直达 `retrieval.search`）。— 依据：Duplicated Code / Repeated Switches。
- `apps/server/src/agent/model.ts:22` — 配置缺失抛普通 `Error`，`model_config_invalid` 码在此路径用不上，HTTP 侧变成 500 `internal_error` 并回显缺哪个环境变量。— 依据：错误分类一致性。
- `apps/server/src/agent/service.ts:136`、`:149` — 模型输出不可解析、引用无法回溯、工具预算耗尽共用 `UNVERIFIABLE_CITATIONS_ANSWER`；实测 `maxToolCalls=1` 加两次 tool call 得到同一句，调用方分不清原因。— 依据：Mysterious Name / 可诊断性。
- `apps/server/src/agent/service.ts:60` — `hitMap` 只增不减；默认 8 次工具调用 × topK 20 最多累积约 160 条全文。— 依据：资源边界。
- `apps/server/src/interfaces/cli/index.ts:13` — `EXIT_USAGE_ERROR = 2` 不可达：`:86` 用 `||`，而 commander 各错误 `exitCode` 均为 1（实测未知子命令、未知选项、非法枚举都是 exit=1）。— 依据：Subtract Before You Add。
- `apps/server/src/interfaces/cli/index.ts:86` — `borges sources`（缺子命令）输出 `{"ok":false,"error":{"code":"invalid_request","message":"(outputHelp)"}}`，exit=1；信封语义不可读。— 依据：Surface Uncertainty。
- `apps/server/src/interfaces/http/index.ts:158` — 错误方法一律结构化 404 `not_found`，没有 405。— 依据：HTTP 语义（不影响验收）。
- `apps/server/src/interfaces/index.ts:18` — 桶文件再导出 `../runtime.js`，`interfaces/` 的模块图因此包含 `storage/db` 与 `pg`；depcruise 的 `interfaces-no-direct-storage-or-indexing` 只按路径判定，`runtime.ts` 在 `src/` 根目录不受约束。— 依据：架构边界。
- `apps/server/src/interfaces/http/index.ts:204` — `DELETE /documents/:documentId` 恒 204（文档不存在也 204），同层 `GET /jobs/:jobId` 缺记录返回 404。— 依据：Failure Modes。
- `apps/server/src/agent/tools.ts:9` — 参数契约两份事实源：zod `ToolParametersSchema` 与 `TOOL_PARAMETERS` 各写一遍 `topK` 上下限。— 依据：Duplicated Code / SSOT。
- `apps/server/src/agent/prompt.ts:32` — `parseModelAnswer` 用首个 `{` 到末个 `}` 切片，模型输出两段 JSON 或答案含花括号时拼坏 JSON，最终记成"引用无法回溯"。— 依据：Surface Uncertainty。
- `apps/server/src/runtime.ts:33` — `pino.destination(2)` 的流未在 `:68` close 里 flush/end；`createDatabase` 急切连库而三个 seam 懒加载，配置错误延迟到首次请求。— 依据：生命周期一致性。
- `docs/ARCHITECTURE.md:43` — 技术栈仍写 `@earendil-works/pi-coding-agent`，`apps/server/package.json` 只装了 `pi-ai` 与 `pi-agent-core`，代码也没有引用。— 依据：docs-rules 文档与代码冲突。

下一步：提交本切片；质量建议留给后续 `/skill:plan` 拆前置重构。
