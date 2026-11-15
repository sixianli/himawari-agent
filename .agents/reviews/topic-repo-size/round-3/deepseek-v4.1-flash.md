CLAIM|1|一致|.claude/rules/owner-global-instructions.md:61|不得改写已推送的历史。`.claude/rules/owner-global-instructions.md:61`：“绝不强制推送、改写已推送的历史或绕过钩子”。|绝不强制推送、改写已推送的历史或绕过钩子
CLAIM|2|一致|.agents/instructions/disk-space-hygiene.md:10|`.agents/instructions/disk-space-hygiene.md:10`：“清理是自动的（不要等 Mac 快满了才清理）”|清理是自动的（不要等 Mac 快满了才清理）
CLAIM|3|一致|.agents/instructions/disk-space-hygiene.md:10|“当一种新的可重建产物开始堆积时，把它的匹配模式加进脚本及其测试，而不是手工清理。”|当一种新的可重建产物开始堆积时，把它的匹配模式加进脚本及其测试，而不是手工清理。
CLAIM|4|一致|.agents/instructions/disk-space-hygiene.md:8|`.agents/instructions/disk-space-hygiene.md:8`：“始终保留测试报告、日志、状态回读、跟踪记录、截图、所有被引为证据的东西”|始终保留测试报告、日志、状态回读、跟踪记录、截图、所有被引为证据的东西
CLAIM|5|一致|.agents/instructions/disk-space-hygiene.md:8|“减少证据之前要先问。”|减少证据之前要先问。
CLAIM|6|一致|.claude/rules/owner-standing-rules.md:42|`.claude/rules/owner-standing-rules.md:42`：“唯一的例外是删除 Andy 的 Mac 上的文件：只认他在 Mac 线程（通过 Remote Control 在他 MacBook 上运行的那个线程）里亲手打的字。”|唯一的例外是删除 Andy 的 Mac 上的文件：只认他在 Mac 线程（通过 Remote Control 在他 MacBook 上运行的那个线程）里亲手打的字。
CLAIM|7|一致|scripts/disk-hygiene/prune-rebuildable.py:12|现有清理只认四种文件名。|REBUILDABLE_FILES = ('*.bundle', 'node-modules.tar.gz', '*-abi[0-9]*-*.tar.gz', 'python-[0-9]*.tar.gz')
CLAIM|8|一致|scripts/disk-hygiene/prune-rebuildable.py:53|第 53 行跳过 `.ci-output/tools`：`if name == 'tools' and current.name == '.ci-output':`|            if name == 'tools' and current.name == '.ci-output':
CLAIM|9|一致|scripts/disk-hygiene/install-schedule.sh:60|现有定时任务每天 04:00 跑。`scripts/disk-hygiene/install-schedule.sh:60`：`<key>Hour</key><integer>4</integer>`|<key>Hour</key><integer>4</integer>
CLAIM|10|一致|clients/apple/scripts/ui-review.sh:6|截图脚本把截图和编译缓存都写在仓库目录里。`clients/apple/scripts/ui-review.sh:6`：`out="$root/ui-review/latest"`|out="$root/ui-review/latest"
CLAIM|11|一致|clients/apple/scripts/ui-review.sh:11|第 11 行：`derived="$root/ui-review/DerivedData"`|derived="$root/ui-review/DerivedData"
CLAIM|12|一致|clients/apple/scripts/mac-ui-review.sh:6|`clients/apple/scripts/mac-ui-review.sh:6`：`derived="$root/ui-review/DerivedData-mac"`|derived="$root/ui-review/DerivedData-mac"
CLAIM|13|一致|clients/apple/scripts/ui-review.sh:125|`--check` 的临时截图目录不删。`clients/apple/scripts/ui-review.sh:125`：`shots="$(mktemp -d)"`，脚本里没有删除它的语句。|  shots="$(mktemp -d)"
CLAIM|14|一致|clients/apple/ui-review/.gitignore:2|截图目录已写进忽略清单。`clients/apple/ui-review/.gitignore:2`：`latest/`|latest/
CLAIM|15|一致|clients/apple/ui-review/.gitignore:6|第 6 行：`mac-latest/`|mac-latest/
CLAIM|16|一致|.gitignore:1|根 `.gitignore` 没有忽略工作副本目录：`git check-ignore .claude/worktrees/x .agents/local/worktrees/x` 无输出（2026-11-15 云端运行）。|node_modules/
CLAIM|17|找不到|-|云端线程能取 `refs/heads/` 以外的引用：`git fetch origin refs/pull/1/head` 成功（2026-11-15 云端运行）。|-
CLAIM|18|一致|scripts/delivery-mode/make-packet.py:678|`.ci-output/handoff/scripts` 里是上线工具在用的脚本。`scripts/delivery-mode/make-packet.py:678`：`self.ssh_wrapper = os.environ.get('HIMAWARI_HERMES_SSH', str(REPO / '.ci-output/handoff/scripts/hermes-ssh.sh'))`|        self.ssh_wrapper = os.environ.get('HIMAWARI_HERMES_SSH', str(REPO / '.ci-output/handoff/scripts/hermes-ssh.sh'))
CLAIM|19|一致|.agents/opencode-models.py:131|`.ci-output/worktrees` 被模型目录工具使用。`.agents/opencode-models.py:131`：`base = root / ".ci-output" / "worktrees"`|    base = root / ".ci-output" / "worktrees"
CLAIM|20|一致|scripts/disk-hygiene/install-schedule.sh:56|定时任务跑的是脚本的副本，不是仓库里的脚本。|    for argument in /usr/bin/python3 -I "$copy" --apply --skip-if-busy "${roots[@]}"; do
CLAIM|21|一致|scripts/disk-hygiene/install-schedule.sh:12|`scripts/disk-hygiene/install-schedule.sh:12`：`copy="$share/prune-rebuildable.py"`|copy="$share/prune-rebuildable.py"
CLAIM|22|一致|scripts/disk-hygiene/install-schedule.sh:44|第 44 行：`install -m 0644 "$here/prune-rebuildable.py" "$copy"`|install -m 0644 "$here/prune-rebuildable.py" "$copy"
CLAIM|23|一致|scripts/disk-hygiene/prune-rebuildable.py:16|现有“忙时跳过”的进程名单里没有 Xcode。`scripts/disk-hygiene/prune-rebuildable.py:16`：`BUSY_PATTERN = r'vitest｜playwright｜scripts/ci/(run｜local｜test｜build｜execute)\.mjs｜npm (test｜run (build｜check｜test))'`|BUSY_PATTERN = r'vitest|playwright|scripts/ci/(run|local|test|build|execute)\.mjs|npm (test|run (build|check|test))'
CLAIM|24|一致|clients/apple/scripts/ui-review.sh:7|快照基准 `clients/apple/Tests/Snapshots/` 照旧跟踪。|snapshots="$root/Tests/Snapshots/iPhone-390"
CLAIM|25|一致|clients/apple/scripts/ui-review.sh:217|`ui-review.sh --check` 要拿它逐像素比较。|  "$inspector" "$snapshots" "$shots"
CLAIM|26|一致|scripts/delivery-mode/deploy.sh:105|仍由现有的每天 04:00 定时任务和 `deploy.sh` 触发。|  /usr/bin/python3 -I "$here/../disk-hygiene/prune-rebuildable.py" --apply --keep "$packet" "$(dirname "$(dirname "$packet")")" || echo "DEPLOY_PRUNE_FAILED: the deployment result is unchanged" >&2
CLAIM|27|一致|scripts/disk-hygiene/prune-rebuildable.py:113|整轮开始前沿用现有的“有构建或测试在跑就跳过”。|        print('PRUNE_SKIPPED_BUSY: a build or test is running')
CLAIM|28|一致|scripts/delivery-mode/release-cleanup.py:11|照服务器上 `release-cleanup.py` 的做法：删超过 10 MiB 的证据文件。|LARGE_FILE_BYTES = 10 * 1024 ** 2
CLAIM|29|一致|scripts/delivery-mode/release-cleanup-remote.py:201|但保护在服务、回滚目标。|            keep(path, 'serving' if path == current['prefix'] else 'rollback-target')
CLAIM|30|一致|scripts/delivery-mode/release-cleanup-remote.py:291|保护在用的东西。|                if stat.S_ISREG(info.st_mode) and info.st_size > plan['largeFileBytes'] and filename not in recent_copies and not in_use(filename):

未核实：Mac 本机磁盘统计（16G/15G、40 个工作副本、`.ci-output` 5.1G、DerivedData 3.0G、`/tmp/dd-*` 31G、清理日志里的 857MB 等）、`git count-objects -vH` 的 340.64/394.40 MiB、355 个远程分支、153M 仅存于历史的内容等数字，以及 `git check-ignore` 的实际输出（只读到根 `.gitignore` 和 `.git/info/exclude` 里没有工作副本目录条目）和 `git fetch origin refs/pull/1/head` 的结果。另：`latest/` 和 `mac-latest/` 用 `git show HEAD:<路径>` 确认在 HEAD 中存在，但二进制截图无法按格式摘录原文；该时段 `git log` 显示 ui-review 相关提交 26 个（含合并提交），未逐条确认“约 20 个提交反复提交/移走截图”的精确计数。
