# ADR-0003 统一证据包契约且不在解析阶段提前摘要

## 决定

所有异构输入（PDF、音频、后续扩展的视频、Office 与图片）经解析后必须输出统一强类型的 `EvidenceIR`（原文文本、结构或时间定位锚点、附件引用），禁止在解析阶段用摘要替代原文；上下文补全信息单独存入 `chunks.context_header`，不污染原文 `chunks.content`。

## 为什么

- 摘要属于有损压缩，信息取舍应推迟到检索与智能体推理阶段执行，确保原始证据可核验、可重用。
- 统一 `EvidenceIR` 将上游多模态解析复杂度彻底隔离，下游分块、索引、三模式检索与引用溯源无需感知源格式差异。
- 参考 [WeKnora 分块上下文头设计](https://weknora.weixin.qq.com/docs/03-features/04-chunking) 与 [Anthropic Contextual Retrieval](https://www.anthropic.com/research/contextual-retrieval)，将 `context_header` 与原文分列存储既能提升召回率，又能保持原文偏移不变式与单块重建能力。

## 代价

- 相比直接存纯文本，需要维护联合类型锚点（页码、毫秒时间戳、文件行号）及跨语言 Schema 校验。
- 后续接入视频关键帧时，需要为原始关键帧预留本地或对象存储空间，并承担少量帧级 OCR/VLM 调用成本。
