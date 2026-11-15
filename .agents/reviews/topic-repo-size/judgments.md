# 仓库瘦身方案：逐条判断

第 1 轮是 DeepSeek 独立出的方案，第 2 轮是它对线程方案的审核。整合结果写在 `docs/adr/0276-generated-files-stay-out-of-git-and-local-artifacts-expire.md`。

## 第 1 轮（独立方案）

- 一次性引用 `refs/review-artifacts/*` 代替专用分支：采纳。普通克隆只取 `refs/heads/*`，专用分支会被 Mac 克隆下载；云端实测能 fetch 非 heads 引用（`git fetch origin refs/pull/1/head` 成功）。
- 截图拼成一张联系表交接：不采纳。设计验收要逐屏看原尺寸，原图放在一次性引用里不占仓库。
- 截图输出和编译缓存移到 `~/Library/Caches/himawari/`、`--check` 加清理：采纳。
- 单文件上限、生成目录被跟踪即失败、本地目录必须被忽略：采纳。
- 快照、证据、设计基线的目录总量预算和白名单到期日：不采纳总量预算（快照随场景正常增长，拦它只会逼人放宽上限）；改为“一次改动新增总量上限”。到期日不采纳：已有证据包是长期证据，没有到期一说。
- 证据目录只报告不删：采纳，符合 `disk-space-hygiene.md:8`“减少证据之前要先问”。
- 历史瘦身不做、列为选项：采纳。

## 第 2 轮（审核线程方案）

1. handoff 清理会删到证据和 `handoff/scripts`：成立。`make-packet.py:678` 默认用 `.ci-output/handoff/scripts/hermes-ssh.sh`。改为 handoff 只报告、`handoff/scripts` 永远不动；上线包保护在服务、回滚目标和在用的。
2. 专用分支会被现有克隆下载：成立，已改用一次性引用；Mac 本地对象靠 git 默认的定期 gc 回收，不做 `--prune=now`（第 10 条同）。
3. 单文件上限挡不住很多小文件：部分成立。加“一次改动新增总量上限”；目录预算不采纳，理由同上。
4. 门禁要说明进 `check:steps`、推送前钩子、CI，基准拿不到要失败，强制加入的文件要用 `git check-ignore --no-index`：成立，已写入。
5. 工作副本回收保护不够：成立。加“没有进程以它为当前目录”“被忽略文件只允许可重建目录”“非 git 登记的副本只列出”“`.ci-output/worktrees` 进保留清单”。
6. 共用 DerivedData 会互相踩、名单里没有 Xcode：成立（`prune-rebuildable.py:16`）。加每平台文件锁和进程名单。
7. 先建新通道再取消跟踪：成立，已写入顺序。
8. `--check` 失败时保留临时目录、`--approve` 先删后拷：成立，已写入。oxipng 压缩不放进本次方案。
9. 定时任务只装旧脚本副本：成立（`install-schedule.sh:12,44`），已写入安装器改动。
10. gc 风险：成立，不做 `--prune=now`。
11. `.agents/local/` 可能有被跟踪文件：已核对，`git ls-files .agents/local` 为空。
12. `node_modules`、`tools` 没上限：不采纳。主克隆的 `node_modules` 和工具缓存每次检查都要用，删了只会重新下载。
13. 规则文档要一起改：成立，写入 `disk-space-hygiene.md` 和 `clients/apple/README.md` 的改动。
- Release 附件（它的首选）：不采纳为首选，列为备选。理由写在 ADR“比较过的方案”。
