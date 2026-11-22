from __future__ import annotations

from typing import ClassVar

import structlog
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from starlette.exceptions import HTTPException as StarletteHTTPException

logger = structlog.get_logger()


class ParserErrorResponse(BaseModel):
    code: str
    message: str
    retryable: bool


class ParserWorkerError(Exception):
    code: ClassVar[str] = "parser_error"
    status_code: ClassVar[int] = 500

    def __init__(self, message: str, *, retryable: bool = False) -> None:
        super().__init__(message)
        self.message = message
        self.retryable = retryable

    def to_response(self) -> ParserErrorResponse:
        return ParserErrorResponse(code=self.code, message=self.message, retryable=self.retryable)


class UnsupportedFormatError(ParserWorkerError):
    code = "unsupported_format"
    status_code = 415


class CorruptedFileError(ParserWorkerError):
    code = "corrupted_file"
    status_code = 422


class FileTooLargeError(ParserWorkerError):
    code = "file_too_large"
    status_code = 413


class MissingFileError(ParserWorkerError):
    code = "file_not_found"
    status_code = 404


class UnknownEngineError(ParserWorkerError):
    code = "unknown_engine"
    status_code = 400


class EngineUnavailableError(ParserWorkerError):
    code = "engine_unavailable"
    status_code = 503


class UpstreamApiError(ParserWorkerError):
    code = "upstream_error"
    status_code = 502


class UpstreamTimeoutError(ParserWorkerError):
    code = "upstream_timeout"
    status_code = 504

    def __init__(self, message: str) -> None:
        super().__init__(message, retryable=True)


def _code_for_status(status_code: int) -> str:
    if status_code == 404:
        return "not_found"
    if status_code < 500:
        return "invalid_request"
    return "http_error"


def install_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ParserWorkerError)
    async def _parser_error(_: Request, exc: ParserWorkerError) -> JSONResponse:
        logger.warning("parser.error", code=exc.code, message=exc.message, retryable=exc.retryable)
        return JSONResponse(exc.to_response().model_dump(), status_code=exc.status_code)

    @app.exception_handler(RequestValidationError)
    async def _invalid_request(_: Request, exc: RequestValidationError) -> JSONResponse:
        details = "; ".join(
            f"{'.'.join(str(part) for part in error['loc'])}: {error['msg']}"
            for error in exc.errors()
        )
        body = ParserErrorResponse(code="invalid_request", message=details, retryable=False)
        return JSONResponse(body.model_dump(), status_code=422)

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        body = ParserErrorResponse(
            code=_code_for_status(exc.status_code),
            message=str(exc.detail),
            retryable=exc.status_code >= 500,
        )
        return JSONResponse(body.model_dump(), status_code=exc.status_code)

    @app.exception_handler(Exception)
    async def _unexpected(_: Request, exc: Exception) -> JSONResponse:
        logger.exception("parser.crashed", error=repr(exc))
        body = ParserErrorResponse(
            code="internal_error",
            message="unexpected parser failure",
            retryable=False,
        )
        return JSONResponse(body.model_dump(), status_code=500)
