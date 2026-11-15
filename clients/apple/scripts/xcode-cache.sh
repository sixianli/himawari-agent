himawari_apple_cache="${HIMAWARI_APPLE_CACHE:-$HOME/Library/Caches/himawari}"
himawari_lock_wait="${HIMAWARI_XCODE_LOCK_WAIT:-1800}"
himawari_held_lock=""
himawari_locked_derived=""

himawari_derived_data() {
  case "$1" in
    ios|mac|watch) printf '%s/DerivedData/%s\n' "$himawari_apple_cache" "$1" ;;
    *) echo "XCODE_CACHE_PLATFORM_INVALID $1 (ios, mac or watch)" >&2; return 2 ;;
  esac
}

himawari_release_lock() {
  [ -z "$himawari_held_lock" ] || rm -rf "$himawari_held_lock"
  himawari_held_lock=""
}

himawari_lock_derived_data() {
  local derived lock owner waited=0
  derived="$(himawari_derived_data "$1")" || return 2
  lock="$derived.lock"
  mkdir -p "$(dirname "$derived")"
  until mkdir "$lock" 2>/dev/null; do
    owner="$(cat "$lock/pid" 2>/dev/null || true)"
    if [ -n "$owner" ] && ! kill -0 "$owner" 2>/dev/null; then
      rm -rf "$lock"
      continue
    fi
    [ "$waited" -lt "$himawari_lock_wait" ] || { echo "XCODE_CACHE_LOCK_TIMEOUT $lock held by pid ${owner:-unknown} for ${himawari_lock_wait}s" >&2; return 1; }
    sleep 5
    waited=$((waited + 5))
  done
  printf '%s\n' "$$" >"$lock/pid"
  himawari_held_lock="$lock"
  mkdir -p "$derived"
  touch "$derived/.himawari-last-used"
  himawari_locked_derived="$derived"
}
