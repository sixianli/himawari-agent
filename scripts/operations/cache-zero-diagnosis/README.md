# 多轮对话缓存命中为 0：只读诊断（2026-11-02 JST）

对象：`thread:f504128e-d710-44e1-a304-6b61c370ef24`（「明天是否需要带伞」，「晚上呢?」00:44 JST 命中 0%，DeepSeek V4.1 Flash 标准，Token 15.3k）。
全部只读，不花钱，不重放模型。

1. 上传 `run-trace.mjs`、`run-on-production.sh` 到生产机 `/tmp/`。
2. 把 `run-trace.mjs` 放进当前发布目录，用 himawari-prod 跑（同 wrong-answer-diagnosis/dump-provider-requests.mjs），跑完删掉：
   `node run-trace.mjs /etc/himawari/config.json /var/lib/himawari/state/secrets thread:f504128e-d710-44e1-a304-6b61c370ef24 4`
3. `bash /tmp/run-on-production.sh`（最后自删）。
4. 两份输出存为 `/mnt/project-files/cache-zero-diagnosis/result-20261102.txt`。
