# todo-02 本地 FastAPI 解析服务（PDF 与音频）

- [ ] 未开始
- Spec: docs/specs/phase1-core.md
- 验收: AC2

## 交付物

- 在 `workers/parser/` 实现仅监听 `127.0.0.1` 的 FastAPI 服务，暴露 `GET /health` 与 `POST /parse`。
- 实现插件化引擎注册表（`ParserEngineRegistry`）与 `check_available` 探针，抽象 `DocumentParser` 与 `Transcriber` 接口。
- 接入 MinerU API 解析插件（PDF 转 `EvidenceIR` 带 `page` 锚点）与云端兼容 ASR API 插件（音频转 `EvidenceIR` 带 `time` 锚点）。
- 显式处理不支持格式、损坏文件、上游超时与 5xx，返回统一结构化错误体并在 `ParserWorkerSeam` 补齐黑盒契约测试。

## 前置

- `docs/todos/todo-01-foundation.md`
