#!/bin/bash
set -u
umask 022
cd "$1" || { echo "GIT_MODES_NO_TREE $1"; exit 2; }
want_mode() {
  case "$1" in
    100755) echo 755 ;;
    100644) echo 644 ;;
    *) echo "" ;;
  esac
}
fixed=0
while IFS= read -r -d '' line; do
  meta=${line%%$'\t'*}
  path=${line#*$'\t'}
  want=$(want_mode "${meta%% *}")
  [ -n "$want" ] && [ -f "$path" ] && [ ! -L "$path" ] || continue
  if [ "$(stat -c %a -- "$path")" != "$want" ]; then
    chmod "$want" -- "$path" && fixed=$((fixed + 1))
  fi
done < <(git ls-files -s -z)
left=0
while IFS= read -r -d '' line; do
  meta=${line%%$'\t'*}
  path=${line#*$'\t'}
  want=$(want_mode "${meta%% *}")
  [ -n "$want" ] && [ -f "$path" ] && [ ! -L "$path" ] || continue
  if [ "$(stat -c %a -- "$path")" != "$want" ]; then
    echo "GIT_MODES_MISMATCH $path"
    left=$((left + 1))
  fi
done < <(git ls-files -s -z)
if [ "$left" -ne 0 ]; then
  echo "GIT_MODES_FAILED left=$left fixed=$fixed"
  exit 3
fi
echo "GIT_MODES_OK fixed=$fixed"
