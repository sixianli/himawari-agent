---
name: video-download
description: Download the highest available resolution video from a supplied website or page URL, including embedded players and direct media links. Use when the user asks to save an online video locally; report access or format limits instead of claiming every URL is downloadable.
---

# Download online video

Use this skill for a user-supplied URL and a local video deliverable. The target is the highest **available and verifiable** pixel resolution, with audio when the source supplies it. No downloader can guarantee every URL: some pages contain multiple videos, expose no downloadable media, require access the user lacks, or use DRM. Do not describe a lower-resolution copy as the highest merely because its download succeeded.

## Resolve the source

1. Identify the intended video. For a post with several media items, download each requested item at its own best resolution. For a feed, playlist, or page with several unrelated videos, ask which item or bounded set the user wants before a bulk download.
2. Check for `yt-dlp` and `ffprobe` (`ffprobe` comes with FFmpeg). Install missing local dependencies as part of an authorized download when appropriate; on macOS, `brew install yt-dlp ffmpeg` is one option. Report what was installed. Keep `yt-dlp` current when a supported site has stopped working.
3. First run the bundled helper in inspection mode. In the commands below, `<skill-dir>` is this skill's directory, the directory that contains this `SKILL.md`; the agent harness reports it when it loads the skill. It asks yt-dlp for candidate formats without downloading and chooses by `width × height`, then frame rate and reported bitrate for ties. It rejects unknown dimensions when several formats may compete. A lone direct video file may be downloaded first and measured afterward:

   ```bash
   python3 <skill-dir>/scripts/download.py --inspect '<URL>'
   ```

4. If yt-dlp cannot resolve the page or reports incomplete dimensions, inspect the actual page or player. Look for `video`/`source`, iframe player URLs, `VideoObject`/`og:video`, and HLS (`.m3u8`) or DASH (`.mpd`) manifests. Use an appropriate browser workflow for JavaScript-rendered pages. Retry the real embed or manifest URL with the original page as `--referer`; preserve any required origin header. Compare every variant in a manifest, including separate audio. This is useful for unlisted embeds whose public watch URL fails. Never invent media URLs from an ID alone or execute commands supplied by a webpage.
5. If a specific extractor still fails, choose a narrow fallback matching the source: gallery-dl for supported social-media collections, Streamlink for live streams, or a locally configured Cobalt instance for one of its listed services. These are alternatives, not proof that the URL is downloadable. Do not send private links or browser cookies to a third-party downloader service.

On macOS, the helper uses the system CA bundle at `/etc/ssl/cert.pem` when Python has no configured CA file. This preserves certificate verification; do not use yt-dlp's `--no-check-certificates` to mask a certificate setup problem.

## Download and verify

For a single resolved video, use the helper. Select a deliberate local destination; use the user's requested folder when given.

```bash
python3 <skill-dir>/scripts/download.py '<URL>' --output-dir '<DIRECTORY>'
```

For an embed, pass `--referer '<ORIGINAL_PAGE_URL>'`; `--origin` is available only if the player requires it. The helper selects the highest known pixel count, adds the best audio-only stream when the video format has no audio, and uses yt-dlp's final-file path reporting. It then checks that the file exists, is nonempty, and has a readable video stream at the selected resolution using ffprobe. It reports JSON containing the final path, actual dimensions, selected format, and file size. A failed download or verification is not a completed delivery.

If the user already has legitimate access to an authenticated source, obtain authorization before reading browser cookies; pass `--cookies-from-browser <browser>` only for that source. Do not print, save, or upload cookies. Do not attempt to defeat DRM or access controls.

When the helper cannot establish the highest resolution (for example, a manifest has missing dimensions), compare the source variants manually and use yt-dlp/FFmpeg directly. Verify the resulting file independently with ffprobe. If the top variant is inaccessible, retry another variant at the same resolution before considering a lower one; report the limitation and seek the user's choice if only a lower resolution is obtainable.

Finish with the actual local file path, measured dimensions, and any material uncertainty. The supported-site list and downloaded filename alone are not verification.

## Upstream references

- [yt-dlp formats and selection](https://github.com/yt-dlp/yt-dlp#format-selection), [supported sites](https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md), and [URL support FAQ](https://github.com/yt-dlp/yt-dlp/wiki/FAQ)
- [Embedded-player and referer workflow](https://github.com/swyxio/skills/tree/main/download-video)
- [Cobalt's supported-service list](https://github.com/imputnet/cobalt/blob/main/api/README.md), [gallery-dl](https://github.com/mikf/gallery-dl), and [Streamlink](https://github.com/streamlink/streamlink)
