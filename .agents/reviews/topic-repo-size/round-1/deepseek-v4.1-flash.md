# 方案：把二进制产物挡在 git 历史之外，把 Mac 上的可重建产物交给脚本回收

## 一、方案依赖的前提（每条附来源和原话）

| # | 前提 | 来源与原话 |
|---|---|---|
| P1 | 发给模型的请求必须“固定的在前、会变的在后”，每轮会变的值只能放最后一条消息 | `.agents/instructions/prompt-prefix.md:27`：“顺序是：工具定义 → 系统提示 → 历史 → 最后一条用户消息。” |
| P2 | 已经发给模型的内容只能追加，不能改写、重排、删除 | `.agents/instructions/prompt-prefix.md:36`：“已经发给过模型的内容，不得改动、重排或删除，只能在末尾追加。” |
| P3 | 系统提示和工具按对话冻结，改提示词只对新对话生效 | `.agents/instructions/prompt-prefix.md:42`：“系统提示和工具按对话冻结……同一对话一直沿用第一次发出时的字节。”；`:44`：“改了提示词文字，只对新对话生效。” |
| P4 | 删除 Andy Mac 上的文件只认他在 Mac 线程亲手打的字 | `.claude/rules/owner-standing-rules.md:42`：“唯一的例外是删除 Andy 的 Mac 上的文件：只认他在 Mac 线程……亲手打的字。” |
| P5 | 证据要保留；减少证据前先问 | `.agents/instructions/disk-space-hygiene.md:8`：“始终保留测试报告、日志、状态回读、跟踪记录、截图、所有被引为证据的东西……”；“减少证据之前要先问。” |
| P6 | 清理要自动完成；新的可重建产物要把匹配模式加进脚本和测试，不能手工清 | `.agents/instructions/disk-space-hygiene.md:10`：“清理是自动的……当一种新的可重建产物开始堆积时，把它的匹配模式加进脚本及其测试，而不是手工清理。” |
| P7 | 禁止强推、改写已推送的历史 | `.claude/rules/owner-global-instructions.md:61`：“绝不强制推送、改写已推送的历史或绕过钩子”。另见 `docs/adr/0190-mask-registered-test-values-in-review-records.md:52`：“改写已推送的历史违反项目规则。” |
| P8 | 现有清理只认四种文件名和 `doc-check/` | `scripts/disk-hygiene/prune-rebuildable.py:12`：`REBUILDABLE_FILES = ('*.bundle', 'node-modules.tar.gz', '*-abi[0-9]*-*.tar.gz', 'python-[0-9]*.tar.gz')`；`:14`：`SKIPPED_DIRECTORIES = ('.git', 'node_modules')` |
| P9 | UI 截图脚本把生成物写进仓库里的 `latest/`、`mac-latest/`；`--check` 的临时目录不删 | `clients/apple/scripts/ui-review.sh:6`：`out="$root/ui-review/latest"`；`:124-125`：`if [ "$mode" = "check" ]; then shots="$(mktemp -d)"`；脚本没有删除 `$shots` 的 trap。`clients/apple/scripts/mac-ui-review.sh:5`：`out="$root/ui-review/mac-latest"` |
| P10 | `.gitignore` 已经写了 `latest/`、`mac-latest/`，但已跟踪文件不受 `.gitignore` 影响 | `clients/apple/ui-review/.gitignore:2`：`latest/`；`:6`：`mac-latest/`。`git log -- clients/apple/ui-review/latest` 和 `.../mac-latest` 都有截图提交记录。 |
| P11 | 当前 21M 的 `intermediate-evidence.zip` 被文档引用为证据 | `test/qualification/evidence/control-center-v4/verification.md:44`：“早期……中间状态无损保存在 [中间证据归档](intermediate-evidence.zip) 中” |
| P12 | 复核记录必须提交进仓库，合并门要读模型答案 | `.agents/instructions/model-review.md:134`：“记录目录固定在仓库里……线程在合并前把记录目录随 PR 一起提交。”；`:74` 的 `--assert-reviewed` 会核对 `verdicts.jsonl` 的原话能在模型答案里找到 |
| P13 | Claude Code 的非交互 `-p` 会话和手工 `git worktree add` 的工作副本不会被自动清扫 | <https://code.claude.com/docs/en/worktrees.md>：“Non-interactive runs with `-p` have no exit prompt, so Claude doesn't clean up their worktrees”；“You created the worktree yourself with `git worktree add`, even if you then ran a `--worktree <name>` session in it and backgrounded that session.”（清扫会保留它） |
| P14 | GitHub 建议仓库小于 1GB，强烈建议小于 5GB；单文件超过 100MiB 会被阻止 | <https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github>：“We recommend repositories remain small, ideally less than 1 GB, and less than 5 GB is strongly recommended.”；“GitHub blocks files larger than 100 MiB.” |
| P15 | GitHub Free 的 LFS 额度是 10GiB 存储、10GiB 流量；流量超了且没有付款方式时，LFS 会被停到下个月 | <https://docs.github.com/en/billing/concepts/product-billing/git-lfs>：“GitHub Free | 10 GiB | 10 GiB”；“If you use more than your included quota of bandwidth per month without a payment method on file, Git LFS support is disabled on your account until the next month.” |
| P16 | 业界有现成的大文件提交检查，默认阈值 500kB | <https://raw.githubusercontent.com/pre-commit/pre-commit-hooks/main/README.md>：“`check-added-large-files` Prevent giant files from being committed.”；“default=500kB”。本项目不需要引入 pre-commit 框架，只借用这个阈值思路。 |
| P17 | CI 的 `static` 作业确实运行 `npm run check`，所以把新检查加进 `check:steps` 就会成为阻断检查 | `scripts/ci/run.mjs:268-269`：`} else if (checkId === "static") { await command("check", tools.node, [tools.npmCli, "run", "check"]);` |
| P18 | `git worktree remove` 默认拒绝删除不干净的工作副本；`git worktree prune` 专门清理已失效的管理文件 | <https://git-scm.com/docs/git-worktree>：“remove refuses to remove an unclean worktree unless --force is used.”；“you can run git worktree prune in the main or any linked worktree to clean up any stale administrative files.” |
| P19 | 重写历史会改所有后续提交哈希、破坏 PR diff/签名，并可能被旧克隆重新污染 | <https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository>：“Changed commit hashes: Rewriting history will change the hashes of the commits that introduced the sensitive data and all commits that came after.”；“High risk of recontamination”；“Broken diff view for closed pull requests”；“Lost signatures on commits and tags” |
| P20 | 整目录打包失败现场是已经反复出现的错误 | `docs/lessons.md:207`：“保存失败现场时整目录打包、重复复制输入材料”；`:210`：“临时目录里的 `node_modules`、`.git` 和与某个提交完全相同的源码副本不打包，只保留一份清单……”；`:213`：“单个证据文件超过 50 MB 或一次运行的证据超过 100 MB 就问清楚原因。” |

另外，材料给出的测量（本次只读环境不能重跑 `du`、`git count-objects`，按材料视为已核对）：仓库 pack 340.64MiB、main 5119 个提交、签出跟踪文件约 260M；历史 blob 约 309M，其中 `clients/apple/ui-review` 131M、`test/qualification/evidence` 74M、`clients/apple/Tests` 36M、`docs/assets/control-center` 23M；当前 HEAD 已不存在的 blob 153M。Mac 克隆 16G，`.ci-output` 5.1G、`clients/apple/ui-review` 3.0G、40 个 worktree 约 6.2G、`$TMPDIR` 下最多 37 个 `dd-*` 约 31G。

---

## 二、根因（回答第 1 问）

### 2.1 仓库本身为什么大

1. **生成物被提交进 main，删除后历史仍然保留。**
   `ui-review.sh` 和 `mac-ui-review.sh` 默认把截图写到仓库内的 `latest/`、`mac-latest/`（P9）。`.gitignore` 已经写了这两个目录（P10），但文件一旦被跟踪，`.gitignore` 不会让它退出跟踪；之后每次设计批次又提交新的约 2M PNG，过几批再移走或删除，旧 blob 仍可从历史到达。`git log` 显示这两个目录有大量“截图/重拍/移到项目文件夹”的提交。按材料，这一条路径历史约 131M，是最大单项。
2. **删除文件不等于删历史。**
   GitHub 官方文档明确区分“最近一次未推送的提交”和“更早提交”：后者必须重写历史（P19 同页：“If you added a file in an earlier commit, you need to remove it from the repository's history.”）。所以当前 HEAD 不存在的 153M blob 不会因为后来的 `git rm` 消失。
3. **整目录证据包。**
   `test/qualification/evidence` 历史 74M，当前还有一个 21M 的 `intermediate-evidence.zip`。这正是 `docs/lessons.md:207-213` 说过的“整目录打包”；它把可重建的中间产物也压进去了。P11 表明它被文档引用，所以不能直接删，只能作为历史遗留保留或由 Andy 决定替换成“清单 + 精选小文件”。
4. **快照基线是必要的，但没有预算。**
   `Tests/Snapshots/iPhone-390` 当前 22M、历史 36M，是 `--check` 逐像素比较的基准，不能简单删。问题是它随场景数量线性增长，没有总量上限，也没有“新增场景必须同时说明预算”的检查。
5. **已批准设计基线是证据，但也在增长。**
   `docs/assets/control-center` 历史 23M，是 Andy 批准过的设计基线，按规则应保留（P5）。但每个版本都存一批全尺寸截图，长期也会线性增长；需要按版本设预算，而不是无限追加。
6. **复核记录 34M。**
   `.agents/reviews` 是合并门要读的记录（P12），不能简单忽略。它多为 md、压缩率高，不是当前最大矛盾，但会随 PR 数增长；可以在合并后做“只保留账本、判断和答案，提示词文件按期限归档”的二次整理，但这属于减少证据，需要 Andy 同意。
7. **没有任何自动检查拦住新的大文件/生成物。**
   仓库没有 `.gitattributes`，没有 pre-commit 框架，也没有 `check:steps` 里的仓库大小检查；`ui-review/latest` 被强加进索引时没有任何门禁会红。CI 的 `static` 作业本来就会跑 `npm run check`（P17），所以缺的只是一条新检查，不需要改 CI 架构。

### 2.2 Mac 克隆为什么大

1. **`.ci-output` 只被很窄的规则清理。**
   现有脚本只删四种文件名和 `doc-check/`（P8），并保护 `production/` 下最新两个包、跳过 `.ci-output/tools/`、跳过 24 小时内文件（`prune-rebuildable.py:36-42,51-54,98-102`）。它不会删除旧上线包的整个 `materials/`，也不会处理 `handoff/`、`tool-execution-audit/` 这些证据目录，所以 5.1G 里的大部分不在清理范围内。
2. **Xcode 缓存放在仓库里，临时目录不回收。**
   `ui-review.sh:11` 的 `derived="$root/ui-review/DerivedData"`、`mac-ui-review.sh:6` 的 `DerivedData-mac` 都在仓库内；`--check` 用 `mktemp -d` 存新截图（`ui-review.sh:124-125`），脚本退出时不删。`DerivedDataWatch` 是会话手工建的，脚本里没有这个名字，也没有任何回收规则。
3. **每个 PR 新建 `$TMPDIR/dd-*`，不复用、不回收。**
   这些目录不是仓库代码创建的（仓库里没有 `dd-` 或 `DerivedDataWatch` 的创建逻辑），是会话手工 `xcodebuild -derivedDataPath` 留下的；按 PR 号新建，所以最多时 37 个、约 31G。
4. **worktree 和复核副本没有生命周期。**
   Claude Code 的非交互 `-p` 会话和手工 `git worktree add` 不会被自动清扫（P13）；`.claude/worktrees/`、`.agents/local/worktrees`、`.cb-delegate` 又没有写进根 `.gitignore`。40 个 worktree/副本约 6.2G，其中 3 个已经 prunable。
5. **`node_modules` 590M 本身正常，但被 worktree 放大。**
   主克隆的 `node_modules` 不是主要矛盾；每个 worktree 里再装一份才是。清掉已合并、干净、空闲的 worktree 会顺带回收这部分。
6. **触发频率和范围不匹配。**
   现有 launchd 每天 04:00 跑一次（`install-schedule.sh:56-60`），但只跑窄规则；`PRUNE_LOW_DISK` 只打印日志，不会扩大回收范围。没有“整机产物清单”和“按目录预算”的机制。

---

## 三、我认为最好的长期方案

核心原则：**main 只保留“人写的文字 + 必要的像素基线 + 被引用的证据”；所有可重建的、按批次生成的截图和构建缓存都放到 git 之外，并用短生命周期的 ref 或本地缓存交接；Mac 上的回收由脚本按配置自动做，证据只做报告、不自动删。**

### 3.1 第一步：仓库止血（不改历史，立即停止继续长大）

1. **把生成物移出跟踪，但保留磁盘文件。**
   - `git rm -r --cached clients/apple/ui-review/latest clients/apple/ui-review/mac-latest`
   - 同时检查是否有被跟踪的 `*.mp4`、`*.mov`，一并 `git rm --cached`。
   - 保留现有 `.gitignore` 的两行（P10），并补根 `.gitignore`：
     - `.agents/local/`
     - `.cb-delegate/`
     - `.claude/worktrees/`
     - `clients/apple/ui-review/DerivedData*/`
     - `clients/apple/ui-review/latest/`
     - `clients/apple/ui-review/mac-latest/`
   - 这一步只让**未来**的克隆不再检查出这 26M，不会缩小旧历史；旧 blob 仍在，见 3.5。
2. **改脚本的默认输出位置。**
   - `ui-review.sh`：`out` 默认改为 `$HOME/Library/Caches/himawari/ui-review/latest`（可用 `HIMAWARI_UI_REVIEW_OUT` 覆盖）；`derived` 默认改为 `$HOME/Library/Caches/himawari/ui-review/DerivedData`（可用 `HIMAWARI_UI_REVIEW_DERIVED` 覆盖）。
   - `mac-ui-review.sh` 同样把 `out`、`derived` 移到缓存目录。
   - `--check` 的 `shots="$(mktemp -d)"` 加 `trap 'rm -rf "$shots"' EXIT`；失败时如果需要现场，只把 `compare-snapshots.swift` 的差异摘要和少量 diff 图复制到缓存下的 `failures/<时间>/`，由回收脚本按年龄清理，而不是把整个临时目录留下来。
   - 这样以后即使有人再跑脚本，也不会默认写进仓库。
3. **快照基线保留，但加预算。**
   - `Tests/Snapshots/iPhone-390` 继续跟踪，因为 `--check` 需要它（P9 的 `snapshots="$root/Tests/Snapshots/iPhone-390"`）。
   - 设总量预算（例如 40MiB）和单文件预算（例如 3MiB），超过就要求显式 allowlist 条目并写明理由/到期日；场景增加时由人决定是加预算还是删旧场景。
4. **证据包改为“清单 + 精选文件”。**
   - 新的测试/资格验证不得再提交整目录 ZIP。按 `docs/lessons.md:210` 的要求，提交报告、日志、状态回读和清单（路径、大小、SHA-256、对应提交），大产物只留引用。
   - 当前 21M 的 `intermediate-evidence.zip` 已被 `verification.md:44` 引用，作为历史遗留加入 allowlist；是否替换成精选文件、是否从历史中移除，交给 Andy 决定（见第五节）。
5. **复核记录保持现状，先不动。**
   `.agents/reviews` 是合并门要读的（P12），且多为 md；先不为了省 34M 去动它，避免破坏复核链。后续可在合并后做“提示词文件按期限归档”的二次方案。

### 3.2 第二步：Mac 线程怎样把截图交给云端线程

约束是“Mac 线程不能直接给云端线程发文件，目前靠 git 推送”。方案是**用 git 的短生命周期自定义 ref 交接，永远不合并进 main**：

1. **发布端（Mac 线程）**：新增 `scripts/apple/publish-ui-review.mjs`：
   - 输入：本次截图目录、PR 号、批次名。
   - 生成一个只有一个提交的树，内容为：
     - `contact-sheet.webp`（把本批所有场景拼成一张联系表，硬上限 1MiB；设计验收看这一张通常足够）；
     - 可选 `full/` 下少量确实需要原尺寸的图片；
     - `manifest.json`：`schemaVersion`、`pr`、`batch`、`files[]`（`path`、`sha256`、`bytes`、`kind`），按路径排序。
   - 推送到 `refs/review-artifacts/<pr>/<batch>`，**不是 `refs/heads/*`**。普通 `git clone` 只取 `refs/heads/*`，不会把这类 ref 带进常规克隆。
   - 批次名用 `20261115T123456Z-<短提交>` 这类固定格式；提交进 git 的文件里不放“当前时间”字段，时间只在 ref 名里。
2. **接收端（云端设计验收线程）**：新增 `scripts/apple/fetch-ui-review.mjs`：
   - 只允许 fetch `refs/review-artifacts/<数字PR>/<合法批次>`；拒绝其他 ref。
   - 核对 `manifest.json` 的 schema、路径（必须是相对路径、不能有 `..`）、SHA-256、字节数；任何一项不符就 `UI_REVIEW_MANIFEST_MISMATCH` 退出。
   - 读完后由设计线程看 `contact-sheet.webp`；确实需要原图时再读 `full/` 里的指定文件。
3. **清理**：
   - 验收完成后，Mac 线程运行 `publish-ui-review.mjs --cleanup --pr <n> --batch <batch>`，删除远端 ref 和本地 ref；本地再 `git gc --prune=now`（在磁盘空闲足够时运行）。
   - 删除一个自定义 ref 不是改写 main 的历史；但如果 Andy 认为“删除已推送的 ref”也算改写历史，这一步需要他明确同意（见第五节）。为降低争议，也可以把 ref 放在 `refs/review-artifacts/` 并在规则里写明“这些 ref 是一次性传输层，不是项目历史”。
4. **为什么不用 main 里的 `latest/`**：
   一旦把截图提交进 main，即使后来删除，旧 blob 仍会在历史里（P19 同页），这正是当前 131M 的来源。联系表即使要留，也应留在一次性 ref 或复核记录里，而不是每次设计批次都进 main。
5. **已批准的设计基线**：
   最终 Andy 批准的设计仍按现有规则存到 `docs/assets/control-center/<版本>/`，但只存该版本的少量关键截图，并受 3.1 的目录预算约束；中间迭代的全部 PNG 不进 main。

### 3.3 第三步：Mac 本地产物自动回收

#### 谁触发

- 沿用现有 launchd 每天 04:00 的定时任务（`install-schedule.sh:56-60`），但把执行内容扩展为：
  1. 原有 `prune-rebuildable.py --apply --skip-if-busy`；
  2. 新增 `prune-worktrees.py --apply --skip-if-busy`；
  3. 新增 `prune-evidence.py --report`（只报告，不删除）。
- `ui-review.sh`、`mac-ui-review.sh` 自己用 `trap` 删除本次的临时截图目录和临时 DerivedData。
- `deploy.sh` 上线成功后已有的 `.ci-output` 清理保持不变，并调用扩展后的脚本。
- 可选：每次 `git gc` 前先跑一次 `prune-worktrees.py --apply`，确认有足够空闲空间再 gc。

#### 保留什么、删什么

新增配置 `scripts/disk-hygiene/retention.json`（值不写死在代码里）：

```json
{
  "schemaVersion": 1,
  "minAgeHours": 24,
  "keepProductionPackets": 2,
  "worktreeIdleDays": 14,
  "derivedDataIdleDays": 7,
  "tmpDerivedDataIdleDays": 2,
  "maxTrackedFileBytes": 5242880,
  "maxNewBlobBytes": 5242880,
  "maxReviewBundleBytes": 1048576,
  "maxSnapshotTotalBytes": 41943040,
  "maxEvidenceTotalBytes": 62914560,
  "allowlist": []
}
```

建议分类：

| 类别 | 处理 | 保留 |
|---|---|---|
| `production/<日期>/materials/` 里超过 `keepProductionPackets` 的旧包 | 删除可重建的 `materials/` 内容（`*.bundle`、`node-modules.tar.gz`、`*-abiN-*.tar.gz`、`python-*.tar.gz`、源码/构建包） | `run-logs/`、`*.log`、`*.json`、`*.md`、`packet-checks.json`、被引用的证据 |
| `clients/apple/ui-review/DerivedData*`、`DerivedDataWatch`、`~/Library/Caches/himawari/ui-review/**` | 空闲超过 `derivedDataIdleDays` 且没有 `xcodebuild`/`simctl` 使用 | 正在使用的目录 |
| `$TMPDIR/dd-*`、其它 `xcodebuild -derivedDataPath` 目录 | 空闲超过 `tmpDerivedDataIdleDays` 且没有进程引用 | 正在构建的 PR 目录 |
| 已合并、干净、空闲超过 `worktreeIdleDays` 的 worktree | `git worktree remove`（绝不 `--force`），再 `git branch -d` 已合并分支 | 未合并、脏、被锁、正在使用的；`../himawari-deploy-wt` 按精确路径永久保留 |
| 已失效的 worktree 管理文件 | `git worktree prune` | 锁定的、路径仍存在的 |
| `doc-check/` 旧副本 | 沿用现有规则 | 最新的 |
| `.ci-output/handoff`、`tool-execution-audit`、旧资格证据 | **只报告**，列出大小、年龄、引用扫描结果；Andy 在 Mac 线程授权后按清单处理 | 被文档/交接/证据 README 引用的；`2026-09-28` 那条 Andy 明确选择保留的 |
| `node_modules` | 不自动删主克隆；随 worktree 删除一起回收 | 主克隆的 |
| `.agents/reviews` | 不自动删；后续可做合并后归档方案 | 合并门需要的记录、被引用的答案 |

#### 怎样避免删到在用的东西

1. **全局锁**：`~/.local/state/himawari/prune.lock`，同一时间只允许一个回收进程；拿不到就打印 `PRUNE_SKIPPED_LOCKED` 退出。
2. **忙时跳过**：扩展 `--skip-if-busy` 的模式，覆盖 `vitest`、`playwright`、`xcodebuild`、`simctl`、`swiftc`、`npm test`、`npm run build` 等；发现主机上的匹配进程就整轮跳过。
3. **逐个候选再检查**：
   - `lsof +D <path>` 或 `ps` 的 cwd 引用；有进程使用就跳过。
   - worktree：`git status --porcelain` 非空、`git merge-base --is-ancestor HEAD origin/main` 不成立、`git worktree list` 显示 locked、或目录不在配置的允许父目录下，全部跳过。
   - 只用 `git worktree remove`（默认拒绝不干净的，P18），绝不 `--force`；只对已合并分支用 `git branch -d`，不用 `-D`。
   - 文件/目录：`lstat` 拒绝符号链接；`realpath` 必须在允许根目录下；删除前再解析一次，避免检查后被替换。
4. **只删可重建的**：报告、日志、截图中的证据、数据库副本、恢复点、被引用的材料一律不自动删；证据类只生成清单，等 Andy 授权。
5. **写日志**：每次运行写 `~/.local/state/himawari/prune-local.jsonl`，每行 `runId`、`time`、`action`、`path`、`bytes`、`reason`、`skippedReason`；任务结束时按现有规则报告删了什么、释放多少、有意保留了什么。

### 3.4 第四步：自动检查，防止复发

新增 `scripts/check-repo-hygiene.mjs`，并加入 `package.json` 的 `check:steps`（P17 的 `static` 作业会自动跑它）：

检查内容：

1. **禁止生成的 UI 产物被跟踪**：`git ls-files` 里出现 `clients/apple/ui-review/latest/**`、`mac-latest/**`、`**/DerivedData*/**`、`*.mp4`、`*.mov` → 失败 `REPO_HYGIENE_TRACKED_GENERATED`。
2. **单文件上限**：每个跟踪文件 `git cat-file -s`；超过 `maxTrackedFileBytes` 且不在 allowlist → 失败 `REPO_HYGIENE_FILE_TOO_LARGE`。
3. **新增 blob 上限**：pre-commit/pre-push 时对 staged/待推送的新增或修改 blob 计算大小；超过 `maxNewBlobBytes` 且不在 allowlist → 失败 `REPO_HYGIENE_NEW_BLOB_TOO_LARGE`。
4. **目录预算**：按前缀累计跟踪字节数：
   - `clients/apple/Tests/Snapshots/` ≤ `maxSnapshotTotalBytes`
   - `test/qualification/evidence/` ≤ `maxEvidenceTotalBytes`
   - `docs/assets/control-center/`、`.agents/reviews/` 各有预算
   超过 → `REPO_HYGIENE_DIRECTORY_BUDGET`，列出最大文件。
5. **本地目录必须被忽略**：`git check-ignore -q` 检查 `.agents/local/`、`.cb-delegate/`、`.claude/worktrees/`；如果它们被跟踪或没有被忽略 → 失败 `REPO_HYGIENE_LOCAL_DIR_TRACKED` / `REPO_HYGIENE_LOCAL_DIR_NOT_IGNORED`。
6. **allowlist 校验**：每条 allowlist 必须是规范化的仓库相对路径、存在于 `git ls-files`、带 `reason` 和 `expiresOn`；过期 → `REPO_HYGIENE_ALLOWLIST_EXPIRED`。这样当前 21M zip 可以暂时合法存在，但到期必须处理。

接入点：

- `package.json`：`"check:repo-hygiene": "node scripts/check-repo-hygiene.mjs"`，并加入 `check:steps`。
- `scripts/git-hooks/pre-push`：在现有检查后调用 `node scripts/check-repo-hygiene.mjs --range @{u}..HEAD`；`pre-commit` 同理加 `--staged`（如果当前共享 hook 结构允许）。这样即使有人绕过 `npm run check`，推送前也会被拦。
- CI：`static` 作业运行 `npm run check`（P17），自动成为阻断检查；`ci/required` 仍然要求 static 绿。

反向用例（必须先在实现前写成失败用例，实现后验证“去掉修复会红”）：

- 临时 git 仓库里 staged 一个 `maxNewBlobBytes + 1` 的二进制文件 → 检查必须失败；删掉该文件 → 通过。
- 在 `clients/apple/ui-review/latest/a.png` 提交一个文件 → `REPO_HYGIENE_TRACKED_GENERATED`；未跟踪且被 ignore → 通过。
- 把 `Tests/Snapshots` 总量加到超过 `maxSnapshotTotalBytes` → `REPO_HYGIENE_DIRECTORY_BUDGET`；减回 → 通过。
- allowlist 条目过期 → `REPO_HYGIENE_ALLOWLIST_EXPIRED`；改到期日 → 通过。
- `.claude/worktrees/x` 未被 ignore 并被跟踪 → 失败；加 ignore 并 `git rm --cached` → 通过。
- `prune-worktrees.py`：脏 worktree、未合并 worktree、被锁 worktree、正在被进程使用的 worktree 都必须保留；已合并+干净+空闲的必须删除。去掉任一保护条件，测试必须失败。
- `prune-rebuildable.py`：被文档引用的证据、日志、报告、24 小时内文件、最新两个生产包必须保留；`retention.json` 的 `keepProductionPackets` 改成 0/1 时行为随之变化，不能写死。
- `install-schedule.sh`：缺少配置文件时拒绝安装；`remove-mac` 必须同时卸载旧任务和新任务，且不动别人的 crontab 行；去掉新标签的卸载逻辑，测试必须失败。

### 3.5 历史瘦身（可选项，等 Andy 决定）

历史瘦身能真正缩小现有 pack，但代价大：

- **做法**：`git filter-repo --invert-paths --path clients/apple/ui-review/latest --path clients/apple/ui-review/mac-latest --path test/qualification/evidence/control-center-v4/intermediate-evidence.zip ...`。建议按显式路径删，不要用“删掉所有大于 5M 的文件”，否则会误删 `Tests/Snapshots` 和已批准的设计基线。GitHub 官方也推荐 `git filter-repo`（P19 同页）。
- **代价**（P19）：
  - 所有后续提交哈希改变；open PR 的 diff、评论、复核账本里的 `head`/`base` 全部失效；上线包参数里引用的提交号要重新生成/核对。
  - 每个克隆都必须重新克隆；旧克隆一旦 `git pull` + `git push` 可能把旧 blob 带回来（recontamination）。
  - 分支保护要临时允许强推；签名会丢失；GitHub 上旧 PR 的 diff 可能不可见。
  - GitHub Support 只处理敏感数据，不会因为“文件大”帮你清缓存视图；fork 和旧克隆也无法强制清理。
- **收益**：可能把 pack 从 340M 降到 100–150M 量级，但这是**推测**，没有实测；具体取决于删哪些路径、有多少旧设计批次。必须先用 `git filter-repo --analyze` 或 `git-sizer` 做只读分析。
- **建议顺序**：先完成 3.1–3.4，观察 1–2 周；确认没有新的截图进 main、Mac 回收生效；再决定是否重写。重写前关闭/合并所有 open PR，所有克隆重新克隆，上线包重新冻结。不要在源头的门禁还没装上时先重写，否则会重新长回来。

---

## 四、考虑过但不选的做法

1. **Git LFS**
   - 不选原因：GitHub Free 只有 10GiB 存储和 10GiB/月流量（P15）；UI 截图每个批次 20M 量级，云端复核多次克隆/拉取会很快消耗流量；超流量且无付款方式时 LFS 直接停到下个月（P15）。另外 LFS 不会自动缩小本地 `.git`，还要 `git lfs prune`，存储按所有历史版本计。它只是把“大文件”换了个地方，不是长期方案。
2. **GitHub Releases 存全尺寸截图**
   - 可以考虑，但需要 API/token、私有仓库鉴权，Mac 线程到云端线程的交接仍要额外脚本；当前约束是“靠 git 推送”，自定义 ref 更简单。先不作为主方案。
3. **把截图提交到一个专用的 `ui-review` 分支，再合并/长期保留**
   - 和现在一样会把 blob 带进历史；不选。
4. **只运行 `git gc` / `git gc --aggressive`**
   - `git gc` 只能清理不可达对象，当前大文件大多仍从 main 历史可达；P19 同页说明更早提交必须重写历史。单独 gc 不解决问题。
5. **用 `*.png` 全部禁止提交**
   - 会误伤 `Tests/Snapshots` 和 `docs/assets` 里已批准的基线；不能做。必须按路径和预算区分。
6. **自动删除 `.ci-output/handoff`、`tool-execution-audit` 等证据**
   - 违反 P5（减少证据前先问）；只能报告 + Andy 授权后按清单处理。
7. **把大小规则写进 Himawari 的系统提示**
   - 没必要，而且会改变模型请求开头；违反 P1–P3。规则应该放在脚本、CI 和开发代理的说明里，不进产品提示。
8. **引入 pre-commit 框架**
   - 仓库已有自己的 `scripts/git-hooks` 和 `npm run check`；再加一个框架会增加依赖和两套钩子冲突。只借鉴 `check-added-large-files` 的阈值思路（P16），用现有 Node 脚本实现。
9. **直接 `rm -rf` 所有旧 worktree/副本**
   - 会丢掉未合并的提交、未提交改动和正在复核的材料；违反 P18 的精神和“避免删到在用东西”的要求。必须用 `git worktree remove`、脏/未合并/锁/进程检查。

---

## 五、风险和反例

1. **只加 `.gitignore`、只 `git rm --cached`，仓库 pack 不会变小。**
   反例：执行完 3.1 后 `git count-objects -vH` 仍是 340M 量级。这是预期结果；3.1 只停止继续增长，真正缩小要 3.5。不要向 Andy 承诺“马上变小”。
2. **预算检查可能误伤合法证据。**
   反例：新加一个 6M 的资格验证报告，被 `maxNewBlobBytes` 拦下。解决：allowlist 必须支持“精确路径 + 理由 + 到期日”，并在失败信息里打印如何登记；不能靠放宽全局阈值。
3. **worktree 清理可能删掉尚未推送的提交。**
   反例：一个 worktree 在 `fix/*` 分支上有 3 个未合并提交，但目录空闲 20 天；如果只看空闲天数就会丢工作。保护条件必须是“已合并 + 干净 + 未被锁 + 无进程使用”，四者同时满足；`git branch -d` 只删已合并分支。`docs/lessons.md` 里已有“改动归属/未提交修改”的教训，必须按此执行。
4. **DerivedData 回收可能撞上正在进行的 Xcode 构建。**
   反例：`xcodebuild` 正在用 20 天前创建的 `DerivedData`；只看 mtime 会误删。必须检查 `xcodebuild`/`simctl` 进程、`lsof` 和路径引用；仍然存在检查后到删除前的竞态，所以只对“空闲超过 N 天”的目录做，且整轮 busy 时跳过。
5. **自定义 ref 可能被普通克隆带到本地。**
   反例：如果把截图推到 `refs/heads/review-artifacts/...`，`git clone` 会取所有 heads，克隆又变大。必须用 `refs/review-artifacts/*`，并在文档里写清楚“只允许显式 fetch，不合并”。
6. **删除自定义 ref 可能被理解为“改写已推送历史”。**
   反例：项目规则 P7 禁止改写已推送历史。删除一个一次性 ref 不是重写 main 的提交，但字面上有争议。需要 Andy 明确同意“`refs/review-artifacts/*` 是一次性传输层，验收后可删”；如果他不同意，就退回“只提交一张 ≤1MiB 联系表到 PR 分支”的方案，但那会继续给 main 增加少量历史。
7. **历史重写后旧 blob 仍可能从旧克隆/fork 回来。**
   反例：Andy 的 Mac 克隆或任何旧分支没有重新克隆，之后 `git pull` + `git push` 把旧历史带回来（P19）。重写前必须列出所有克隆和分支，全部重新克隆；上线包引用的提交号要重新生成。
8. **当前 21M zip 不能直接删。**
   反例：`verification.md:44` 链接了它；删掉会让证据文档断链。只能 allowlist 保留，或由 Andy 同意用“精选文件 + 清单”替换并更新文档。
9. **launchd 安装的脚本副本可能过期。**
   反例：仓库里改了 `prune-worktrees.py`，但 `~/.local/share/himawari/` 里的副本还是旧的。`install-schedule.sh` 需要在安装时重新复制并核验脚本摘要；配置路径也要在安装时检查存在，否则打印 `PRUNE_CONFIG_MISSING` 并拒绝安装。
10. **清理脚本的 TOCTOU 竞态。**
    反例：检查时目录不在使用，删除前一个进程进入；或者检查后路径被换成符号链接。需要 `lstat`、`realpath` 前缀校验、删除前再检查一次，并且不对未知父目录做递归删除。

---

## 六、需要 Andy 拍板的取舍

1. **自动回收规则本身**：是否同意安装“已合并 + 干净 + 空闲 N 天”的 worktree/复核副本自动删除；是否同意 DerivedData、`$TMPDIR/dd-*` 的自动删除。按 P4，规则要他在 Mac 线程里明确同意后才能装；装好后具体删除由脚本执行。
2. **证据保留**：`.ci-output/handoff`、`tool-execution-audit`、旧资格证据中，哪些可以归档/删除，保留多少天；`2026-09-28` 的审计目录是否继续永久保留。按 P5，减少证据前必须他确认。
3. **截图交接方式**：接受“短生命周期 `refs/review-artifacts/*` + 联系表”的方案，还是坚持“只把一张 ≤1MiB 联系表提交进 PR 分支”；以及是否同意验收后删除这些 ref。
4. **预算阈值**：`maxNewBlobBytes`、单文件上限、快照/设计基线/证据/复核记录的目录预算；当前 21M zip 是否 grandfather（允许保留到某日）。
5. **是否重写历史**：如果做，选择删除哪些路径（建议只删 `ui-review/latest`、`mac-latest`、旧的整目录证据 zip，保留快照和已批准设计基线），以及何时做（所有 PR 合并、所有克隆重新克隆、上线包重新冻结之后）。
6. **是否调整已批准设计基线的存储方式**：例如每个版本只保留关键截图、其余用联系表；这是设计证据策略，需要他同意。

---

## 七、哪些是读代码/来源证实的，哪些是推测

### 已证实

- `ui-review.sh` / `mac-ui-review.sh` 的默认输出位置、`--check` 的 `mktemp` 不删除、DerivedData 在仓库内：P9。
- 现有清理只覆盖四种文件名和 `doc-check/`，每天 04:00 由 launchd 触发，忙时跳过：P8、`install-schedule.sh:56-60`。
- `.gitignore` 已写 `latest/`、`mac-latest/`，但这两个目录仍有大量历史提交：P10 及 `git log`。
- `intermediate-evidence.zip` 被 `verification.md:44` 引用：P11。
- 复核记录必须提交、合并门要读模型答案：P12。
- CI 的 `static` 作业运行 `npm run check`：P17。
- 仓库没有 `.gitattributes`、没有 `.pre-commit-config.*`、`check:steps` 里没有仓库大小检查（本次 glob/grep/read 核实）。
- GitHub 的 LFS 额度、单文件限制、仓库大小建议、重写历史副作用：P14、P15、P19。
- Claude Code 的 worktree 清扫边界：P13。
- `git worktree remove` 拒绝不干净副本、`git worktree prune` 的作用：P18。

### 推测 / 未核实

- 历史瘦身后 pack 能降到 100–150M 量级：没有实测，只是按 153M 不可达 blob + 旧截图版本估算。
- GitHub 在删除自定义 ref 后多久回收不可达对象：未核实；普通克隆不受影响是确定的，但服务端对象回收时间不确定。
- 云端线程能否直接 `git fetch origin refs/review-artifacts/...`：按 git 语义应该可以，但没有在当前云端环境实测；需要先做一次小批次试点。
- `.cb-delegate` 的 8 个目录是否都是注册过的 git worktree：材料说是“复核用副本”，仓库里没有创建代码；本次未逐个核对，按“可能是普通副本”处理，建议先报告、Andy 同意后再自动删。
- `DerivedDataWatch` 是否还有会话在用：仓库脚本里没有这个名字，无法确认；先按“空闲 N 天才删”处理，第一次运行只报告。
- 当前 1174 个 PNG 里是否还有除 `latest/`、`mac-latest/` 之外的生成物被跟踪：需要实现前用 `git ls-files` 全量分类；本次只核对了已知路径。
- Mac 上 40 个 worktree 中哪些分支已合并：材料说“是否已合并未核对”；实现前必须逐个数，脚本不能猜。

---

## 八、逐条回答必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？

**不会改变 Himawari 发给模型的请求开头。** 本方案只改开发工具、清理脚本、CI 检查、`.gitignore`、本地配置和文档；不修改 `packages/prompt-catalog`、不修改请求组装、不修改工具定义、不修改历史消息、不修改遮盖规则。发给模型的内容仍然只在末尾追加，每轮变化的值仍然只放在最后一条消息里（P1、P2）。

需要补充说明两点：

- 如果实现时修改 `.agents/instructions/disk-space-hygiene.md` 或 `AGENTS.md`，那是给 Claude/opencode 这类**开发代理**的指令，不是 Himawari 的产品请求；它只在新开发会话开头出现一次，不会每轮变化，也不会改写已有会话的历史。若 Andy 把“开发代理的会话开头”也算作“模型已经见过的请求开头”，则这部分需要他同意；可以把规则只写进脚本注释和 ADR，不写进指令文件，从而完全不动任何代理上下文。
- 系统提示和工具按对话冻结（P3）；本方案不触发任何“换新”条件（工具集合、模型、推理强度、回答语言、数据分类都没有变）。

### 2. 这个改动会不会让同一段文字在不同请求里变成不同的字节？

**不会。** 本方案没有新增任何进入模型请求的文本、遮盖规则或序列化。所有新增的值都在本地工具链里：

- `retention.json`、allowlist、`manifest.json` 都按固定键序、固定数组排序生成；
- 时间只出现在**本地日志**和**ref 名**里，不写进提交给 main 的文件，也不进入模型请求；
- 不依赖对象遍历顺序、数据库返回顺序或当前时间生成模型可见内容。

因此同一段历史、同一份遮盖密钥下，模型请求的字节与现在一致。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

有，而且分三层：

1. **提交前 / 推送前**：`scripts/check-repo-hygiene.mjs --staged`（pre-commit）和 `--range @{u}..HEAD`（pre-push），拦住新增大文件、生成的截图、未忽略的本地目录、过期 allowlist。
2. **`npm run check` / CI**：`check:repo-hygiene` 加入 `check:steps`，CI 的 `static` 作业会跑（P17），`ci/required` 必须绿。
3. **清理脚本自身**：`test_prune_rebuildable.py` 扩展；新增 `test_prune_worktrees.py`、`test_prune_evidence.py`、`test_publish_ui_review.py`；`test_install_schedule.py` 扩展。

反向用例确实会失败，做法是先写红再实现：

- 新增 `maxNewBlobBytes + 1` 的文件：检查必须返回非零；删掉后必须返回 0。
- 跟踪 `clients/apple/ui-review/latest/a.png`：必须报 `REPO_HYGIENE_TRACKED_GENERATED`；未跟踪且被 ignore 时必须通过。
- 目录预算超 1 字节：必须报 `REPO_HYGIENE_DIRECTORY_BUDGET`；减回必须通过。
- allowlist 过期：必须报 `REPO_HYGIENE_ALLOWLIST_EXPIRED`；改到期日必须通过。
- 脏 worktree / 未合并 worktree / 被锁 worktree / 有进程使用的 worktree：清理脚本必须保留；只有“已合并 + 干净 + 空闲”才删除。删掉任一保护条件，测试必须红。
- 缺少 `retention.json`：`install-schedule.sh` 必须拒绝安装；`remove-mac` 必须同时卸载旧任务和新任务，否则测试红。
- `publish-ui-review` 的非法 ref 名、路径含 `..`、SHA-256/字节数不符：必须拒绝；去掉校验后测试必须红。

本次是只读方案环境，没有实际运行这些测试；上述“会失败”是设计时必须用红绿验证的结果，不是我已经跑过的结论。

### 4. 每个值产生处和使用处都能接受吗？

下面逐项核对本方案新增/修改的值：

| 值 | 产生处 | 使用处 | 两端校验 |
|---|---|---|---|
| `retention.json` 的 `schemaVersion` | 配置文件 | `prune-rebuildable.py`、`prune-worktrees.py`、`prune-evidence.py`、`check-repo-hygiene.mjs` | 两端都要求 `schemaVersion === 1`；未知版本失败关闭；测试非法版本 |
| `keepProductionPackets` | 配置 | `prune-rebuildable.py` 的 `protected_packets()` / 候选过滤 | 非负整数；CLI `--keep-packets` 可覆盖；测试 0/1/2 |
| `minAgeHours` | 配置 | 各清理脚本的 cutoff | 非负数字；`--min-age-hours` 覆盖；测试年轻文件保留 |
| `worktreeIdleDays` | 配置 | `prune-worktrees.py` 选择候选 | 正整数；与 mtime/`git status`/`git worktree list` 一起判断；测试空闲/最近 |
| `derivedDataIdleDays`、`tmpDerivedDataIdleDays` | 配置 | `prune-rebuildable.py` 的缓存清理 | 正整数；与 `xcodebuild`/`simctl`/`lsof` 检查一起；测试忙时跳过 |
| `maxTrackedFileBytes`、`maxNewBlobBytes`、`maxReviewBundleBytes`、`maxSnapshotTotalBytes`、`maxEvidenceTotalBytes` | 配置 | `check-repo-hygiene.mjs`；发布脚本检查联系表大小 | 正整数；边界用 `>` 还是 `>=` 在代码和测试里一致；allowlist 可豁免单文件 |
| `allowlist[].path` | 配置 | `check-repo-hygiene.mjs`；文档生成失败信息 | 必须是规范化仓库相对路径、`git ls-files` 中存在、无 `..`/绝对路径/符号链接；两端用同一 parser；测试路径逃逸 |
| `allowlist[].expiresOn` | 配置 | `check-repo-hygiene.mjs` | ISO 日期；过期失败；测试过期/未过期 |
| `.gitignore` 的 `.agents/local/`、`.cb-delegate/`、`.claude/worktrees/`、`latest/`、`mac-latest/` | `.gitignore` | git；`check-repo-hygiene.mjs` 的 `git check-ignore` | 检查脚本要求这些路径“被忽略且未被跟踪”；测试跟踪后失败 |
| `refs/review-artifacts/<pr>/<batch>` | `publish-ui-review.mjs` | `fetch-ui-review.mjs`、`cleanup` | 两端都调用 `git check-ref-format`；`<pr>` 只允许数字，`<batch>` 只允许 `[A-Za-z0-9._-]` 且不以 `.` 开头；测试非法 ref |
| `manifest.json` 的 `schemaVersion`、`pr`、`batch`、`files[].path/sha256/bytes/kind` | `publish-ui-review.mjs` | `fetch-ui-review.mjs`、设计线程 | 两端同一 JSON schema；路径相对、无 `..`；`sha256` 十六进制；`bytes` 整数；`kind` 枚举；抓取端重新计算哈希/大小；测试错哈希/错大小/路径逃逸 |
| `check:repo-hygiene` npm 脚本名 | `package.json` | `check:steps`、`scripts/run-all-checks.mjs`、CI `static` | `run-all-checks.mjs` 只接受 `npm run <name>`；脚本必须存在；`check:ci-policy` / `test/tooling/run-all-checks.test.mjs` 守护；测试缺脚本 |
| `com.himawari.prune-local`（或合并到现有 label） | `install-schedule.sh` 生成的 plist / crontab 行 | launchd / crontab；`remove-mac`/`remove-hermes` | 两端都校验 label/marker；卸载必须同时移除旧任务和新任务；测试幂等且保留无关 crontab 行 |
| `PRUNE_*`、`REPO_HYGIENE_*`、`UI_REVIEW_*` 消息 | 各脚本 | 测试、文档、运行日志 | 测试断言精确字符串；文档列出；删除对应分支后反向测试必须红 |
| `~/.local/state/himawari/prune-local.jsonl` | 清理脚本 | 人/审计；不进入模型 | 目录 0700、文件 0600；每行 JSON；路径必须是允许根目录内的绝对路径；测试拒绝写根外 |
| `contact-sheet.webp` 的 `maxReviewBundleBytes` | 发布脚本 | 云端抓取脚本 | 两端都检查 `bytes <= maxReviewBundleBytes`；测试超 1 字节失败 |

特别要避免 I-73 那类“只看了改动、没核对两端”的错误：

- 生成 `refs/review-artifacts/...` 的脚本必须和抓取脚本用同一套 ref 规则；不能一端允许 `PR#123`、另一端只认数字。
- allowlist 的路径必须和 `git ls-files` 的输出格式一致（仓库相对、无前导 `./`）；不能让配置写 `./clients/...`、检查端却不认。
- `install-schedule.sh` 写进 plist 的脚本路径、配置路径必须和运行时实际读取的路径一致；不能把仓库路径写进 launchd 后又在脚本里读 `~/.local/share` 的另一份。
- 清理脚本产生的候选路径必须和真正执行的删除函数接受的范围一致；候选侧做了 `realpath` 前缀检查，删除侧还要再检查一次，不能只在一端做。
- `check-repo-hygiene` 的预算前缀、allowlist 路径、`git cat-file` 的 blob 来源必须一致：pre-commit 读 staged blob，CI 读 `base...head` 的提交 blob，不能一个读工作区文件、一个读提交。

---

## 九、一句话结论

当前“仓库大”的主因不是正常源码，而是**把生成的 UI 截图和整目录证据包提交进 main，删除后历史仍保留**；“Mac 克隆大”的主因是**旧上线包材料、Xcode DerivedData、每 PR 的 `$TMPDIR/dd-*`、worktree/复核副本没有自动回收**。最合适的长期方案是：**main 只留文字、必要快照和已批准基线；截图通过一次性 `refs/review-artifacts/*` 交接；Mac 上用配置驱动的脚本按“已合并/干净/空闲/未在用”回收；用 `check:repo-hygiene` 在提交、推送和 CI 三层拦住新增大文件/生成物；历史重写只作为 Andy 明确同意后的可选步骤。**
