# ADR-0001 TypeScript 主服务与本地 Python FastAPI 解析服务

## 决定

使用 TypeScript（`pnpm`）承载主服务、入库状态机、检索引擎、Pi SDK 智能体运行时与 HTTP/MCP/CLI 接口；使用 Python（`uv`）构建仅监听 `127.0.0.1` 的本地 FastAPI 解析服务，通过 `EvidenceIR` JSON 契约提供多模态解析能力。纯文本与代码文件由 TypeScript 主服务直读，不经 Python 解析服务。

## 为什么

- Pi SDK 为原生 TypeScript 生态，将智能体循环与主业务留在同一运行时可避免跨语言编排复杂度。
- 多模态解析（MinerU、各类 ASR、OCR、视频抽帧与 Office 解析）在 Python 生态最成熟；参考 [WeKnora docreader 轻量化设计](https://weknora.weixin.qq.com/docs/03-features/03-document-parsing.html)，将 Python 侧严格限定为无状态格式转换与引擎注册表，边界最清晰。
- 选择本地常驻 FastAPI 而非一次性 CLI 子进程，是为了在后续挂载本地 ASR（如 FunASR、faster-whisper）或本地 OCR（如 PaddleOCR）时保持模型权重常驻内存，避免逐文件冷启动。

## 代价

- 仓库需要同时维护 TypeScript 与 Python 两套依赖管理、测试与静态检查工具链。
- 本地运行与部署时需管理两个进程的健康检查、超时控制与 `x-request-id` 链路透传。
- 跨语言边界需要维护共享 JSON Schema 并在双端同步校验。
