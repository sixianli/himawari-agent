#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
. "$here/xcode-cache.sh"

[ $# -ge 2 ] || { echo "usage: clients/apple/scripts/xcode-build.sh ios|mac|watch <xcodebuild arguments without -derivedDataPath>" >&2; exit 2; }
platform="$1"
shift
for argument in "$@"; do
  case "$argument" in -derivedDataPath | -derivedDataPath=*) echo "XCODE_BUILD_DERIVED_DATA_GIVEN the cache path is chosen by this script; leave -derivedDataPath out" >&2; exit 2 ;; esac
done

trap himawari_release_lock EXIT
himawari_lock_derived_data "$platform"
echo "XCODE_BUILD_DERIVED_DATA $himawari_locked_derived"
xcodebuild -derivedDataPath "$himawari_locked_derived" "$@"
