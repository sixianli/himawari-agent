只读了当前提交 `82ebfe69` 的代码与文档；Mac 上的实际目录、进程、克隆状态没有现场核对，依赖方案里统计数字的部分标为未核实。总体判断：方向对（先停止把截图写进 `main`，再回收本地产物），但有 3 处会直接删到证据或在用工作，2 处达不到“克隆不再增长”，而且新门禁没有按 I-73 核对产生端和使用端。

## 证实的发现

### 1. 严重：`.ci-output`/`handoff` 的清理会删掉文档引用的证据和部署脚本

**问题：** B3 写“handoff 下超过 N 天的证据目录，只保留报告、日志和小于 1MB 的 json/md，删其余大文件”，还要删 `production` 下的旧上线包。但 `.ci-output/handoff` 里既有被文档引用的证据，也有 `make-packet.py` 默认使用的 SSH 包装脚本；`tool-execution-audit/2026-09-28` 还被多份规格和教训记录引用。按方案文字执行会同时违反磁盘规则和破坏部署工具。

**证据：**
- 规则要求“始终保留测试报告、日志、截图、所有被引为证据的东西”“减少证据之前要先问”：`.agents/instructions/disk-space-hygiene.md:8-9`。
- 文档直接引用这些路径：`docs/execution/specs/2026-09-24-isolated-tool-execution-design.md:158`、`docs/lessons.md:467`、`:540`、`test/qualification/evidence/control-center-v4/verification.md:44`（引用 21M 的 `intermediate-evidence.zip`）。
- `scripts/delivery-mode/make-packet.py:678-679` 默认使用 `.ci-output/handoff/scripts/hermes-ssh.sh` 和 `hermes-upload.sh`；`.agents/instructions/test-and-production-hosts.md:14,26` 要求所有 Hermes 连接必须经过这两个脚本。
- 服务器上的 `release-cleanup-remote.py` 并不是无条件删大文件：它保护 `current evidence`、最近的数据库副本、失败验收现场和 `serving/rollback/in-use` 路径（`scripts/delivery-mode/release-cleanup-remote.py:199-209,277-294`）。方案只学了“删超过 10MiB 的文件”，没学这些保护条件。

**建议：** 清理前先建立“文档/报告引用索引”，任何被引用的路径一律保留；`handoff/scripts`、`.ci-output/tools`、`production` 当前/回滚/在用包、失败验收现场必须列入硬保护名单。大证据不要自动删，先移到 GitHub Release 附件或外部归档，并在仓库里留摘要和链接；删除证据必须由 Andy 明确批准。

### 2. 高：专用分支 + 删分支不会让现有克隆停止增长，方案漏了 GC

**问题：** 方案说“分支删掉后对象不在 main 历史，新克隆不下载”。这只对新克隆成立。现有克隆默认按 `remote.origin.fetch` 取所有分支；即使之后删分支，对象仍留在本地，直到 `git gc` 和 reflog 过期。Mac 的 `.git` 已 505M，方案 C 的预计释放没有算这块。

**证据：**
- `git fetch` 默认从 `remote.<name>.fetch` 取 refspec，支持负 refspec 排除分支：https://git-scm.com/docs/git-fetch（“When no refspecs appear on the command line, the refs to fetch are read from `remote.<repository>.fetch` variables”；“If a refspec is prefixed by `^`, it will be interpreted as a negative refspec”）。
- `git gc` 才会移除不可达对象；默认 `prune` 是两周前，`gc.reflogExpire` 默认 90 天，`gc.reflogExpireUnreachable` 默认 30 天：https://git-scm.com/docs/git-gc。
- 方案 A1/C 没有提到现有克隆的 fetch、GC 或 reflog。

**建议：** 首选 GitHub Release 附件或独立仓库，完全不让截图进入主仓库对象库；如果坚持专用分支，必须给所有 fetch 配置加 `^refs/heads/ui-review/*` 负 refspec，并单独设计一次经 Andy 同意的 `git gc`/`git maintenance`。不要在没有 GC 的情况下声称 Mac 克隆会变小。

### 3. 高：500KB 单文件门槛挡不住累计增长，`test/qualification/evidence` 和快照目录没被处理

**问题：** 500KB 只限制单个文件。当前 1174 个 png 共 115M、`latest/` 48 个文件 26M、快照 22M、`test/qualification/evidence` 历史 74M、当前最大的 zip 21M，都可以由“很多小文件”或“一个白名单目录”继续进入历史。方案只把 snapshots 和 test/fixtures 举例为白名单，没有给 evidence 二进制定规则。

**证据：**
- 方案 A2；当前 `test/qualification/evidence/control-center-v4/intermediate-evidence.zip` 和 `verification.md:44` 明确把它当证据。
- 即使采用 pre-commit 的 `check-added-large-files` 默认 500kB，也只是单文件阈值：https://github.com/pre-commit/pre-commit-hooks。
- GitHub 建议仓库尽量小于 1GB、强烈建议小于 5GB：https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-large-files-on-github（“We recommend repositories remain small, ideally less than 1 GB, and less than 5 GB is strongly recommended.”）。

**建议：** 门禁同时包含“单文件上限 + 单次提交总增量上限 + 每个目录的预算”。白名单必须写精确路径、理由和总量上限；evidence 中的大 zip/截图/视频默认走 Release 附件或外部归档，仓库只留报告、日志、SHA-256 和链接。历史 309M 不需要为此立即重写。

### 4. 高：新门禁没有测试和反向用例，且没有明确进 `check:steps`、pre-push 和 CI

**问题：** 方案只写了 `npm run check:added-files`，没有说测试、反向用例、加进哪个门槛。现有 `npm run check` 只跑 `check:steps` 里的步骤；现有推送前的硬门槛在 `scripts/git-hooks/pre-push`。另外“相对 origin/main”在 `origin/main` 过期、缺失或分支含 merge commit 时不可靠；“命中 .gitignore 却被强制加入”如果用普通 `git check-ignore` 会漏掉已跟踪文件。

**证据：**
- `package.json:26-27`，`scripts/run-all-checks.mjs:31-32`。
- `scripts/git-hooks/pre-push:3-18` 已有 boundary/format/lint/secret 检查，新门禁应同层。
- `git check-ignore` 文档原话：“By default, tracked files are not shown at all since they are not subject to exclude rules; but see ‘--no-index’”：https://git-scm.com/docs/git-check-ignore。
- 合并队列已经用 `base...head` 计算变更文件（`scripts/ci/merge-queue.mjs:112-117`），可作为正确基线写法的参照。

**建议：** 把门禁做成一个共享模块，提交钩子用 staged diff（`git diff --cached --raw -z`），CI/PR 用调用方传入的 base SHA 和 `base...head`；强制加 `git check-ignore --no-index`；`origin/main` 不存在时失败关闭，不静默跳过。至少加这些反向用例：501KB 文件失败、400KB 通过、单次提交总量超限失败、`git add -f latest/x.png` 失败、白名单无理由失败、allowlist 里过宽 glob 失败、base 缺失失败、重命名大文件按预期处理；并确认去掉门禁后测试会红。

### 5. 高：worktree 回收可能删到正在用或有本地未跟踪文件的工作副本，`.cb-delegate` 也不一定是 git worktree

**问题：** B2 的“未加锁、无未提交和未跟踪改动、分支已合进 origin/main、3 天没改动”不足以证明安全：手工 worktree 不一定有锁；`git status` 默认不显示忽略文件；活跃但空闲三天的会话可能仍以该目录为 cwd；`.cb-delegate` 是“复核用副本”，不一定是 `git worktree`，`git worktree remove` 清不到它；`.claude/worktrees` 可能正被 Claude Code 会话使用。

**证据：**
- `git worktree remove` 只保证删“clean worktree”，有未跟踪/修改文件或子模块时必须 `--force`：https://git-scm.com/docs/git-worktree（“Only clean worktrees (no untracked files and no modification in tracked files) can be removed. Unclean worktrees or ones with submodules can be removed with `--force`.”）。
- Claude Code 文档：`-p` 非交互运行不会清理 worktree；手工 `git worktree add` 建的 worktree 也不会被周期清扫；运行中的 agent 会持有 `git worktree lock`：https://code.claude.com/docs/en/worktrees.md。
- `.agents/opencode-models.py:130-138` 还使用 `.ci-output/worktrees`，方案没有把它列入保护/清理范围。
- `git worktree list` 有 `locked`/`prunable` 状态，应使用 `--porcelain -z` 解析，避免路径含换行/空格时出错。

**建议：** 只删显式带“可回收标记”的 worktree；主 worktree、`../himawari-deploy-wt`、锁定、保留清单、当前 cwd 被进程使用、`git status --ignored` 有内容的一律只列出不删；`.cb-delegate` 单独按副本处理；`.claude/worktrees` 优先交给 Claude Code 的 sweep，不要和手工 `git worktree` 混在一起。默认 dry-run，删除前输出清单，禁止随手 `--force`。

### 6. 高：所有 xcodebuild 共用 DerivedData 会互相踩，清理也没有 xcodebuild 忙检查

**问题：** B1 把所有 xcodebuild 的 DerivedData 固定到 `~/Library/Caches/himawari/DerivedData/<平台>` 并“跨 PR 复用”。多个 worktree/会话同时构建时，同一个 `Build/Intermediates` 和 `build.db` 会竞争；清理只按“N 天没用”，没有检查 `xcodebuild`/`swiftc`/`clang`/`simctl` 是否在跑。现有 04:00 清理的 busy 正则也没有 xcodebuild（`scripts/disk-hygiene/prune-rebuildable.py:16`）。另外 `DerivedDataWatch` 891M 是会话手工建的，方案没有迁移或回收它。

**证据：**
- `clients/apple/scripts/ui-review.sh:11,86-88` 当前把 DerivedData 放在仓库内；`mac-ui-review.sh:6,15` 同样。
- `scripts/disk-hygiene/prune-rebuildable.py:16` 的 `BUSY_PATTERN` 只有 vitest/playwright/CI/npm，没有 Xcode。
- 方案自己列出的 Mac 事实：`DerivedDataWatch` 891M，“脚本里没有这个名字，是会话手工建的”。

**建议：** 要么每个 worktree 独立 DerivedData（最安全），要么按平台加文件锁并让 `xcode-build.sh` 输出确定的路径；清理前检查 Xcode 相关进程和 DerivedData 的最近使用标记，设置“总大小上限”而不只是天数；对 `ui-review/DerivedData*` 和 `DerivedDataWatch` 做一次显式迁移/删除清单，先 dry-run。

### 7. 中：`git rm --cached latest/` 后其他克隆 pull 会删工作区文件，文档仍把这两个目录当交付位置

**问题：** 方案说取消跟踪 `latest/`、`mac-latest/`，但 README 仍说截图放在这些目录；`ui-review.sh`/`mac-ui-review.sh` 也默认写入它们。取消跟踪后，其他克隆（包括云端）拉取提交时工作区文件会被删除，而截图交接流程还没完全切换到新通道，容易在切换期丢图。

**证据：**
- `clients/apple/README.md:101,158` 明确写 `clients/apple/ui-review/latest/`、`mac-latest/` 是输出位置。
- `clients/apple/scripts/ui-review.sh:6`、`mac-ui-review.sh:5` 默认 `out` 就是这两个目录。
- 当前 `latest/` 有 48 个文件、`mac-latest/` 有 24 个文件，且 `git show HEAD:clients/apple/ui-review/latest/08-settings-dark.png` 能取到 blob，说明 `.gitignore` 里的 `latest/` 确实仍被跟踪。

**建议：** 先完成新传输通道，再 `git rm --cached`；更新 README 说明这些目录只在本机存在、如何重新生成、如何从 Release 附件恢复；给其他克隆一个迁移说明。历史里的旧截图仍可找回，不要为了“当前工作区干净”删除唯一副本。

### 8. 中：`--check` 的临时目录会泄漏，`--approve` 先删后拷，oxipng 可能改变元数据

**问题：** `ui-review.sh --check` 用 `mktemp -d` 存新截图，但只有正常走到结尾才会退出，比较失败或脚本提前失败时没有 trap 删除，会反复泄漏 `$TMPDIR` 目录。`--approve` 先用 `rm -f "$snapshots"/*.png` 再 `cp`，如果 oxipng 或复制中途失败，旧基线已经被删。oxipng 若剥掉色彩配置，`compare-snapshots` 的 `CGContext` 解码结果可能变化；方案说“不改像素”需要实测证明。

**证据：**
- `clients/apple/scripts/ui-review.sh:124-126,215-218`；`:65-68`。
- `clients/apple/scripts/compare-snapshots.swift:11-30,64-77` 是按解码后的 RGBA 像素比较，不是按文件字节比较；这支持“无损压缩”方向，但不自动证明元数据不影响解码。
- 方案 A3 没有测试或回退方案。

**建议：** `mktemp` 后立即 `trap` 清理，失败时保留目录并打印路径作为诊断证据；`--approve` 先写临时目录，校验通过后原子替换；oxipng 固定版本、禁止 strip 色彩配置，先在一小批快照上跑 `--check` 验证，再全量启用；oxipng 缺失时回退原始 PNG，不要失败。

### 9. 中：`install-schedule.sh` 只装旧脚本，新清理脚本/配置不会自动生效，也没有 Andy 同意后的安装步骤

**问题：** B4 说“新脚本并入现有 04:00 launchd 任务”，但现有安装器只把 `prune-rebuildable.py` 拷到 `~/.local/share/himawari`，launchd 运行的是这份副本；新脚本和配置文件不会被安装，现有任务会继续跑旧逻辑。副本在仓库外，也不能靠仓库相对路径读配置。

**证据：**
- `scripts/disk-hygiene/install-schedule.sh:11-13,43-45,56`。
- `scripts/disk-hygiene/test_install_schedule.py:47` 只断言旧脚本副本存在。
- 规则要求“自动回收规则本身要 Andy 同意后才能装”；方案 B4 没有写安装前的 dry-run、报告和同意步骤。
- 已有 I-52 记录过：Hermes 上的脚本副本要重跑 `install-schedule.sh` 才生效（`docs/incidents-and-gates.md:106`）。

**建议：** 把新脚本、配置和测试一起安装；launchd 用绝对 `--config` 路径，或把配置也复制到 `~/.config/himawari/`；安装器先跑 dry-run 并打印将删除/保留的内容，等 Andy 明确同意后再写 plist；加一条“脚本版本/配置摘要”日志，避免继续跑旧副本。

### 10. 中：没有本地 GC/reflog 计划；`git gc --prune=now` 在 99% 磁盘和并发 git 下有风险

**问题：** 如果保留专用分支，方案没有说何时 GC；如果为了立即缩小 `.git` 直接 `--prune=now`，在 Mac 磁盘 99%、可能有其他 git 进程时风险很高。Git 文档明确说并发运行 `git gc` 有删掉别人正在用对象的风险。

**证据：**
- `git gc` 文档：默认 prune 两周前，`--prune=now` 会立即删且“increases the risk of corruption if another process is writing to the repository concurrently”；reflog 默认保留 90/30 天：https://git-scm.com/docs/git-gc。
- 方案 C 没有 `.git` 的回收项。

**建议：** 优先用 Release 附件/独立仓库，避免主克隆产生垃圾；如果必须 GC，先备份、确认没有 git 进程、检查空闲空间大于 pack 的约两倍，先用默认 `git gc`/`git maintenance`，不要默认 `--prune=now`；把“清 reflog/立即 prune”列为需要 Andy 单独同意的不可逆操作。

### 11. 低：`.gitignore` 新增条目不会取消已跟踪文件；`.agents/local/` 可能藏着用户笔记

**问题：** 方案 B2 说“根 .gitignore 加 `.claude/worktrees/`、`.agents/local/`”，但 `.gitignore` 不会把已跟踪文件移出索引；`latest/` 就是现成例子。`.agents/local/` 若已有被跟踪文件，加了 ignore 也不会消失；如果里面是用户本地笔记，忽略后 agent 的搜索/glob 会跳过，反而可能漏读。

**证据：**
- 根 `.gitignore:1-16` 当前没有这两个条目；`clients/apple/ui-review/.gitignore:2,6` 已有 `latest/`、`mac-latest/`，但文件仍被跟踪。
- `git check-ignore` 默认不显示已跟踪文件：https://git-scm.com/docs/git-check-ignore。

**建议：** 实施时先列出这两个目录下已跟踪文件；有就 `git rm --cached`（保留工作区）或在 README 说明；确认 `.agents/local/` 的用途后再忽略，不要把用户笔记当作构建产物。

### 12. 低：`node_modules`、`.ci-output/tools`、`tool-execution-audit` 和 `.ci-output/worktrees` 没有上限，预计释放可能达不到

**问题：** 方案只处理 production/handoff，`node_modules` 590M、`.ci-output/tools` 701M、9-28 audit 1.3G 基本不动；`.ci-output/worktrees` 还被 opencode 的模型导出工具使用，方案没有把它列入清理或保护。C 的“约 5G + 3G + 2-3G”可能不足以把 99% 磁盘降下来。

**证据：**
- 方案自己的 Mac 统计；`scripts/disk-hygiene/prune-rebuildable.py:53` 明确跳过 `.ci-output/tools`。
- `.agents/opencode-models.py:130-138` 使用 `.ci-output/worktrees`。

**建议：** 给这些目录定“总量上限 + 保留最近 N 个”的可配置策略；`.ci-output/worktrees` 必须先确认是否在用，不要被通用 `.ci-output` 清理误删；9-28 audit 由 Andy 单独决定，且删除前先补文档/摘要。

### 13. 低：规则、说明和代码会不一致，方案没有更新它们

**问题：** `disk-space-hygiene.md:10` 现在明确写“只删四种可重建文件”“绝不删除日志、报告、证据”“最新的两个上线包”；方案要扩展到 worktree、Xcode、production/handoff 证据，必须同步改规则、AGENTS、README、runbook 和安装器说明，否则下一个线程会按旧规则判断。`check:instruction-links` 只查链接，不查语义。

**证据：**
- `.agents/instructions/disk-space-hygiene.md:8-10`；`AGENTS.md:136-139`。
- `clients/apple/README.md:101,158`；`.agents/instructions/test-and-production-hosts.md:14,26`；`docs/runbooks/agent-tooling-runbook.md:71`。
- 方案没有列出这些文档的更新项。

**建议：** 把规则修改作为实施的一部分，并加一条“文档与脚本一致”的检查（例如脚本保护名单必须出现在规则里，或测试读取规则中的保留项）；不要只改脚本。

## 推测或未核实

- Mac 上 40 个 worktree、`.cb-delegate` 1.2G、`.claude/worktrees` 1.1G 的实际状态没有现场核对；`.cb-delegate` 是否都是 git worktree 未核实，若不是，`git worktree` 方案清不到。
- `DerivedDataWatch` 891M 的实际内容、是否仍在使用未核实；方案只提到它，没有回收步骤。
- `oxipng` 能省多少、是否会改变 PNG 色彩配置/像素解码结果未实测；`compare-snapshots` 的像素比较提示风险较低，但不能替代实测。
- `git worktree remove` 对“忽略文件”的实际处理需要实测；`git status` 默认不显示忽略文件，不能只看它判断“干净”。
- 当前 `remote.origin.fetch` 是否覆盖所有分支未核对；但默认行为通常是 `+refs/heads/*:refs/remotes/origin/*`，方案不能假设现有克隆不会取到截图分支。
- GitHub Release 附件对私有/公开仓库的可见性、以及 Andy 是否接受这种交接方式，未核实；官方只说明了数量和单文件大小限制（见下）。
- `.agents/local/` 是否已有被跟踪文件未核对；如果有，单加 `.gitignore` 不够。

## 侧重检查

- **错误路径：** 查了 `ui-review.sh` 的 `--check`/`--approve`、`compare-snapshots.swift`、`prune-rebuildable.py`、`release-cleanup-remote.py`、`install-schedule.sh`。结论：临时目录无 trap、`--approve` 先删后拷、prune 遇错继续、安装器只复制旧脚本，都是会在失败路径上放大损失的写法；方案没有逐一处理。
- **不合规范/不可信输入：** 查了配置文件、分支名、worktree 路径、`.gitignore`、`git check-ignore`。结论：分支名 `ui-review/pr-<号>` 没有严格格式和 ref 校验；配置值没有 schema/范围校验；`git check-ignore` 必须 `--no-index` 才能查强制加入的已跟踪文件；路径要用 `--porcelain -z`，否则空格/换行会解析错。
- **安全：** 查了删除根目录、符号链接、worktree 路径、Release 附件可见性。结论：清理脚本必须拒绝符号链接、非本人所有、越界路径；删除前用 `lstat`/`resolve` 并确认根目录；分支/附件里的截图要当不可信输入，只按固定文件名复制，不执行其中任何脚本；私有仓库/敏感截图要先确认可见性。
- **资源耗尽：** 查了 `.git` 505M、`$TMPDIR/dd-*` 最多 31G、`.ci-output` 5.1G、`node_modules` 590M、`oxipng` 和 `git gc`。结论：方案没有给 Xcode/DerivedData 设总大小上限，没有给 `git gc` 预留空间，`check:added-files` 若读 blob 内容会占用内存；应使用 `git cat-file -s`/`--raw -z`，并给清理脚本超时、错误继续和报告。
- **不可逆操作：** 查了 `git rm --cached`、`git worktree remove`、`.ci-output`/证据删除、分支删除、`git gc --prune=now`、历史重写。结论：证据/工作副本/分支/GC/历史重写都不可逆或难以恢复，方案没有统一的“先 dry-run、再确认、再执行、留报告”流程；尤其不能把 Andy 对“自动规则”的同意当成对每次证据删除的授权。
- **规则/文档/代码一致：** 查了 `disk-space-hygiene.md`、`AGENTS.md`、README、runbook、`make-packet.py`、`install-schedule.sh`。结论：方案会改变规则声明的行为，但没有更新这些文件；`handoff/scripts`、`latest/`、`mac-latest/` 仍被其他代码/文档消费。

## 如果由我来定，我会这样改

1. **先停止截图进 `main`，但不用主仓库分支。** 首选 GitHub Release 附件：官方说明“Up to 1000 release assets … each file under 2 GiB. There is no limit on the total size of a release, nor bandwidth usage”（https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases），不会进入克隆。Mac 线程上传到每个 PR 的 Release/tag，云端线程按 URL 下载；仓库里只留文本报告、SHA-256 和链接。若 Andy 不接受 Release，再用独立仓库；主仓库的 orphan 分支是最后选项，并且必须配负 refspec 和 GC。
2. **仓库门禁做“单文件 + 单次提交总量 + 目录预算”。** 精确白名单（路径、理由、总量上限），`git check-ignore --no-index`，base SHA + `base...head`，staged diff，失败关闭；加到 `check:steps`、`pre-push` 和 CI，并有反向测试。不要只照搬 pre-commit 的 500kB 单文件阈值。
3. **快照压缩只在验证后启用。** oxipng 固定版本、禁止 strip 色彩配置；`--approve` 写临时目录再原子替换；`--check` 用 trap 清理，失败时保留目录并打印路径。先测一批再全量。
4. **本地产物用一个可配置的清理脚本，默认 dry-run。** Xcode 每个 worktree 独立或加锁；检查 xcodebuild/swift/clang/simctl 忙；worktree 只删有标记、无锁、无进程 cwd、无未提交/未跟踪/忽略文件、分支已合并的；`.cb-delegate` 单独处理；`.ci-output` 只删可重建文件，`handoff/scripts`、`tools`、当前/回滚/在用包、被引用证据全部保护；9-28 audit 由 Andy 决定。
5. **安装器一起升级。** 复制新脚本和配置，launchd 用绝对 `--config`；安装前先 dry-run 报告，等 Andy 明确同意后写 plist；加版本/配置摘要日志，防止继续跑旧副本。
6. **本地 Git 只做温和维护。** 用默认 `git gc`/`git maintenance`，不默认 `--prune=now`；要立即清 reflog/unreachable 对象时，单独列为不可逆操作，先备份、确认无 git 进程、检查空闲空间，再由 Andy 同意。
7. **历史瘦身不做。** 当前 pack 340M、GitHub 建议 <1GB；为 309M 重写 5119 个提交的代价（所有 hash 变化、所有分支/PR/克隆重建、GitHub 可能保留不可达对象、8GB Mac/99% 磁盘）不值。若以后坚持，先备份、冻结推送、用 `git filter-repo`，并接受所有克隆都要重新克隆。
8. **需要 Andy 拍板：** Release 附件还是独立仓库/专用分支；哪些 `.ci-output`/handoff 证据可以删或移到外部；9-28 audit 1.3G 是否保留；旧 production 包保留几个；是否安装新的自动回收规则；是否允许本地 GC/清 reflog；是否重写历史；500KB/单次总量/目录预算的具体值。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。本方案没有触碰 Himawari 的请求组装、系统提示、工具定义、历史、出口遮盖；这些规则要求固定内容在前、会变的值只在最后一条消息、历史只追加（`.agents/instructions/prompt-prefix.md:27-30,36-37,42-45`）。唯一相关的是开发用复核提示：复核脚本会从提交里读 `model-review.md`，但本方案不改它；若实施时改了，复核每次是新会话，不构成跨运行缓存问题，仍不应把时间、分支名、磁盘剩余空间等会变的值放进系统提示或工具定义。若要把截图交给设计验收模型，只应在对话末尾追加新图片/新消息，不改写已有消息。
2. **会不会让同一段文字在不同请求里变成不同字节？** 不会。方案没有给提示词加时间、随机数、无序集合或依赖前后文的遮盖；新增的配置键、保留天数、分支名、清理日志都只属于脚本/文件系统，不进入模型请求。需要守住的是：不要把这些值塞进提示词目录或系统提示；截图附件如果要进对话，也只追加在末尾；oxipng 改变的是仓库文件字节，不是模型请求文本，但同一张图重新压缩后若再作为附件，字节会变，所以设计验收应按新会话处理，不要依赖跨运行缓存。
3. **有没有对应的自动检查，反向用例真的会失败？** 方案目前没有。它只点名了 `check:added-files`，没有测试计划、没有反向用例、没有说明进 `check:steps`/pre-push/CI；清理脚本和截图传输也没有测试。现有 `check:prompt-prefix` 有反向用例（`prompt-prefix.md:76`），`prune-rebuildable.py` 有临时目录测试（`scripts/disk-hygiene/test_prune_rebuildable.py:62-178`），新方案应按同样标准补：门禁用例（超限失败、allowlist 通过、强制加入失败、总量超限失败、base 缺失失败）；清理用例（dry-run 不删、引用证据不删、锁定/忙 worktree 不删、符号链接不跟随、配置非法失败、部分删除报错退出 1）；传输用例（分支名/附件名非法拒绝、删除分支前保留 N 天、云端只复制允许的文件）。每条都要证明“去掉修复会红”。
4. **每个产生/修改的值，使用它的地方都能接受吗？** 不能全部接受，至少这些要逐项核对：
   - `ui-review/pr-<号>`：Mac 线程产生，云端线程按分支取；没有严格格式校验，分支名可含 `..`/空格/控制字符，存在取错 ref 和 shell 注入风险。建议固定正则、只 fetch 精确 ref、只复制 `*.png`/`*.mp4`。
   - 500KB/单次总量/目录预算：配置产生，门禁和钩子消费；没有 schema、没有共享解析器，钩子和 CI 可能读出不同结果。建议一个模块、范围校验、缺失即失败。
   - 白名单路径：配置产生，门禁消费；宽 glob 会让整个目录绕过门禁。建议精确路径 + 理由 + 总量上限，并测试每条都真的被用到。
   - `7d/24h/2/14d/1MB/15GB` 等保留值：配置产生，清理脚本、launchd、文档消费；没有范围校验，且 `install-schedule.sh` 只复制旧脚本，副本读不到仓库配置。建议安装配置、打印生效值、非法值失败。
   - `~/Library/Caches/himawari/DerivedData/<平台>`：`xcode-build.sh` 产生，`ui-review.sh`/`mac-ui-review.sh`/README 消费；没有输出契约和并发锁。建议固定输出路径变量、每 worktree 独立或加锁、README 同步。
   - `.claude/worktrees/`、`.agents/local/`：`.gitignore` 产生效果，`git check-ignore`、agent 搜索消费；已跟踪文件不会自动取消。建议先列已跟踪文件并 `git rm --cached`，确认 `.agents/local/` 用途。
   - `handoff/scripts`：仓库/历史产生，`make-packet.py:678-679` 和测试主机说明消费；清理方案没有保护，必须加入硬保留名单。
   - `production` 的“最新 N 个”：清理脚本产生，`deploy.sh`/`rollback.sh`/证据消费；只按日期保留会漏掉当前/回滚/在用包。建议按 `release-cleanup-remote.py:199-209` 的 `serving/rollback-target/used-by-process/named-by-database` 保护。
   - `test/qualification/evidence` 的链接：仓库/文档产生，`verification.md` 等消费；大文件门禁/清理必须保留被引用文件，或把大文件移到 Release 并保留摘要和链接。
