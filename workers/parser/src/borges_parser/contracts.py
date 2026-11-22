from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class _CamelModel(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class PageAnchor(_CamelModel):
    kind: Literal["page"] = "page"
    page_number: int = Field(alias="pageNumber", ge=1)
    section_path: list[str] = Field(alias="sectionPath")


class TimeAnchor(_CamelModel):
    kind: Literal["time"] = "time"
    start_ms: int = Field(alias="startMs", ge=0)
    end_ms: int = Field(alias="endMs", ge=1)
    speaker: str | None = Field(default=None, min_length=1)

    @model_validator(mode="after")
    def _validate_range(self) -> TimeAnchor:
        if self.start_ms >= self.end_ms:
            raise ValueError("startMs must be strictly less than endMs")
        return self


class LineAnchor(_CamelModel):
    kind: Literal["line"] = "line"
    file_path: str = Field(alias="filePath", min_length=1)
    start_line: int = Field(alias="startLine", ge=1)
    end_line: int = Field(alias="endLine", ge=1)

    @model_validator(mode="after")
    def _validate_range(self) -> LineAnchor:
        if self.start_line > self.end_line:
            raise ValueError("startLine must be less than or equal to endLine")
        return self


Anchor = Annotated[PageAnchor | TimeAnchor | LineAnchor, Field(discriminator="kind")]


class DocumentMeta(_CamelModel):
    title: str = Field(min_length=1)
    media_type: str = Field(alias="mediaType", min_length=1)
    content_hash: str = Field(alias="contentHash", pattern=r"^[a-f0-9]{64}$")
    parser_engine: str = Field(alias="parserEngine", min_length=1)


class EvidenceSegment(_CamelModel):
    text: str = Field(min_length=1)
    anchor: Anchor
    attachments: list[str] | None = None


class EvidenceIR(_CamelModel):
    document_meta: DocumentMeta = Field(alias="documentMeta")
    segments: list[EvidenceSegment]
