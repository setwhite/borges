from __future__ import annotations

import io
import wave
from dataclasses import dataclass
from pathlib import Path

import httpx
from pydantic import BaseModel, ValidationError

from borges_parser.contracts import DocumentMeta, EvidenceIR, EvidenceSegment, TimeAnchor
from borges_parser.errors import (
    CorruptedFileError,
    FileTooLargeError,
    UpstreamApiError,
    UpstreamTimeoutError,
)
from borges_parser.protocols import EngineStatus

MAX_UPLOAD_BYTES = 8 * 1024 * 1024
SLICE_AUDIO_MS = 115_000
SLICE_BUDGET_BYTES = 7 * 1024 * 1024
BYTES_PER_SAMPLE = 2

MEDIA_TYPES = {".wav": "audio/wav", ".ogg": "audio/ogg", ".opus": "audio/ogg"}


class AsrResponse(BaseModel):
    request_id: str
    text: str
    duration_ms: int


@dataclass(frozen=True)
class WavInfo:
    channels: int
    frame_rate: int
    frame_count: int

    @property
    def bytes_per_frame(self) -> int:
        return self.channels * BYTES_PER_SAMPLE

    @property
    def duration_ms(self) -> int:
        return self.frame_count * 1000 // self.frame_rate


@dataclass(frozen=True)
class WavChunk:
    start_frame: int
    end_frame: int
    start_ms: int
    end_ms: int


def _data_chunk_offset(file_path: Path) -> int:
    with file_path.open("rb") as handle:
        header = handle.read(12)
        if len(header) < 12 or header[:4] != b"RIFF" or header[8:12] != b"WAVE":
            raise CorruptedFileError(f"not a RIFF/WAVE file: {file_path.name}")
        offset = 12
        while True:
            chunk_header = handle.read(8)
            if len(chunk_header) < 8:
                raise CorruptedFileError(f"WAV carries no data chunk: {file_path.name}")
            chunk_size = int.from_bytes(chunk_header[4:], "little")
            if chunk_header[:4] == b"data":
                return offset + 8
            offset += 8 + chunk_size + (chunk_size & 1)
            handle.seek(offset)


def read_wav_info(file_path: Path) -> WavInfo:
    data_offset = _data_chunk_offset(file_path)
    try:
        with wave.open(str(file_path), "rb") as handle:
            if handle.getcomptype() != "NONE":
                raise CorruptedFileError(f"compressed WAV is not supported: {file_path.name}")
            if handle.getsampwidth() != BYTES_PER_SAMPLE:
                raise CorruptedFileError(
                    f"WAV must be 16-bit PCM, got {handle.getsampwidth() * 8}-bit: {file_path.name}"
                )
            channels = handle.getnchannels()
            frame_rate = handle.getframerate()
            payload_bytes = max(file_path.stat().st_size - data_offset, 0)
            frame_count = min(handle.getnframes(), payload_bytes // (channels * BYTES_PER_SAMPLE))
            info = WavInfo(channels=channels, frame_rate=frame_rate, frame_count=frame_count)
    except (wave.Error, EOFError) as exc:
        raise CorruptedFileError(f"invalid WAV file {file_path.name}: {exc}") from exc
    if info.channels < 1 or info.frame_rate < 1 or info.frame_count < 1:
        raise CorruptedFileError(f"WAV file carries no audio frames: {file_path.name}")
    if info.duration_ms < 1:
        raise CorruptedFileError(f"WAV file is shorter than 1ms: {file_path.name}")
    return info


def plan_wav_chunks(info: WavInfo) -> list[WavChunk]:
    max_frames = min(
        SLICE_AUDIO_MS * info.frame_rate // 1000,
        SLICE_BUDGET_BYTES // info.bytes_per_frame,
    )
    if max_frames < 1:
        raise FileTooLargeError(f"WAV frame size exceeds the {SLICE_BUDGET_BYTES}B upload budget")
    if info.frame_count <= max_frames:
        return [WavChunk(0, info.frame_count, 0, info.duration_ms)]
    chunks: list[WavChunk] = []
    for start_frame in range(0, info.frame_count, max_frames):
        end_frame = min(start_frame + max_frames, info.frame_count)
        start_ms = start_frame * 1000 // info.frame_rate
        end_ms = (
            info.duration_ms
            if end_frame == info.frame_count
            else end_frame * 1000 // info.frame_rate
        )
        chunks.append(WavChunk(start_frame, end_frame, start_ms, max(end_ms, start_ms + 1)))
    return chunks


def encode_wav(info: WavInfo, frames: bytes) -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(info.channels)
        handle.setsampwidth(BYTES_PER_SAMPLE)
        handle.setframerate(info.frame_rate)
        handle.writeframes(frames)
    return buffer.getvalue()


class DeepSeekAsrTranscriber:
    name: str = "deepseek_asr"
    supported_extensions: tuple[str, ...] = (".wav", ".ogg", ".opus")

    def __init__(self, *, api_key: str | None, base_url: str, client: httpx.AsyncClient) -> None:
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._client = client

    def check_available(self) -> EngineStatus:
        if not self._api_key:
            return EngineStatus(available=False, reason="DEEPSEEK_API_KEY is not set")
        return EngineStatus(available=True)

    async def parse(self, file_path: Path, content_hash: str) -> EvidenceIR:
        media_type = MEDIA_TYPES[file_path.suffix.lower()]
        if file_path.suffix.lower() == ".wav":
            segments = await self._transcribe_wav(file_path)
        else:
            segments = await self._transcribe_compressed(file_path)
        return EvidenceIR(
            documentMeta=DocumentMeta(
                title=file_path.stem,
                mediaType=media_type,
                contentHash=content_hash,
                parserEngine=self.name,
            ),
            segments=segments,
        )

    async def _transcribe_wav(self, file_path: Path) -> list[EvidenceSegment]:
        info = read_wav_info(file_path)
        segments: list[EvidenceSegment] = []
        with wave.open(str(file_path), "rb") as source:
            for index, chunk in enumerate(plan_wav_chunks(info), start=1):
                source.setpos(chunk.start_frame)
                frames = source.readframes(chunk.end_frame - chunk.start_frame)
                text = await self._transcribe(
                    f"{file_path.stem}-{index:03d}.wav", encode_wav(info, frames), "audio/wav"
                )
                segments.extend(_segments_from(text, chunk.start_ms, chunk.end_ms))
        return segments

    async def _transcribe_compressed(self, file_path: Path) -> list[EvidenceSegment]:
        data = file_path.read_bytes()
        if not data:
            raise CorruptedFileError(f"audio file is empty: {file_path.name}")
        if len(data) > MAX_UPLOAD_BYTES:
            raise FileTooLargeError(
                f"{file_path.name} is {len(data)}B, ASR accepts at most {MAX_UPLOAD_BYTES}B"
            )
        result = await self._transcribe(file_path.name, data, "audio/ogg")
        if result.duration_ms < 1:
            raise UpstreamApiError(f"ASR returned no duration for {file_path.name}")
        return _segments_from(result, 0, result.duration_ms)

    async def _transcribe(self, filename: str, data: bytes, media_type: str) -> AsrResponse:
        try:
            response = await self._client.post(
                f"{self._base_url}/v1/tools/asr",
                headers={"Authorization": f"Bearer {self._api_key}"},
                files={"file": (filename, data, media_type)},
            )
        except httpx.TimeoutException as exc:
            raise UpstreamTimeoutError(f"ASR request timed out: {exc}") from exc
        except httpx.HTTPError as exc:
            raise UpstreamApiError(f"ASR request failed: {exc}") from exc
        if response.status_code >= 400:
            retryable = response.status_code == 429 or response.status_code >= 500
            raise UpstreamApiError(
                f"ASR upstream returned {response.status_code}: {response.text[:200]}",
                retryable=retryable,
            )
        try:
            return AsrResponse.model_validate(response.json())
        except (ValueError, ValidationError) as exc:
            raise UpstreamApiError(f"ASR upstream returned a malformed payload: {exc}") from exc


def _segments_from(
    result: AsrResponse, start_ms: int, unmeasured_end_ms: int
) -> list[EvidenceSegment]:
    text = result.text.strip()
    if not text:
        return []
    end_ms = start_ms + result.duration_ms if result.duration_ms > 0 else unmeasured_end_ms
    return [
        EvidenceSegment(
            text=text, anchor=TimeAnchor(startMs=start_ms, endMs=max(end_ms, start_ms + 1))
        ),
    ]
