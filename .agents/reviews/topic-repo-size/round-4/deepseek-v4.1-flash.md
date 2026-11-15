CLAIM|1|一致|.claude/rules/owner-global-instructions.md:61|不得改写已推送的历史。`.claude/rules/owner-global-instructions.md:61`：“绝不强制推送、改写已推送的历史或绕过钩子”。|- 每个提交创建后立即推送到 `origin` 上的同名分支，第一次推送时设置上游；绝不强制推送、改写已推送的历史或绕过钩子，推送被拒绝时停下并报告。除非明确要求，不得创建分支或标签、开 PR 或合并。项目自己的推送规则优先。
CLAIM|2|一致|.agents/instructions/disk-space-hygiene.md:10|清理要自动、由脚本做；新的可重建产物要加进脚本和测试。`.agents/instructions/disk-space-hygiene.md:10`：“清理是自动的（不要等 Mac 快满了才清理）”|清理是自动的（不要等 Mac 快满了才清理）。
CLAIM|3|一致|.agents/instructions/disk-space-hygiene.md:10|“当一种新的可重建产物开始堆积时，把它的匹配模式加进脚本及其测试，而不是手工清理。”|当一种新的可重建产物开始堆积时，把它的匹配模式加进脚本及其测试，而不是手工清理。
CLAIM|4|一致|.agents/instructions/disk-space-hygiene.md:8|证据要保留，减少证据先问。`.agents/instructions/disk-space-hygiene.md:8`：“始终保留测试报告、日志、状态回读、跟踪记录、截图、所有被引为证据的东西”|始终保留测试报告、日志、状态回读、跟踪记录、截图、所有被引为证据的东西
CLAIM|5|一致|.agents/instructions/disk-space-hygiene.md:8|“减少证据之前要先问。”|优先删除可重建产物而不是证据；减少证据之前要先问。
CLAIM|6|一致|.claude/rules/owner-standing-rules.md:42|删除 Andy Mac 上的文件只认他在 Mac 线程亲手打的字。`.claude/rules/owner-standing-rules.md:42`：“唯一的例外是删除 Andy 的 Mac 上的文件：只认他在 Mac 线程（通过 Remote Control 在他 MacBook 上运行的那个线程）里亲手打的字。”|- 唯一的例外是删除 Andy 的 Mac 上的文件：只认他在 Mac 线程（通过 Remote Control 在他 MacBook 上运行的那个线程）里亲手打的字。
CLAIM|7|一致|scripts/disk-hygiene/prune-rebuildable.py:12|现有清理只认四种文件名。`scripts/disk-hygiene/prune-rebuildable.py:12`：`REBUILDABLE_FILES = ('*.bundle', 'node-modules.tar.gz', '*-abi[0-9]*-*.tar.gz', 'python-[0-9]*.tar.gz')`|REBUILDABLE_FILES = ('*.bundle', 'node-modules.tar.gz', '*-abi[0-9]*-*.tar.gz', 'python-[0-9]*.tar.gz')
CLAIM|8|一致|scripts/disk-hygiene/prune-rebuildable.py:53|第 53 行跳过 `.ci-output/tools`：`if name == 'tools' and current.name == '.ci-output':`|            if name == 'tools' and current.name == '.ci-output':
CLAIM|9|一致|scripts/disk-hygiene/install-schedule.sh:88|现有定时任务每天 04:00 跑。`scripts/disk-hygiene/install-schedule.sh:60`：`<key>Hour</key><integer>4</integer>`|    echo '<key>StartCalendarInterval</key><dict><key>Hour</key><integer>4</integer><key>Minute</key><integer>0</integer></dict>'
CLAIM|10|一致|clients/apple/scripts/ui-review.sh:6@07181db904ac5cdb18fa9b801bcc774e100b100d|截图脚本把截图和编译缓存都写在仓库目录里。`clients/apple/scripts/ui-review.sh:6`：`out="$root/ui-review/latest"`|out="$root/ui-review/latest"
CLAIM|11|一致|clients/apple/scripts/ui-review.sh:11@07181db904ac5cdb18fa9b801bcc774e100b100d|第 11 行：`derived="$root/ui-review/DerivedData"`|derived="$root/ui-review/DerivedData"
CLAIM|12|一致|clients/apple/scripts/mac-ui-review.sh:6@07181db904ac5cdb18fa9b801bcc774e100b100d|`clients/apple/scripts/mac-ui-review.sh:6`：`derived="$root/ui-review/DerivedData-mac"`|derived="$root/ui-review/DerivedData-mac"
CLAIM|13|不一致|clients/apple/scripts/ui-review.sh:97|`--check` 的临时截图目录不删。`clients/apple/scripts/ui-review.sh:125`：`shots="$(mktemp -d)"`，脚本里没有删除它的语句。|    if [ "$status" -eq 0 ]; then rm -rf "$shots"; else echo "UI_REVIEW_CHECK_KEPT $shots (screenshots from the failed check, left for diagnosis)" >&2; fi
CLAIM|14|一致|clients/apple/ui-review/.gitignore:2|`clients/apple/ui-review/.gitignore:2`：`latest/`|latest/
CLAIM|15|一致|clients/apple/ui-review/.gitignore:6|第 6 行：`mac-latest/`|mac-latest/
CLAIM|16|不一致|.gitignore:18|根 `.gitignore` 没有忽略工作副本目录：`git check-ignore .claude/worktrees/x .agents/local/worktrees/x` 无输出（2026-11-15 云端运行）。|.claude/worktrees/
CLAIM|17|找不到|-|云端线程能取 `refs/heads/` 以外的引用：`git fetch origin refs/pull/1/head` 成功（2026-11-15 云端运行）。|-
CLAIM|18|一致|scripts/delivery-mode/make-packet.py:678|`.ci-output/handoff/scripts` 里是上线工具在用的脚本。`scripts/delivery-mode/make-packet.py:678`：`self.ssh_wrapper = os.environ.get('HIMAWARI_HERMES_SSH', str(REPO / '.ci-output/handoff/scripts/hermes-ssh.sh'))`|        self.ssh_wrapper = os.environ.get('HIMAWARI_HERMES_SSH', str(REPO / '.ci-output/handoff/scripts/hermes-ssh.sh'))
CLAIM|19|一致|.agents/opencode-models.py:131|`.ci-output/worktrees` 被模型目录工具使用。`.agents/opencode-models.py:131`：`base = root / ".ci-output" / "worktrees"`|    base = root / ".ci-output" / "worktrees"
CLAIM|20|一致|scripts/disk-hygiene/install-schedule.sh:12|定时任务跑的是脚本的副本，不是仓库里的脚本。`scripts/disk-hygiene/install-schedule.sh:12`：`copy="$share/prune-rebuildable.py"`|copy="$share/prune-rebuildable.py"
CLAIM|21|一致|scripts/disk-hygiene/install-schedule.sh:64|第 44 行：`install -m 0644 "$here/prune-rebuildable.py" "$copy"`|install -m 0644 "$here/prune-rebuildable.py" "$copy"
CLAIM|22|一致|scripts/disk-hygiene/prune-rebuildable.py:16|现有“忙时跳过”的进程名单里没有 Xcode。`scripts/disk-hygiene/prune-rebuildable.py:16`：`BUSY_PATTERN = r'vitest｜playwright｜scripts/ci/(run｜local｜test｜build｜execute)\.mjs｜npm (test｜run (build｜check｜test))'`|BUSY_PATTERN = r'vitest|playwright|scripts/ci/(run|local|test|build|execute)\.mjs|npm (test|run (build|check|test))'
CLAIM|23|一致|clients/apple/scripts/ui-review.sh:8|快照基准 `clients/apple/Tests/Snapshots/` 照旧跟踪|snapshots="$root/Tests/Snapshots/iPhone-390"
CLAIM|24|一致|clients/apple/scripts/ui-review.sh:237|`ui-review.sh --check` 要拿它逐像素比较。|  "$inspector" "$snapshots" "$shots"
CLAIM|25|一致|scripts/disk-hygiene/prune-rebuildable.py:113|整轮开始前沿用现有的“有构建或测试在跑就跳过”|        print('PRUNE_SKIPPED_BUSY: a build or test is running')
CLAIM|26|一致|scripts/delivery-mode/release-cleanup-remote.py:291|照服务器上 `release-cleanup.py` 删大证据文件的做法|                if stat.S_ISREG(info.st_mode) and info.st_size > plan['largeFileBytes'] and filename not in recent_copies and not in_use(filename):
CLAIM|27|找不到|-|截图目录 `clients/apple/ui-review/latest/` 写在了 `.gitignore` 里，却被强制提交在跟踪中。|-

未核实：仓库与本机体积/数量类数字（16G、0.5G、pack 340.64 MiB、355 个远程分支、309M/131M/74M/36M/153M、40 个工作副本及各目录容量、`.ci-output` 5.1G 及其子项、DerivedData 3.0G、`dd-*` 最多 37 个 31G、约 20 个提交、5119 个提交等）无法用允许的只读工具核对；第 11 条的联网 `git fetch` 也只能标为找不到，被强制跟踪的旧截图是二进制且已在本提交取消跟踪，未能逐字摘录。
