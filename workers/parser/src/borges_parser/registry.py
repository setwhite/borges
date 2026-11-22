from __future__ import annotations

from collections.abc import Iterable

from pydantic import BaseModel, ConfigDict, Field

from borges_parser.errors import UnknownEngineError, UnsupportedFormatError
from borges_parser.protocols import DocumentParser, EngineStatus, ParserEngine


class _CamelModel(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class EngineHealth(_CamelModel):
    name: str
    supported_extensions: list[str] = Field(alias="supportedExtensions")
    available: bool
    reason: str | None = None


class HealthResponse(_CamelModel):
    status: str
    engines: list[EngineHealth]


class ParserEngineRegistry:
    def __init__(self, engines: Iterable[DocumentParser]) -> None:
        self._by_name: dict[str, ParserEngine] = {}
        self._by_extension: dict[str, str] = {}
        for engine in engines:
            if engine.name in self._by_name:
                raise ValueError(f"duplicate parser engine name: {engine.name}")
            self._by_name[engine.name] = engine
            for extension in engine.supported_extensions:
                owner = self._by_extension.setdefault(extension.lower(), engine.name)
                if owner != engine.name:
                    raise ValueError(
                        f"extension {extension} registered by both {owner} and {engine.name}"
                    )

    def resolve(self, extension: str, engine_name: str | None = None) -> ParserEngine:
        if engine_name is not None:
            engine = self._by_name.get(engine_name)
            if engine is None:
                known = ", ".join(sorted(self._by_name))
                raise UnknownEngineError(f"unknown parser engine {engine_name!r}, known: {known}")
            return engine
        name = self._by_extension.get(extension.lower())
        if name is None:
            known = ", ".join(sorted(self._by_extension))
            raise UnsupportedFormatError(
                f"no parser engine handles {extension or '<no extension>'!r}, supported: {known}"
            )
        return self._by_name[name]

    def health(self) -> HealthResponse:
        statuses: list[EngineHealth] = []
        for engine in self._by_name.values():
            status = self._describe(engine)
            statuses.append(
                EngineHealth(
                    name=engine.name,
                    supportedExtensions=list(engine.supported_extensions),
                    available=status.available,
                    reason=status.reason,
                )
            )
        degraded = any(not status.available for status in statuses)
        return HealthResponse(status="degraded" if degraded else "ok", engines=statuses)

    def _describe(self, engine: ParserEngine) -> EngineStatus:
        return engine.check_available()
