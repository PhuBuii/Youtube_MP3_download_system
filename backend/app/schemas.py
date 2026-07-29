from pydantic import BaseModel, Field, HttpUrl


class SearchItem(BaseModel):
    id: str
    url: str
    title: str
    thumbnail: str | None = None
    duration: int | None = None
    channel: str | None = None


class SearchResponse(BaseModel):
    results: list[SearchItem]


class ErrorDetail(BaseModel):
    code: str
    message: str
    hint: str | None = None


class FormatItem(BaseModel):
    format_id: str
    label: str
    ext: str | None = None
    type: str
    abr: float | None = None
    vbr: float | None = None
    height: int | None = None
    fps: float | None = None
    filesize: int | None = None
    has_audio: bool = False
    has_video: bool = False


class MetadataResponse(BaseModel):
    id: str
    url: str
    title: str
    thumbnail: str | None = None
    duration: int | None = None
    channel: str | None = None
    audio_formats: list[FormatItem] = Field(default_factory=list)
    video_formats: list[FormatItem] = Field(default_factory=list)


class StreamPart(BaseModel):
    kind: str
    url: HttpUrl
    ext: str | None = None
    format_id: str


class ExtractStreamResponse(BaseModel):
    title: str
    requested_format: str
    stream_url: HttpUrl
    streams: list[StreamPart]


class DebugFormatItem(BaseModel):
    format_id: str | None = None
    ext: str | None = None
    acodec: str | None = None
    vcodec: str | None = None
    height: int | None = None
    abr: float | None = None
    protocol: str | None = None
    has_url: bool = False


class DebugFormatsResponse(BaseModel):
    id: str
    title: str
    format_count: int
    formats: list[DebugFormatItem]
