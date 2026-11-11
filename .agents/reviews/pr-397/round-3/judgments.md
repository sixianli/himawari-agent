# 第 3 轮复核判断（DeepSeek）

- ds-1（高，成立，中高）：`main-confirm.mjs` 把构建检查发布进 `.ci-output/main-public/`，`publish.mjs` 原样复制 `kind: "artifact"` 的归档，`main.yml` 再把整个目录传上 GitHub。核实没有任何地方下载 `main-confirmation-*`。修法：`publish.mjs` 新增 `--artifacts omit`（取值只认 `keep`/`omit`），跳过归档；`main-confirm.mjs` 两次发布都传它。归档摘要原本就记在 `summary.json` 的 `artifactSha256`。反向用例：`gate-lifecycle.test.mjs` 去掉跳过那一行后新用例失败；`main-confirmation.test.mjs` 去掉参数后失败，恢复后 14 条通过。
- ds-2（中，成立，判低）：只是 ADR 第 4 条措辞过宽。改成写明 `check-policy.mjs` 只检查 `ci.yml`，`main.yml` 下载 `gate-` 和证据是保留的例外，确认报告不带归档。
- ds-3（低，成立）：补了“组和目录都已存在时照常重装、不建也不删组”的正向用例（`ci-runner-scripts.test.mjs`，95 条通过）。
- ds-4（低，成立）：ADR 后果一节和运维手册故障表都补上“摘要为空时报 `CI_SHARE_DIGEST_INVALID`，同样重跑整轮”。
- 推测项（locale 排序、chmod 竞争）：两个 runner 同机同一份锁定 Node，put 前的摘要已拒绝符号链接，不处理。
