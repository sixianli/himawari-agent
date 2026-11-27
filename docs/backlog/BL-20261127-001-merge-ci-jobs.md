---
status: "active"
document_type: "backlog"
record_id: "BL-20261127-001"
record_state: "open"
date: "2026-11-27"
updated: "2026-11-27"
priority: "low"
item_type: "enhancement"
source_idea: ""
review_after: ""
promoted_to: ""
result: ""
reason: ""
supersedes: ""
superseded_by: ""
---
# 把 PR 检查的几个作业合并成更少的作业

## Summary

CI 优化的第 6 号任务原计划把 `ci.yml` 里能合的作业合起来（首选把 `policy` 和 `security` 合成一个，两者都跑在 ARM 机器上）。2026-11-27 量过之后暂不做，先记在这里，等下面的条件变了再拿出来。

## Origin

- 2026-11-27 Andy 给 CI 优化线程的第 6 号任务；同日按实测数据改为放进 Backlog（线程里的决定卡选“改成放进 Backlog”）。

## Notes

- 实测（PR 772 合并前最后一次运行，2026-11-27）：`policy` 14:16:31 结束，`static`、`build`、`security`、`tooling` 在 14:16:34 到 14:16:36 之间全部开始。也就是说 Linux 和 ARM 作业不排队，合并作业不会让 PR 更早出结果。
- 合并 `policy` 和 `security`：`security` 本身扫描约 1 分 43 秒（14:18:14 到 14:19:57）。放进 `policy` 后，其他所有作业都要多等这么久，等于把第 5 号任务省下的约 2 分钟大部分吐回去。
- 合并 `tooling` 和 `security`（两个都在 ARM 上，`tooling` 约 11 分钟，不在最长的那条路上）：每个 PR 能省一次装工具和装依赖，约 1.5 分钟机器时间，PR 出结果的时间不变。代价是要改“一个检查对应一个作业”的整套约定：`check-policy.mjs` 的作业清单和依赖关系、汇总作业 `ci/required` 取报告的方式、main 的轻量确认（`main-confirm.mjs`）和交接证据（`export-evidence.mjs`），还要给基线提交上的旧 `ci/policy.json` 写升级函数。
- `static` 不能和 ARM 作业合并：`npm run check` 里的 `check:delivery-dependencies` 只能在 x64 上跑（[ADR 0292](../adr/0292-how-ci-runs-now.md)）。
- 什么时候重新拿出来：作业开始排队等机器（免费账号的并发上限被占满），或者 GitHub 开始对公开仓库的托管机器计时收费。第 7 号任务（缓存依赖和工具）做完后，每个作业的安装时间会变短，合并能省的机器时间也会跟着变少。
