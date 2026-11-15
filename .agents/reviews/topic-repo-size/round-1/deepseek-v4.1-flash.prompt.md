你是独立的方案设计者。
你能用的工具：read、grep、glob、websearch、webfetch，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。可以用 websearch 搜索、用 webfetch 读网页；业界做法只认一手来源（官方文档、各大 AI 公司的工程文章、成熟开源项目的源码），每条都附网址。
下面只给了问题、目标和约束，没有给出任何人的方案；材料里如果提到某种做法，只作参考。先读代码弄清现状，再独立提出你认为最好的方案，不要假设已经有人想好了答案。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
列出的方案只是参考，请从问题本身出发，提出你认为更好的方案。
必答问题：
1. 这个改动会不会改变模型已经见过的请求开头？包括系统提示、工具定义、历史消息、遮盖结果。要求回答：发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里。依据：[发给模型的内容只追加](../../.agents/instructions/prompt-prefix.md#rules)。
2. 这个改动会不会让同一段文字在不同请求里变成不同的字节（例如依赖前后文的遮盖、带时间的字段、无序的集合）？
3. 改动有没有对应的自动检查，反向用例是否真的会失败？
4. 改动产生或修改的每个值（标识、字段、配置键、清单项、序列化格式），每一个使用它的地方都能接受吗？逐个找到产生它的地方和使用它的地方，核对两端的校验，只看改动本身不够。依据：[I-73](../../docs/incidents-and-gates.md#incidents)，双模型复核只看了改动，没问“清单里的 id 能通过后端校验吗”。
输出格式：先列方案依赖的前提，每个前提附来源（文件:行或网址）和原话；再写方案本身、考虑过但不选的做法及原因、风险和反例、需要人拍板的取舍。把「读代码或来源证实的」和「推测」分开写。最后逐条回答必答问题。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 82ebfe6960e97724909f6d433f167862ce695070。
问题、目标和约束：
# 问题：himawari-agent 仓库和它在开发机上的克隆越来越大

## 目标

Andy（仓库主人，唯一用户）问：为什么 himawari-agent 这么大，要求专门优化项目大小。请设计一套长期方案，让仓库本身和开发机上的克隆都不再无限增长。

## 约束

- 禁止改写已推送的 git 历史（项目规则）。历史瘦身只能作为选项，写明代价，由 Andy 决定。
- 不在 GitHub 上花钱（不买 LFS 额度、不买存储）。
- 不许写死：保留天数、保留个数这类值要能改。
- Andy 的 Mac 上删除文件，只认 Andy 在 Mac 线程里亲手打字授权；自动回收规则本身要 Andy 同意后才能装。
- 证据规则（`.agents/instructions/disk-space-hygiene.md`）：测试报告、日志、被文档引用的证据要保留；可重建的产物用完即删；清理由脚本自动完成，不手工。
- 开发机 Mac 8GB 内存、磁盘常在 99%。Mac 上的远程会话（"Mac 线程"）不能直接给云端线程发文件，目前靠 git 推送把截图交给云端的设计验收线程。

## 已核对的事实

仓库本身（云端完整克隆 main，2026-11-15）：

- `git count-objects -vH`：pack 340.64 MiB；main 上 5119 个提交。签出的跟踪文件约 260M。Mac 上克隆的 `.git` 为 505M（含其他分支）。
- main 历史里全部 blob 压缩后约 309M，按路径：`clients/apple/ui-review` 131M、`test/qualification/evidence` 74M、`clients/apple/Tests` 36M、`docs/assets/control-center` 23M。按扩展名：png 163M、mp4 53M、zip 29M。当前 HEAD 里已经不存在的 blob 占 153M。
- 当前跟踪文件按扩展名：png 115M（1174 个）、md 39M、zip 29M（12 个）、gz 17M。最大单文件 `test/qualification/evidence/control-center-v4/intermediate-evidence.zip` 21M；`clients/apple/ui-review/latest/*.png` 单张约 2M。
- `clients/apple/ui-review/.gitignore` 已写 `latest/`、`mac-latest/`、`DerivedData/`、`DerivedData-mac/`、`*.mp4`，但 `latest/`（48 个文件 26M）和 `mac-latest/`（24 个）仍被强制提交在跟踪中；`git log -- clients/apple/ui-review` 显示 11-12 到 11-15 有约 20 个提交反复提交和移走截图（例如 “截图和录像移到项目文件夹，不进仓库” 之后又 “第 11 批 … 截图”）。
- `clients/apple/Tests/Snapshots/iPhone-390/`（22M）是 `ui-review.sh --approve` 生成的逐像素比对基准，`--check` 用它比较。
- `clients/apple/scripts/ui-review.sh` 把 Xcode 编译缓存放在 `clients/apple/ui-review/DerivedData`；`--check` 模式用 `mktemp -d` 存新截图，脚本不删它。`mac-ui-review.sh` 用 `ui-review/DerivedData-mac`。
- 根 `.gitignore` 没有忽略 `.claude/worktrees/` 和 `.agents/local/`。仓库代码里没有任何地方创建 `.agents/local/worktrees` 或 `.cb-delegate`。
- `.agents/reviews/`（模型复核记录，合并门要读）跟踪 34M，多为 md，压缩率高。
- 现有清理：`scripts/disk-hygiene/prune-rebuildable.py` 只删四种文件名（`*.bundle`、`node-modules.tar.gz`、`*-abiN-*.tar.gz`、`python-*.tar.gz`）和 `doc-check/` 下的旧副本；跳过 `node_modules`、`.ci-output/tools/`、24 小时内的文件、每个 `production/` 下最新两个带日期的上线包；`install-schedule.sh` 在 Mac 上装 launchd 每天 04:00 跑，忙时跳过；`deploy.sh` 上线成功后也跑它。

Andy 的 Mac 克隆（2026-11-15 只读统计，共 16G）：

- `.ci-output` 5.1G（已被 git 忽略）：`production` 1.8G（最大的两个旧上线包 292M、271M，其余约 1.1G 是许多小目录）、`tool-execution-audit` 1.3G（几乎全是 2026-09-28 一个目录，Andy 在 10-26 选择过保留它）、`handoff` 1.0G（旧的生产证据目录，最大 176M）、`tools` 701M（semgrep、node、python 等工具下载缓存）。`.ci-output` 里 node_modules 合计约 56M。
- `clients/apple/ui-review` 3.0G：DerivedData 1.4G、DerivedDataWatch 891M（脚本里没有这个名字，是会话手工建的）、DerivedData-mac 741M、latest 26M。
- 40 个 git worktree：`.agents/local/worktrees` 21 个约 3.9G（最后修改 11-05 到 11-10，多为 ci/*、fix/* 分支，是否已合并未核对）；`.cb-delegate` 8 个复核用副本约 1.2G；`.claude/worktrees` 3 个 1.1G；3 个 prunable（目录已不存在）；`../himawari-deploy-wt` 1.4G 是上线用的，在用。
- launchd 任务 com.himawari.prune-rebuildable 在跑、退出码 0；最近一次删了 12 个文件约 857MB，之后几次删 0 个；日志出现过 PRUNE_LOW_DISK（约 9GB 空闲）。
- 仓库外 `$TMPDIR` 下有 `dd-518-ios`、`dd-518-mac`、`dd-489-mac`、`dd-shared-ios` 等 `xcodebuild -derivedDataPath` 目录，按 PR 号新建、不复用、不回收；最多时 37 个约 31G。
- `node_modules` 590M。

## 外部资料（已核对）

- GitHub 免费账号 Git LFS：10 GiB 存储、每月 10 GiB 流量；超出且无付款方式时，“Git LFS support is disabled on your account until the next month”（https://docs.github.com/en/billing/concepts/product-billing/git-lfs）。
- Claude Code worktree 文档：建议 “Add `.claude/worktrees/` to your `.gitignore`”；子代理和后台会话的 worktree 按 `cleanupPeriodDays` 定期清扫，但 “Non-interactive runs with `-p` have no exit prompt, so Claude doesn't clean up their worktrees”，手工 `git worktree add` 建的也不清扫（https://code.claude.com/docs/en/worktrees.md）。
- pre-commit 的 `check-added-large-files` 钩子：“Prevent giant files from being committed”，默认 500kB（https://github.com/pre-commit/pre-commit-hooks）。

## 请回答

1. 这些增长的根因各是什么（区分“仓库本身大”和“本地产物大”）。
2. 你认为最好的长期方案，包括：怎样让仓库历史不再被二进制截图撑大、Mac 线程怎样把截图交给云端线程、本地产物怎样自动回收（谁触发、保留什么、怎样避免删到在用的东西）、要加什么自动检查防止复发。
3. 历史瘦身（重写历史）的利弊和代价。
4. 哪些决定需要 Andy 拍板。
