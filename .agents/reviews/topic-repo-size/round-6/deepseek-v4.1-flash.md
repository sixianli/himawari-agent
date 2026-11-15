CLAIM|1|找不到|-|他 Mac 上的克隆一共 16G|-|
CLAIM|2|找不到|-|仓库本身只占约 0.5G|-|
CLAIM|3|找不到|-|其余约 15G 都是本机产生、git 不跟踪的东西|-|
CLAIM|4|找不到|-|云端完整克隆的 `git count-objects -vH` 是 pack 340.64 MiB（只算 main 和它的历史）|-|
CLAIM|5|找不到|-|加上全部 355 个远程分支是 394.40 MiB|-|
CLAIM|6|找不到|-|签出的跟踪文件约 260M|-|
CLAIM|7|找不到|-|main 历史里的文件内容压缩后约 309M|-|
CLAIM|8|找不到|-|最大一块是 `clients/apple/ui-review`（界面截图和录屏）131M|-|
CLAIM|9|找不到|-|其次是 `test/qualification/evidence` 74M|-|
CLAIM|10|找不到|-|`clients/apple/Tests` 36M|-|
CLAIM|11|找不到|-|当前 main 里已经不存在、只留在历史里的内容有 153M|-|
CLAIM|12|一致|clients/apple/ui-review/.gitignore:2|截图目录 `clients/apple/ui-review/latest/` 写在 `.gitignore` 里|latest/
CLAIM|13|一致|clients/apple/ui-review/latest/01-today-device-actions-dark.png@07181db904ac5cdb18fa9b801bcc774e100b100d|在本 PR 之前却被强制提交在跟踪中；本 PR 已取消跟踪|delete mode 100644 clients/apple/ui-review/latest/01-today-device-actions-dark.png
CLAIM|14|一致|scripts/repo-hygiene/config.json:6|`check:repo-hygiene` 拦它再被提交|"clients/apple/ui-review/latest/",
CLAIM|15|找不到|-|11-12 到 11-15 之间约有 20 个提交反复“提交截图”又“把截图移到项目文件夹”|-|
CLAIM|16|找不到|-|40 个 git 工作副本约 6G：`.agents/local/worktrees` 21 个 3.9G、`.cb-delegate` 8 个 1.2G、`.claude/worktrees` 3 个 1.1G，另有 3 个目录已经不存在的|-|
CLAIM|17|找不到|-|`.ci-output` 5.1G：旧上线包 1.8G、9 月 28 日的一次测试证据 1.3G、旧生产证据 1.0G、工具下载缓存 701M|-|
CLAIM|18|一致|scripts/disk-hygiene/prune-rebuildable.py:12|每天 04:00 的自动清理只认四种安装包文件名|REBUILDABLE_FILES = ('*.bundle', 'node-modules.tar.gz', '*-abi[0-9]*-*.tar.gz', 'python-[0-9]*.tar.gz')
CLAIM|19|找不到|-|这些它都不碰|-|
CLAIM|20|找不到|-|它最近一次删了约 857MB，之后几次都是 0|-|
CLAIM|21|找不到|-|Xcode 编译缓存放在仓库目录 `clients/apple/ui-review` 下，共 3.0G|-|
CLAIM|22|找不到|-|仓库外的系统临时目录里，每个 PR 新建一份 Xcode 编译缓存（`dd-518-ios`、`dd-489-mac` 等），不复用、不回收，最多时 37 个约 31G|-|
CLAIM|23|一致|.claude/rules/owner-global-instructions.md:61|不得改写已推送的历史：`绝不强制推送、改写已推送的历史或绕过钩子`|- 每个提交创建后立即推送到 `origin` 上的同名分支，第一次推送时设置上游；绝不强制推送、改写已推送的历史或绕过钩子，推送被拒绝时停下并报告。除非明确要求，不得创建分支或标签、开 PR 或合并。项目自己的推送规则优先。
CLAIM|24|一致|.agents/instructions/disk-space-hygiene.md:10|清理要自动、由脚本做：`清理是自动的（不要等 Mac 快满了才清理）` `当一种新的可重建产物开始堆积时，把它的匹配模式加进脚本及其测试，而不是手工清理。`|- 清理是自动的（不要等 Mac 快满了才清理）。`scripts/disk-hygiene/prune-rebuildable.py` 只删除可重建文件（`*.bundle`、`node-modules.tar.gz`、`*-abi<N>-*.tar.gz` 包、`python-<version>.tar.gz`）和 `doc-check/` 下的旧临时仓库副本；它绝不删除日志、报告、证据、脚本、`.ci-output/tools/`、最近 24 小时内改动过的文件，以及任何 `production/` 目录下最新的两个带日期的上线包。`deploy.sh` 在 `DEPLOY_PASSED` 之后对 `.ci-output` 以 `--apply` 运行它。`scripts/disk-hygiene/install-schedule.sh mac|hermes <root>...` 安装每天 04:00 的定时运行（Mac 上用 launchd，Hermes 上用登录账号的 crontab），在有构建或测试正在运行时跳过这一轮；`remove-mac` 和 `remove-hermes` 撤销安装。不带 `--apply` 运行它可以查看它会删除什么。当一种新的可重建产物开始堆积时，把它的匹配模式加进脚本及其测试，而不是手工清理。
CLAIM|25|一致|.agents/instructions/disk-space-hygiene.md:8|证据要保留，减少证据先问：`始终保留测试报告、日志、状态回读、跟踪记录、截图、所有被引为证据的东西` `减少证据之前要先问。`|- 始终保留测试报告、日志、状态回读、跟踪记录、截图、所有被引为证据的东西、备份、恢复点（在云服务器上指当前在服务版本的恢复点），以及在云服务器上当前在服务的生产版本和它的上一个版本。每次测试和每次发布结束时都要清理其临时产物，包括失败的尝试，并且由脚本完成而不是手工完成，也绝不能只是给它们改名了事；在云服务器上，`deploy.sh` 用 `release-cleanup.py` 完成这件事，见 [交付模式](delivery-mode.md)。优先删除可重建产物而不是证据；减少证据之前要先问。
CLAIM|26|一致|.claude/rules/owner-standing-rules.md:42|删除 Andy Mac 上的文件只认他在 Mac 线程亲手打的字：`唯一的例外是删除 Andy 的 Mac 上的文件：只认他在 Mac 线程（通过 Remote Control 在他 MacBook 上运行的那个线程）里亲手打的字。`|- 唯一的例外是删除 Andy 的 Mac 上的文件：只认他在 Mac 线程（通过 Remote Control 在他 MacBook 上运行的那个线程）里亲手打的字。需要时，协调者在项目聊天里直接告诉他“去 Mac 线程打什么”和为什么，不说“在这里说也行”。
CLAIM|27|一致|scripts/disk-hygiene/prune-rebuildable.py:12|现有清理只认四种文件名|REBUILDABLE_FILES = ('*.bundle', 'node-modules.tar.gz', '*-abi[0-9]*-*.tar.gz', 'python-[0-9]*.tar.gz')
CLAIM|28|一致|scripts/disk-hygiene/prune-rebuildable.py:53|第 53 行跳过 `.ci-output/tools`|            if name == 'tools' and current.name == '.ci-output':
CLAIM|29|一致|scripts/disk-hygiene/install-schedule.sh:88|现有定时任务每天 04:00 跑|    echo '<key>StartCalendarInterval</key><dict><key>Hour</key><integer>4</integer><key>Minute</key><integer>0</integer></dict>'
CLAIM|30|不一致|clients/apple/scripts/ui-review.sh:7|截图脚本把截图和编译缓存都写在仓库目录里|out="$himawari_apple_cache/ui-review/latest"
CLAIM|31|不一致|clients/apple/scripts/ui-review.sh:6|`clients/apple/scripts/ui-review.sh:6`：`out="$root/ui-review/latest"`|mode="record"
CLAIM|32|不一致|clients/apple/scripts/ui-review.sh:11|第 11 行：`derived="$root/ui-review/DerivedData"`|expected_width=1170
CLAIM|33|不一致|clients/apple/scripts/mac-ui-review.sh:6|`clients/apple/scripts/mac-ui-review.sh:6`：`derived="$root/ui-review/DerivedData-mac"`|out="$himawari_apple_cache/ui-review/mac-latest"
CLAIM|34|一致|clients/apple/scripts/ui-review.sh:125@07181db904ac5cdb18fa9b801bcc774e100b100d|本 PR 之前，`--check` 的临时截图目录（`shots="$(mktemp -d)"`）没有删除它的语句|  shots="$(mktemp -d)"
CLAIM|35|一致|clients/apple/scripts/ui-review.sh:97|本 PR 改为检查通过就删，失败才留下并打印 `UI_REVIEW_CHECK_KEPT`|    if [ "$status" -eq 0 ]; then rm -rf "$shots"; else echo "UI_REVIEW_CHECK_KEPT $shots (screenshots from the failed check, left for diagnosis)" >&2; fi
CLAIM|36|一致|clients/apple/ui-review/.gitignore:2|`clients/apple/ui-review/.gitignore:2`：`latest/`|latest/
CLAIM|37|一致|clients/apple/ui-review/.gitignore:6|第 6 行：`mac-latest/`|mac-latest/
CLAIM|38|一致|.gitignore:16@07181db904ac5cdb18fa9b801bcc774e100b100d|本 PR 之前，根 `.gitignore` 没有忽略工作副本目录|/muse_prompt/
CLAIM|39|找不到|-|`git check-ignore .claude/worktrees/x .agents/local/worktrees/x` 无输出（2026-11-15 云端运行）|-|
CLAIM|40|一致|.gitignore:18|本 PR 在根 `.gitignore` 加了 `.claude/worktrees/`|.claude/worktrees/
CLAIM|41|一致|.gitignore:19|本 PR 在根 `.gitignore` 加了 `.agents/local/`|.agents/local/
CLAIM|42|一致|.gitignore:20|本 PR 在根 `.gitignore` 加了 `.cb-delegate/`|.cb-delegate/
CLAIM|43|找不到|-|云端线程能取 `refs/heads/` 以外的引用：`git fetch origin refs/pull/1/head` 成功（2026-11-15 云端运行）|-|
CLAIM|44|一致|scripts/delivery-mode/make-packet.py:678|`.ci-output/handoff/scripts` 里是上线工具在用的脚本|        self.ssh_wrapper = os.environ.get('HIMAWARI_HERMES_SSH', str(REPO / '.ci-output/handoff/scripts/hermes-ssh.sh'))
CLAIM|45|一致|.agents/opencode-models.py:131|`.ci-output/worktrees` 被模型目录工具使用|    base = root / ".ci-output" / "worktrees"
CLAIM|46|一致|scripts/disk-hygiene/install-schedule.sh:12|`scripts/disk-hygiene/install-schedule.sh:12`：`copy="$share/prune-rebuildable.py"`|copy="$share/prune-rebuildable.py"
CLAIM|47|一致|scripts/disk-hygiene/install-schedule.sh:64|第 64 行：`install -m 0644 "$here/prune-rebuildable.py" "$copy"`|install -m 0644 "$here/prune-rebuildable.py" "$copy"
CLAIM|48|一致|scripts/disk-hygiene/install-schedule.sh:64|定时任务跑的是脚本的副本，不是仓库里的脚本|install -m 0644 "$here/prune-rebuildable.py" "$copy"
CLAIM|49|一致|scripts/disk-hygiene/prune-rebuildable.py:16|现有“忙时跳过”的进程名单里没有 Xcode|BUSY_PATTERN = r'vitest|playwright|scripts/ci/(run|local|test|build|execute)\.mjs|npm (test|run (build|check|test))'
CLAIM|50|一致|clients/apple/scripts/ui-review.sh:8|快照基准 `clients/apple/Tests/Snapshots/` 照旧跟踪|snapshots="$root/Tests/Snapshots/iPhone-390"
CLAIM|51|一致|clients/apple/scripts/ui-review.sh:237|`ui-review.sh --check` 要拿它逐像素比较|  "$inspector" "$snapshots" "$shots"
CLAIM|52|一致|scripts/disk-hygiene/install-schedule.sh:88|仍由现有的每天 04:00 定时任务触发|    echo '<key>StartCalendarInterval</key><dict><key>Hour</key><integer>4</integer><key>Minute</key><integer>0</integer></dict>'
CLAIM|53|一致|scripts/delivery-mode/deploy.sh:105|`deploy.sh` 触发|  /usr/bin/python3 -I "$here/../disk-hygiene/prune-rebuildable.py" --apply --keep "$packet" "$(dirname "$(dirname "$packet")")" || echo "DEPLOY_PRUNE_FAILED: the deployment result is unchanged" >&2
CLAIM|54|一致|scripts/disk-hygiene/prune-rebuildable.py:109|整轮开始前沿用现有的“有构建或测试在跑就跳过”|    host_busy, container_ignored = busy_processes(options.busy_pattern, options.proc_root) if options.skip_if_busy else ([], [])
CLAIM|55|一致|scripts/delivery-mode/release-cleanup-remote.py:291|照服务器上 `release-cleanup.py` 删大证据文件的做法|                if stat.S_ISREG(info.st_mode) and info.st_size > plan['largeFileBytes'] and filename not in recent_copies and not in_use(filename):
CLAIM|56|找不到|-|main 上 5119 个提交的哈希全部改变|-|

未核实：Mac 本机磁盘统计（16G/0.5G/15G、worktree 明细、`.ci-output` 明细、DerivedData 3.0G、`dd-*` 37 个 31G）、云端 `git count-objects` 与 355 个远程分支数、`git fetch origin refs/pull/1/head` 的云端实测结果，以及 main 提交总数 5119 的准确口径；这些都是我无法从当前仓库文件和允许的 git 命令中直接读到的内容。
