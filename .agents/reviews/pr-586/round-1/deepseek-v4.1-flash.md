### 1、高：非 releasesRoot 下的目标路径完全不检查数据库引用，会误删数据库引用的 operations/evidence/stage/资格目录

文件:行：`scripts/delivery-mode/release-cleanup-remote.py:96-119`（`database_releases`）、`scripts/delivery-mode/release-cleanup-remote.py:343`（`clear_target_paths` 用 `named_by_database`）

问题：`target_paths()` 返回五类路径（`newPrefix`、`newOperations`、`evidenceRoot`、stage、`newQualificationEvidenceRoot`），但 `named_by_database` 只由 `database_releases` 生成，而它只以 `plan['releasesRoot']` 为前缀匹配数据库内容。因此只有 `newPrefix` 可能被数据库保护；operations、evidence、stage、资格目录即使被数据库引用，`clear_target_paths` 也会照常归档小文件后删除。

证据（读代码证实）：
- `release-cleanup-remote.py:97`：`pattern = re.compile(re.escape(plan['releasesRoot']) + r'/([A-Za-z0-9._-]+)')`
- `release-cleanup-remote.py:109`：`rows = database.execute(query, [plan['releasesRoot'] + '/'] * len(values))...`
- `release-cleanup-remote.py:116`：`found.setdefault(plan['releasesRoot'] + '/' + match.group(1), table + '.' + column)`
- `release-cleanup-remote.py:343`：`reason = protected.get(path) or in_use(path) or ('named-by-database:' + named_by_database[path] if path in named_by_database else None)`

这直接违反约束“部署前清理不能误删……数据库引用的路径”，也与 ADR 0281 第 1 条“被进程或数据库引用……保留”不符。现有新测试 `test_a_release_named_by_the_database_stays_and_is_reported` 只覆盖 release 路径，覆盖不到这个缺口。

建议：把数据库引用扫描改为对所有目标路径做逐路径检索（例如对每个 target path 用 `instr` 扫描全部表列，或单独查 operations/evidence/qualification 根），并加一条“operations/资格目录被数据库引用时保留并报 `CLEANUP_TARGET_PATH_LEFT`”的反向用例。若数据库确实不会引用这些路径，也应把 ADR 的措辞改成只保证 releases。

### 2、中：成功部署后的收尾清理必然返回 3，deploy.sh 每次成功都会打印 DEPLOY_CLEANUP_FAILED

文件:行：`scripts/delivery-mode/deploy.sh:29`、`scripts/delivery-mode/release-cleanup.py:99`、`scripts/delivery-mode/release-cleanup-remote.py:330-346`

问题：部署成功后 `result passed` 会调用 `cleanup after 0`。此时 `serving(plan)` 读到的就是新版本，`plan['targetPaths']` 正是新版本自己的 `newPrefix/newOperations/evidenceRoot/stage/qualification`；`clear_target_paths` 把这些全部标为 `serving` 并放进 `targetPathsLeft`，于是 `report` 在 apply 模式下返回 3。`deploy.sh` 只在 `$1 == before` 时把 3 当成 target-paths-left，`$1 == after` 时落进 `DEPLOY_CLEANUP_FAILED` 分支，每次成功部署都会打印一条假的清理失败。

证据（读代码证实）：
- `deploy.sh:29`：`if [[ "$1" == passed ]]; then cleanup after 0; else cleanup after 1; fi`
- `release-cleanup.py:99`：`return TARGET_PATHS_LEFT_EXIT if result['mode'] == 'apply' and result.get('targetPathsLeft') else 0`
- `release-cleanup-remote.py:330`：`protected = {current['prefix']: 'serving', current['operations']: 'serving', ...}`
- `release-cleanup-remote.py:344-346`：`if reason: keep(path, reason); result['targetPathsLeft'].append(...)`

`test_target_paths_left_after_a_passed_deploy_do_not_change_its_result` 用的是假的 `release-cleanup.py`（`test_deploy.py:533`），只验证结果不被改写，没验证真实清理不会报失败。

建议：区分“before”和“after”的退出语义。例如 `report` 只在明确的前置清理模式返回 3，或让 `deploy.sh` 在 after 阶段把 3 视为正常（不打印 `DEPLOY_CLEANUP_FAILED`），并加一条用真实 `release-cleanup-remote.py` 模拟“plan==serving”的用例断言不打印假失败。

### 3、中：目标路径与允许父目录同源，允许列表校验基本恒真；`evidence_parent` 还是整个 `/var/lib/himawari`

文件:行：`scripts/delivery-mode/deploy-target-paths.py:11-19`、`scripts/delivery-mode/release-cleanup-remote.py:322`

问题：`targetPaths` 和 `targetParents` 都由同一个 `binding` 算出，`valid_target_path` 只要求“父目录在同一个 binding 推出的父目录集合里”，因此无法防住绑定本身写错或不可信的情况；测试只注入了从绑定里推不出来的额外路径。更重要的是，`allowed_parents` 把 `Path(paths['evidenceRoot']).parent` 当成“证据根”，而实际绑定里 `evidenceRoot` 是 `/var/lib/himawari/<label>-<date>-evidence`（`packet-template/inputs/bindings.draft.json:90`），其父目录是整个 `/var/lib/himawari`，包含 `state`、`secrets`、`jobs`、`qualification`。若 `evidenceRoot` 或目标路径被写成 `/var/lib/himawari/state` 之类，父目录校验会放行；新逻辑又会删除非空目录，只能靠 `in_use`/数据库（且数据库只覆盖 releasesRoot）兜底。

证据（读代码证实）：
- `deploy-target-paths.py:11`：`evidence_parent = Path(paths['evidenceRoot']).parent`
- `deploy-target-paths.py:12`：`parents = {Path(paths['newPrefix']).parent, Path(paths['newOperations']).parent, evidence_parent, evidence_parent / 'qualification'}`
- `release-cleanup-remote.py:322`：`return os.path.isabs(path) and os.path.normpath(path) == path and str(Path(path).parent) in parents and ...`

建议：允许父目录应是固定的、由 ADR 规定的最窄根（releases、operations、`/var/lib/himawari/qualification`、证据根本身的父目录应为独立的证据目录而不是 `/var/lib/himawari`、`/var/tmp`），并对目标路径本身加“不得等于任何允许根本身”的显式检查。测试应包含“绑定把 evidenceRoot 指到 state”这种反例，验证会被拒绝。

### 4、中：releases/operations 更早被直接删除，绕过 failed-attempts 归档，ADR“先留报告和日志再删除”对这两类不成立

文件:行：`scripts/delivery-mode/release-cleanup-remote.py:199-209`、`scripts/delivery-mode/release-cleanup-remote.py:262-263`、`scripts/delivery-mode/release-cleanup-remote.py:316`；`scripts/delivery-mode/test_release_cleanup.py:421-425`

问题：`clear_target_paths` 的“小文件先归档到 `failed-attempts` 再删”只有在目标路径没被更早的清理逻辑处理时才发生。但 `newPrefix` 在 releases 循环里直接 `remove(path, 'old-release')`，`newOperations` 在 `plan['currentOperations']` 分支里直接 `remove(..., 'failed-attempt-operations')`，都不归档。新测试特意在 `self.failed['operations']/run-01/s6-report.json` 放了报告文件，却只断言目标路径消失，没有断言该报告被归档。

证据（读代码证实）：
- `release-cleanup-remote.py:208-209`：`else: remove(path, 'old-release')`
- `release-cleanup-remote.py:262-263`：`if os.path.isdir(plan['currentOperations']) ...: remove(plan['currentOperations'], 'failed-attempt-operations')`
- `release-cleanup-remote.py:329`：`handled = {item['path'] for item in result['deleted']} | ...`，随后 `:338` 跳过这些路径
- `test_release_cleanup.py:421-424`：只写 `operations/run-01/s6-report.json`，断言 `targets` 全部不存在，没有检查 `failed-attempts` 下的该报告

建议：把 failed-attempts 归档提前到所有目标路径删除之前，或在 releases/operations 分支删除前也调用 `archive_small_files`；测试补上“operations 里的报告被归档”的断言，否则 ADR 的“留报告和日志”只是部分实现。

### 5、中低：缓存目录的 I/O 错误不会退回整包传输，反而让整个传输失败

文件:行：`scripts/delivery-mode/packet-template/steps/transport-packet.py:215-222`、`scripts/delivery-mode/packet-template/steps/transport-packet.py:65-74`

问题：`receive_archive` 只捕获 `cache_directories` 抛出的 `RuntimeError`。`cache_directories` 里的 `directory.mkdir`、`os.chown`、`os.lstat` 以及 `os.open(cache/'lock', ...)` 都可能抛 `OSError`/`PermissionError`（例如 /opt 满、只读、权限异常）。这些异常不会走“缓存不可用就整包传”的分支，而是直接冒到 `production_main`，把本来可以成功的整包传输判失败。ADR 0283/0281 写的是“缓存目录不安全或查询失败时，整包传输照常进行”。

证据（读代码证实）：
- `transport-packet.py:215-218`：`try: entries = cache_directories(...) except RuntimeError as error: require(not spec['fill'], str(error)) ...`
- `transport-packet.py:222`：`lock = os.open(cache / 'lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)`（不在缓存回退的捕获范围内）
- `transport-packet.py:68-73`：`directory.mkdir(...)`、`os.chown(...)` 等未包在 RuntimeError 里

建议：把缓存初始化/加锁的异常类型扩大到 `OSError`（或先在安全目录里 try 整个缓存路径，失败就 `require(not spec['fill'], ...)` 并走全量），并加“缓存父目录只读/创建锁失败时整包传输仍成功”的用例。注意如果 `spec['fill']` 非空，安全失败是合理的，但错误码应明确、且不应把可全量的场景误判失败。

### 6、低：缓存坏条目的自愈不完整：已存在但不可用的条目不会被替换，目录条目删不掉

文件:行：`scripts/delivery-mode/packet-template/steps/transport-packet.py:124-127`、`scripts/delivery-mode/packet-template/steps/transport-packet.py:100-105`

问题：`store_in_cache` 对已存在的 `final` 只做 `os.utime(..., follow_symlinks=False)` 就跳过，不校验也不替换。若缓存里有一个查询不会报告为命中的条目（例如权限不对、属主不对、硬链接数不为 1），本次全量传完后它仍然保留，于是该 SHA 永远不命中、每次都要全量传，缓存也永远不修复。另一方面，`fill_from_cache` 对“非普通文件”直接 `os.unlink(source)`；如果那是目录，`unlink` 抛 `IsADirectoryError`（不是 RuntimeError），既不会删掉坏条目，也会让失败码变成类型名而非 `CACHE_ENTRY_INVALID`。

证据（读代码证实）：
- `transport-packet.py:125-127`：`if os.path.lexists(final): os.utime(final, follow_symlinks=False); continue`
- `transport-packet.py:103-105`：`if not (stat.S_ISREG(...) ...): os.unlink(source); raise RuntimeError(...)`

建议：`store_in_cache` 在 `lexists(final)` 时用 `lstat` 校验普通文件、属主、nlink、权限、大小，不符合就 `os.unlink`/`os.replace` 修复；`fill_from_cache` 对非普通文件用 `os.unlink` 前判断类型，目录条目可先 `shutil.rmtree` 或明确保留并报 `CACHE_ENTRY_INVALID`。补一条“坏权限/坏目录条目不阻塞后续缓存命中”的测试。

### 7、低：关键接线没有自动测试：`cache_settings` 从未被执行，verify-steps 的 fixture 包也没有 packet-parameters.json

文件:行：`scripts/delivery-mode/packet-template/steps/run-local-step.py:53-60`、`scripts/delivery-mode/packet-template/steps/verify-steps.py:74-93`、`scripts/delivery-mode/packet-template/steps/verify-steps.py:331-343`

问题：`MATERIAL_CACHE_JSON` 的产生端有 `test_make_packet.py:616-622`，消费端 `run-local-step.cache_settings` 却没有任何测试调用；`verify-steps` 的 `build_packet` 没有生成 `packet-parameters.json`，`local_side_skips_cached_members` 也是直接调用 `stream_packet`/`remote_command` 并手写 spec，绕过了 `cache_settings` 和 `main`。因此键名拼错、JSON 双层编码写错、参数缺失等“接线错误”不会被任何自动检查发现，只会在第一次真实上线时暴露。这正属于 I-73 的教训（一个值只在一端被验证）。

证据（读代码证实）：
- `run-local-step.py:56`：`settings = json.loads(json.loads(common.read(packet / 'packet-parameters.json', os.getuid())).get('MATERIAL_CACHE_JSON', 'null'))`，仅在 `:128` 被调用
- `verify-steps.py:74-93` 的 `build_packet` 只建 `steps/install/materials/inputs`，没有 `packet-parameters.json`
- `verify-steps.py:332-342` 直接从临时包加载 `run-local-step.py` 后调用 `stream_packet`/`remote_command`，没有走 `main`/`cache_settings`

建议：在 `verify-steps` 的 fixture 里写一个带 `MATERIAL_CACHE_JSON` 的 `packet-parameters.json`，并加一条经 `run-local-step.main`（或 `cache_settings`）的用例，断言包参数非空时远端命令带 cache spec、为 null/缺失时不带；同时在 `test_make_packet.py` 里断言真实 `build_packet` 生成的 `packet-parameters.json` 含该键。另加“数据库引用 operations/资格目录”和“成功后不打印假清理失败”的反向用例（见第 1、2 条）。

### 8、低：计划文档与最终代码多处不一致

文件:行：`.agents/plans/deploy-speed.md:26`、`.agents/plans/deploy-speed.md:49`、`.agents/plans/deploy-speed.md:51`、`.agents/plans/deploy-speed.md:52`；`scripts/delivery-mode/packet-template/steps/README.md:91`

问题（读代码证实的文档与实现差异）：
- 计划第 26 行说“在 `target_paths()` 现有路径之外补上真正的上传目录”，但 `deploy-target-paths.py` 仍只有 `Path(paths['transportRoot']).parent`，没有加入 `common.UPLOAD`。
- 计划第 49 行说“在 tar 流开头发一份清单”，实现是通过 SSH 命令最后一个 base64 参数传递（`run-local-step.py:90-91`）。
- 计划第 51 行写 `materialCacheMinBytes`，实现是实例文件的 `materialCache.{minBytes,maxBytes}`（`make-packet.py:440-446`、`instances/andy-production.json:32-35`）。
- 计划第 52 行说“缓存占用算进预检的空间检查”，实现没有把 `/opt/himawari/material-cache` 计入 `deploy-preflight.py` 的 `space()`/`ROOT_FREE_FOR_ACCEPTANCE`；缓存上限 1 GiB 与预检只留的 1 GiB 储备同量，缓存增长后安装阶段可能吃掉全部预留。
- `steps/README.md:91` 仍只列出旧的 verify-steps 覆盖项，没有提这次新增的缓存用例（新的缓存说明在第 48 行）。

建议：把计划文档更新为最终实现（或标注哪些条目未采纳），并补上 README 第 91 行的缓存检查；空间预算要么把缓存占用计入预检，要么把 `maxBytes` 调到明显小于保留空间并写明理由。

## 侧重检查

我按“错误路径、不合规范或不可信的输入、安全、资源耗尽、不可撤销操作、规则/文档/代码一致性”逐项查过：

- 错误路径：`clear_target_paths` 的非绝对路径、`..`、根路径、非目录、符号链接、父目录不在允许列表（`release-cleanup-remote.py:321-350`，测试 `test_paths_outside_the_allowed_parents_are_refused`）；缓存查询超时/失败（`run-local-step.py:69-75` 返回空 → 全量）；缓存目录不安全（`transport-packet.py:215-221`）；坏缓存条目（`fill_from_cache`/`store_in_cache`）。发现第 1、2、5、6 条问题。
- 不可信输入：绑定里的路径、目标路径、`MATERIAL_CACHE_JSON`、base64 cache spec。`cache_spec` 对键、类型、`safe_relative`、去重都有校验（`transport-packet.py:56-62`），`receive_members` 还要求 fill 名字必须在冻结清单里（`:189`）；但目标路径允许列表与绑定同源（第 3 条），数据库保护只覆盖 releasesRoot（第 1 条）。
- 安全：缓存目录/文件用 0700/0600、`O_NOFOLLOW`、`lstat` 后 `fstat` 身份复核（`transport-packet.py:65-74`、`:100-108`）；写缓存先临时文件再 `os.replace`（`:128-137`）；归档只复制普通文件、不跟随符号链接（`release-cleanup-remote.py:129-146`）。未发现明显的路径穿越或 symlink 跟随；主要弱点是允许父目录过宽/同源（第 3 条）。
- 资源耗尽：缓存 `maxBytes` 只修剪“本次没用到”的条目，当前包大成员本身超过上限时不会删（`transport-packet.py:147-154`），缓存可能超过配置上限；失败现场先归档再修剪，峰值不受 `failedAttemptBytes` 限制；缓存占用未进入预检空间预算（第 8 条）。磁盘满时缓存目录创建可能让整包传输失败（第 5 条）。
- 不可撤销操作：`clear_target_paths` 对目标路径先归档小文件再 `remove`，但 releases/operations 更早被直接删除，绕过了归档（第 4 条）；最终删除不可恢复，ADJ 依赖“只有可重建内容会被删”，而允许父目录过宽让这个前提变弱（第 3 条）。
- 规则/文档一致性：ADR 0281 的共享清单、缓存复制、坏条目删除大体与代码一致；但计划文档多处与最终实现不符（第 8 条），`README` 的 verify-steps 覆盖说明未更新（第 8 条），ADR“数据库引用保留”对非 release 目标路径不成立（第 1 条），ADR“操作目录留报告日志”对 releases/operations 不成立（第 4 条）。
- 未核实：生产数据库是否真的引用 operations/evidence/资格目录；`verify-steps.py` 是否真在 Hermes 上以非 root 全过、是否正好 73 条；`npm run check` 是否通过；`acceptance/OWNED-SHA256SUMS` 的新哈希是否与文件实际一致；生产 `/opt`、`/var/tmp`、`/var/lib` 是否同一文件系统；带缓存的上传实测耗时。以上均未运行测试或访问生产，只做了代码阅读。

## 必答问题

**1. 这个改动会不会改变模型已经见过的请求开头？**
不会。本次 diff 只涉及部署脚本、实例文件、依赖收集脚本、文档/复核记录，没有触碰系统提示、工具定义、历史消息或出口遮盖（`git diff --name-status` 的改动文件里没有 `apps/`、`packages/` 或提示词/适配器代码）。发给模型的内容仍由原有链路决定，本改动不改变“只在末尾追加”的规则，也不在每条请求里插入时间等变化值。依据规则：`.agents/instructions/prompt-prefix.md#rules`（本次改动与该规则无关）。

**2. 这个改动会不会让同一段文字在不同请求里变成不同的字节？**
对模型请求：不会（本改动不产生模型请求内容）。对部署产物：依赖收集脚本现在按 `readdirSync(root).sort()` 遍历、跳过 `.vite/.vite-temp/.cache`、用 `tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner --hard-dereference` 打包（`collect-installer-dependencies.mjs:79-98`），`test_collect_dependencies.py` 用两次运行比较 tar 摘要，能证明同一环境下字节相同。缓存以成员内容的 SHA-256 为键（`transport-packet.py:98`、`:124`），相同内容映射到同一文件名；新增的 `stamp`、缓存 mtime/LRU、`cacheFilled` 都是部署/日志值，不进入模型请求。一个既有的小风险是 `entries.sort((a,b)=>a.path.localeCompare(b.path))` 依赖 locale（`collect-installer-dependencies.mjs:94`），但这是改动前就有的，且测试只承诺“同一环境打两次”；跨环境未核实。

**3. 改动有没有对应的自动检查，反向用例是否真的会失败？**
有，且多数反向用例有效：
- `test_collect_dependencies.py`：未知顶层条目 `P5_MODULE_UNEXPECTED_ENTRY`、两次打包摘要相同；去掉“跳过工具缓存”或“未知条目报错”后用例会失败。
- `test_release_cleanup.py`：`TargetPathClearingTest` 覆盖清理后预检路径全不存在、服务中路径/资格目录保留、进程引用保留、数据库引用（仅 release）保留、符号链接保留、越界路径拒绝、失败现场按份数和字节修剪；去掉 `clear_target_paths` 后相关用例会失败。
- `test_deploy.py`：前置清理返回 3 时在预检前以 `target-paths-left` 退出；其他清理失败继续；成功后的 3 不改结果。去掉 `deploy.sh` 的新分支后会失败。
- `test_make_packet.py`：`material_cache` 的合法/非法值。
- `verify-steps.py`：缓存存储、缓存填充、缺失未声明、声明又流式、声明未冻结、坏条目删除、符号链接条目、缓存 miss、修剪、目录不安全、cache spec 校验、本地跳过成员等用例；去掉对应逻辑会成为 RuntimeError/断言失败。但该文件只在 Hermes 上以非 root 运行（`verify-steps.py:16-20`），未在本环境执行，73 条之数未核实。
缺口：`run-local-step.cache_settings` 的接线没有测试（第 7 条）；非 release 目标路径的数据库引用没有测试（第 1 条）；成功后真实清理不打印假失败没有测试（第 2 条）。因此“反向用例都会失败”只对已覆盖的行为成立。

**4. 每个值产生处和使用处的校验是否互相匹配？**
逐项核对（读代码证实）：
- `MATERIAL_CACHE_JSON`：产生于 `make-packet.material_cache`（`make-packet.py:440-446`，要求恰好 `{minBytes,maxBytes}`、正整数、`minBytes<=maxBytes`，排序紧凑序列化）；使用于 `run-local-step.cache_settings`（`run-local-step.py:53-60`，要求恰好两键、正整数），消费者没再校验 `min<=max`，但生产者已保证。缺一层“真实包参数被消费”的测试（第 7 条）。
- cache spec `{fill,minBytes,maxBytes}`：产生于 `run-local-step.main`（`run-local-step.py:129-130`，base64 后作为命令最后参数）；消费于 `transport-packet.cache_spec`（`transport-packet.py:56-62`，校验键集合、fill 为唯一 `safe_relative`、min/max 为正整数），随后 `receive_members` 要求 fill 名字在冻结清单中（`:189`）。两端匹配。
- `targetPaths` / `targetParents`：产生于 `deploy-target-paths.py`，使用于 `deploy-preflight.py`（只用 `targetPaths`）和 `release-cleanup-remote.clear_target_paths`（两者都用）。两端都从同一个 binding 派生，因此允许列表不能独立约束绑定（第 3 条）。
- `TARGET_PATHS_LEFT_EXIT=3`：产生于 `release-cleanup.report`（`release-cleanup.py:99`）；消费于 `deploy.sh:18`（只在 `before` 时作为停止信号）。`after` 也会收到 3 但不改写结果，仅打印假失败（第 2 条）。
- `targetPathsLeft` 的 `{path,reason}`：产生于 `clear_target_paths`（`:346`），消费于 `release-cleanup.report`（`:96-97`）打印；两端字段一致。
- `keepFailedAttempts` / `failedAttemptBytes`：产生于 `cleanup_plan` 常量（`release-cleanup.py:19-20`、`:62-63`），消费于 `clear_target_paths`（`:353-356`）；一致。
- 本地回执 `cacheFilled`：产生于 `run-local-step.py:159`，接收端报告 `cacheFilled` 产生于 `transport-packet.py:226`；目前没有下游严格 schema 消费者（只用于记录/测试），未发现不匹配。

## 结论

改动的主线设计是合理的：预检与清理共用一份目标路径清单；缓存只在显式声明缺席时使用，且接收端仍做大小+SHA 复核和 `verify_frozen(exact=True)`；旧实例没有 `materialCache` 时传输命令与旧版一致；依赖收集脚本只收锁文件条目并跳过已知工具缓存，测试也验证了可复现性。但上线前建议先处理第 1、2 条：数据库引用保护只覆盖 releases 会让新删除逻辑在非 release 路径上失去约束，而成功部署后必然打印 `DEPLOY_CLEANUP_FAILED` 会制造持续的假告警。第 3、4 条属于安全的纵深和证据保留，应在下一次真实上线前补测试或收窄允许范围。第 5、6 条是缓存错误路径的可用性/自愈问题，建议一并修。未核实项已在上文标明。
