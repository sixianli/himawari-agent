#!/usr/bin/env bash
set -u

usage() {
  cat >&2 <<'USAGE'
usage:
  grok-launch.sh new <brief> <run prefix> xai/<model>[#variant] [title]
  grok-launch.sh resume <session id> <reply> <next stop file> <run prefix> xai/<model>[#variant]
Same arguments as oc-launch.sh, but only models
from the xai/ provider (the user's own X Subscription login) are accepted.
USAGE
  exit 2
}

[ $# -ge 1 ] || usage
case "$1" in
  new) [ $# -ge 4 ] || usage; model=$4 ;;
  resume) [ $# -ge 6 ] || usage; model=$6 ;;
  *) usage ;;
esac

case "$model" in
  xai/?*) ;;
  *)
    echo "refusing model '$model': Grok batches run only on xai/<model> through the subscription login; Grok resold by other providers is not allowed" >&2
    exit 2
    ;;
esac

script_dir=$(cd "$(dirname "$0")" && pwd)
exec bash "$script_dir/oc-launch.sh" "$@"
