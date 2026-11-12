# PR 457 第 2 轮：作者说明

这一轮只看上一轮之后的修改（提交 14eacd4ea）。

- 上一轮第 2 条（中）：`mac-runners.sh` 的 `label_states` 现在只把“`ci-vps-1` 同时带 `ci-vps` 和 `ci-vps-gate`”记成 `extra`；其他“自己的标签加另一个受管标签”记成 `mixed`，`resume-runners.sh` 遇到 `mixed` 不启动服务。请核对：有没有别的标签组合仍会让服务在标签不对时启动；`pause-runners.sh` 对 `mixed` 的处理（照样去掉全部受管标签）有没有问题。
- 上一轮第 4 条（低）：`gate-fallback.sh on` 在 `ci-vps-1` 不是 `online` 时拒绝。
- 上一轮第 3 条（低）：运行手册四处改成三个 runner，并重新封存。
- 上一轮第 1 条判为不成立：提交 c73eecacc 的 diff 里手册第 5 行的摘要已经变了。理由见 `round-1/judgments.md`。

不在这个 PR 里的事：`ci.yml` 的汇总作业还没有切到 `ci-vps-gate`，那是下一个 PR。
