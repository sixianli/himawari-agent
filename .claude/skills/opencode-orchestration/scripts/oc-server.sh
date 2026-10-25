#!/usr/bin/env bash
set -u

usage() {
  cat >&2 <<'EOF'
usage: oc-server.sh start|stop|status [state dir]
Runs one opencode server per task on 127.0.0.1 with a random password, so a
running session can be steered (oc-steer.sh). The state dir (argument, else
OC_SERVER_DIR) holds url, password (mode 600), pid and serve.log; oc-launch.sh
and oc-steer.sh use <run prefix dir>/oc-server. The password is never printed.
EOF
  exit 2
}

[ $# -ge 1 ] && [ $# -le 2 ] || usage
dir=${2:-${OC_SERVER_DIR:-}}
[ -n "$dir" ] || usage
opencode_bin=${OC_OPENCODE:-opencode}
ready=${OC_SERVER_READY_SECONDS:-30}

answers() {
  OPENCODE_PASSWORD=$(cat "$dir/password") \
    "$opencode_bin" api --server "$(cat "$dir/url")" GET /api/session/active > /dev/null 2>&1
}

running() {
  [ -f "$dir/pid" ] && [ -f "$dir/url" ] && [ -f "$dir/password" ] &&
    kill -0 "$(cat "$dir/pid")" 2>/dev/null && answers
}

stop() {
  if [ -f "$dir/pid" ]; then
    pid=$(cat "$dir/pid")
    kill "$pid" 2>/dev/null
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.5
    done
    kill -9 "$pid" 2>/dev/null
  fi
  rm -f "$dir/pid" "$dir/url"
}

case "$1" in
  start)
    if running; then
      echo "server $(cat "$dir/url") already running (pid $(cat "$dir/pid"))"
      exit 0
    fi
    stop
    mkdir -p "$dir"
    chmod 700 "$dir"
    port=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')
    (umask 077 && python3 -c 'import secrets; print(secrets.token_hex(24))' > "$dir/password")
    chmod 600 "$dir/password"
    echo "http://127.0.0.1:$port" > "$dir/url"
    OPENCODE_SERVER_PASSWORD=$(cat "$dir/password") nohup "$opencode_bin" serve --hostname 127.0.0.1 --port "$port" \
      < /dev/null > "$dir/serve.log" 2>&1 &
    echo $! > "$dir/pid"
    elapsed=0
    while [ "$elapsed" -lt "$ready" ]; do
      if ! kill -0 "$(cat "$dir/pid")" 2>/dev/null; then
        echo "server exited during startup; see $dir/serve.log" >&2
        stop
        exit 3
      fi
      if answers; then
        echo "server $(cat "$dir/url") started (pid $(cat "$dir/pid"))"
        exit 0
      fi
      sleep 1
      elapsed=$((elapsed + 1))
    done
    echo "server did not answer within ${ready}s; stopped it; see $dir/serve.log" >&2
    stop
    exit 3
    ;;
  stop)
    stop
    echo "server stopped"
    ;;
  status)
    if running; then
      echo "running $(cat "$dir/url") pid $(cat "$dir/pid")"
    else
      echo "not running"
      exit 1
    fi
    ;;
  *)
    usage
    ;;
esac
