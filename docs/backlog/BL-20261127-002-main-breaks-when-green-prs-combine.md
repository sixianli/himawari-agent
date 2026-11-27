---
status: "active"
document_type: "backlog"
record_id: "BL-20261127-002"
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
# 两个各自变绿的 PR 合到一起后 main 变红

## Summary

CI 优化的第 9 号任务查了 2026-11-24 到 11-27 main 上完整确认失败的原因。其中 3 次是同一类：两个 PR 各自以较早的 main 为底跑完 CI、都是绿的，先后合进 main 之后，组合起来的代码通不过检查。合并队列（先把几个 PR 叠在最新 main 上一起跑 CI 再合的机制）暂停期间，这类失败只能在 main 上发现。先记在这里，不在这次修。

## Origin

- 2026-11-27 Andy 给 CI 优化线程的第 9 号任务：“找出 main 完整确认失败的根因，每一类修掉或放进 Backlog”。

## Notes

- 实例（都是 main 上的完整确认；PR 头上的 `ci/required` 都是成功）：
  - 2026-11-25 21:12Z，`static` 的 `check:delivery-packet`：上线包的实际文件比测试里的清单多出 4 个脚本（`S2-stop-and-inspect.py`、`S7-switch-start-readback.py`、`S7-startup-readback.mjs`、`S9-clean-transport.py`）。
  - `static` 的 `check:operations` 和 `tooling` 的 `operations-check` 在同一次运行里一起失败。
  - `tooling` 里一条检查合并队列文档措辞的断言失败。
  - 这 3 次背后的合并提交，各自 PR 头上的 `ci/required` 都是成功，之后的 main 运行又恢复通过；据此推断是组合问题，没有逐个找出是哪两个 PR 撞在一起。
- 业界做法：GitHub 的合并队列（merge queue）在合并前把 PR 和排在前面的 PR 一起放在最新 main 上跑一遍；或者在分支保护里打开“合并前分支必须是最新的”（Require branches to be up to date before merging）。见 <https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue>。
- 本仓库已有自己的合并队列，但按 [ADR 0292](../adr/0292-how-ci-runs-now.md#merge-queue) 暂停；“合并前必须最新”要改分支规则，而规则只由 Andy 运行的脚本设置（`scripts/delivery-mode/github-ruleset.sh`），所以这次都不动。
- 现在的兜底：main 变红时 main 的完整确认会失败，下一个 PR 的线程能看到。代价是 main 红一段时间。
- 什么时候重新拿出来：同时在合的 PR 变多、这类失败一周超过 2 次，或者 Andy 决定恢复合并队列。
