from __future__ import annotations

from pathlib import Path
from typing import Protocol, runtime_checkable

from pydantic import BaseModel

from borges_parser.contracts import EvidenceIR


class EngineStatus(BaseModel):
    available: bool
    reason: str | None = None


@runtime_checkable
class ParserEngine(Protocol):
    name: str
    supported_extensions: tuple[str, ...]

    def check_available(self) -> EngineStatus: ...

    async def parse(self, file_path: Path, content_hash: str) -> EvidenceIR: ...


DocumentParser = ParserEngine
Transcriber = ParserEngine
