import re
import time
from collections import defaultdict, deque
from urllib.parse import urlparse

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from yt_dlp.utils import DownloadError, ExtractorError

from app.config import Settings, get_settings
from app.schemas import ErrorDetail
from app.schemas import DebugFormatsResponse, ExtractStreamResponse, MetadataResponse, SearchResponse
from app.youtube import YoutubeService


app = FastAPI(
    title="PB Media Fetch API",
    version="1.0.0",
    description="Metadata-only proxy for YouTube media streams.",
)

settings = get_settings()
request_log: dict[str, deque[float]] = defaultdict(deque)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.origins,
    allow_credentials=False,
    allow_methods=["GET", "OPTIONS"],
    allow_headers=["*"],
)


def get_youtube_service(config: Settings = Depends(get_settings)) -> YoutubeService:
    return YoutubeService(config)


def api_error(code: str, message: str, hint: str | None = None) -> dict[str, str | None]:
    return ErrorDetail(code=code, message=message, hint=hint).model_dump()


def ytdlp_error_detail(exc: Exception) -> str:
    return re.sub(r"\x1b\[[0-9;]*m", "", str(exc))


def client_key(request: Request) -> str:
    forwarded_for = request.headers.get("x-forwarded-for", "")
    if forwarded_for:
        return forwarded_for.split(",", 1)[0].strip()
    return request.client.host if request.client else "unknown"


def enforce_rate_limit(request: Request, config: Settings = Depends(get_settings)) -> None:
    now = time.monotonic()
    bucket = request_log[client_key(request)]
    while bucket and now - bucket[0] > config.rate_limit_window_seconds:
        bucket.popleft()
    if len(bucket) >= config.rate_limit_max_requests:
        raise HTTPException(
            status_code=429,
            detail=api_error(
                "rate_limited",
                "Bạn đang gửi quá nhiều yêu cầu. Hãy chờ một lát rồi thử lại.",
                f"Giới hạn hiện tại là {config.rate_limit_max_requests} yêu cầu/{config.rate_limit_window_seconds} giây.",
            ),
        )
    bucket.append(now)


def validate_youtube_url(url: str) -> str:
    parsed = urlparse(url)
    host = parsed.hostname.lower() if parsed.hostname else ""
    allowed_hosts = {
        "youtube.com",
        "www.youtube.com",
        "m.youtube.com",
        "music.youtube.com",
        "youtu.be",
    }
    if parsed.scheme not in {"http", "https"} or host not in allowed_hosts:
        raise HTTPException(
            status_code=400,
            detail=api_error(
                "invalid_youtube_url",
                "URL không thuộc YouTube.",
                "Hãy dùng link từ youtube.com, music.youtube.com hoặc youtu.be.",
            ),
        )
    return url


def handle_ytdlp_error(exc: Exception) -> HTTPException:
    return HTTPException(
        status_code=502,
        detail=api_error(
            "extractor_error",
            ytdlp_error_detail(exc),
            "Direct URL của YouTube có thể hết hạn nhanh. Hãy thử lại ngay trước khi tải.",
        ),
    )


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/search", response_model=SearchResponse)
async def search(
    q: str = Query(min_length=2),
    limit: int = Query(default=12, ge=1, le=60),
    _: None = Depends(enforce_rate_limit),
    service: YoutubeService = Depends(get_youtube_service),
) -> SearchResponse:
    try:
        if q.startswith(("http://", "https://")):
            q = validate_youtube_url(q)
        return SearchResponse(results=await service.search(q, limit=limit))
    except (DownloadError, ExtractorError) as exc:
        raise handle_ytdlp_error(exc) from exc


@app.get("/api/metadata", response_model=MetadataResponse)
async def metadata(
    url: str = Query(min_length=8),
    _: None = Depends(enforce_rate_limit),
    service: YoutubeService = Depends(get_youtube_service),
) -> MetadataResponse:
    try:
        url = validate_youtube_url(url)
        return await service.metadata(url)
    except (DownloadError, ExtractorError) as exc:
        raise handle_ytdlp_error(exc) from exc


@app.get("/api/extract-stream", response_model=ExtractStreamResponse)
async def extract_stream(
    url: str = Query(min_length=8),
    format: str = Query(default="auto_audio"),
    _: None = Depends(enforce_rate_limit),
    service: YoutubeService = Depends(get_youtube_service),
) -> ExtractStreamResponse:
    try:
        url = validate_youtube_url(url)
        title, streams = await service.extract_stream(url, format)
    except ValueError as exc:
        raise HTTPException(
            status_code=404,
            detail=api_error(
                "format_not_found",
                str(exc),
                "Hãy thử chất lượng thấp hơn hoặc bật tải file gốc.",
            ),
        ) from exc
    except (DownloadError, ExtractorError) as exc:
        raise handle_ytdlp_error(exc) from exc

    return ExtractStreamResponse(
        title=title,
        requested_format=format,
        stream_url=streams[0].url,
        streams=streams,
    )


@app.get("/api/debug/formats", response_model=DebugFormatsResponse)
async def debug_formats(
    url: str = Query(min_length=8),
    _: None = Depends(enforce_rate_limit),
    service: YoutubeService = Depends(get_youtube_service),
) -> DebugFormatsResponse:
    try:
        url = validate_youtube_url(url)
        video_id, title, formats = await service.debug_formats(url)
    except (DownloadError, ExtractorError) as exc:
        raise handle_ytdlp_error(exc) from exc

    return DebugFormatsResponse(
        id=video_id,
        title=title,
        format_count=len(formats),
        formats=formats,
    )
