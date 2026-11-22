from __future__ import annotations

import asyncio
import io
import json
import time
import zipfile
from collections.abc import AsyncIterator
from pathlib import Path, PurePosixPath
from typing import Any, cast

import httpx
from pydantic import BaseModel, ValidationError

from borges_parser.contracts import DocumentMeta, EvidenceIR, EvidenceSegment, PageAnchor
from borges_parser.errors import (
    CorruptedFileError,
    FileTooLargeError,
    UpstreamApiError,
    UpstreamTimeoutError,
)
from borges_parser.protocols import EngineStatus

PDF_MAGIC = b"%PDF-"
MODEL_VERSION = "pipeline"
MAX_PDF_BYTES = 200 * 1024 * 1024
UPLOAD_CHUNK_BYTES = 1024 * 1024
CONTENT_LIST_SUFFIX = "_content_list.json"


class _Envelope(BaseModel):
    code: int
    msg: str = ""
    data: dict[str, Any] | None = None


class _BatchCreated(BaseModel):
    batch_id: str
    file_urls: list[str]


class _ExtractResult(BaseModel):
    state: str
    err_msg: str | None = None
    full_zip_url: str | None = None


class _BatchResults(BaseModel):
    extract_result: list[_ExtractResult] = []


async def _read_in_chunks(file_path: Path, chunk_bytes: int) -> AsyncIterator[bytes]:
    with file_path.open("rb") as handle:
        while chunk := await asyncio.to_thread(handle.read, chunk_bytes):
            yield chunk


def assert_pdf(file_path: Path) -> None:
    with file_path.open("rb") as handle:
        header = handle.read(len(PDF_MAGIC))
    if header != PDF_MAGIC:
        raise CorruptedFileError(f"{file_path.name} does not start with {PDF_MAGIC.decode()}")


def segments_from_content_list(blocks: list[dict[str, Any]]) -> list[EvidenceSegment]:
    section_path: list[str] = []
    segments: list[EvidenceSegment] = []
    for block in blocks:
        text = _block_text(block)
        if text is None:
            continue
        level = block.get("text_level")
        if isinstance(level, int) and not isinstance(level, bool) and level >= 1:
            section_path = [*section_path[: level - 1], text]
        page_idx = block.get("page_idx")
        page_number = (
            page_idx + 1 if isinstance(page_idx, int) and not isinstance(page_idx, bool) else 1
        )
        segments.append(
            EvidenceSegment(
                text=text,
                anchor=PageAnchor(pageNumber=max(page_number, 1), sectionPath=list(section_path)),
            )
        )
    return segments


def _string_lines(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    return [item.strip() for item in value if isinstance(item, str) and item.strip()]


def _block_text(block: dict[str, Any]) -> str | None:
    block_type = block.get("type")
    if block_type in {"text", "equation"}:
        raw = block.get("text")
    elif block_type == "table":
        caption = _string_lines(block.get("table_caption"))
        body = block.get("table_body")
        if isinstance(body, str) and body.strip():
            caption.append(body.strip())
        raw = "\n".join(caption) if caption else None
    elif block_type == "list":
        raw = "\n".join(_string_lines(block.get("list_items"))) or None
    else:
        return None
    if not isinstance(raw, str):
        return None
    text = raw.strip()
    return text or None


class MinerUPdfParser:
    name: str = "mineru_pdf"
    supported_extensions: tuple[str, ...] = (".pdf",)

    def __init__(
        self,
        *,
        api_token: str | None,
        base_url: str,
        poll_interval_s: float,
        poll_timeout_s: float,
        client: httpx.AsyncClient,
    ) -> None:
        self._api_token = api_token
        self._base_url = base_url.rstrip("/")
        self._poll_interval_s = poll_interval_s
        self._poll_timeout_s = poll_timeout_s
        self._client = client

    def check_available(self) -> EngineStatus:
        if not self._api_token:
            return EngineStatus(available=False, reason="MINERU_API_TOKEN is not set")
        return EngineStatus(available=True)

    async def parse(self, file_path: Path, content_hash: str) -> EvidenceIR:
        size = file_path.stat().st_size
        if size > MAX_PDF_BYTES:
            raise FileTooLargeError(
                f"{file_path.name} is {size}B, MinerU accepts at most {MAX_PDF_BYTES}B"
            )
        assert_pdf(file_path)
        batch_id, upload_url = await self._create_batch(file_path.name)
        await self._upload(upload_url, file_path)
        zip_url = await self._wait_for_zip(batch_id)
        blocks = await self._fetch_content_list(zip_url)
        return EvidenceIR(
            documentMeta=DocumentMeta(
                title=file_path.stem,
                mediaType="application/pdf",
                contentHash=content_hash,
                parserEngine=self.name,
            ),
            segments=segments_from_content_list(blocks),
        )

    async def _create_batch(self, filename: str) -> tuple[str, str]:
        data = await self._call_json(
            "POST",
            "/api/v4/file-urls/batch",
            payload={"files": [{"name": filename}], "model_version": MODEL_VERSION},
        )
        try:
            created = _BatchCreated.model_validate(data)
        except ValidationError as exc:
            raise UpstreamApiError(f"MinerU batch creation payload is malformed: {exc}") from exc
        if not created.file_urls:
            raise UpstreamApiError("MinerU batch creation returned no upload URL")
        return created.batch_id, created.file_urls[0]

    async def _upload(self, upload_url: str, file_path: Path) -> None:
        try:
            response = await self._client.put(
                upload_url, content=_read_in_chunks(file_path, UPLOAD_CHUNK_BYTES)
            )
        except httpx.TimeoutException as exc:
            raise UpstreamTimeoutError(f"MinerU upload timed out: {exc}") from exc
        except httpx.HTTPError as exc:
            raise UpstreamApiError(f"MinerU upload failed: {exc}") from exc
        if response.status_code >= 400:
            raise UpstreamApiError(
                f"MinerU upload returned {response.status_code}: {response.text[:200]}",
                retryable=response.status_code >= 500,
            )

    async def _wait_for_zip(self, batch_id: str) -> str:
        deadline = time.monotonic() + self._poll_timeout_s
        while True:
            data = await self._call_json("GET", f"/api/v4/extract-results/batch/{batch_id}")
            result = self._first_result(data, batch_id)
            if result is not None:
                if result.state == "done":
                    if not result.full_zip_url:
                        raise UpstreamApiError(
                            f"MinerU batch {batch_id} finished without a result archive"
                        )
                    return result.full_zip_url
                if result.state == "failed":
                    reason = result.err_msg or "no reason given"
                    raise UpstreamApiError(f"MinerU batch {batch_id} failed: {reason}")
            if time.monotonic() >= deadline:
                raise UpstreamTimeoutError(
                    f"MinerU batch {batch_id} did not finish within {self._poll_timeout_s}s"
                )
            await asyncio.sleep(self._poll_interval_s)

    def _first_result(self, data: dict[str, Any], batch_id: str) -> _ExtractResult | None:
        try:
            results = _BatchResults.model_validate(data)
        except ValidationError as exc:
            raise UpstreamApiError(f"MinerU batch result payload is malformed: {exc}") from exc
        if not results.extract_result:
            return None
        if len(results.extract_result) > 1:
            raise UpstreamApiError(f"MinerU batch {batch_id} returned more than one file result")
        return results.extract_result[0]

    async def _fetch_content_list(self, zip_url: str) -> list[dict[str, Any]]:
        try:
            response = await self._client.get(zip_url)
        except httpx.TimeoutException as exc:
            raise UpstreamTimeoutError(f"MinerU result download timed out: {exc}") from exc
        except httpx.HTTPError as exc:
            raise UpstreamApiError(f"MinerU result download failed: {exc}") from exc
        if response.status_code >= 400:
            raise UpstreamApiError(
                f"MinerU result download returned {response.status_code}",
                retryable=response.status_code >= 500,
            )
        try:
            with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
                names = [
                    name
                    for name in archive.namelist()
                    if PurePosixPath(name).name.endswith(CONTENT_LIST_SUFFIX)
                ]
                if not names:
                    raise UpstreamApiError(f"MinerU archive has no *{CONTENT_LIST_SUFFIX} entry")
                decoded: object = json.loads(archive.read(sorted(names)[0]))
        except (zipfile.BadZipFile, json.JSONDecodeError) as exc:
            raise UpstreamApiError(f"MinerU result archive is unreadable: {exc}") from exc
        if not isinstance(decoded, list):
            raise UpstreamApiError("MinerU content list is not a JSON array")
        return [cast(dict[str, Any], block) for block in decoded if isinstance(block, dict)]

    async def _call_json(
        self, method: str, path: str, *, payload: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        try:
            response = await self._client.request(
                method,
                f"{self._base_url}{path}",
                json=payload,
                headers={"Authorization": f"Bearer {self._api_token}"},
            )
        except httpx.TimeoutException as exc:
            raise UpstreamTimeoutError(f"MinerU {method} {path} timed out: {exc}") from exc
        except httpx.HTTPError as exc:
            raise UpstreamApiError(f"MinerU {method} {path} failed: {exc}") from exc
        if response.status_code >= 400:
            raise UpstreamApiError(
                f"MinerU {path} returned {response.status_code}: {response.text[:200]}",
                retryable=response.status_code == 429 or response.status_code >= 500,
            )
        try:
            envelope = _Envelope.model_validate(response.json())
        except (ValueError, ValidationError) as exc:
            raise UpstreamApiError(f"MinerU {path} returned a malformed payload: {exc}") from exc
        if envelope.code != 0 or envelope.data is None:
            raise UpstreamApiError(
                f"MinerU {path} rejected the request: {envelope.msg or envelope.code}"
            )
        return envelope.data
