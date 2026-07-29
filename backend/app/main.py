import re

from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from yt_dlp.utils import DownloadError, ExtractorError

from app.config import Settings, get_settings
from app.schemas import DebugFormatsResponse, ExtractStreamResponse, MetadataResponse, SearchResponse
from app.youtube import YoutubeService


app = FastAPI(
    title="SonicFetch API",
    version="1.0.0",
    description="Metadata-only proxy for YouTube media streams.",
)

settings = get_settings()
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.origins,
    allow_credentials=False,
    allow_methods=["GET", "OPTIONS"],
    allow_headers=["*"],
)


def get_youtube_service(config: Settings = Depends(get_settings)) -> YoutubeService:
    return YoutubeService(config)


def ytdlp_error_detail(exc: Exception) -> str:
    return re.sub(r"\x1b\[[0-9;]*m", "", str(exc))


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/search", response_model=SearchResponse)
async def search(
    q: str = Query(min_length=2),
    limit: int = Query(default=12, ge=1, le=60),
    service: YoutubeService = Depends(get_youtube_service),
) -> SearchResponse:
    try:
        return SearchResponse(results=await service.search(q, limit=limit))
    except (DownloadError, ExtractorError) as exc:
        raise HTTPException(status_code=502, detail=ytdlp_error_detail(exc)) from exc


@app.get("/api/metadata", response_model=MetadataResponse)
async def metadata(
    url: str = Query(min_length=8),
    service: YoutubeService = Depends(get_youtube_service),
) -> MetadataResponse:
    try:
        return await service.metadata(url)
    except (DownloadError, ExtractorError) as exc:
        raise HTTPException(status_code=502, detail=ytdlp_error_detail(exc)) from exc


@app.get("/api/extract-stream", response_model=ExtractStreamResponse)
async def extract_stream(
    url: str = Query(min_length=8),
    format: str = Query(default="auto_audio"),
    service: YoutubeService = Depends(get_youtube_service),
) -> ExtractStreamResponse:
    try:
        title, streams = await service.extract_stream(url, format)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except (DownloadError, ExtractorError) as exc:
        raise HTTPException(status_code=502, detail=ytdlp_error_detail(exc)) from exc

    return ExtractStreamResponse(
        title=title,
        requested_format=format,
        stream_url=streams[0].url,
        streams=streams,
    )


@app.get("/api/debug/formats", response_model=DebugFormatsResponse)
async def debug_formats(
    url: str = Query(min_length=8),
    service: YoutubeService = Depends(get_youtube_service),
) -> DebugFormatsResponse:
    try:
        video_id, title, formats = await service.debug_formats(url)
    except (DownloadError, ExtractorError) as exc:
        raise HTTPException(status_code=502, detail=ytdlp_error_detail(exc)) from exc

    return DebugFormatsResponse(
        id=video_id,
        title=title,
        format_count=len(formats),
        formats=formats,
    )
