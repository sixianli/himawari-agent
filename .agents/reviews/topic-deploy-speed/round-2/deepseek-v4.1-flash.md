## 结论摘要

方向是对的：用内容寻址缓存避免重复传输，符合 OCI 分发规范里“层已存在就不必上传”的做法（“the registry indicates that its not necessary because the layer is already known”，https://github.com/opencontainers/distribution-spec/blob/main/spec.md ），也符合 Nix 先问目标机缺什么再传的做法（“It doesn’t copy store objects that are already present on the other machine.”，https://nix.dev/manual/nix/2.26/command-ref/nix-copy-closure ）。但方案在两个关键点上会“看起来做了、实际没做或做错”：2a 改的不是真正出包的 collector；2b 改了 S1 传输契约却没有同步文档和现有硬门槛。第 1 部分则把 I-33 已经证明会耗尽磁盘的“改名不删、保留整份失败现场”重新引了回来。

---

## 证实的（按严重度）

### 高 1：2a 改错了 collector，实际出包仍会带上 `.vite`

**问题**：方案前提 10 和 2a 引用 `packet-template/install/collect-installer-dependencies.mjs:88`，但真正用来生成 `node-modules.tar.gz` 的是 `packet-template/acceptance/helpers/collect-installer-dependencies.mjs`。只改 install 副本，构建完全不受影响。

**证据**：
- `scripts/delivery-mode/make-packet.py:784`：把 `TEMPLATE / 'acceptance/helpers/collect-installer-dependencies.mjs'` 上传为 Hermes 上的 `collect-installer-dependencies.mjs`。
- `scripts/delivery-mode/hermes/build-candidate.sh:66,70` 执行 `$(helper installerDependencyCollector)`；`hermes/builder.json:13` 指向 `collect-installer-dependencies.mjs`，即上面上传的那份。
- 两份当前同哈希：`fixtures/twelfth-frozen-sha256.json:62,81`；但 `make-packet.py` 从不把 `install/collect-installer-dependencies.mjs` 上传给构建机。

**建议**：以 `acceptance/helpers/collect-installer-dependencies.mjs` 为源，修改后同步 `install/` 副本及 `OWNED-SHA256SUMS`/fixture；加一条测试断言两份字节相同，避免再次改错。

### 高 2：整路径 `os.rename` 前没有校验绑定路径的根，root 脚本可能移动任意目录

**问题**：方案要把 `target_paths(binding)` 的每条路径整条改名，但现有远端清理只校验了资格目录，其他 plan 路径直接使用。一个错误或恶意的 `bindings.json` 可以让 root 清理脚本把 `/opt`、`/var/lib` 甚至更上层目录移走。

**证据**：
- `scripts/delivery-mode/release-cleanup.py:20-48` 直接把 `newPrefix`、`newOperations`、`evidenceRoot`、`transportRoot` 写进 plan。
- `scripts/delivery-mode/release-cleanup-remote.py:248-250` 只对 `qualificationTarget` 检查“父目录必须是 qualification 根”，其余路径没有同类检查。
- `scripts/delivery-mode/deploy-preflight.py:99-101` 直接从 bindings 取值。

**建议**：在共享的 owned-paths 函数和远端 plan 两头都校验：绝对路径、规范化、父目录正好是 `releasesRoot`/`operationsRoot`/`evidenceParent`/`tmpRoot`/`qualificationRoot`，不得是允许根本身，不得是失败目录本身。补 `/`、`..`、`/opt`、符号链接等拒绝用例。

### 高 3：移动被数据库引用的 release 会破坏生产数据引用

**问题**：现有清理把数据库里出现的 release 路径作为保留理由；方案的保留条件只写了“正在服务、回滚目标、被进程引用”，漏掉了“被数据库引用”。`newPrefix` 正在 `target_paths` 里，一旦被移动，数据库行仍指向旧路径。

**证据**：
- `scripts/delivery-mode/release-cleanup-remote.py:197,206-207`：`named_by_database` / `keep(path, 'named-by-database:' + ...)`。
- 方案第 1 部分的保留条件没有这一项。

**建议**：保留条件加上 `named_by_database`，并加一条测试：目标路径被 SQLite 某表某列引用时不得移动。这正是 I-73 的教训——值的一端在数据库，另一端在清理脚本。

### 高 4：保留两份完整失败目录会重演 I-33 的磁盘耗尽

**问题**：方案要求“整条路径改名、只改名不删除、保留最近 2 份”，并且门槛要求“内容完整出现在 `failed-attempts/` 下”。这会把 release、operations、stage、evidence 这些可能数 GB 的目录整份留下，正好是 I-33 记录过的失败模式。

**证据**：
- `.agents/instructions/disk-space-hygiene.md:8`：“每次测试和每次发布结束时都要清理其临时产物，包括失败的尝试，并且由脚本完成而不是手工完成，也绝不能只是给它们改名了事”。
- `docs/incidents-and-gates.md:71` I-33：失败上线留下副本和上传包约 7.7 GB；失败重试时旧目录被改名 `.attemptN-failed` 而不删，根分区三次不够用。
- 现有 `scripts/delivery-mode/test_release_cleanup.py:142-147` 的行为是只保留小文件；`release-cleanup-remote.py:226-230` 对 stage 也是先归档小文件再删。
- `KEEP_FAILED_ACCEPTANCE=2`（`release-cleanup.py:17`）是给“小文件/验收证据”的，不是给整份 release 的。

**建议**：失败现场只归档证据（报告、日志、小文本），可重建子树（`REBUILDABLE_SUBTREES`）直接删除；按字节预算而不是只按份数保留；确实要整份保留时走现有 `keep` 失败模式并要 Andy 明示。不要用“改名”代替清理。

### 高 5：缓存损坏后“下次自动全量”是假的，会永久卡住

**问题**：方案说缓存文件校验不一致时“按没命中处理并以 `MATERIAL_CACHE_MISS_AFTER_QUERY` 失败，下次自动全量”。但坏条目仍留在缓存里，下一次查询还会命中，Mac 继续跳过，服务器继续失败，永远不会回到全量上传。

**证据**：
- 方案原文该句。
- 现有传输端要求所有冻结成员都到齐：`scripts/delivery-mode/packet-template/steps/transport-packet.py:82,87`。方案没有删除或隔离坏缓存条目的步骤。

**建议**：校验失败时先原子地删除/隔离该缓存条目并 `fsync` 目录，再失败；或查询时逐个校验并只返回可用集合。加反向测试：第一次坏条目失败，第二次必须走全量并成功。

### 高 6：2b 改变了 S1 传输契约，但方案说“安装脚本和 7 个材料完全不改”，现有文档和硬门槛仍要求缺成员必须失败

**问题**：要让 `tar` 流只放缓存没有的文件，服务器就必须接受“清单成员不在 tar 里”，这与当前“缺成员就失败”的契约冲突。方案只提了新的夹具测试，没有提更新 `steps/README.md` 和 `verify-steps.py`，也没定义如何区分“客户端故意跳过”和“连接截断”。

**证据**：
- `transport-packet.py:82` 拒绝清单外成员，`:87` 要求 `seen == set(members)`。
- `steps/README.md:47`：“多出成员、重复成员、路径越界或缺成员都失败”。
- `steps/verify-steps.py:230` 明确测试“receiver rejects a missing member”；`:163` 断言本地流包含完整包。
- 方案说“安装脚本和 7 个材料完全不改”，但没有说传输脚本、README、`verify-steps.py` 要改。

**建议**：客户端显式传一份经过校验的“缓存命中哈希列表”（或单独的早期控制成员）；服务器只允许列表内的成员缺失，其他缺成员仍失败；截断的流仍必须失败。同步更新 README 和 `verify-steps.py`，并加“声明命中的缺成员成功、未声明的缺成员失败、截断失败”三条测试。

### 中 7：跨文件系统 rename 会 `EXDEV`，方案只查了 `/opt` 与 state

**问题**：目标路径分布在 `/opt`（release/operations）、`/var/lib`（evidence/qualification）、`/var/tmp`（stage）；目的地是 `/var/lib/himawari/release-cleanup`。`os.rename` 跨文件系统会失败。方案前提 13 只比较 `optFree` 和 `stateFree`，没有比较 `/var/tmp`；即使 `/opt` 与 state 同盘，`/var/tmp` 仍可能是另一个挂载点。

**证据**：
- `packet-template/inputs/bindings.draft.json:84,90,91,94,118` 展示路径分布。
- `release-cleanup.py:34` 目的地 `archiveRoot = evidence_parent + '/release-cleanup'`。
- 方案说“改名失败就保留，让预检报错”，这会把本可处理的残留变成新的部署阻塞。

**建议**：实施前对每个源路径和目的地取 `stat -c %d`；同盘才 `rename`，不同盘要么在同一父目录内改名（`<path>.attempt-failed-<stamp>`），要么复制证据后删除；给出明确的跨盘策略和测试，不能默认同盘。

### 中 8：缓存查询与传输、清理之间没有串行化，可能查询命中后被清理掉

**问题**：部署锁是“每个包一把”（`deploy.sh:31`），不同包可以并发；清理锁是全局的，但传输不拿它。清理可以在 Mac 查询之后、服务器复制之前删掉缓存条目，导致 `MATERIAL_CACHE_MISS_AFTER_QUERY`。另外 `BUSY_MARKERS` 里的 `transport-packet` 很可能匹配不到传输进程（实际进程命令行是 base64 bootstrap 和 `<frozen-packet-transport>`）。

**证据**：
- `deploy.sh:31`：`lock="$(dirname "$packet")/.$(basename "$packet").deploy.lock"`。
- `release-cleanup.py:14` 的全局锁只被清理使用。
- `release-cleanup-remote.py:172-173` 的 `BUSY_MARKERS`；`run-local-step.py:39-40` 的 transport 命令行是 bootstrap，不包含字面量 `transport-packet`（这是读代码判断，未在生产验证）。

**建议**：缓存修剪与传输共用一把全局锁，或清理在任意传输进行时跳过缓存修剪；更稳妥的是服务器在查询时把命中项复制到本次上传的暂存区并返回句柄，后续只传未命中项。至少加一条并发/锁测试。

### 中 9：`materialCacheMinBytes` 没有生产端/消费端接线，也没有校验

**问题**：方案说把它写在 `instances/andy-production.json`，但当前没有任何代码消费这个键；实例文件只做 `json.loads`，没有 schema。最后会变成一个“写进去但没人用”的配置键，正是 I-73 的类型。

**证据**：
- `scripts/delivery-mode/instances/andy-production.json` 当前没有该键。
- `scripts/delivery-mode/make-packet.py:93-97` 只 `json.loads`；`:440-467` 的 `base_parameters` 没有该字段；`grep` 在 delivery-mode 下没有找到 `materialCache`。
- `deploy.sh`/`run-local-step.py` 不读实例文件。

**建议**：选一个明确的位置把它冻结进包（`packet-parameters.json` 或 bindings），由 `make-packet.py` 写入、`run-local-step.py` 读取，并在两端校验 `type int`、范围合理。加测试证明改这个键会改变查询阈值。

### 中 10：缓存目录 0755、文件 0644 会把包材料暴露给本机所有用户，且缺少原子发布/安全读取

**问题**：缓存里会有源码 bundle、候选包、`node_modules` 等材料。生产上传目录是 root:root 0700（`transport-packet.py:55,73-75`），缓存却设计成 0755/0644，等于复制了一份对所有本地用户可读的材料。方案也没有要求缓存文件必须是普通文件、`st_nlink == 1`、非符号链接，以及先写临时文件再 `os.replace`。

**证据**：
- 方案原文：“root 所有，目录 0755、文件 0644”。
- 项目自己的文件安全模式：`packet-common.py:41` 要求 `st_nlink == 1`、无 group/other write，并用 `O_NOFOLLOW` 打开。
- `transport-packet.py:30-50` 的上传写入也是先写、`fsync`、再校验。

**建议**：缓存目录 0700 root、文件 0600（若服务账号要读再单独讨论）；命中时 `lstat` 要求普通文件、uid 0、`nlink == 1`、无 group/other write，`open(O_NOFOLLOW)` 后 `fstat` 再校验；写入用临时文件 + `fsync` + `os.replace`；复制到上传目录同样先写临时文件再改名。补符号链接、硬链接、半写文件测试。

### 中 11：`failed-attempts/<时间>` 平铺会撞名，operations 和 qualification 的 basename 相同

**问题**：方案没有定义失败现场在 `failed-attempts/<时间>/` 下的子路径。`newOperations` 和 `newQualificationEvidenceRoot` 的 basename 都是 `<label>-<compact>`，平铺到同一个时间目录会互相覆盖或 `ENOTEMPTY`。

**证据**：
- `packet-template/inputs/bindings.draft.json:94,118`：`/opt/himawari/operations/<label>-<compact>` 与 `/var/lib/himawari/qualification/<label>-<compact>`。
- 方案只写“整条路径改名移到 .../<时间>/，并记下原路径”，没有镜像原路径结构。

**建议**：按原绝对路径镜像保存（如 `failed-attempts/<stamp>/opt/himawari/operations/...`），或用唯一名称；时间戳用 UTC、零填充、可排序；用 `mkdir` 独占创建时间目录，目标已存在时拒绝而不是覆盖。加同时间戳、两条同 basename 路径的测试。

### 中 12：统一清单仍漏掉 S1 上传目录，且和现有清理分类重叠

**问题**：`target_paths()` 加的是 `Path(transportRoot).parent`，即 `/var/tmp/himawari-<label>-<date>`，不是 S1 真正的上传目录 `/var/tmp/<label>-packet-upload/<date>-<label>-change-packet-01`。另外 `newPrefix`、`newOperations`、`evidenceRoot` 已经分别被现有清理按 `old-release`、`failed-attempt-operations`、`.attempt-failed` 处理；新逻辑如果插在之后，内容已经被删；插在之前，又会绕过数据库/符号链接检查。

**证据**：
- `deploy-preflight.py:99-101`；`bindings.draft.json:91` 的 `transportRoot` 是 `/var/tmp/himawari-.../input`。
- `packet-common.py:17` 的 `UPLOAD` 才是 `/var/tmp/<label>-packet-upload/...`。
- `release-cleanup-remote.py:199-209`（releases）、`:211-230`（tmp/upload/stage）、`:264-268`（operations）、`:283-299`（evidence）、`:248-259`（qualification）。

**建议**：定义真正的“本次部署占用路径”清单，包含上传目录、stage、release、operations、evidence、qualification、validation 等；新移动逻辑必须在现有破坏性处理之前接管这些精确路径，或直接替换对应分类的处理。测试断言的是完整占用清单，而不只是 `target_paths()`。

### 中 13：部署前清理失败一律致命，会让无关清理问题阻塞部署

**问题**：方案说“清理失败后预检必然被残留拦下”，但清理还做了很多与目标路径无关的事：清理 `/tmp` 失败场景、state 副本、evidence 大文件、stale transport、数据库扫描等。这些失败不一定导致 `TARGET_PATH_ABSENT` 失败，却会让部署停在第 1 步。

**证据**：
- `deploy.sh:14-17` 当前对两次清理都 `|| echo`。
- `release-cleanup-remote.py` 的 `cleanup()` 里还有 `CLEANUP_TRANSPORT_PROCESS_NOT_STOPPED`、`CLEANUP_QUALIFICATION_PATH_INVALID`、数据库扫描、`remove()` 等其他失败点。

**建议**：拆成“占用路径清理”（失败会留下目标路径才致命）和“尽力而为的卫生清理”（失败只打印）；或者先跑预检，只在 `TARGET_PATH_ABSENT` 等关键项失败时停。加一条“无关清理失败但目标路径已清空时部署继续”的测试。

### 中 14：事故记录应扩充 I-56，不应新增 I-109

**问题**：方案说新增 I-109，再给 I-56 补一句。但这次的前提 12 就是 `TARGET_PATH_ABSENT .../qualification/...`，和 I-56 是同一领域、同一个报错关键词。规则要求重复发生时扩充原行，不另加新行。

**证据**：
- `.claude/rules/incident-gates.md:23`：“新事故加一行；重复发生时，提高次数并扩充原有那一行，不另加新行。判断是不是重复发生时，按领域、文件名或报错关键词搜整份清单”。
- `docs/incidents-and-gates.md:93` 的 I-56 正是 qualification 残留和“统一占用路径清单”的缺口。

**建议**：把 I-56 的次数从 1 提高到 2 或 3，补上这次的现场和门槛；如果确实要新行，先说明为什么不是同一领域。另确认 `check-incident-gates.mjs` 不会因为新行缺少门槛文件而拒绝。

### 中 15：`run-packet-checks.py` 的“和上一个包比 tar 哈希”没有数据来源，且会因工具链升级误报

**问题**：`run-packet-checks.py` 只接收当前包，没有“上一个包”的参数；它运行在 Hermes 上，而之前的包在 Mac 的 `.ci-output/production`。另外 Hermes 的 tar/gzip 版本一升级，tar 哈希就会变，即使内容完全可复现，也会被判失败。

**证据**：
- `scripts/delivery-mode/run-packet-checks.py:195-204` 的入参只有当前 packet/source/node。
- `make-packet.py:785` 把它上传到 Hermes 执行。
- 方案自己写“Hermes 上的 tar/gzip 版本未核实”。

**建议**：在同一环境里把同一 payload 打两次并比较（或记录工具链版本后再比较）；不要拿任意旧包当 oracle。若一定要比旧包，把旧包显式传入，并把 tar/gzip 版本纳入比较键。

### 中 16：排除 `.vite` 必须同时排除 `entries`/`files.list`/`node-modules.json`，否则安装读回失败；且只查“顶层点目录”会漏掉点文件和嵌套缓存

**问题**：collector 的 `copyTree` 会把 `.vite` 同时写进 payload、`entries`、`files.list` 和 `node-modules.json`。如果只从 tar/payload 排除，`artifact-install` 的读回比对会失败（`P5_MODULE_TREE_READBACK_FAILED`）。另外方案只检查“顶层点目录”，`node_modules/.cache` 之外的顶层点文件（如 `.yarn-integrity`、`.modules.yaml`）和嵌套缓存不会被发现。

**证据**：
- `collect-installer-dependencies.mjs:57-82` 的 `copyTree`；`:86` 写 `files.list`；`:89-90` 写 `node-modules.json`。
- `artifact-install.mjs:63-72` 用 `canonical(moduleEntries)` 和 `dependencies.entries` 比对。

**建议**：在 `copyTree` 层排除，让 payload、entries、list、record 四者一致；对每个 dependency root 校验所有顶层条目（目录和文件），未知条目直接失败；测试 `.vite` 文件、未知顶层文件、嵌套缓存三种情况。

### 中 17：缓存容量和“同盘几秒”的估算偏乐观

**问题**：方案说缓存约 330 MB，但 `node-modules.tar.gz` 本身就约 316 MB，候选包、Python 等也在缓存范围内；如果保留 serving、rollback、current 且锁文件各自不同，可能是 3 份，接近 1 GB。复制目的地是 `/var/tmp`，不是方案用来推断同盘的 state 盘。

**证据**：
- `packet-template/inputs/bindings.draft.json:91`：上传目标是 `/var/tmp/...`。
- `deploy-preflight.py:178,185`：`OPT_FREE` 要求至少包大小两倍。
- 方案自己的“同盘复制”推断只比较了 `optFree` 和 `stateFree`。

**建议**：实测 `/opt`、`/var/lib`、`/var/tmp` 的设备和可用空间；给缓存设字节上限和保留策略；把缓存占用纳入预检空间计算；分别测量同盘和跨盘复制时间。

---

## 推测 / 未核实

- 生产机 `/opt`、`/var/lib`、`/var/tmp` 的实际 `st_dev` 和空闲空间。方案只从 `optFree`/`stateFree` 相等推断，且没有覆盖 `/var/tmp`。
- 两次早期残留为什么没被清理；没有清理输出，方案自己也标了“原因未核实”。
- 前提 11 的四个包哈希、37,581 个文件中只有 1 个不同，来自仓库外数据，本次没有独立核对。
- Hermes 上的 tar/gzip 版本，以及 `.vite` 是否就是唯一的非确定性来源。即使排除 `.vite`，也可能有其它安装缓存或 `node-modules.json` 里的每轮绝对路径。
- `BUSY_MARKERS` 是否真的匹配不到正在运行的传输进程：这是读 `run-local-step.py:39-40` 的 bootstrap 结构得出的判断，未在生产进程上验证。
- 272–365 秒降到 65–90 秒、每次省 3.5–4.5 分钟，都是按旧上传速度推算，未在真实缓存命中场景测量。
- 两个不同包的部署是否会并发执行；部署锁是每包一把，实际是否有人为串行化未核实。

---

## 侧重检查

- **错误路径**：查了缓存命中后文件消失、缓存文件损坏、rename 失败、跨文件系统、目标已存在、清理失败、服务未运行。结论：坏缓存不删除会永久卡住；跨文件系统 rename 会留下同样的阻塞；失败目录平铺会撞名；这些都需要明确失败策略和测试。
- **不合规范/不可信输入**：查了 `bindings.json` 的路径是否在远端校验。结论：只有 qualification 有根校验，新增的整路径移动必须补上；缓存哈希来自冻结清单，格式已有校验，但缓存文件本身还要校验普通文件/属主/链接数。
- **安全**：查了缓存权限、符号链接/硬链接、TOCTOU、root 脚本的路径来源。结论：0755/0644 对包含源码/候选包的材料过宽；缓存读取应 `O_NOFOLLOW`、校验 `nlink == 1`；写入应原子化；`os.rename` 前应校验允许根。
- **资源耗尽**：查了 I-33、`disk-space-hygiene.md`、现有 `archive_small_files`。结论：保留两份完整失败目录会重演磁盘耗尽；应只保留证据、删除可重建内容，并按字节预算。
- **不可撤销操作**：查了移动被数据库引用的 release、缓存删除、失败现场保留。结论：移动 DB 引用路径会破坏生产数据；缓存条目删除是可重建的，但必须保证下一次能全量；失败现场如果只保留 2 份，旧证据会被不可逆删除。
- **规则/文档/代码一致**：查了 `disk-space-hygiene.md:8`、`.claude/rules/incident-gates.md:23`、`docs/incidents-and-gates.md` 的 I-33/I-53/I-56、`steps/README.md:47`、`verify-steps.py:230`、`make-packet.py:784`。结论：方案至少在三处与现有规则/文档/硬门槛不一致：改名不删、新增 I-109、传输缺成员语义。

---

## 如果由我定，我会怎样改这份方案

### 第 1 部分

1. 先做一份真正的“本次部署占用路径”清单，包含 S1 上传目录、stage、release、operations、evidence、qualification、validation 等；清单函数同时校验每条路径的允许根，预检和清理共用。
2. 清理按路径分类：正在服务的 release/operations/evidence/qualification（从 serving 的 `bindings.json` 读，而不是从目录名猜）、回滚目标、被进程引用、被数据库引用、符号链接，全部保留；其余才处理。
3. 不整目录保留。复用现有的 `archive_small_files`/`preserve_failed_acceptance`，只把报告、日志、小文本复制到 `release-cleanup/failed-attempts/<UTC-stamp>/<原路径镜像>/`，然后删除可重建内容；按字节预算限制总保留量。真需要整份现场时走 `keep` 模式，单独征求 Andy 同意。
4. 跨文件系统逐路径判断：同盘 `rename`；不同盘在同一父目录改名，或归档证据后删除；不要因为 `EXDEV` 把部署卡死。
5. 部署前清理拆成“占用路径清理（必须成功）”和“尽力而为的卫生清理（失败只打印）”；只在前者留下目标路径时早停，并加新结果的退出码/日志。
6. 事故记录扩充 I-56（次数和门槛），不要新增 I-109。

### 第 2 部分

1. 改真正的构建 collector：`packet-template/acceptance/helpers/collect-installer-dependencies.mjs`；同步 `install/` 副本、`OWNED-SHA256SUMS`/fixture，并加“两份字节相同”的测试。
2. 更彻底的可复现做法：不要复制整个 `node_modules` 树，而是只复制 `package-lock.json` 里列出的包目录和允许的元数据（`.bin`、`.package-lock.json`），其他顶层条目一律报错；这样 `.vite` 和未来缓存不会悄悄进包。在 `copyTree` 层排除，保证 payload、entries、files.list、node-modules.json 一致。
3. 可复现性门槛改成“同一环境打两次包比较”，并在 `node-modules.json` 记录 tar/gzip 版本；不要拿任意旧包做 oracle。
4. 传输契约显式化：客户端把“缓存命中、服务器可代填”的哈希列表传给服务器；服务器只允许这些成员缺失，逐个按冻结清单校验缓存文件，其他缺成员和截断流仍失败。更新 README、`verify-steps.py` 和所有相关夹具。
5. 缓存生命周期：内容寻址路径；临时文件 + `fsync` + `os.replace` 原子发布；命中时 `lstat`/`O_NOFOLLOW`/`nlink == 1`/属主/权限/大小/SHA 全查；不一致时删除或隔离坏条目再失败，保证下一次全量；目录 0700、文件 0600。
6. 缓存修剪和传输串行化：共用全局锁，或传输进行时跳过修剪；保留策略按字节上限，不只按版本数。
7. `materialCacheMinBytes` 从实例文件经 `make-packet.py` 冻结进包参数，由 `run-local-step.py` 读取；两端校验类型和范围，并加生产者/消费者测试。
8. 实测 `/opt`、`/var/lib`、`/var/tmp` 的设备和容量，把缓存占用纳入预检；更新 330 MB 和“几秒”的估算。

---

## 必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？

**不会。** 这次改的是上线脚本、传输协议和 `node_modules` 归档，不改系统提示、工具定义、历史消息、遮盖结果或任何请求组装代码。模型请求仍然只在末尾追加，每轮会变的值仍然只放在最后一条用户消息里。依据：`.agents/instructions/prompt-prefix.md:36`（“已经发给过模型的内容，不得改动、重排或删除，只能在末尾追加”）和 `:28`（“每轮都会变的内容只放在最后一条用户消息里”）。唯一要守住的是：不要把缓存状态、时间、版本号这类会变的值加进系统提示或工具定义；如果要告诉模型，只能追加在末尾。方案没有这么做。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

**对模型请求：不会。** 没有文本进入模型请求路径。

**对打包产物：2a 方向正确，但目前不能证明。** 方案只观察到 `.vite` 不同，且 Hermes 的 tar/gzip 版本未核实；只查“顶层点目录”会漏掉点文件和嵌套缓存；`entries` 用 `localeCompare` 排序，虽然 tar 又用 `--sort=name`，但 `node-modules.json` 本身仍可能因每轮 `output` 绝对路径不同而不同。建议用“只复制锁文件包 + 允许元数据”的方式从根上排除无关文件，并用同环境打两次包来证明 tar 逐字节一致。依据：Reproducible Builds 的定义要求“same source code, build environment and build instructions ... bit-by-bit identical copies”（https://reproducible-builds.org/docs/definition/ ）。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

**第 1 部分：部分有，但不够。** 方案列的“三类目标路径都有非空残留”“清理后预检全部不存在”“serving/进程引用不移动”“部署前清理失败在预检前退出”都是好检查。反向的 `test_directory_with_content_stays_for_the_preflight_to_report` 改成“移走”后，在改代码前会失败、改后通过，是有效的反向用例。但还缺：被数据库引用的路径、跨文件系统 `EXDEV`、目标撞名、S1 上传目录、符号链接、恶意/错误的绑定根、无关清理失败不阻塞、字节预算。没有这些，无法证明第 1 部分不会重演 I-33 或误移生产数据。

**第 2a 部分：测试必须打在真正的构建 collector 上。** 如果按方案引用去测 `install/collect-installer-dependencies.mjs`，测试可能通过而实际出包仍带 `.vite`，这是一个假阳性。打在 `acceptance/helpers` 上，“同一锁文件、不同 `.vite` 内容打两次包，tar 哈希相同”在改前会失败、改后通过，是有效的反向用例。`run-packet-checks.py` 的“上一个包”检查没有数据来源，且会因 tar/gzip 升级误报，不是可靠门槛。

**第 2b 部分：夹具覆盖了全中、部分中、全不中、被篡改、权限不安全，但反向不完整。** “缓存文件被篡改（拒绝且不算命中）”只证明了第一次拒绝，没有证明第二次会全量成功；由于坏条目不会被删除，实际上第二次仍会命中并再次失败。还缺：截断流必须失败、声明的缓存命中列表、缓存查询与清理的并发、缓存文件符号链接/硬链接/半写文件、`materialCacheMinBytes` 两端接线。现有 `verify-steps.py:230` 的“缺成员失败”会在传输契约改变后失败，必须同步更新，否则包检查本身会红。

### 4. 每个值的生产端和使用端都能接受吗？

逐个核对如下（“生产端 → 使用端”）：

| 值 | 生产端 | 使用端 | 结论 |
| --- | --- | --- | --- |
| `failed-attempts` 路径、`keepFailedAttempts` | `release-cleanup.py` 的新常量/`cleanup_plan` | `release-cleanup-remote.py` 的计划读取、保留逻辑 | 方案没写要把新常量加入 plan；两端必须同时加，并测 plan 默认值。 |
| `target_paths` / owned-paths | 新的共享模块 | `deploy-preflight.py`、`release-cleanup.py` | 当前只有预检使用；清理端必须把列表放进 plan。远端还要校验根，否则 root 脚本可移动任意路径。清单还漏了 S1 上传目录。 |
| `materialCacheMinBytes` | `instances/andy-production.json` | 目前没有消费者 | **未接线**。需要经 `make-packet.py` 冻结进包参数，再由 `run-local-step.py` 读取；两端校验整数和范围。 |
| `/opt/himawari/material-cache/sha256/<hash>` | `run-local-step.py` 查询、`transport-packet.py` 写入 | `release-cleanup-remote.py` 修剪、传输复制 | 需要同一常量/plan 字段，并校验 `<hash>` 是 64 位十六进制；否则生产端和清理端可能指向不同目录。 |
| 缓存目录 0755/0644 | 传输端创建 | 传输端读取/复制 | 两端都能“接受”，但安全上不应接受：材料会变成全机可读。建议 0700/0600，并在读取端复核文件和目录权限。 |
| `MATERIAL_CACHE_MISS_AFTER_QUERY` | 服务器传输端 | 本地步骤/日志/操作者 | 只是一个失败码，没有程序化消费者；可以，但必须保证失败时删除坏缓存条目，否则下一次不会全量。 |
| `.vite`/`.vite-temp` 排除名单 | 构建 collector | `entries`、`files.list`、`node-modules.json`、`artifact-install.mjs:63-72` 的读回 | 必须四端一致；只从 tar 排除会让安装读回失败。 |
| 未知顶层条目错误码 | 构建 collector | 出包检查/操作者 | 方案没有给出错误码、文档和测试；需要补。 |
| `packageLockSha256` + tar 哈希 | collector（`packageLockSha256`、`archive.sha256`） | `artifact-install.mjs:61`、拟议的 `run-packet-checks.py` | 安装端能接受；“上一个包”的值没有生产端，需要明确来源。 |
| failed-attempts 时间戳格式 | 清理端 | 保留逻辑按名称排序 | 现有 `failed-acceptance` 用 UTC 零填充格式；新目录必须同样可排序，否则“保留最近 N 份”会选错。 |
| 清理失败的新结果/退出码 | `deploy.sh` | `result()` 白名单（`deploy.sh:19-29`）、测试 | 方案没定义；`result()` 只对 passed/recovered/stopped-before-service-stop 做事，新结果要显式 `exit`，不能误触发 rollback 或第二次清理。 |
