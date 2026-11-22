# todo-02 解析服务审计报告（复审）

结论：通过（AC2 通过；原「WAV 时间锚点被元数据块放大」缺陷已修复；未发现新的可复现缺陷）

## 验收

- AC2 通过 — `just check-py`：ruff check、ruff format --check、basedpyright 全绿；pytest 25 passed（含新增 `test_parse_wav_ignores_junk_chunk_before_streamed_data`、`test_parse_pdf_rejects_file_over_mineru_size_limit`）。
- AC2 通过 — 干净服务 + 真实上游（`source .env`、127.0.0.1:8001；netstat 监听 PID 与 uvicorn 日志 `Started server process` 一致）：
  - `GET /health` → 200，`{"status":"ok","engines":[...]}`，两引擎 `available:true`。
  - `POST /parse` 真实 PDF（w3.org dummy.pdf）→ 200（8.46s）。MinerU 上传已改为异步分块流式发送（`mineru_pdf.py:52,173`），真实预签名 URL 接受，无回归。jsonschema 通过；`pageNumber=1`；`contentHash` 与文件 SHA-256 一致。
  - `POST /parse` 真实 11s 语音（whisper.cpp jfk.wav）→ 200（1.24s），jsonschema 通过，`time {startMs:0, endMs:11000}`，转写为真实文本。
  - `POST /parse` 原缺陷输入（1MiB `JUNK` + 流式 data 长度的 11s WAV）→ 200（1.59s），`time {startMs:0, endMs:11000}`，与真实音频一致。
- AC2 通过 — 损坏/非法输入仍返回 4xx/5xx 且 body 恰为 `{code,message,retryable}`：`broken.pdf` 422 `corrupted_file`；`broken.wav` 422（`WAV carries no data chunk`）；`truncated.pdf` 502 `upstream_error`；`.txt` 415 `unsupported_format`；未知引擎 400 `unknown_engine`。
- AC2 通过 — 无 token 启动：`/health` → 200，`status:"degraded"`，两引擎 `available:false` 且带原因；`POST /parse` → 503 `engine_unavailable`。
- 范围蔓延：无。`justfile:22` 的 `parser-serve` 仍属本地验证便利，不越 spec 边界。

## 实跑缺陷与安全前提

- 原缺陷已修复 — WAV 锚点不再把 data 前的元数据块算作音频：
  - 修复点：`deepseek_asr.py:57` 新增 RIFF chunk 扫描定位 data 偏移；`read_wav_info` 用 `file_size - data_offset` 估算字节数；`_segments_from`（`deepseek_asr.py:209`）优先使用 ASR 返回的 `duration_ms`，估算值仅兜底。
  - 证明：新单测 `test_parser_worker_seam.py:497` 用 `duration_ms=0` 的 mock 证明仅靠偏移计算也能得到 `endMs=11000`；真实上游复测同样返回 `endMs=11000`（修复前为 `43768`）。
- 新缺陷：无。
- 安全前提（已证明）— 真实上游接受当前请求：MinerU 流式上传 + 解析 200；DeepSeek ASR 真实转写 200，锚点与音频时长一致。
- 安全前提（已证明）— 仅监听本机：`netstat -ano` 显示 `TCP 127.0.0.1:8001 LISTENING`，无 0.0.0.0 监听。

## 质量建议

- `workers/parser/src/borges_parser/engines/deepseek_asr.py:69` — `payload_bytes` 仍取到文件末尾；若 data 块之后还有尾随 chunk，仍会高估帧数。— 依据：RIFF 允许 chunk 任意顺序；建议在 data 块长度可信时取 `min(data_size, file_size - data_offset)`。低概率边界，不影响本次验收。
- `workers/parser/src/borges_parser/engines/deepseek_asr.py:174` — 压缩音频先 `read_bytes()` 再判 8MiB 上限，超大 `.ogg/.opus` 会先整文件入内存。— 依据：Fail Fast / 资源边界；建议先 `stat().st_size` 再读。
- `workers/parser/src/borges_parser/app.py:124` — 先 `_sha256(file_path)` 再进引擎；超过 200MiB 的 PDF 会先被完整哈希才触发 413。— 依据：Minimal Footprint / 资源边界；建议把大小守卫前移到路由或分块哈希。
- `workers/parser/tests/test_parser_worker_seam.py:45,146` — 上游仍全 mock（静音 WAV、6 行伪 PDF）；真实 MinerU/ASR 契约只能手工验证。— 依据：AC2 的「样例 PDF/音频」；建议补真实小样例 + 显式开启的 live 契约测试，防再次漏掉元数据类差异。
