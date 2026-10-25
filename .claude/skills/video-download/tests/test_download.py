"""Behavioral tests for format choice and final-file verification."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import download as video_download


class FormatChoiceTests(unittest.TestCase):
    def test_larger_video_only_format_keeps_separate_audio(self) -> None:
        info = {
            "formats": [
                {"format_id": "combined", "width": 1280, "height": 720, "vcodec": "h264", "acodec": "aac"},
                {"format_id": "video", "width": 1920, "height": 1080, "vcodec": "vp9", "acodec": "none"},
                {"format_id": "audio", "vcodec": "none", "acodec": "opus"},
            ]
        }
        selected = video_download.choose_format(info)
        self.assertEqual(selected["selector"], "video+ba")
        self.assertEqual((selected["width"], selected["height"]), (1920, 1080))
        self.assertTrue(selected["expect_audio"])

    def test_pixel_area_then_frame_rate_decide(self) -> None:
        info = {
            "formats": [
                {"format_id": "vertical", "width": 1080, "height": 1920, "fps": 30, "vcodec": "h264", "acodec": "aac"},
                {"format_id": "landscape", "width": 1920, "height": 1080, "fps": 60, "vcodec": "h264", "acodec": "aac"},
                {"format_id": "wide", "width": 2560, "height": 720, "fps": 120, "vcodec": "h264", "acodec": "aac"},
            ]
        }
        self.assertEqual(video_download.choose_format(info)["format_id"], "landscape")

    def test_unknown_progressive_audio_is_verified_without_duplicate_merge(self) -> None:
        info = {
            "formats": [
                {"format_id": "hls-audio", "vcodec": "none", "acodec": None},
                {"format_id": "http-high", "width": 788, "height": 576, "tbr": 2176, "vcodec": None, "acodec": None},
                {"format_id": "hls-high", "width": 788, "height": 576, "tbr": 472, "vcodec": "h264", "acodec": "none"},
            ]
        }
        selected = video_download.choose_format(info)
        self.assertEqual(selected["selector"], "http-high")
        self.assertTrue(selected["expect_audio"])

    def test_unknown_video_dimensions_prevent_highest_claim(self) -> None:
        info = {
            "formats": [
                {"format_id": "known", "width": 1280, "height": 720, "vcodec": "h264"},
                {"format_id": "unknown", "vcodec": "h264"},
            ]
        }
        with self.assertRaisesRegex(video_download.DownloadError, "lack dimensions"):
            video_download.choose_format(info)

    def test_one_direct_mp4_can_be_measured_after_download(self) -> None:
        info = {"formats": [{"format_id": "mp4", "ext": "mp4", "vcodec": None, "acodec": None}]}
        selected = video_download.choose_format(info)
        self.assertEqual(selected["selector"], "mp4")
        self.assertEqual(selected["pixels"], 0)
        self.assertIn("verified after download", selected["resolution_scope"])

    def test_playlist_is_not_silently_downloaded(self) -> None:
        with self.assertRaisesRegex(video_download.DownloadError, "multiple videos"):
            video_download.choose_format({"_type": "playlist", "entries": [{"id": "one"}]})


class VerificationTests(unittest.TestCase):
    def test_actual_lower_resolution_fails(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "video.mp4"
            path.write_bytes(b"nonempty")
            actual = json.dumps({"streams": [{"codec_type": "video", "width": 1280, "height": 720}]})
            selected = {"pixels": 1920 * 1080, "width": 1920, "height": 1080, "expect_audio": False}
            with (
                patch.object(video_download, "run_command", return_value=actual),
                self.assertRaisesRegex(video_download.DownloadError, "below selected"),
            ):
                video_download.verify(path, selected)

    def test_cli_download_reports_independently_verified_file(self) -> None:
        script = Path(video_download.__file__)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bin_dir = root / "bin"
            bin_dir.mkdir()
            yt_dlp = bin_dir / "yt-dlp"
            yt_dlp.write_text(
                "#!/usr/bin/env python3\n"
                "import json, pathlib, sys\n"
                "a = sys.argv[1:]\n"
                "if '--dump-single-json' in a:\n"
                "    print(json.dumps({'formats': ["
                "{'format_id':'low','width':640,'height':360,'vcodec':'h264','acodec':'aac'},"
                "{'format_id':'high','width':1920,'height':1080,'vcodec':'h264','acodec':'none'},"
                "{'format_id':'sound','vcodec':'none','acodec':'aac'}]}))\n"
                "else:\n"
                "    assert a[a.index('-f') + 1] == 'high+ba'\n"
                "    assert a[a.index('--referer') + 1] == 'https://example.org/page'\n"
                "    p = pathlib.Path(a[a.index('-P') + 1]) / 'test.mp4'\n"
                "    p.write_bytes(b'video')\n"
                "    print(p)\n",
                encoding="utf-8",
            )
            ffprobe = bin_dir / "ffprobe"
            ffprobe.write_text(
                "#!/usr/bin/env python3\n"
                "import json\n"
                "print(json.dumps({'streams': ["
                "{'codec_type':'video','width':1920,'height':1080},"
                "{'codec_type':'audio'}]}))\n",
                encoding="utf-8",
            )
            yt_dlp.chmod(0o755)
            ffprobe.chmod(0o755)
            result = subprocess.run(
                [
                    sys.executable,
                    str(script),
                    "https://example.org/embed/1",
                    "--referer",
                    "https://example.org/page",
                    "--output-dir",
                    str(root / "out"),
                ],
                capture_output=True,
                text=True,
                check=False,
                env={**os.environ, "PATH": f"{bin_dir}:{os.environ.get('PATH', '')}"},
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            delivered = json.loads(result.stdout)
            self.assertEqual((delivered["width"], delivered["height"]), (1920, 1080))
            self.assertTrue(delivered["has_audio"])
            self.assertEqual(Path(delivered["path"]).read_bytes(), b"video")


if __name__ == "__main__":
    unittest.main()
