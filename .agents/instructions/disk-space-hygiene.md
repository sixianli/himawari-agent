<a id="disk-space-hygiene"></a>
# 磁盘空间整洁

开发用的 Mac 磁盘空间很紧张，生产机的磁盘留给生产使用。边界如下：

- 在完整构建、完整的 `npm test`、产品路径资格验证或上线之前，用 `df -h` 检查空闲空间；低于该步骤所需时要报告。
- 用过可重建产物的那次验证一经记录，就立即删除这些产物（在 Mac 上：`.ci-output/` 下的 `build-macos-arm64/` 和 `public-build-macos-arm64/` 打包目录及 tar 包、已结束的 `/tmp/hma-pp-*` 安装、临时检出和 `node_modules` 副本）。删除之前，先确认没有东西还在使用该路径，并在仓库和 `.ci-output/` 里搜索它；凡是被文档、交接文件、证据 README 或测试报告点名为保留证据、或作为某个未解决失败唯一记录的东西，都要保留。一份报告记录了某个可重建包的路径和 SHA-256，并不会让这个包变成证据。只删除当前任务或之前某次测试运行创建的东西，绝不删除用户自己的文件。
- 始终保留测试报告、日志、状态回读、跟踪记录、截图、所有被引为证据的东西、备份、恢复点（在生产机上指当前在服务版本的恢复点），以及生产机上当前在服务的版本和它的上一个版本。每次测试和每次发布结束时都要清理其临时产物，包括失败的尝试，并且由脚本完成而不是手工完成，也绝不能只是给它们改名了事；在生产机上，`deploy.sh` 用 `release-cleanup.py` 完成这件事，见 [交付模式](delivery-mode.md)。优先删除可重建产物而不是证据；减少证据之前要先问。
- 有意识地挑选要保留的失败证据，绝不整目录打包（见 [关于证据过于臃肿的教训](../../docs/lessons.md#bulky-evidence)）。
- 清理是自动的（不要等 Mac 快满了才清理）。`scripts/disk-hygiene/prune-rebuildable.py` 只删除可重建文件（`*.bundle`、`node-modules.tar.gz`、`*-abi<N>-*.tar.gz` 包、`python-<version>.tar.gz`）和 `doc-check/` 下的旧临时仓库副本；它绝不删除日志、报告、证据、脚本、`.ci-output/tools/`、最近 24 小时内改动过的文件，以及任何 `production/` 目录下最新的两个带日期的上线包。`deploy.sh` 在 `DEPLOY_PASSED` 之后对 `.ci-output` 以 `--apply` 运行它。`scripts/disk-hygiene/install-schedule.sh mac <root>...` 在 Mac 上用 launchd（macOS 的定时任务）安装每天 04:00 的定时运行，在有构建或测试正在运行时跳过这一轮；`remove-mac` 撤销安装。不带 `--apply` 运行它可以查看它会删除什么。当一种新的可重建产物开始堆积时，把它的匹配模式加进脚本及其测试，而不是手工清理。
- 开发机上的 Xcode 编译缓存、git 工作副本和旧上线包里的大文件，由 `scripts/disk-hygiene/prune-local.py` 按 `scripts/disk-hygiene/retention.json` 里可改的期限回收（[ADR 0276](../../docs/adr/0276-generated-files-stay-out-of-git-and-local-artifacts-expire.md)）：超过期限没用过、没被锁住的 Xcode 缓存（`~/Library/Caches/himawari/DerivedData/*`、遗留的 `$TMPDIR/dd-*` 和仓库里的 `clients/apple/ui-review/DerivedData*`）；分支提交都已在 `origin/main`、没有改动和未跟踪文件、被忽略的只有 `node_modules` 这类可重建目录、没加锁、没有进程在里面、超过期限没动过、不在保留清单里的工作副本（用 `git worktree remove`，不加 `--force`）；最新几个之外、也不是最近两次上线成功（`run-logs/deploy-*.log` 里有 `DEPLOY_RESULT {"result":"passed"`）的上线包里，大于上限、又不是日志和报告的文件。不满足条件的只打印 `KEEP <种类> <原因> <路径>`，不删。`install-schedule.sh mac --repo <仓库> <根>...` 把它和配置一起装成每天 04:10 的定时任务，先只报告；Andy 在 Mac 线程看过预演清单、亲手同意后，才加 `--apply-local` 重装成真删。Xcode 编译一律走 `clients/apple/scripts/xcode-build.sh`，不要自己建 `dd-*` 目录。
- 任务结束时，报告删除了哪些路径、释放了多少空间，以及哪些大的产物是有意保留的、为什么保留。
