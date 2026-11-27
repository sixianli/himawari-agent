#!/usr/bin/env bash
set -euo pipefail

for name in GH_TOKEN GITHUB_REPOSITORY GITHUB_SHA ZIP APPCAST VERSION BUILD SUPERSEDES_RUN HIMAWARI_PENDING_ARTIFACT; do
  [ -n "${!name:-}" ] || { echo "MAC_PUBLISH_MISSING $name" >&2; exit 2; }
done

gh release create "mac-$BUILD" "$ZIP" \
  --repo "$GITHUB_REPOSITORY" \
  --target "$GITHUB_SHA" \
  --title "Himawari for Mac $VERSION ($BUILD)" \
  --notes "提交 ${GITHUB_SHA::8}。下载 zip，解压后把 HimawariMac 拖进“应用程序”。以后 App 会自己更新。" \
  --latest
if ! gh release view mac-updates --repo "$GITHUB_REPOSITORY" >/dev/null 2>&1; then
  gh release create mac-updates \
    --repo "$GITHUB_REPOSITORY" \
    --target "$GITHUB_SHA" \
    --title "Mac 自动更新清单" \
    --notes "Mac App 每次检查更新读这里的 appcast.xml，不用手动下载。" \
    --prerelease
fi
gh release upload mac-updates "$APPCAST" --repo "$GITHUB_REPOSITORY" --clobber

gh api --paginate "repos/$GITHUB_REPOSITORY/actions/artifacts?name=$HIMAWARI_PENDING_ARTIFACT&per_page=100" \
  --jq ".artifacts[] | select(.workflow_run.id <= $SUPERSEDES_RUN) | .id" |
  while read -r artifact; do
    gh api -X DELETE "repos/$GITHUB_REPOSITORY/actions/artifacts/$artifact"
  done

echo "已发布 Mac 版 $VERSION（build $BUILD，提交 ${GITHUB_SHA::8}）：https://github.com/$GITHUB_REPOSITORY/releases/tag/mac-$BUILD" >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
