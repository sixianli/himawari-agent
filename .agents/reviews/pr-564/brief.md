# PR 564 复核材料

## 问题

Andy 问 himawari-agent 为什么这么大。Mac 上的克隆约 16G：仓库本身约 0.5G，main 历史里截图和录屏约 131M（Mac 线程把截图强行提交进仓库，用来交给云端线程看）；其余是本机产物，没有过期回收：约 40 个工作副本（git worktree）约 6G、`.ci-output` 5.1G、`clients/apple/ui-review` 下三份 Xcode 编译缓存 3.0G、按 PR 建的 `/tmp/dd-*` 编译缓存（最多 31G）。原有的 `prune-rebuildable.py` 只认 4 种文件名。

## 目标

1. 截图、录屏、编译缓存以后不进 main：新增阻断检查 `check:repo-hygiene`（进 `npm run check` 和推送前钩子），上限从 `scripts/repo-hygiene/config.json` 读，不写死。
2. 截图交接改走一次性的 `refs/review-artifacts/pr-N/批次` 引用（普通克隆不取），带清单核对大小和 SHA-256，Mac 验收后删：`scripts/ui-review-artifacts.mjs`。
3. Xcode 每个平台一份固定缓存，放在仓库外 `~/Library/Caches/himawari/DerivedData/<平台>`，用目录锁防并发：`clients/apple/scripts/xcode-cache.sh`、`xcode-build.sh`，截图脚本改用它们。
4. 本机产物按 `scripts/disk-hygiene/retention.json` 的期限回收：`prune-local.py`。默认只报告；只有 Andy 在 Mac 线程同意后，`install-schedule.sh mac --repo DIR --apply-local` 才会真删。工作副本只删已合进 origin/main、没有未提交改动、没有不许的忽略文件、过了闲置期、不在保留名单里的，并且用不带 `--force` 的 `git worktree remove`。

## 约束

- 不改写已推送历史，不在 Mac 上删任何东西（真删只认 Andy 在 Mac 线程亲手点名）。
- 能动态取的不写死；不加代码注释。
- 云端代理不让推非分支引用，所以截图引用由 Mac 线程推和删。

## 作者的说法（待核）

- `check-repo-hygiene.mjs` 只看 `merge-base(基准, HEAD)...HEAD` 的新增和修改，删除和完全相同的改名不算；基准缺失时失败而不是放行。
- `ui-review-artifacts.mjs fetch` 在任何一个文件对不上清单时一个文件都不写出，并且总会删掉临时引用。
- `xcode-cache.sh` 的锁在脚本退出（包括失败）时释放；持锁进程已不在时可以接管。
- `ui-review.sh --approve` 先把新截图拷到临时目录并核对齐全，再整体替换；不齐全时旧截图不动。
- `prune-local.py` 在 Xcode 正在编译时不删缓存，`--skip-if-busy` 在有构建进程时整次跳过；对工作副本的判断失败（拿不到 origin/main、查不了进程）一律保留。
