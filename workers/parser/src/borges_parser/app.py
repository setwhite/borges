from __future__ import annotations

import hashlib
import logging
import os
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from pathlib import Path
from uuid import uuid4

import httpx
import structlog
import uvicorn
from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from borges_parser.engines.deepseek_asr import DeepSeekAsrTranscriber
from borges_parser.engines.mineru_pdf import MinerUPdfParser
from borges_parser.errors import (
    EngineUnavailableError,
    MissingFileError,
    install_error_handlers,
)
from borges_parser.protocols import DocumentParser, Transcriber
from borges_parser.registry import HealthResponse, ParserEngineRegistry

logger = structlog.get_logger()

HOST = "127.0.0.1"
PORT = 8001


class Settings(BaseModel):
    model_config = ConfigDict(frozen=True)

    deepseek_api_key: str | None = None
    deepseek_base_url: str = "https://api.deepseek.com"
    mineru_api_token: str | None = None
    mineru_base_url: str = "https://mineru.net"
    mineru_poll_interval_s: float = 3.0
    mineru_poll_timeout_s: float = 600.0

    @classmethod
    def from_env(cls) -> Settings:
        env = os.environ
        return cls(
            deepseek_api_key=env.get("DEEPSEEK_API_KEY") or None,
            deepseek_base_url=env.get("DEEPSEEK_BASE_URL") or "https://api.deepseek.com",
            mineru_api_token=env.get("MINERU_API_TOKEN") or None,
            mineru_base_url=env.get("MINERU_BASE_URL") or "https://mineru.net",
            mineru_poll_interval_s=float(env.get("MINERU_POLL_INTERVAL_S") or 3.0),
            mineru_poll_timeout_s=float(env.get("MINERU_POLL_TIMEOUT_S") or 600.0),
        )


class ParseRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    file_path: str = Field(alias="filePath", min_length=1)
    engine: str | None = None


def create_app(
    settings: Settings | None = None,
    upstream_transport: httpx.AsyncBaseTransport | None = None,
) -> FastAPI:
    resolved = settings or Settings.from_env()
    _configure_logging()
    client = httpx.AsyncClient(
        transport=upstream_transport,
        timeout=httpx.Timeout(120.0, connect=10.0),
    )
    document_parser: DocumentParser = MinerUPdfParser(
        api_token=resolved.mineru_api_token,
        base_url=resolved.mineru_base_url,
        poll_interval_s=resolved.mineru_poll_interval_s,
        poll_timeout_s=resolved.mineru_poll_timeout_s,
        client=client,
    )
    transcriber: Transcriber = DeepSeekAsrTranscriber(
        api_key=resolved.deepseek_api_key,
        base_url=resolved.deepseek_base_url,
        client=client,
    )
    registry = ParserEngineRegistry([document_parser, transcriber])

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        try:
            yield
        finally:
            await client.aclose()

    app = FastAPI(title="Borges parser worker", lifespan=lifespan)
    install_error_handlers(app)

    @app.middleware("http")
    async def request_context(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        request_id = request.headers.get("x-request-id") or uuid4().hex
        structlog.contextvars.clear_contextvars()
        structlog.contextvars.bind_contextvars(request_id=request_id)
        logger.info("request.start", method=request.method, path=request.url.path)
        response = await call_next(request)
        logger.info("request.finish", status_code=response.status_code)
        response.headers["x-request-id"] = request_id
        return response

    @app.get("/health")
    async def health() -> HealthResponse:
        return registry.health()

    @app.post("/parse")
    async def parse(payload: ParseRequest) -> JSONResponse:
        file_path = Path(payload.file_path)
        if not file_path.is_file():
            raise MissingFileError(f"file not found: {file_path}")
        engine = registry.resolve(file_path.suffix, payload.engine)
        status = engine.check_available()
        if not status.available:
            raise EngineUnavailableError(f"{engine.name} unavailable: {status.reason}")
        evidence = await engine.parse(file_path, _sha256(file_path))
        return JSONResponse(evidence.model_dump(by_alias=True, exclude_none=True))

    return app


def _sha256(file_path: Path) -> str:
    digest = hashlib.sha256()
    with file_path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _configure_logging() -> None:
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(logging.INFO),
        cache_logger_on_first_use=True,
    )


if __name__ == "__main__":
    uvicorn.run(create_app(), host=HOST, port=PORT)
