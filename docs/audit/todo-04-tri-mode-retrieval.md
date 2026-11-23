# todo-04 三模式检索引擎审计报告

结论：通过（第 2 轮；上一轮 `topK` 边界缺陷已修复并复验）

## 复审记录

- 已修复 — `hnsw.ef_search` 越界：`apps/server/src/retrieval/prefilter.ts:9` 新增上限 1000，`:85` `clampEfSearch` 把候选池压到 `[64, 1000]`。
  - 复验（`.tmp` 脚本，已删，连真实库）：hybrid 与 hyperedge 在 `topK` 20、250、251、300、1000、10000 全部返回 1 hit，无异常：`RETOPK {"hybrid:251":{"hits":1},...,"hyperedge:10000":{"hits":1}}`。
  - 复验设置值：`current_setting('hnsw.ef_search')` 对候选池 20、1200、40000 分别为 64、1000、1000：`REF ["64","1000","1000"]`。
- 已补测试 — `apps/server/tests/retrieval.seam.test.ts:497`（hybrid）与 `:510`（hyperedge）各一条 `topK: 300` 边界用例。
- 预过滤回归（`topK: 300`）— 三模式均 `allow=1, noAcl=0, wrongTenant=0`：`REACL {"hybrid:allow":1,"hyperedge:allow":1,"rg:allow":1,...}`。

## 验收

- AC5 通过（锚点与异常）— `pnpm --filter @borges/server exec vitest run tests/retrieval.seam.test.ts`：16 passed。覆盖 hybrid/hyperedge 的 page、time、line 锚点与逐字 `content`，rg 的 line 映射，共享实体扩展，三模式预过滤，BM25、embedding、rerank、rg 的故障传播，以及两条 `topK` 边界用例。
- AC5 通过（全量 TS 门禁）— `just check-ts`：biome、tsc、dependency-cruiser 通过，vitest 39 passed。
- AC5 通过（独立复验，`.tmp` 脚本已删）：
  - 源级 ACL 继承进 chunk；`finance` 可见，无 acl 与错租户三模式均为 0：`ACL_GATE {"mode":"hybrid","withoutAcl":0,"wrongTenant":0}`（hyperedge、rg 同）。
  - 非默认租户生效：`TENANT {"wrong":0,"right":1}`。
  - 三种模式只返回请求的 `sourceIds`：`SCOPE` 均为单 source。
  - rg 混合 ACL：受限文件被排除、公开文件保留：`RG_PARTIAL_ACL ["open.ts"]`。
  - dense 分支故障映射：`DENSE_FAIL {"code":"dense_failed","mode":"hybrid"}`。
- 范围蔓延：无。`.env.example` 的两个超时变量、indexing/ingestion 的导出、retrieval 模块与测试均对应交付物。

## 实跑缺陷与安全前提

- 实跑缺陷：无（上一轮 `topK >= 251` 缺陷已修复，见复审记录）。
- 安全前提（已证明）—
  - 预过滤不跨租户、信源与 ACL：见上四条独立复验与 `REACL`。
  - `hnsw.iterative_scan` 与 `ef_search` 在同一事务连接生效，且 `ef_search` 已限制在 pgvector 0.8.6 的合法区间：`HNSW {"iterative":"strict_order","ef":"120","ext":"0.8.6"}`、`REF ["64","1000","1000"]`。
  - rg 沙箱：交付测试证明 `../` 与外部符号链接被拒；本次另证 CJK、空格、方括号文件名都能映射回 line 锚点。
- 未证明 — `apps/server/src/retrieval/rg.ts:119` 的 realpath 校验与 `execFile` 之间存在 TOCTOU（镜像目录被并发替换）；无稳定复现，记为 unproven。

## 质量建议

- `apps/server/src/retrieval/rg.ts:178` — `loadLineChunks` 一次性把 scope 内全部 line chunk 的 `content`/`anchor` 读进内存，没有上限。— 依据：资源边界。
- `apps/server/src/retrieval/hyperedge.ts:123` — 实体种子 `limit 12` 没有 `order by`；命中超过 12 个实体时选哪 12 个取决于物理行序，召回不可复现。— 依据：Determinism。
- `apps/server/src/retrieval/rg.ts:124` — `MIRROR_ROOT` 整体缺失与"源没有镜像目录"都返回 `[]`，配置错误被降级成"无命中"；`apps/server/tests/retrieval.seam.test.ts:645` 固化了这一行为。— 依据：Surface Uncertainty。
- `apps/server/src/retrieval/index.ts:114` — `sourceIds` 不校验 UUID：实测 `["not-a-uuid"]` 在 hybrid 报 `bm25_failed`、hyperedge 报 `hyperedge_failed`、rg 静默返回 0。— 依据：Fail Fast / Primitive Obsession。
- `apps/server/src/retrieval/index.ts:166`、`reranker.ts:199`、`ingestion/parserWorker.ts:123`、`indexing/providers.ts:302` — `timeoutFromEnv` 四份拷贝，`trimTrailingSlash` 三份；本次新增第 4 份。— 依据：Duplicated Code / Rule of Three。
- `apps/server/src/retrieval/index.ts:101` — `createDefaultRetrievalService` 构造时就建 embedding 与 reranker；只用 `rg` 的调用方也必须提供 `RERANK_*`，否则构造抛错。— 依据：无关依赖。
- `apps/server/tests/retrieval.seam.test.ts` — 仍没有 dense 分支故障用例（todo 要求"单路异常传播测试"），该路径由本次临时脚本证明。— 依据：测试覆盖缺口。
- `apps/server/src/retrieval/rg.ts:236` — 查询按正则传给 rg（`a.b` 会命中 `axb`），`SearchRequest` 契约未说明；要字面量检索需加 `-F`。— 依据：契约模糊（与交付测试的 `rg_invalid_pattern` 自洽）。

下一步：可走 `/skill:docs-commit` 提交本切片，或进入 T05。
