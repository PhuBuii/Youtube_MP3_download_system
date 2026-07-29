import asyncio
from typing import Any

from yt_dlp import YoutubeDL

from app.config import Settings
from app.schemas import DebugFormatItem, FormatItem, MetadataResponse, SearchItem, StreamPart


YOUTUBE_WATCH_URL = "https://www.youtube.com/watch?v="


class YoutubeService:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    def _base_opts(self) -> dict[str, Any]:
        opts: dict[str, Any] = {
            "ignoreconfig": True,
            "quiet": True,
            "no_warnings": True,
            "skip_download": True,
            "noplaylist": True,
            "ignore_no_formats_error": True,
            "socket_timeout": self.settings.ytdlp_socket_timeout,
            "retries": 2,
            "extractor_args": {
                "youtube": {
                    "player_client": self.settings.player_clients,
                }
            },
        }

        if self.settings.ytdlp_pot_provider.lower() == "bgutil":
            opts["extractor_args"]["youtubepot-bgutilhttp"] = {
                "base_url": [self.settings.ytdlp_bgutil_base_url]
            }

        return opts

    async def search(self, query: str, limit: int = 12) -> list[SearchItem]:
        safe_limit = max(1, min(limit, 60))
        target = query if _looks_like_url(query) else f"ytsearch{safe_limit}:{query}"

        def run() -> dict[str, Any]:
            opts = self._base_opts()
            opts["extract_flat"] = "in_playlist"
            with YoutubeDL(opts) as ydl:
                return ydl.extract_info(target, download=False)

        info = await asyncio.to_thread(run)
        entries = info.get("entries") or [info]
        return [self._search_item(entry) for entry in entries[:safe_limit] if entry]

    async def metadata(self, url: str) -> MetadataResponse:
        info = await asyncio.to_thread(self._extract_info, url)
        return self._metadata_response(info, url)

    async def extract_stream(self, url: str, format_id: str) -> tuple[str, list[StreamPart]]:
        info = await asyncio.to_thread(self._extract_info, url)
        streams = self._select_streams(info, format_id)
        return info.get("title") or "media", streams

    async def debug_formats(self, url: str) -> tuple[str, str, list[DebugFormatItem]]:
        info = await asyncio.to_thread(self._extract_info, url)
        formats = [
            DebugFormatItem(
                format_id=_optional_str(fmt.get("format_id")),
                ext=fmt.get("ext"),
                acodec=fmt.get("acodec"),
                vcodec=fmt.get("vcodec"),
                height=fmt.get("height"),
                abr=fmt.get("abr"),
                protocol=fmt.get("protocol"),
                has_url=bool(fmt.get("url")),
            )
            for fmt in info.get("formats") or []
        ]
        return info.get("id") or "", info.get("title") or "Untitled video", formats

    def _extract_info(self, url: str) -> dict[str, Any]:
        with YoutubeDL(self._base_opts()) as ydl:
            return ydl.extract_info(url, download=False)

    def _search_item(self, entry: dict[str, Any]) -> SearchItem:
        video_id = entry.get("id") or ""
        url = entry.get("webpage_url") or entry.get("url") or f"{YOUTUBE_WATCH_URL}{video_id}"
        if video_id and not url.startswith("http"):
            url = f"{YOUTUBE_WATCH_URL}{video_id}"

        return SearchItem(
            id=video_id,
            url=url,
            title=entry.get("title") or "Untitled video",
            thumbnail=_best_thumbnail(entry),
            duration=entry.get("duration"),
            channel=entry.get("channel") or entry.get("uploader"),
        )

    def _metadata_response(self, info: dict[str, Any], url: str) -> MetadataResponse:
        formats = info.get("formats") or []
        audio = [_format_item(fmt, "audio") for fmt in formats if _is_audio(fmt)]
        video = [_format_item(fmt, "video") for fmt in formats if _is_video(fmt)]

        audio.sort(key=lambda item: item.abr or 0, reverse=True)
        video.sort(key=lambda item: (item.height or 0, item.vbr or 0), reverse=True)

        return MetadataResponse(
            id=info.get("id") or "",
            url=info.get("webpage_url") or url,
            title=info.get("title") or "Untitled video",
            thumbnail=_best_thumbnail(info),
            duration=info.get("duration"),
            channel=info.get("channel") or info.get("uploader"),
            audio_formats=audio[:12],
            video_formats=video[:20],
        )

    def _select_streams(self, info: dict[str, Any], format_id: str) -> list[StreamPart]:
        formats = info.get("formats") or []
        if not formats:
            raise ValueError("Không tìm thấy định dạng có thể tải. Hãy thử video khác, cấu hình player client khác hoặc cookies.")

        if format_id in {"auto_audio", "mp3_128", "mp3_320", "mp3_256", "mp3_64"}:
            audio_candidates = [f for f in formats if _has_audio(f) and _is_media_file(f) and f.get("url")]
            if not audio_candidates:
                raise ValueError("Không tìm thấy stream âm thanh có thể tải. Hãy thử video khác, cấu hình player client khác hoặc cookies.")
            fmt = max(audio_candidates, key=lambda f: (0 if _is_audio(f) else -1, f.get("abr") or f.get("tbr") or 0))
            return [_stream_part(fmt, "audio")]

        if format_id.startswith("mp4_"):
            height = int(format_id.replace("mp4_", "").replace("p", ""))
            progressive_candidates = [
                f for f in formats if _is_progressive_video(f) and f.get("url") and (f.get("height") or 0) <= height
            ]
            video_candidates = [
                f for f in formats if _is_video(f) and not _has_audio(f) and f.get("url") and (f.get("height") or 0) <= height
            ]
            audio_candidates = [f for f in formats if _is_audio(f) and f.get("url")]
            if video_candidates and audio_candidates:
                video = max(video_candidates, key=lambda f: (f.get("height") or 0, f.get("tbr") or 0))
                audio = max(audio_candidates, key=lambda f: f.get("abr") or 0)
                return [_stream_part(video, "video"), _stream_part(audio, "audio")]

            if progressive_candidates:
                progressive = max(progressive_candidates, key=lambda f: (f.get("height") or 0, f.get("tbr") or 0))
                return [_stream_part(progressive, "video")]

            if not video_candidates:
                raise ValueError(f"Không tìm thấy stream video có thể tải ở mức {height}p trở xuống. Hãy thử chất lượng thấp hơn hoặc video khác.")
            raise ValueError("Không tìm thấy stream âm thanh có thể tải. Hãy thử video khác, cấu hình player client khác hoặc cookies.")

        fmt = next((f for f in formats if f.get("format_id") == format_id and f.get("url")), None)
        if not fmt:
            raise ValueError(f"Không tìm thấy định dạng: {format_id}")

        kind = "video" if _has_video(fmt) else "audio"
        return [_stream_part(fmt, kind)]


def _looks_like_url(value: str) -> bool:
    return value.startswith("http://") or value.startswith("https://")


def _optional_str(value: Any) -> str | None:
    return None if value is None else str(value)


def _best_thumbnail(info: dict[str, Any]) -> str | None:
    thumbnails = info.get("thumbnails") or []
    if thumbnails:
        return thumbnails[-1].get("url")
    return info.get("thumbnail")


def _has_audio(fmt: dict[str, Any]) -> bool:
    return fmt.get("acodec") not in {None, "none"}


def _has_video(fmt: dict[str, Any]) -> bool:
    return fmt.get("vcodec") not in {None, "none"}


def _is_audio(fmt: dict[str, Any]) -> bool:
    return _has_audio(fmt) and not _has_video(fmt)


def _is_video(fmt: dict[str, Any]) -> bool:
    return _has_video(fmt) and fmt.get("ext") in {"mp4", "webm", "m4v"}


def _is_progressive_video(fmt: dict[str, Any]) -> bool:
    return _has_audio(fmt) and _has_video(fmt) and _is_media_file(fmt)


def _is_media_file(fmt: dict[str, Any]) -> bool:
    return fmt.get("ext") in {"mp4", "webm", "m4a", "mp3", "opus"}


def _format_item(fmt: dict[str, Any], item_type: str) -> FormatItem:
    height = fmt.get("height")
    abr = fmt.get("abr")
    label = f"{height}p" if item_type == "video" and height else f"{int(abr or 0)}kbps"
    return FormatItem(
        format_id=str(fmt.get("format_id")),
        label=label,
        ext=fmt.get("ext"),
        type=item_type,
        abr=abr,
        vbr=fmt.get("vbr"),
        height=height,
        fps=fmt.get("fps"),
        filesize=fmt.get("filesize") or fmt.get("filesize_approx"),
        has_audio=_has_audio(fmt),
        has_video=_has_video(fmt),
    )


def _stream_part(fmt: dict[str, Any], kind: str) -> StreamPart:
    return StreamPart(
        kind=kind,
        url=fmt["url"],
        ext=fmt.get("ext"),
        format_id=str(fmt.get("format_id")),
    )
