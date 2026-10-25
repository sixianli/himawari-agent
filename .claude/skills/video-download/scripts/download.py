#!/usr/bin/env python3
"""Download one video's largest known pixel resolution and verify the result."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import ssl
import subprocess
import sys
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit


class DownloadError(Exception):
    """The requested video could not be delivered with verified resolution."""


def positive_number(value: Any) -> float:
    """Return usable numeric metadata, or zero for missing/invalid values."""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0
    return number if 0 < number < float("inf") else 0


def choose_format(info: dict[str, Any]) -> dict[str, Any]:
    """Select the largest known video format without silently ignoring unknowns."""
    if info.get("_type") in {"playlist", "multi_video"}:
        raise DownloadError("URL resolves to multiple videos; select one video URL first")

    formats = info.get("formats")
    if not isinstance(formats, list):
        raise DownloadError("yt-dlp supplied no format list; inspect the player or manifest")

    videos: list[tuple[tuple[float, ...], dict[str, Any]]] = []
    unknown: list[str] = []
    single_unmeasured: dict[str, Any] | None = None
    audio_only = False
    combined = False
    for index, item in enumerate(formats):
        if not isinstance(item, dict):
            continue
        video_codec = item.get("vcodec")
        audio_codec = item.get("acodec")
        width = positive_number(item.get("width"))
        height = positive_number(item.get("height"))
        if video_codec == "none":
            audio_only |= audio_codec != "none"
            continue
        direct_video = item.get("ext") in {"mp4", "webm", "mov", "mkv", "m4v", "ts"}
        if video_codec is None and not (width or height or direct_video):
            continue
        if not width or not height:
            unknown.append(str(item.get("format_id", "unknown")))
            if len(formats) == 1 and direct_video and item.get("format_id"):
                single_unmeasured = item
            continue
        if not item.get("format_id"):
            unknown.append("missing format_id")
            continue
        combined |= audio_codec not in (None, "none")
        area = width * height
        bitrate = positive_number(item.get("vbr")) or positive_number(item.get("tbr"))
        rank = (area, positive_number(item.get("fps")), bitrate, float(index))
        videos.append((rank, item))

    if single_unmeasured is not None:
        return {
            "format_id": str(single_unmeasured["format_id"]),
            "selector": str(single_unmeasured["format_id"]),
            "width": None,
            "height": None,
            "pixels": 0,
            "expect_audio": False,
            "requires_merge": False,
            "known_video_formats": 0,
            "resolution_scope": "one direct format; dimensions verified after download",
        }
    if unknown:
        raise DownloadError(
            "some video formats lack dimensions ("
            + ", ".join(unknown)
            + "); inspect the source manifest before claiming the maximum"
        )
    if not videos:
        raise DownloadError("no video format with known dimensions was found")

    _, selected = max(videos, key=lambda candidate: candidate[0])
    needs_audio = selected.get("acodec") == "none"
    if needs_audio and combined and not audio_only:
        raise DownloadError(
            "the largest video format has no audio and no separate audio stream was found; "
            "inspect the source before delivering a silent file"
        )
    format_id = str(selected["format_id"])
    selector = f"{format_id}+ba" if needs_audio and audio_only else format_id
    return {
        "format_id": format_id,
        "selector": selector,
        "width": int(selected["width"]),
        "height": int(selected["height"]),
        "pixels": int(positive_number(selected["width"]) * positive_number(selected["height"])),
        "expect_audio": audio_only or selected.get("acodec") not in (None, "none"),
        "requires_merge": needs_audio and audio_only,
        "known_video_formats": len(videos),
        "resolution_scope": "all video formats exposed by yt-dlp for this URL",
    }


def run_command(command: list[str], *, timeout: int | None = None) -> str:
    """Run without a shell so untrusted URLs cannot become commands."""
    environment = os.environ.copy()
    if (
        sys.platform == "darwin"
        and "SSL_CERT_FILE" not in environment
        and ssl.get_default_verify_paths().cafile is None
        and Path("/etc/ssl/cert.pem").is_file()
    ):
        environment["SSL_CERT_FILE"] = "/etc/ssl/cert.pem"
    try:
        result = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            timeout=timeout,
            env=environment,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise DownloadError(f"{command[0]} could not finish: {error}") from error
    if result.returncode:
        detail = (result.stderr or result.stdout).strip()[-1600:]
        raise DownloadError(f"{command[0]} failed ({result.returncode}): {detail}")
    return result.stdout.strip()


def yt_options(args: argparse.Namespace) -> list[str]:
    """Keep authentication and player headers scoped to the chosen invocation."""
    options = ["--ignore-config", "--no-playlist", "--abort-on-error"]
    if args.referer:
        options.extend(["--referer", args.referer])
    if args.origin:
        options.extend(["--add-headers", f"Origin:{args.origin}"])
    if args.cookies_from_browser:
        options.extend(["--cookies-from-browser", args.cookies_from_browser])
    return options


def inspect(args: argparse.Namespace) -> dict[str, Any]:
    output = run_command(
        ["yt-dlp", *yt_options(args), "--dump-single-json", "--", args.url],
        timeout=180,
    )
    try:
        info = json.loads(output)
    except json.JSONDecodeError as error:
        raise DownloadError("yt-dlp did not return valid format JSON") from error
    if not isinstance(info, dict):
        raise DownloadError("yt-dlp returned an unexpected metadata shape")
    return choose_format(info)


def verify(path: Path, selected: dict[str, Any]) -> dict[str, Any]:
    """Read back the actual media stream, not only the extractor's metadata."""
    if not path.is_file() or path.stat().st_size == 0:
        raise DownloadError(f"downloaded file is missing or empty: {path}")
    output = run_command(
        ["ffprobe", "-v", "error", "-show_streams", "-of", "json", str(path)],
        timeout=90,
    )
    try:
        streams = json.loads(output)["streams"]
    except (json.JSONDecodeError, KeyError, TypeError) as error:
        raise DownloadError("ffprobe returned invalid stream information") from error
    if not isinstance(streams, list):
        raise DownloadError("ffprobe returned no stream list")
    video_streams = [
        stream
        for stream in streams
        if stream.get("codec_type") == "video"
        and not stream.get("disposition", {}).get("attached_pic")
    ]
    if not video_streams:
        raise DownloadError("downloaded file has no video stream")
    video = max(
        video_streams,
        key=lambda stream: positive_number(stream.get("width"))
        * positive_number(stream.get("height")),
    )
    width = int(positive_number(video.get("width")))
    height = int(positive_number(video.get("height")))
    if not width or not height:
        raise DownloadError("ffprobe could not measure the downloaded video's dimensions")
    if width * height < selected["pixels"]:
        raise DownloadError(
            f"actual video is {width}x{height}, below selected "
            f"{selected['width']}x{selected['height']}"
        )
    has_audio = any(stream.get("codec_type") == "audio" for stream in streams)
    if selected["expect_audio"] and not has_audio:
        raise DownloadError("the source offered audio but the downloaded file has none")
    return {
        "path": str(path),
        "width": width,
        "height": height,
        "size_bytes": path.stat().st_size,
        "has_audio": has_audio,
        "format_id": selected["format_id"],
        "known_video_formats": selected["known_video_formats"],
        "resolution_scope": selected["resolution_scope"],
    }


def download(args: argparse.Namespace, selected: dict[str, Any]) -> dict[str, Any]:
    directory = Path(args.output_dir).expanduser().resolve()
    directory.mkdir(parents=True, exist_ok=True)
    output = run_command(
        [
            "yt-dlp",
            *yt_options(args),
            "--quiet",
            "--no-simulate",
            "-f",
            selected["selector"],
            "-P",
            str(directory),
            "-o",
            "%(extractor_key)s-%(id)s-%(format_id)s.%(ext)s",
            "--print",
            "after_move:filepath",
            "--",
            args.url,
        ]
    )
    paths = output.splitlines()
    if len(paths) != 1:
        raise DownloadError("yt-dlp did not report exactly one final file path")
    path = Path(paths[0]).expanduser().resolve()
    if not path.is_relative_to(directory):
        raise DownloadError("yt-dlp reported a file outside the requested output directory")
    return verify(path, selected)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("url", help="HTTP(S) video or page URL")
    parser.add_argument("--output-dir", help="directory for the final video")
    parser.add_argument("--inspect", action="store_true", help="select a format without downloading")
    parser.add_argument("--referer", help="original page URL for an embedded player")
    parser.add_argument("--origin", help="Origin header required by an embedded player")
    parser.add_argument("--cookies-from-browser", help="authorized local browser name/profile")
    args = parser.parse_args()
    parsed = urlsplit(args.url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        parser.error("URL must be an HTTP(S) URL")
    if not args.inspect and not args.output_dir:
        parser.error("--output-dir is required unless --inspect is set")
    if not shutil.which("yt-dlp"):
        parser.error("yt-dlp is required; see https://github.com/yt-dlp/yt-dlp/wiki/Installation")
    if not args.inspect and not shutil.which("ffprobe"):
        parser.error("ffprobe is required to verify the downloaded file; install FFmpeg")
    try:
        selected = inspect(args)
        result = selected if args.inspect else download(args, selected)
    except DownloadError as error:
        print(f"video-download: {error}", file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
