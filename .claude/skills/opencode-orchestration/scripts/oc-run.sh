#!/usr/bin/env bash
set -u
prefix=$1 stop=$2 model=$3 server=$4 limit=$5 opencode_bin=$6
shift 6
script_dir=$(cd "$(dirname "$0")" && pwd)
message="你结束了本轮，但停止文件 $stop 还没有写完：它不存在，或者还留着“待填写”之类的占位内容。结束本轮不能用来等待后台任务，结束后没有人会接着做。如果你在等测试主机或其他后台任务，就在本轮内等待：用项目提供的等待脚本，或者用短命令反复查看结果文件。继续完成简报和回复里剩下的工作，把停止文件写完整之后再结束。"

"$opencode_bin" "$@" > "$prefix.jsonl" 2> "$prefix.err"
rc=$?
resumed=0
while [ "$rc" -eq 0 ] && ! python3 "$script_dir/stop-file.py" finished "$stop"; do
  if [ "$resumed" -ge "$limit" ]; then
    echo "stop file $stop missing or unfinished after $resumed automatic resumes" > "$prefix.unfinished"
    break
  fi
  session=$(head -1 "$prefix.jsonl" | python3 -c 'import json,sys; print(json.loads(sys.stdin.readline()).get("sessionID",""))' 2>/dev/null)
  if [ -z "$session" ]; then
    echo "stop file $stop missing and no session id to resume" > "$prefix.unfinished"
    break
  fi
  resumed=$((resumed + 1))
  echo "AUTO_RESUME $resumed session=$session stop=$stop" >> "$prefix.err"
  "$opencode_bin" run --auto --format json -m "$model" -s "$session" --server "$server" "$message" >> "$prefix.jsonl" 2>> "$prefix.err"
  rc=$?
done
echo "$rc" > "$prefix.rc"
