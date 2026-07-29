import unittest
from pathlib import Path
import sys

from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import Settings
from app.main import validate_youtube_url
from app.youtube import YoutubeService


class YoutubeValidationTests(unittest.TestCase):
    def test_accepts_youtube_urls(self) -> None:
        url = "https://www.youtube.com/watch?v=abc"
        self.assertEqual(validate_youtube_url(url), url)
        self.assertEqual(
            validate_youtube_url("https://youtu.be/abc"),
            "https://youtu.be/abc",
        )

    def test_rejects_non_youtube_urls(self) -> None:
        with self.assertRaises(HTTPException) as context:
            validate_youtube_url("https://example.com/video")
        self.assertEqual(context.exception.status_code, 400)
        self.assertEqual(context.exception.detail["code"], "invalid_youtube_url")


class StreamSelectionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.service = YoutubeService(Settings())

    def test_selects_audio_only_for_mp3(self) -> None:
        streams = self.service._select_streams(
            {
                "formats": [
                    {
                        "format_id": "18",
                        "ext": "mp4",
                        "acodec": "mp4a",
                        "vcodec": "avc1",
                        "tbr": 300,
                        "url": "https://rr1.googlevideo.com/video",
                    },
                    {
                        "format_id": "140",
                        "ext": "m4a",
                        "acodec": "mp4a",
                        "vcodec": "none",
                        "abr": 128,
                        "url": "https://rr1.googlevideo.com/audio",
                    },
                ]
            },
            "mp3_128",
        )
        self.assertEqual(len(streams), 1)
        self.assertEqual(streams[0].kind, "audio")
        self.assertEqual(streams[0].format_id, "140")

    def test_selects_split_video_and_audio_for_mp4(self) -> None:
        streams = self.service._select_streams(
            {
                "formats": [
                    {
                        "format_id": "137",
                        "ext": "mp4",
                        "acodec": "none",
                        "vcodec": "avc1",
                        "height": 1080,
                        "tbr": 2500,
                        "url": "https://rr1.googlevideo.com/video",
                    },
                    {
                        "format_id": "140",
                        "ext": "m4a",
                        "acodec": "mp4a",
                        "vcodec": "none",
                        "abr": 128,
                        "url": "https://rr1.googlevideo.com/audio",
                    },
                ]
            },
            "mp4_1080p",
        )
        self.assertEqual([stream.kind for stream in streams], ["video", "audio"])

    def test_falls_back_to_progressive_video(self) -> None:
        streams = self.service._select_streams(
            {
                "formats": [
                    {
                        "format_id": "18",
                        "ext": "mp4",
                        "acodec": "mp4a",
                        "vcodec": "avc1",
                        "height": 360,
                        "tbr": 300,
                        "url": "https://rr1.googlevideo.com/video",
                    }
                ]
            },
            "mp4_720p",
        )
        self.assertEqual(len(streams), 1)
        self.assertEqual(streams[0].format_id, "18")

    def test_raises_when_no_formats_exist(self) -> None:
        with self.assertRaises(ValueError):
            self.service._select_streams({"formats": []}, "mp3_128")


if __name__ == "__main__":
    unittest.main()
