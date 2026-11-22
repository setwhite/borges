from __future__ import annotations

import hashlib
import io
import json
import wave
import zipfile
from pathlib import Path
from typing import Any

import httpx
import jsonschema
import pytest
from fastapi.testclient import TestClient

from borges_parser.app import Settings, create_app
from borges_parser.engines.mineru_pdf import MAX_PDF_BYTES

SCHEMA_PATH = Path(__file__).resolve().parents[3] / "schemas" / "evidence-ir.schema.json"


@pytest.fixture(scope="session")
def schema() -> dict[str, Any]:
    return json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))


def test_health_lists_each_engine_with_availability() -> None:
    settings = Settings(deepseek_api_key=None, mineru_api_token=None)

    with TestClient(create_app(settings)) as client:
        response = client.get("/health")

    assert response.status_code == 200
    assert response.json()["status"] == "degraded"
    engines = {engine["name"]: engine for engine in response.json()["engines"]}
    assert set(engines) == {"deepseek_asr", "mineru_pdf"}
    assert engines["mineru_pdf"]["supportedExtensions"] == [".pdf"]
    assert engines["deepseek_asr"]["supportedExtensions"] == [".wav", ".ogg", ".opus"]
    assert engines["mineru_pdf"] == {
        "name": "mineru_pdf",
        "supportedExtensions": [".pdf"],
        "available": False,
        "reason": "MINERU_API_TOKEN is not set",
    }


def _wav_bytes(seconds: float, *, frame_rate: int = 16_000) -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(frame_rate)
        handle.writeframes(b"\x00\x00" * int(seconds * frame_rate))
    return buffer.getvalue()


def _parse_json(client: TestClient, file_path: Path) -> httpx.Response:
    return client.post("/parse", json={"filePath": str(file_path)})


def test_parse_wav_sends_whole_file_and_anchors_full_duration(
    tmp_path: Path, schema: dict[str, Any]
) -> None:
    audio = tmp_path / "standup.wav"
    audio.write_bytes(_wav_bytes(3.0))
    upstream: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        upstream.append(request)
        return httpx.Response(
            200,
            json={"request_id": "req-1", "text": "先过一遍本周进度", "duration_ms": 3000},
        )

    settings = Settings(deepseek_api_key="test-key")
    with TestClient(create_app(settings, httpx.MockTransport(handler))) as client:
        response = _parse_json(client, audio)

    assert response.status_code == 200
    body = response.json()
    jsonschema.validate(instance=body, schema=schema)
    assert body["documentMeta"] == {
        "title": "standup",
        "mediaType": "audio/wav",
        "contentHash": hashlib.sha256(audio.read_bytes()).hexdigest(),
        "parserEngine": "deepseek_asr",
    }
    assert body["segments"] == [
        {"text": "先过一遍本周进度", "anchor": {"kind": "time", "startMs": 0, "endMs": 3000}}
    ]
    assert len(upstream) == 1
    assert str(upstream[0].url) == "https://api.deepseek.com/v1/tools/asr"
    assert upstream[0].headers["authorization"] == "Bearer test-key"


def test_parse_long_wav_slices_into_contiguous_time_anchors(
    tmp_path: Path, schema: dict[str, Any]
) -> None:
    audio = tmp_path / "all-hands.wav"
    audio.write_bytes(_wav_bytes(130.0))
    texts: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        texts.append(f"第{len(texts) + 1}段转写")
        return httpx.Response(
            200,
            json={"request_id": f"req-{len(texts)}", "text": texts[-1], "duration_ms": 0},
        )

    settings = Settings(deepseek_api_key="test-key")
    with TestClient(create_app(settings, httpx.MockTransport(handler))) as client:
        response = _parse_json(client, audio)

    assert response.status_code == 200
    body = response.json()
    jsonschema.validate(instance=body, schema=schema)
    anchors = [segment["anchor"] for segment in body["segments"]]
    assert anchors == [
        {"kind": "time", "startMs": 0, "endMs": 115_000},
        {"kind": "time", "startMs": 115_000, "endMs": 130_000},
    ]
    assert [segment["text"] for segment in body["segments"]] == ["第1段转写", "第2段转写"]


MINERU_CONTENT_LIST = [
    {"type": "text", "text": "季度报告", "text_level": 1, "page_idx": 0},
    {"type": "text", "text": "营收同比增长 12%。", "page_idx": 0},
    {"type": "text", "text": "区域拆解", "text_level": 2, "page_idx": 1},
    {
        "type": "table",
        "table_body": "<table><tr><td>华东</td></tr></table>",
        "table_caption": ["表 1 区域营收"],
        "page_idx": 1,
    },
    {"type": "image", "img_path": "images/a.jpg", "img_caption": ["架构图"], "page_idx": 2},
    {"type": "equation", "text": "$$E = mc^2$$", "text_format": "latex", "page_idx": 2},
]


def _mineru_zip(blocks: list[dict[str, Any]]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("abc123_content_list.json", json.dumps(blocks))
        archive.writestr("abc123_layout.json", "{}")
    return buffer.getvalue()


def _pdf_bytes() -> bytes:
    return b"%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<<>>\n%%EOF\n"


def _mineru_transport(
    pdf: bytes, polls: list[dict[str, Any]], requests: list[httpx.Request], zip_bytes: bytes
) -> httpx.MockTransport:
    pending = list(polls)

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.method == "POST" and request.url.path == "/api/v4/file-urls/batch":
            return httpx.Response(
                200,
                json={
                    "code": 0,
                    "msg": "ok",
                    "data": {
                        "batch_id": "batch-1",
                        "file_urls": ["https://upload.example/batch-1/demo.pdf"],
                    },
                },
            )
        if request.method == "PUT" and request.url.host == "upload.example":
            assert await request.aread() == pdf
            return httpx.Response(200)
        if request.method == "GET" and request.url.path == "/api/v4/extract-results/batch/batch-1":
            return httpx.Response(200, json={"code": 0, "msg": "ok", "data": pending.pop(0)})
        if request.method == "GET" and request.url.path == "/result.zip":
            return httpx.Response(200, content=zip_bytes)
        raise AssertionError(f"unexpected upstream call: {request.method} {request.url}")

    return httpx.MockTransport(handler)


def test_parse_pdf_maps_content_list_to_page_anchors(
    tmp_path: Path, schema: dict[str, Any]
) -> None:
    pdf = tmp_path / "quarterly.pdf"
    pdf.write_bytes(_pdf_bytes())
    requests: list[httpx.Request] = []
    transport = _mineru_transport(
        _pdf_bytes(),
        polls=[
            {
                "batch_id": "batch-1",
                "extract_result": [{"state": "running", "file_name": "quarterly.pdf"}],
            },
            {
                "batch_id": "batch-1",
                "extract_result": [
                    {
                        "state": "done",
                        "file_name": "quarterly.pdf",
                        "full_zip_url": "https://cdn.example/result.zip",
                    }
                ],
            },
        ],
        requests=requests,
        zip_bytes=_mineru_zip(MINERU_CONTENT_LIST),
    )
    settings = Settings(mineru_api_token="mineru-token", mineru_poll_interval_s=0.0)
    with TestClient(create_app(settings, transport)) as client:
        response = _parse_json(client, pdf)

    assert response.status_code == 200
    body = response.json()
    jsonschema.validate(instance=body, schema=schema)
    assert body["documentMeta"] == {
        "title": "quarterly",
        "mediaType": "application/pdf",
        "contentHash": hashlib.sha256(pdf.read_bytes()).hexdigest(),
        "parserEngine": "mineru_pdf",
    }
    assert [
        (segment["text"], segment["anchor"]["pageNumber"], segment["anchor"]["sectionPath"])
        for segment in body["segments"]
    ] == [
        ("季度报告", 1, ["季度报告"]),
        ("营收同比增长 12%。", 1, ["季度报告"]),
        ("区域拆解", 2, ["季度报告", "区域拆解"]),
        ("表 1 区域营收\n<table><tr><td>华东</td></tr></table>", 2, ["季度报告", "区域拆解"]),
        ("$$E = mc^2$$", 3, ["季度报告", "区域拆解"]),
    ]
    assert [request.method for request in requests] == ["POST", "PUT", "GET", "GET", "GET"]
    assert requests[0].headers["authorization"] == "Bearer mineru-token"
    assert "content-type" not in requests[1].headers


def test_parse_pdf_rejects_broken_magic_before_touching_upstream(tmp_path: Path) -> None:
    pdf = tmp_path / "broken.pdf"
    pdf.write_bytes(b"not a pdf at all")
    requests: list[httpx.Request] = []
    transport = httpx.MockTransport(lambda request: requests.append(request) or httpx.Response(500))
    settings = Settings(mineru_api_token="mineru-token")

    with TestClient(create_app(settings, transport)) as client:
        response = _parse_json(client, pdf)

    assert response.status_code == 422
    assert response.json()["code"] == "corrupted_file"
    assert response.json()["retryable"] is False
    assert requests == []


def test_parse_pdf_maps_poll_timeout_to_retryable_504(tmp_path: Path) -> None:
    pdf = tmp_path / "slow.pdf"
    pdf.write_bytes(_pdf_bytes())
    running = {"batch_id": "batch-1", "extract_result": [{"state": "running"}]}
    transport = _mineru_transport(
        _pdf_bytes(),
        polls=[running] * 50,
        requests=[],
        zip_bytes=_mineru_zip([]),
    )
    settings = Settings(
        mineru_api_token="mineru-token", mineru_poll_interval_s=0.0, mineru_poll_timeout_s=0.0
    )

    with TestClient(create_app(settings, transport)) as client:
        response = _parse_json(client, pdf)

    assert response.status_code == 504
    assert response.json()["code"] == "upstream_timeout"
    assert response.json()["retryable"] is True


def _assert_error_body(response: httpx.Response, *, code: str, retryable: bool) -> None:
    body = response.json()
    assert set(body) == {"code", "message", "retryable"}
    assert body["code"] == code
    assert body["message"]
    assert body["retryable"] is retryable


def test_parse_reports_unsupported_extension(tmp_path: Path) -> None:
    note = tmp_path / "note.txt"
    note.write_text("hello", encoding="utf-8")

    with TestClient(create_app(Settings())) as client:
        response = _parse_json(client, note)

    assert response.status_code == 415
    _assert_error_body(response, code="unsupported_format", retryable=False)


def test_parse_reports_unknown_engine(tmp_path: Path) -> None:
    note = tmp_path / "note.wav"
    note.write_bytes(_wav_bytes(1.0))

    with TestClient(create_app(Settings(deepseek_api_key="test-key"))) as client:
        response = client.post("/parse", json={"filePath": str(note), "engine": "nope"})

    assert response.status_code == 400
    _assert_error_body(response, code="unknown_engine", retryable=False)


def test_parse_reports_missing_file(tmp_path: Path) -> None:
    with TestClient(create_app(Settings())) as client:
        response = _parse_json(client, tmp_path / "ghost.wav")

    assert response.status_code == 404
    _assert_error_body(response, code="file_not_found", retryable=False)


def test_parse_reports_engine_unavailable_without_upstream_call(tmp_path: Path) -> None:
    audio = tmp_path / "standup.wav"
    audio.write_bytes(_wav_bytes(2.0))
    requests: list[httpx.Request] = []
    transport = httpx.MockTransport(lambda request: requests.append(request) or httpx.Response(200))

    with TestClient(create_app(Settings(deepseek_api_key=None), transport)) as client:
        response = _parse_json(client, audio)

    assert response.status_code == 503
    _assert_error_body(response, code="engine_unavailable", retryable=False)
    assert requests == []


def test_parse_rejects_corrupted_wav(tmp_path: Path) -> None:
    audio = tmp_path / "broken.wav"
    audio.write_bytes(b"RIFF....WAVEbroken")

    with TestClient(create_app(Settings(deepseek_api_key="test-key"))) as client:
        response = _parse_json(client, audio)

    assert response.status_code == 422
    _assert_error_body(response, code="corrupted_file", retryable=False)


def test_parse_maps_upstream_5xx_to_retryable_error(tmp_path: Path) -> None:
    audio = tmp_path / "standup.wav"
    audio.write_bytes(_wav_bytes(2.0))
    transport = httpx.MockTransport(lambda request: httpx.Response(503, text="busy"))

    with TestClient(create_app(Settings(deepseek_api_key="test-key"), transport)) as client:
        response = _parse_json(client, audio)

    assert response.status_code == 502
    _assert_error_body(response, code="upstream_error", retryable=True)


def test_parse_maps_upstream_timeout_to_retryable_error(tmp_path: Path) -> None:
    audio = tmp_path / "standup.wav"
    audio.write_bytes(_wav_bytes(2.0))

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectTimeout("upstream is slow", request=request)

    with TestClient(
        create_app(Settings(deepseek_api_key="test-key"), httpx.MockTransport(handler))
    ) as client:
        response = _parse_json(client, audio)

    assert response.status_code == 504
    _assert_error_body(response, code="upstream_timeout", retryable=True)


def test_request_id_header_is_echoed() -> None:
    with TestClient(create_app(Settings())) as client:
        response = client.get("/health", headers={"x-request-id": "trace-42"})

    assert response.headers["x-request-id"] == "trace-42"


def test_health_marks_engines_available_when_tokens_are_configured() -> None:
    settings = Settings(deepseek_api_key="test-key", mineru_api_token="mineru-token")

    with TestClient(create_app(settings)) as client:
        health = client.get("/health").json()
    engines = {e["name"]: e for e in health["engines"]}

    assert health["status"] == "ok"
    assert engines["deepseek_asr"]["available"] is True
    assert engines["mineru_pdf"]["available"] is True
    assert engines["deepseek_asr"]["reason"] is None


def test_parse_wav_returns_empty_segments_when_asr_text_is_blank(
    tmp_path: Path, schema: dict[str, Any]
) -> None:
    audio = tmp_path / "silence.wav"
    audio.write_bytes(_wav_bytes(2.0))
    transport = httpx.MockTransport(
        lambda request: httpx.Response(
            200, json={"request_id": "req-1", "text": "   ", "duration_ms": 2000}
        )
    )

    with TestClient(create_app(Settings(deepseek_api_key="test-key"), transport)) as client:
        response = _parse_json(client, audio)

    assert response.status_code == 200
    body = response.json()
    jsonschema.validate(instance=body, schema=schema)
    assert body["segments"] == []


def test_parse_pdf_keeps_table_body_when_caption_is_missing(
    tmp_path: Path, schema: dict[str, Any]
) -> None:
    pdf = tmp_path / "table.pdf"
    pdf.write_bytes(_pdf_bytes())
    blocks = [{"type": "table", "table_body": "<table><tr><td>1</td></tr></table>", "page_idx": 0}]
    transport = _mineru_transport(
        _pdf_bytes(),
        polls=[
            {
                "batch_id": "batch-1",
                "extract_result": [
                    {"state": "done", "full_zip_url": "https://cdn.example/result.zip"}
                ],
            }
        ],
        requests=[],
        zip_bytes=_mineru_zip(blocks),
    )
    settings = Settings(mineru_api_token="mineru-token", mineru_poll_interval_s=0.0)

    with TestClient(create_app(settings, transport)) as client:
        response = _parse_json(client, pdf)

    assert response.status_code == 200
    body = response.json()
    jsonschema.validate(instance=body, schema=schema)
    assert body["segments"] == [
        {
            "text": "<table><tr><td>1</td></tr></table>",
            "anchor": {"kind": "page", "pageNumber": 1, "sectionPath": []},
        }
    ]


def test_parse_reports_malformed_json_body(tmp_path: Path) -> None:
    with TestClient(create_app(Settings())) as client:
        response = client.post(
            "/parse", content=b"{not json", headers={"content-type": "application/json"}
        )

    assert response.status_code == 422
    _assert_error_body(response, code="invalid_request", retryable=False)


def test_parse_wav_ignores_streamed_header_frame_count(
    tmp_path: Path, schema: dict[str, Any]
) -> None:
    streamed = bytearray(_wav_bytes(2.0))
    streamed[40:44] = (2**31 - 1).to_bytes(4, "little")
    audio = tmp_path / "streamed.wav"
    audio.write_bytes(bytes(streamed))
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(
            200, json={"request_id": "req-1", "text": "今天上海的天气怎么样？", "duration_ms": 2000}
        )

    with TestClient(
        create_app(Settings(deepseek_api_key="test-key"), httpx.MockTransport(handler))
    ) as client:
        response = _parse_json(client, audio)

    assert response.status_code == 200
    body = response.json()
    jsonschema.validate(instance=body, schema=schema)
    assert len(calls) == 1
    assert body["segments"] == [
        {"text": "今天上海的天气怎么样？", "anchor": {"kind": "time", "startMs": 0, "endMs": 2000}}
    ]


def _junk_streamed_wav(seconds: float, *, junk_bytes: int = 1024 * 1024) -> bytes:
    canonical = _wav_bytes(seconds)
    fmt_chunk = canonical[12:36]
    payload = canonical[44:]
    body = (
        fmt_chunk
        + b"JUNK"
        + junk_bytes.to_bytes(4, "little")
        + b"\x00" * junk_bytes
        + b"data"
        + (2**31 - 2).to_bytes(4, "little")
        + payload
    )
    return b"RIFF" + (len(body) + 4).to_bytes(4, "little") + b"WAVE" + body


def test_parse_wav_ignores_junk_chunk_before_streamed_data(
    tmp_path: Path, schema: dict[str, Any]
) -> None:
    audio = tmp_path / "jfk_junk_streamed.wav"
    audio.write_bytes(_junk_streamed_wav(11.0))
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(
            200, json={"request_id": "req-1", "text": "问一下天气", "duration_ms": 0}
        )

    settings = Settings(deepseek_api_key="test-key")
    with TestClient(create_app(settings, httpx.MockTransport(handler))) as client:
        response = _parse_json(client, audio)

    assert response.status_code == 200
    body = response.json()
    jsonschema.validate(instance=body, schema=schema)
    assert len(calls) == 1
    assert body["segments"] == [
        {"text": "问一下天气", "anchor": {"kind": "time", "startMs": 0, "endMs": 11_000}}
    ]


def test_parse_pdf_rejects_file_over_mineru_size_limit(tmp_path: Path) -> None:
    pdf = tmp_path / "huge.pdf"
    with pdf.open("wb") as handle:
        handle.write(b"%PDF-1.7\n")
        handle.truncate(MAX_PDF_BYTES + 1)
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        raise AssertionError(f"unexpected upstream call: {request.method} {request.url}")

    with TestClient(
        create_app(Settings(mineru_api_token="mineru-token"), httpx.MockTransport(handler))
    ) as client:
        response = _parse_json(client, pdf)

    assert response.status_code == 413
    _assert_error_body(response, code="file_too_large", retryable=False)
    assert calls == []
