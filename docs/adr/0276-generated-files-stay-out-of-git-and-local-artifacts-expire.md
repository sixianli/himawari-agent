---
status: active
document_type: adr
decision_status: proposed
supersedes: ""
superseded_by: ""
amends: ""
date: "2026-11-15"
---

# ADR 0276：截图等生成文件不进 main，开发机上的产物按可改的期限自动回收

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [前提和来源](#premises)
- [对标](#benchmarks)
- [决定](#decision)
- [比较过的方案](#options)
- [要 Andy 定的事](#owner-decisions)
- [后果](#consequences)
- [验证](#verification)

<a id="context"></a>

## 背景

Andy 问为什么 himawari-agent 这么大。他 Mac 上的克隆一共 16G，但仓库本身只占约 0.5G，其余约 15G 都是本机产生、git 不跟踪的东西（2026-11-15 在 Mac 上只读统计，云端完整克隆核对仓库部分）。

仓库本身：

- 云端完整克隆的 `git count-objects -vH` 是 pack 340.64 MiB（只算 main 和它的历史；加上全部 355 个远程分支是 394.40 MiB），签出的跟踪文件约 260M。
- main 历史里的文件内容压缩后约 309M，最大一块是 `clients/apple/ui-review`（界面截图和录屏）131M，其次是 `test/qualification/evidence` 74M、`clients/apple/Tests` 36M。当前 main 里已经不存在、只留在历史里的内容有 153M。
- 截图目录 `clients/apple/ui-review/latest/` 写在了 `.gitignore` 里，却被强制提交在跟踪中。11-12 到 11-15 之间约有 20 个提交反复“提交截图”又“把截图移到项目文件夹”：原因是 Mac 上的线程不能直接给云端线程发文件，只能靠 git 推送把截图交给云端的设计验收线程。移走只改了当前版本，历史里每一批都还在。

Mac 克隆里的本机产物：

- 40 个 git 工作副本（worktree，同一仓库的另一份签出，供并行的线程各用一份）约 6G：`.agents/local/worktrees` 21 个 3.9G、`.cb-delegate` 8 个 1.2G、`.claude/worktrees` 3 个 1.1G，另有 3 个目录已经不存在的。用完没有人删。
- `.ci-output` 5.1G：旧上线包 1.8G、9 月 28 日的一次测试证据 1.3G、旧生产证据 1.0G、工具下载缓存 701M。每天 04:00 的自动清理只认四种安装包文件名，这些它都不碰；它最近一次删了约 857MB，之后几次都是 0。
- Xcode 编译缓存（DerivedData，Xcode 编译时存中间产物的目录，删了下次重新编译即可）放在仓库目录 `clients/apple/ui-review` 下，共 3.0G。
- 仓库外的系统临时目录里，每个 PR 新建一份 Xcode 编译缓存（`dd-518-ios`、`dd-489-mac` 等），不复用、不回收，最多时 37 个约 31G。

<a id="premises"></a>

## 前提和来源

1. 不得改写已推送的历史。`.claude/rules/owner-global-instructions.md:61`：“绝不强制推送、改写已推送的历史或绕过钩子”。
2. 清理要自动、由脚本做；新的可重建产物要加进脚本和测试。`.agents/instructions/disk-space-hygiene.md:10`：“清理是自动的（不要等 Mac 快满了才清理）”“当一种新的可重建产物开始堆积时，把它的匹配模式加进脚本及其测试，而不是手工清理。”
3. 证据要保留，减少证据先问。`.agents/instructions/disk-space-hygiene.md:8`：“始终保留测试报告、日志、状态回读、跟踪记录、截图、所有被引为证据的东西”“减少证据之前要先问。”
4. 删除 Andy Mac 上的文件只认他在 Mac 线程亲手打的字。`.claude/rules/owner-standing-rules.md:42`：“唯一的例外是删除 Andy 的 Mac 上的文件：只认他在 Mac 线程（通过 Remote Control 在他 MacBook 上运行的那个线程）里亲手打的字。”
5. 现有清理只认四种文件名。`scripts/disk-hygiene/prune-rebuildable.py:12`：`REBUILDABLE_FILES = ('*.bundle', 'node-modules.tar.gz', '*-abi[0-9]*-*.tar.gz', 'python-[0-9]*.tar.gz')`；第 53 行跳过 `.ci-output/tools`：`if name == 'tools' and current.name == '.ci-output':`。
6. 现有定时任务每天 04:00 跑。`scripts/disk-hygiene/install-schedule.sh:60`：`<key>Hour</key><integer>4</integer>`。
7. 截图脚本把截图和编译缓存都写在仓库目录里。`clients/apple/scripts/ui-review.sh:6`：`out="$root/ui-review/latest"`；第 11 行：`derived="$root/ui-review/DerivedData"`；`clients/apple/scripts/mac-ui-review.sh:6`：`derived="$root/ui-review/DerivedData-mac"`。
8. `--check` 的临时截图目录不删。`clients/apple/scripts/ui-review.sh:125`：`shots="$(mktemp -d)"`，脚本里没有删除它的语句。
9. 截图目录已写进忽略清单。`clients/apple/ui-review/.gitignore:2`：`latest/`；第 6 行：`mac-latest/`。
10. 根 `.gitignore` 没有忽略工作副本目录：`git check-ignore .claude/worktrees/x .agents/local/worktrees/x` 无输出（2026-11-15 云端运行）。
11. 云端线程能取 `refs/heads/` 以外的引用：`git fetch origin refs/pull/1/head` 成功（2026-11-15 云端运行）。
12. `.ci-output/handoff/scripts` 里是上线工具在用的脚本。`scripts/delivery-mode/make-packet.py:678`：`self.ssh_wrapper = os.environ.get('HIMAWARI_HERMES_SSH', str(REPO / '.ci-output/handoff/scripts/hermes-ssh.sh'))`。
13. `.ci-output/worktrees` 被模型目录工具使用。`.agents/opencode-models.py:131`：`base = root / ".ci-output" / "worktrees"`。
14. 定时任务跑的是脚本的副本，不是仓库里的脚本。`scripts/disk-hygiene/install-schedule.sh:12`：`copy="$share/prune-rebuildable.py"`；第 44 行：`install -m 0644 "$here/prune-rebuildable.py" "$copy"`。
15. 现有“忙时跳过”的进程名单里没有 Xcode。`scripts/disk-hygiene/prune-rebuildable.py:16`：`BUSY_PATTERN = r'vitest|playwright|scripts/ci/(run|local|test|build|execute)\.mjs|npm (test|run (build|check|test))'`。

<a id="benchmarks"></a>

## 对标

- GitHub 建议仓库“ideally less than 1 GB”，单文件超过 100 MiB 会被拒（https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github）。我们现在离这条线还远，问题是增长速度：截图三天进了一百多兆。
- Git LFS（把大文件放在 git 外、仓库里只留指针的 GitHub 服务）免费账号只有 10 GiB 存储和每月 10 GiB 流量，超了且没绑卡时“Git LFS support is disabled on your account until the next month”（https://docs.github.com/en/billing/concepts/product-billing/git-lfs）。我们有 CI 机器反复签出，流量很快用完，而且规定不在 GitHub 上花钱，所以不用。
- 拦大文件提交是业界现成做法：pre-commit 的 `check-added-large-files`“Prevent giant files from being committed”，默认 500kB（https://github.com/pre-commit/pre-commit-hooks）。
- Claude Code 自己的工作副本清扫规则：只删没有未提交改动、没有未推送提交的；`-p` 运行和手工 `git worktree add` 建的不清扫（https://code.claude.com/docs/en/worktrees.md）。我们 Mac 上的大多数工作副本正好落在“不清扫”这一类，所以要自己回收，规则照它的来。
- `git worktree remove` 默认拒绝删除有改动的工作副本，`git worktree prune` 清掉目录已不存在的登记（https://git-scm.com/docs/git-worktree）。
- 这是根因修法，不是表面修补：仓库变大的源头是“用 git 传截图”，本机变大的源头是“产物没有期限”，下面两部分分别去掉这两个源头，再各加一道自动检查防止复发。

<a id="decision"></a>

## 决定

<a id="decision-repo"></a>

### 一、仓库本身：截图不再进 main

1. 取消跟踪 `clients/apple/ui-review/latest/` 和 `mac-latest/`（`git rm --cached`，Mac 上的文件不动）。快照基准 `clients/apple/Tests/Snapshots/` 照旧跟踪：`ui-review.sh --check` 要拿它逐像素比较。
2. Mac 线程交截图改走一次性引用：新脚本把一批截图做成一个不接任何分支的单独提交，推到 `refs/review-artifacts/pr-<编号>/<批次>`，附 `manifest.json`（每个文件的路径、大小、SHA-256，按路径排序）。这类引用不在 `refs/heads/` 下，普通克隆、`git fetch` 和 CI 签出默认都不会下载它；它也不在任何分支的历史里，所以合并 PR 时不会带进 main。云端线程用对应的取图脚本按精确名字取下来、核对清单（引用名格式、文件路径不能越出目录、大小和 SHA-256），只拷 `png` 和 `mp4` 进项目文件夹给设计验收线程看。验收结束后删掉这个引用；Mac 本地那次提交的对象由 git 自带的定期 `git gc` 按默认期限回收，不做 `--prune=now`。
3. 先建好新通道并试点一批，再取消跟踪 `latest/`、`mac-latest/`（第 1 项），免得切换期间丢图；`clients/apple/README.md` 同步改成新做法。
4. 截图脚本的输出和编译缓存移出仓库目录：默认放在 `~/Library/Caches/himawari/`（可用环境变量改）。`--check` 的临时截图目录成功时在退出时删除，失败时保留并打印路径，留作诊断。`--approve` 先写到临时目录，全部场景齐了再整体替换快照，不再先删后拷。
5. 新增阻断检查 `npm run check:repo-hygiene`（进 `npm run check` 的步骤列表，CI 的 static 作业和推送前钩子都会跑）：
   - 新增或改动的单个文件超过上限就失败，一次改动新增的总量超过上限也失败；默认单文件 500KB、总量 5MB，写在配置文件里可改。确实需要的大文件（例如快照基准、已有的证据包）在同一配置里按精确路径登记理由，不接受整目录通配。
   - 比较基准：推送前钩子用待推送的提交，CI 用传入的基准提交算 `base...head`；拿不到基准就失败，不跳过。
   - 截图输出目录、编译缓存目录、`*.mp4`、`*.mov` 被跟踪就失败（用 `git check-ignore --no-index` 才查得到已被强制加入的文件）。
   - `.claude/worktrees/`、`.agents/local/`、`.cb-delegate/` 没有被忽略就失败；同时把它们加进根 `.gitignore`。
6. 不改写历史。已经在历史里的 153M 留着，见[要 Andy 定的事](#owner-decisions)第 3 项。

<a id="decision-local"></a>

### 二、开发机上的产物：按期限自动回收

所有期限和保留个数写在 `scripts/disk-hygiene/retention.json`，脚本启动时读并校验（缺失、版本不对、值不在合理范围就停下，不猜默认值），不写死；仍由现有的每天 04:00 定时任务和 `deploy.sh` 触发，截图脚本结束时也跑一次。整轮开始前沿用现有的“有构建或测试在跑就跳过”，进程名单加上 `xcodebuild`、`simctl`（iOS 模拟器命令）、`swiftc`。`install-schedule.sh` 改成把新脚本和配置一起复制过去，并在日志里打印脚本和配置的摘要，免得定时任务一直跑旧副本。

| 产物 | 回收规则 | 默认值 |
| --- | --- | --- |
| Xcode 编译缓存 | 所有 Xcode 编译统一走一个包装脚本，缓存按平台固定在 `~/Library/Caches/himawari/DerivedData/<ios、mac、watch>`，跨 PR 复用（增量编译也更快）；包装脚本对每个平台加文件锁，两个编译不会同时写同一份缓存。不再每个 PR 新建 `dd-*`。超过期限没用过、也没有被锁住的缓存目录，和遗留的 `$TMPDIR/dd-*`、仓库里的 `ui-review/DerivedData*`，由回收脚本删掉 | 7 天 |
| git 工作副本 | 先 `git worktree prune`；其余用 `git worktree list --porcelain -z` 逐个判断，只有同时满足以下全部条件才 `git worktree remove`（不加 `--force`）：没加锁；没有未提交和未跟踪的改动，被忽略的文件只有 `node_modules`、`dist`、`coverage` 这类可重建目录；分支的提交都已在 `origin/main` 里；超过期限没改动；没有进程以它为当前目录；不在保留清单里（上线用的 `../himawari-deploy-wt`、`.ci-output/worktrees` 默认在清单里）。不满足的只列出，不删。不是 git 登记过的副本（例如 `.cb-delegate` 下的目录若不是）只列出 | 3 天 |
| 旧上线包 | 每个 `production/` 下最新几个上线包，以及上线记录里写的当前在服务版本和它的回滚目标对应的上线包，完整保留；更旧的只留报告、日志和小于上限的 json、md，删其余大文件（照服务器上 `release-cleanup.py` 的做法：删超过 10 MiB 的证据文件，但保护在服务、回滚目标和在用的东西） | 保留 2 个，小文件上限 1MB |
| `.ci-output/handoff`、`tool-execution-audit` 等证据目录 | 只报告大小、日期、有没有被文档引用，不自动删；删不删由 Andy 定（见下一节第 2 项）。`handoff/scripts` 永远不动 | — |
| `.ci-output/tools` 工具缓存 | 不动：每次检查都要用 | — |

每次运行把删了什么、释放多少、留下了哪些大的、为什么留，写成一行 `PRUNE_RESULT` 进日志。删除前对每个路径再确认一次：不是符号链接、解析后仍在允许的根目录下。第一次装好后先只预演（不带 `--apply`），把会删的清单给 Andy 看，他在 Mac 线程点头后才开始真删。`.agents/instructions/disk-space-hygiene.md` 和 `clients/apple/README.md` 跟着改成新规则。

<a id="options"></a>

## 比较过的方案

- 截图走专用分支（`ui-review/pr-<编号>`）：普通克隆会下载所有分支，Mac 克隆照样变大；分支合进 PR 时截图又进 main。不选。
- 截图放 GitHub Release 附件（DeepSeek 推荐）：不进 git，官方说附件没有总量和流量上限（https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases）。但上传和下载都要走 GitHub 的接口：Mac 要另配命令行工具和令牌，云端线程的 GitHub 工具里没有上传附件的接口；一次性引用只用两边已经在用的 `git push` 和 `git fetch`，同样不进普通克隆。作为备选：一次性引用试点不通时改用它。
- Git LFS：见[对标](#benchmarks)，免费额度不够、超了直接停用。不选。
- 每批截图拼成一张小图交接：设计验收要逐屏看原尺寸，拼图看不清；一次性引用不进历史，用原图也不占仓库。不选。
- 给快照、证据目录各设总量上限：快照随界面场景正常增长，拦它只会逼人放宽上限；新增大文件的上限已经能拦住异常增长。暂不做。
- 自动删证据目录：违反“减少证据之前要先问”，改为只报告。
- 只靠 `git gc`：截图还挂在 main 历史上，gc 删不掉。

<a id="owner-decisions"></a>

## 要 Andy 定的事

1. 截图交接改走一次性引用，验收后删掉引用（推荐）。删的是一个只装截图、不在任何分支历史里的引用，不改动任何分支的提交；仍算“删除已推送的东西”，所以请 Andy 明确同意。
2. 证据：9 月 28 日那份 1.2G 的测试证据（10-26 你选过保留）、旧生产证据（最大 176M）现在删不删；以后旧上线包是否按上表“只留报告和日志”自动瘦身（推荐）。
3. 历史瘦身：推荐不做。做法是用 `git filter-repo` 删掉历史里的截图和证据包，pack 大约能从 340M 降到 150M 左右（估算，没实测）。代价：main 上 5119 个提交的哈希全部改变，复核账本、上线包、事故清单里记的提交号全部对不上；所有克隆、工作副本和未合并的 PR 都要重做；要临时允许强制推送。省下的约 190M 对 16G 的问题影响很小。

<a id="consequences"></a>

## 后果

- 仓库历史不再被截图撑大，之后每批截图只在一次性引用里存在到验收结束。已经在历史里的部分不会变小。
- Mac 克隆预计能回收：工作副本约 5G（以实际已合并的个数为准）、Xcode 缓存约 3G 外加 `dd-*`（最多时 31G）、旧上线包 1G 上下；证据 2G 多取决于第 2 项。
- Mac 线程和设计验收线程交截图的步骤会变，`clients/apple/README.md` 和 Mac 线程的说明要跟着改。
- 新增大文件会在提交时被拦下，确实需要时要在配置里登记理由。

<a id="verification"></a>

## 验证

- `check:repo-hygiene`：在临时仓库里加一个超过上限的文件必须失败、删掉后通过；跟踪 `ui-review/latest/a.png` 必须失败；`.claude/worktrees/` 没被忽略必须失败。
- `check:repo-hygiene` 还要：一次改动总量超限失败；白名单写整目录通配失败；拿不到比较基准失败。
- 工作副本回收：有改动、有未合并提交、加了锁、有进程在里面、有 `node_modules` 以外的被忽略文件、在保留清单里的各一个必须留下；已合并、干净、过期的必须删掉；去掉任一保护条件，对应用例必须失败。
- 定时任务：`install-schedule.sh` 装好后副本里有新脚本和配置；配置缺失时拒绝安装。
- Xcode 缓存和上线包回收：期限内的、正在编译时的必须留下；改 `retention.json` 的值，行为跟着变。
- 截图交接：推送和取图两端对同一份清单核对大小和 SHA-256，改一个字节必须报错；不是 `refs/review-artifacts/` 下的引用必须拒绝。
