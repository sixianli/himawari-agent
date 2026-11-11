# PR 397 第 1 轮逐条判断

| 编号 | 意见 | 判断 | 依据和处理 |
|---|---|---|---|
| ds-1 | 矩阵作业各成员只写自己的输出键，合并语义未核实 | 不成立 | GitHub 文档 workflow-syntax 的 “Using Job Outputs in a Matrix Job” 一节原话：“When using a matrix, job outputs will be combined from all jobs inside the matrix … An output with an empty value is not set, so it does not override a value set by another matrix job.” 已把这条来源写进 ADR 0238 背景。改动前 build 的 linux/macos 输出也是这样用的。 |
| ds-2 / glm-1 | ADR 说“只重跑失败作业”不受影响，实际上新尝试号目录里没有上游文件 | 成立，会出错，低 | 行为本身没有变坏：`scripts/ci/aggregate.mjs` 本来就要求报告的尝试号等于本次尝试号，不符时报 “rerun the complete workflow”，改动前只重跑失败作业同样过不了。错的是 ADR 的说法，已改成“一律重跑整轮（Re-run all jobs）”，运维手册排错表同步。 |
| ds-3 / glm-2 | download-artifact 禁令的反向用例被 SHA 检查先拦下 | 成立，会出错，低 | 已改成独立用例：用锁文件里真实的 SHA，在 browser 和 required 里各加一次，断言报错是这条禁令。反向验证：把禁令换成 `true`，两条用例都失败。 |
| ds-4 | 运行目录建好后才 chmod，不是原子的 | 不成立 | 生产里 `run-share.mjs` 的 `main()` 把 umask 设成 007，共享根目录是 2770（setgid），Linux 上新子目录继承 setgid，`mkdir` 一步就得到 2770，不走 chmod；只有根目录没有 setgid（配置坏了）时才会走到“非属主报 DIRECTORY_MODE”，这时失败是对的。根目录 setgid 丢失的排查已按 glm-4 写进运维手册。 |
| ds-5 | `get` 复制或遍历出错时不删半份副本 | 成立，会出错，低 | 已把复制和重算摘要包进 try，任何出错都删掉目标再抛出；补用例：存放的目录里加一个符号链接，取回以 `ARTIFACT_LINK_FORBIDDEN` 失败且不留副本。反向验证：换回旧代码，用例失败。 |
| ds-6 | 共享目录已存在而组是新建时，回滚删组留下失效组号的目录 | 成立，会出错，低 | 安装脚本改为：组不存在而目录已存在时以退出码 71 拒绝，不接管；补用例（真实 bubblewrap）：预先建目录，安装以 71 结束、目录原样保留、没有 groupadd/groupdel。 |
| ds-7 | 事故清单 I-93 一行仍写 `full-permissions` | 成立，会出错，低 | 已重写门槛和证据：门槛是 `check:ci-policy` 里的 `validateCallerGrantsCalledPermissions`，并说明 2026-11-11 起的变化。 |
| ds-8 | ADR 低估了共享目录的可写范围 | 成立，会出错，低 | ADR 后果改成“一个任务能读、改、删共享目录里任何一轮运行的文件”。 |
| glm-3 | collect 部分缺失时没有明确的日志 | 可以更好，已改 | 按“可以更好就改”：collect 对每个缺失往标准错误写一行 `CI_SHARE_COLLECT_MISSING <原因>`，退出码不变，失败仍由 `required.mjs` 判定。 |
| glm-4 | 根目录 setgid 丢失时报错不指向根因 | 可以更好，已改 | 运维手册排错表加一行：跨 runner 取文件报 `EACCES` 时查根目录 `2770 root gh-ci-share`，重新运行安装脚本。 |
