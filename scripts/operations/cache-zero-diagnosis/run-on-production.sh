#!/usr/bin/env bash
# 只读：查对话 thread:f504128e 逐轮缓存命中，并统计其他多轮对话
set -u
THREAD="${1:-thread:f504128e-d710-44e1-a304-6b61c370ef24}"
DB=/var/lib/himawari/state/data/product.sqlite
echo "=== 1. 这个对话每一轮的模型调用记录 (model_usage_observations)"
sudo -u himawari-prod node -e '
const Database=require("better-sqlite3");
const db=new Database(process.argv[1],{readonly:true,fileMustExist:true});
const rows=db.prepare(`select r.id run, r.created_at runAt, m.invocation_id, m.purpose, m.source, m.provider, m.model, m.input_tokens, m.cache_read_tokens, m.cache_write_tokens, m.cache_reported, m.occurred_at from runs r left join model_usage_observations m on m.run_id=r.id where r.thread_id=? order by r.created_at, m.occurred_at`).all(process.argv[2]);
for(const r of rows) console.log(JSON.stringify(r));
' "$DB" "$THREAD" 2>&1 | tail -80
echo "=== 2. 所有对话的 chat 用途：按模型、按是否同一次运行内后续请求"
sudo -u himawari-prod node -e '
const Database=require("better-sqlite3");
const db=new Database(process.argv[1],{readonly:true,fileMustExist:true});
console.log(JSON.stringify(db.prepare(`select model,provider,source,count(*) n,sum(cache_reported) reported,sum(input_tokens) input,sum(cache_read_tokens) cacheRead from model_usage_observations where purpose=? group by model,provider,source order by n desc`).all("chat"),null,1));
console.log("--- 每个对话第 N 轮 (按 run 顺序) chat 请求的命中，最近 300 条运行");
const rs=db.prepare(`select thread_id, id run, created_at from runs order by created_at desc limit 300`).all();
const per=new Map();
for(const r of rs.reverse()){const k=r.thread_id;const n=(per.get(k)??0)+1;per.set(k,n);
 const u=db.prepare(`select sum(input_tokens) i,sum(cache_read_tokens) c,sum(cache_reported) rep,count(*) q,group_concat(distinct model) mdl from model_usage_observations where run_id=? and purpose=?`).get(r.run,"chat");
 if(u.q) console.log(JSON.stringify({thread:k.slice(0,15),turn:n,run:r.run.slice(0,12),at:r.created_at,q:u.q,rep:u.rep,input:u.i,cacheRead:u.c,model:u.mdl}));}
' "$DB" 2>&1 | tail -400
echo "=== 3. Magpie 日志里该时段 (11-01 15:30Z 前后 ±20 分钟，只含路由/缓存字样)"
for unit in $(systemctl list-units --type=service --no-legend 'magpie*' | awk '{print $1}'); do
  echo "--- $unit"
  journalctl -u "$unit" --since "2026-11-01 15:20:00 UTC" --until "2026-11-01 15:55:00 UTC" --no-pager -o cat | grep -iE 'cache|cached|upstream|provider|route|fallback|deepseek|opencode' | sed -E 's/(sk-|Bearer )[A-Za-z0-9._-]+/\1***/g' | tail -80
done
echo "=== 4. magpie 配置里的路由顺序 (只列键名与 provider 名，不含密钥)"
ls /etc/magpie* /var/lib/magpie* 2>/dev/null | head -20
rm -f /tmp/cache-zero-run-on-production.sh
