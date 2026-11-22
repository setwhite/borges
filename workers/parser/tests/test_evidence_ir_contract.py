from __future__ import annotations

import json
from pathlib import Path

import jsonschema
import pytest
from pydantic import ValidationError

from borges_parser import (
    DocumentMeta,
    EvidenceIR,
    EvidenceSegment,
    LineAnchor,
    PageAnchor,
    TimeAnchor,
)

SCHEMA_PATH = Path(__file__).resolve().parents[3] / "schemas" / "evidence-ir.schema.json"
VALID_HASH = "a" * 64


def test_evidence_ir_matches_shared_json_schema() -> None:
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    evidence = EvidenceIR(
        documentMeta=DocumentMeta(
            title="sample.pdf",
            mediaType="application/pdf",
            contentHash=VALID_HASH,
            parserEngine="mineru",
        ),
        segments=[
            EvidenceSegment(
                text="Section 1 content",
                anchor=PageAnchor(pageNumber=1, sectionPath=["Overview"]),
            ),
            EvidenceSegment(
                text="Speaker utterance",
                anchor=TimeAnchor(startMs=0, endMs=1200, speaker="S1"),
            ),
            EvidenceSegment(
                text="export const version = 1;",
                anchor=LineAnchor(filePath="src/index.ts", startLine=1, endLine=1),
            ),
        ],
    )
    dumped = evidence.model_dump(by_alias=True, exclude_none=True)
    jsonschema.validate(instance=dumped, schema=schema)


def test_rejects_illegal_time_range() -> None:
    with pytest.raises(ValidationError):
        TimeAnchor(startMs=1000, endMs=1000)


def test_rejects_illegal_line_range() -> None:
    with pytest.raises(ValidationError):
        LineAnchor(filePath="src/index.ts", startLine=10, endLine=5)


def test_rejects_extra_fields() -> None:
    payload = {
        "documentMeta": {
            "title": "sample.pdf",
            "mediaType": "application/pdf",
            "contentHash": VALID_HASH,
            "parserEngine": "mineru",
            "unexpectedMeta": True,
        },
        "segments": [],
    }
    with pytest.raises(ValidationError):
        EvidenceIR.model_validate(payload)
