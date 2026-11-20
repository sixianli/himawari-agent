## 先说明

- 同目录的 `34f2e1411ce4-plan.md` **不在当前稀疏检出里，我没读到**；下面只能以仓库代码、你补充的事实和一手资料为准。这一点标为「未核实」。
- 我按「先查错误路径和值两端」的顺序读：首装/升级脚本、包生成与检查、签名与回执、配置 schema、运行环境块、CI runner 与 runbook。读到的内容已足够下结论，没有再扩大范围。

---

## 一、已证实的问题（按严重度）

### 阻断 1：A4 的“新主机首装”在现有流水线里不存在，第一步就会失败

**问题**：方案说“新主机首装上线包：不读 S0 的运行版本，要求目标机上服务不存在、目录为空”。但 `make-packet.py` 和 `deploy.sh` 都是**升级/迁移**流程，不是首装流程。

**证据**：
- `scripts/delivery-mode/make-packet.py:316-362` 的 `discover()` 会 SSH 到目标机读运行中的 unit、config，`interpret_discovery()` 在 `:328-329` 明确 `if facts.get('active') != 'active': refuse('PACKET_SERVICE_NOT_ACTIVE')`；没有运行中的服务就无法准备包。
- `make-packet.py:1055` 的 `prepare` 无条件调用 `read_s0()`；`:680-709` 的 `read_s0()` 用 `runuser -u himawari-prod` 读生产数据库和配置。空机器上没有这个账号、没有数据库、没有 `/opt/himawari/node`，直接失败。
- `make-packet.py:1015-1018` 还要求 `--since` 或输出目录里有上一版包；新主机第一次出包没有上一版。
- `deploy.sh:92-95` 的动作表包含 `S2_STOP`、`S3_COPY51`（停旧服务、复制旧库）；首装没有旧服务和旧库。
- `deploy-preflight.py:177-199` 要求 `SERVICE_ACTIVE`、`CONFIG_UNCHANGED_SINCE_FREEZE`、`UNIT_UNCHANGED_SINCE_FREEZE`、`AUTHORITY_UNCHANGED_SINCE_FREEZE`、`RUNNING_KERNEL_MATCHES_QUALIFICATION`；空机器没有这些状态。
- `cloud-seal.mjs:490` 还要求 `inputs/s0-db-readback.json` 和 `inputs/bindings.json` 的摘要；`:448-454` 要求每个已有 capability 都有 frozen observation。首装没有这些。

**建议**：不要假装 A4 是现有流程的一个参数。单独做一条 **first-install** 路径：独立的包生成器/安装器，明确跳过 `discover`、`read_s0`、`S2_STOP`、`S3_COPY51`，生成空库的 S0 观察或首装专用 receipt，并把“目标为空”作为前置条件；在空 VM 上加一条反向用例，证明现有 `deploy.sh` 会拒绝、新路径才会通过。

---

### 阻断 2：uid 999 / gid 988 在目标机已被占用，方案没有处理，且多处模板写死

**问题**：目标机 uid 999 是 `ocarun`，gid 988 是 `gh-ci-share`；Contabo 生产服务账号是 999/988，模板里多处写死。A4 只说“建服务账号”，没有说 uid/gid 冲突怎么办。

**证据**：
- `scripts/delivery-mode/instances/andy-production.json:9-10`：`serviceUid: 999`, `serviceGid: 988`。
- `packet-template/measurement/S6-service-read.py:22` 要求 `(account.pw_uid, account.pw_gid) == (999, 988)`；`:53`、`:83` 还按 999/988 chown。
- `packet-template/measurement/probe/run-service-probe.py:30` 要求 `os.getuid() == 999`、`os.getgid() == 988`。
- `packet-template/systemd/S7-switch-start-readback.py:27` 要求 `(account.pw_uid, account.pw_gid) == (999, 988)`。
- `packet-template/steps/run-step.py:58` 要求 `(account.pw_uid, account.pw_gid) == (999, 988)`。
- `packet-template/systemd/S7-startup-readback.mjs:124` 要求 `acceptanceUid === 999`，`:172` 要求 `runtimeUid: 999`。
- `packet-template/inputs/finalize-binding-inputs.py:21`、`acceptance/helpers/observe-production-npm.py:134` 也写死 999/988。
- `acceptance/cloud/cloud-inputs.draft.json:6-7` 写死 `acceptanceUid: 999`、`acceptanceAccount: "himawari-prod"`。
- `cloud-protected-prepare.mjs:79` 要求 `receipt.bindingInputs.acceptanceUid === process.getuid()`。

**后果**：如果新建 `himawari-prod` 用别的 uid，S6/S7/run-step/finalize 全部拒绝；如果强行复用 999，服务就以 `ocarun` 身份运行，或者把生产文件放进 `gh-ci-share` 组，和 CI runner 共享组权限。两种都不可接受。

**建议**：把 `serviceUid/serviceGid/acceptanceUid` 全部参数化到实例配置和所有模板；选一个**既不是 999 也不是 988、且不与 CI runner 共享**的专用 uid/gid；加一道预检：目标 uid/gid 已存在、或新 gid 的成员包含 CI runner 账号，就拒绝出包/上线。所有 receipt/binding 重新生成。

---

### 阻断 3：新主机首装需要的签名信任锚在目标机上不存在，`cloud-seal` 和 S7 都会失败

**问题**：A4 说“跑现有的验收和 `cloud-seal` 生成新回执，`cloud-protected-prepare` 一行不改”。但 `cloud-seal` 和 S7 都要求目标机上有固定的 `first-20261007` 公钥，并且当前私钥必须和它匹配。

**证据**：
- `packet-template/signing/cloud-seal.mjs:436-446`：读取 `/var/lib/himawari/qualification/first-20261007/host-qualification-public-key.pem`，缺失时抛 `FIRST_SIGNING_KEY_REQUIRED`；并断言当前私钥公钥与该文件相同。
- `packet-template/systemd/S7-startup-readback.mjs:111-115` 也读取同一个路径，并断言 signer 相同。
- `docs/runbooks/authority-transfer-runbook.md:173`、`:274` 明确：目标 host 的配置、秘密、能力部署快照和平台 runtime root 必须独立准备；迁移包不携带机器秘密、可执行绑定或平台资格。把 Contabo 的私钥复制到 Oracle 违反这条。
- 新事实也指出 `cloud-seal.mjs:441` 写死该路径，缺失时报 `FIRST_SIGNING_KEY_REQUIRED`。

**建议**：把“首签名公钥/信任锚”做成按主机或实例配置的路径，首装时在目标机生成新的签名密钥并登记为新信任锚；同步更新 `cloud-seal`、`S7`、`cloud-protected-prepare` 和所有引用该路径的测试。不要复制源主机私钥。若决定沿用旧信任锚，必须作为一次显式的密钥轮换/迁移决定写进 ADR，并说明风险。

---

### 高 4：A3 改错了摘要清单，而且会直接改坏 `deploy-preflight` 和现有测试

**问题**：A3 说改完 `cloud-seal.mjs`、探测脚本、`deploy-preflight.py` 后“同时更新 `scripts/delivery-mode/probe-sources.json` 里的摘要”。`probe-sources.json` 根本不包含这些文件。

**证据**：
- `scripts/delivery-mode/probe-sources.json:1-23` 只有 `bootstrap` 和三个文件：`job-host-main.js`、`sandbox-sdk.js`、`sandbox-sdk-worker.js`，没有 `cloud-seal.mjs`，也没有 probe 脚本。
- `deploy-preflight.py:83` 用正则 `readOnlyToolchainPaths: \[(.*?)protectedPaths: \[` 从 `cloud-seal.mjs` 源码里抠字面量；`:123-128` 找不到就 `PREFLIGHT_CHECK sandbox read paths not found`。如果 A3 把数组改成函数调用，这里会直接失败。
- `scripts/delivery-mode/test_make_packet.py:496-505` 也用字符串切分 `seal.split('readOnlyToolchainPaths: [', 1)...`；改成函数调用后测试会失败。
- 真正记录 probe 摘要的是 `acceptance/OWNED-SHA256SUMS`、`acceptance/cloud/adaptation-manifest.json`、`acceptance/cloud/question-12-inputs.json`、`acceptance/cloud/cloud-inputs.draft.json`、`r2l6-source-manifest.json` 等；`cloud-seal.mjs` 本身在包的签名/冻结材料里，由 `freeze`/`finalize` 重新计算。

**建议**：先列出“哪些文件哈希在哪些清单里”，再动代码。要么保留 `cloud-seal` 里的字面量数组（只把 `/lib64` 改成可选处理），要么让 `deploy-preflight.py` 和 `test_make_packet.py` 改为读取一个共享的、可解析的数据文件；不要声称更新 `probe-sources.json` 就够了。

---

### 高 5：A2 的“在 Oracle 上原生构建 ARM 候选”在现有构建链里没有落点

**问题**：方案说在 Oracle 上开独立构建账号，原生编译 better-sqlite3、rename-native，跑浏览器验收。但现有出包链把构建机写死为 Hermes x64。

**证据**：
- `make-packet.py:719-724` 的 `Hermes` 类固定读 `hermes/builder.json` 和 `hermes-ssh.sh`/`hermes-upload.sh`；`:1039` 无条件创建 `Hermes(...)`。
- `hermes/builder.json:2,14` 写死 `hostname: "hermes-home"`、`pythonMaterial` 路径。
- `hermes/build-candidate.sh:17` 要求主机名是 `hermes-home`；`:40` 调 `scripts/ci/local.mjs --check build`；`:44-46` 写死 `build-linux-x64` 和 `linux-x64-abi127-...`；`:75` 复制 `python-3.12.10.tar.gz`。
- `hermes/capture-build-source-inputs.template.mjs:115` 要求 `process.arch === "x64"`、`os.hostname() === "hermes-home"`、`process.getuid() === 1000`。
- `packet-template/install/collect-installer-dependencies.mjs:15` 和 `acceptance/helpers/collect-installer-dependencies.mjs:15` 都要求 `process.arch === "x64"`。
- `scripts/ci/platforms.mjs:15` 的 `ARTIFACT_PLATFORM_KEYS` 只有 `macos-arm64` 和 `linux-x64`；`scripts/ci/local.mjs:31` 在 build/tests 时调用 `artifactPlatformKey()`，ARM 上会抛 `CI_ARTIFACT_PLATFORM_UNSUPPORTED`。
- `scripts/ci/aggregate.mjs:219`、`packet-template/acceptance/cloud/basis-04/run-stage-03.py:253` 也写死 `linux-x64`。

**建议**：把“构建机”抽象成配置（host、arch、source root、tools、browser、pythonMaterial），新增 ARM builder 配置和脚本；把 `ARTIFACT_PLATFORM_KEYS` 加上 `linux-arm64`；同步改 `capture-build-source-inputs`、两份 `collect-installer-dependencies`、`build-candidate.sh`、`run-stage-03.py`、`aggregate.mjs`。否则 A2 只是描述，无法执行。

---

### 高 6：B 把生产数据复制到与 CI runner 同机的 Oracle，安全边界和完整性都不够

**问题**：B 说在 Contabo 上用 SQLite backup 复制到 Oracle，做问答、搜索、抓取、文件、记忆验证。Oracle 同时跑两个 CI runner，且 gid 988 是 `gh-ci-share`。

**证据**：
- `docs/runbooks/authority-transfer-runbook.md:269`：迁移会打包整个 Memory 目录，包含 `vectors.sqlite`、`history.sqlite`、`entities.sqlite`；只复制产品 SQLite 不能验证记忆。
- `authority-transfer-runbook.md:173`、`:274`：目标 host 的配置、秘密、能力部署快照必须独立准备，迁移包不携带机器秘密；不能复制源主机密钥代替。
- `ci-vps-runner-runbook.md:61`：runner 服务通过 `SupplementaryGroups=gh-ci-share` 获得共享组；`:65` 的 nft 规则只挡“端口名单里的本机端口”，新服务端口要刷新；`:79` 的 `ProtectHome=yes` 只挡 `/home`。
- `production-run-policy.ts:249-260` 的 `configuredWorkspaceRoot` 会检查 `grant.hostId === route.hostId`；把 Contabo 的 DB 直接复制到 Oracle，目录 grant 的 hostId 不匹配，文件工具会变成“没有工作目录”。
- 新事实：gid 988 已被 `gh-ci-share` 占用。

**建议**：验证副本不要放在生产/CI 同机。若必须同机，至少：生产服务用独立 uid/gid（不要 988），CI runner 不属于该组；刷新 runner nft 端口；验证副本使用独立的验证密钥，不复制生产密钥；复制完整 Memory 目录或用受支持的 export/import；为 Oracle 重新创建目录 grant；用 `PRAGMA integrity_check` + 文件哈希核对，而不是“大小和关键表行数”。

SQLite 官方也说明 backup API 完成时目标库是“bit-wise identical copy”的快照（<https://www.sqlite.org/backup.html>），但“行数对得上”仍不能替代完整性校验。

---

### 高 7：A5 只关掉三个配置键，不能证明验证副本没有外部副作用

**问题**：A5 说配置里不写 `runPolicy.proactive`、`realEval`、`museIntake`，不装心跳、不装 cloudflared，然后“提醒是否仍会投递要实测”。但 `runPolicy` 还有多个可能产生外部调用/通知的键，方案没有逐一关闭。

**证据**：
- `packages/platform-node/src/strict-configuration.ts:1825-1942` 允许的 `runPolicy` 键还包括 `webPush`、`applePush`、`homeFeed`、`deliveryTiming`、`perception`、`device`、`thinkInbox`、`importDuplicates`、`automaticReview`、`mcpRead` 等。
- `apps/agent-service/src/service-main.ts:753-766` 创建 `webPush`、`applePush`、`proactive`、`realEval`；`:1983-2410` 构造 proactive/realEval；`:3384-3425` 把它们接入 HTTP 组合。
- `apps/agent-service/src/production-web-push.ts:221,441` 会把 proactive 项推送到客户端。
- `production-memory-worker.ts` 也会在服务启动后运行，可能写记忆、调用嵌入模型。

**建议**：不要用“少写几个键”来当验证模式。加一个显式的 `validationOnly` 运行模式：在服务装配层禁用所有出站通道（web push、Apple push、proactive、邮件、MCP、外部模型评测、记忆捕获、后台任务、心跳、cloudflared），配置里用白名单而不是黑名单；启动后实测没有外部连接（nft/tcpdump/日志），再允许用生产数据副本。若生产配置里实际启用了哪些键未核实，先读配置或让配置解析器打印启用的外呼能力。

---

### 高 8：E 只给 CI runner 设 CPU 上限不够，且没有刷新 runner 的本机端口防火墙

**问题**：E 说“给 runner 设 CPU 上限，或把 CI 挪走”。但同机风险主要是网络、内存、磁盘和账户组，不只是 CPU。

**证据**：
- `docs/runbooks/ci-vps-runner-runbook.md:65`：runner 的 nft 规则拒绝访问本机“端口名单里的 TCP 端口”，名单取当时在监听的端口；`:210` 明确“本机新增了服务：防火墙只挡端口名单里的端口，要重新运行 `install-runner.sh` 刷新规则”。生产服务在 8400、Magpie 在 3425/3430，这些端口如果不在名单里，runner 任务可以访问。
- `ci-vps-runner-runbook.md:61`：runner 服务带 `SupplementaryGroups=gh-ci-share`；如果生产 gid 也用 988，组权限会交叉。
- `ci-vps-runner-runbook.md:79`：`ProtectHome=yes` 只挡 `/home`，不挡 `/var/lib/himawari` 或 `/opt/himawari` 的可读部分。
- GitHub 官方明确警告：self-hosted runner 可能被不可信 workflow 持久化破坏；“be cautious when using self-hosted runners on private or internal repositories, as anyone who can fork the repository and open a pull request ... can compromise the self-hosted runner environment, including gaining access to secrets and the GITHUB_TOKEN”（<https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions#hardening-for-self-hosted-runners>）。

**建议**：优先把 CI runner 挪到独立机器。若必须同机：生产 uid/gid 不得与 `gh-ci-share` 相同；在启动生产服务前重跑 runner 安装脚本刷新 nft 端口名单，并验证 runner 账号访问 8400/3425/3430/22/元数据地址都被拒绝；给 runner 设内存、磁盘、任务数上限并监控 OOM；不要在 `ubuntu` 的 docker 组/sudo 与生产共存的前提下把该机器当生产机（Docker 官方：只有可信用户才能控制 Docker daemon，<https://docs.docker.com/engine/security/#docker-daemon-attack-surface>）。

---

### 中 9：A1 漏掉多个平台消费者，按现状会直接找不到 ARM 产物

**问题**：A1 只点名 `make-packet.py` 和 `run-packet-checks.py`，但写死 `linux-x64`/`x64` 的消费者远不止这两个。

**证据**：
- `make-packet.py:509,552`：`materials.glob('linux-x64-abi127-...')`。
- `run-packet-checks.py:166`：`glob('linux-x64-abi127-*-1.tar.gz')`。
- `hermes/build-candidate.sh:44-46`：`build-linux-x64`、`linux-x64-abi127-...`。
- `basis-04/run-stage-03.py:253`：正则只认 `linux-x64`/`macos-arm64`；`:478` 读 `build-linux-x64/result.json`。
- `scripts/ci/aggregate.mjs:219`：`const platform = "linux-x64"`。
- `packet-template/install/__PKT_LABEL__-artifact-install.mjs:14`：`process.arch === "x64"`；`:23` 允许的材料名写死 `python-3.12.10.tar.gz`；`:53` 也写死。
- 两份 `collect-installer-dependencies.mjs:15`：`process.arch === "x64"`。
- `capture-build-source-inputs.template.mjs:115`：x64 + `hermes-home` + uid 1000。
- `download-question-12.py:16`、`run-network-preparation.py:20`：fd 下载写死 `x86_64`；`cloud-inputs.draft.json:35` 也写死 `fd-v10.5.0-x86_64...`。

**建议**：做一个集中的“目标平台/架构/构建机”配置，出包、检查、安装、CI 汇总、fd/Python/Node 材料都从它取；逐个文件核对“产生处”和“使用处”，按 I-73 的做法补一条“平台矩阵”测试：x64 默认值不变、ARM 选中 ARM 产物、错配产物必须被 `verify-artifact` 拒绝。

---

### 中 10：“x64 产出字节不变”这个判断可能不成立

**问题**：A1 说“x64 默认值和产出字节不变”。如果为了 ARM 往 `ci/toolchain-lock.json` 加 fd 等条目，`toolchainSha256` 会变，x64 的 context/artifact record 也会变。

**证据**：
- `scripts/ci/context.mjs:143`：`toolchainSha256: fileSha256(path.join(root, "ci/toolchain-lock.json"))`。
- `scripts/ci/aggregate.mjs:310-311` 会核对 `context.toolchainSha256`；`verify-artifact.mjs:120` 把 `ci/toolchain-lock.json` 列入 source inputs。
- ADR 0253 第 41 行已经指出：改主工具链锁文件会改变 x64 产物记录里的上下文。

**建议**：明确选择：(a) fd 不放进 `ci/toolchain-lock.json`，放到实例/包配置里，保持 x64 context 不变；或 (b) 接受一次 x64 context 变化，更新所有固定期望值和 `fixtures/twelfth-*` 等基准。不要同时声称“加锁文件条目”和“x64 字节不变”。

---

### 中 11：D 照抄 Contabo 的包名/GRUB 做法会在 Oracle 上失败或漏锁

**问题**：目标内核是 `7.0.0-1013-oracle`，Contabo 的 hold 清单是 `linux-virtual`、`linux-image-6.8.0-142-generic` 等；Oracle 镜像不一定装这些元包，GRUB 的 `saved_entry` 路径也不同。

**证据**：
- `production-server-access-runbook.md:65-66` 的 Contabo 清单和 `GRUB_DEFAULT=saved` 做法。
- 新事实：目标内核 `7.0.0-1013-oracle`；`/usr/bin/socat` 是 `socat1` 的符号链接。
- `apt-mark` 官方说明：hold “prevent the package from being automatically installed, upgraded or removed”（<https://manpages.ubuntu.com/manpages/noble/man8/apt-mark.8.html>）。
- `collect-system-tools.mjs:52-70,93` 会把符号链接链和最终 realpath 的身份一起记入 receipt；只 hold `socat` 不一定能锁住 `socat1` 的目标内容。

**建议**：在目标机用 `dpkg-query`/`apt-mark showmanual` 推导实际包名，至少锁住运行内核的 image/modules/headers、`linux-oracle` 元包（若存在）、`bubblewrap`、`socat`、`socat1`、`bash`、`ripgrep`；用实际 `grub.cfg` 的 menuentry id 设置 `saved_entry`；显式写 `Unattended-Upgrade::Automatic-Reboot "false"`，不要依赖注释掉的默认值；把“重新验收后解锁”的流程写清楚。此条中包名部分是**推测**，需在目标机只读核对。

---

### 中 12：C 只写了 authority transfer，漏了公网入口、证书/隧道、OAuth 回调、心跳顺序和防火墙

**问题**：C 说“cloudflared 换到 Oracle；心跳迁过去”，但没有写切换顺序和失败回退。Oracle 目标机还需要自己的 ufw/VCN 入站规则。

**证据**：
- `production-server-access-runbook.md:145`：生产机入站默认拒绝，只放行 22/tcp；网页走 Cloudflare 隧道，不开 80/443/8400。
- `authority-transfer-runbook.md:272-278`：export/import/activate 的独立授权、目标空 state root、目标配置/秘密/能力快照独立准备、preflight 要求 `doctorReady`/`publicIngressReady` 来自本次只读检查。
- `production-server-access-runbook.md:194`：心跳是独立的 systemd timer，不随上线包安装；切换时要先暂停旧心跳，避免旧机继续发心跳掩盖停机。

**建议**：在 C 里加一张 cutover 清单：Oracle 入站只开 22、出站允许 Cloudflare/Magpie；创建/安装新的 tunnel 凭据（不复制源机秘密）；更新 Cloudflare DNS/route；核对 Google OAuth redirect URI、web push 订阅、设备配对；先停旧心跳再启新心跳；明确失败时如何回退到 Contabo；activate 后跑 `publicIngressReady` 和真实浏览器走查。

---

### 中 13：B 的“核对大小和关键表行数”不足以证明副本可用

**问题**：SQLite backup API 本身能生成一致快照，但“行数对得上”不能发现页损坏、schema/迁移账本不一致、payload 无法解密等问题。

**证据**：SQLite 官方原话：“The effect of completing the backup call sequence is to make the destination a bit-wise identical copy of the source database as it was when the copying commenced.”（<https://www.sqlite.org/backup.html>）

**建议**：至少做 `PRAGMA integrity_check`、比对 `schema_migrations`/迁移账本、对关键表做内容哈希、验证 payload 解密、验证 Memory 目录的版本和文件；用 `VACUUM INTO` 或 backup API 生成副本，避免 `cp` 正在写的 WAL 库。

---

### 中 14：主机名 `himawari-prod` 也必须像内核一样被锁住

**问题**：receipt、S6、S7、`make-packet discover` 都核对主机名。Oracle 的 cloud-init 可能在重启后改回默认主机名。

**证据**：
- `make-packet.py:326-329` 要求 `facts.hostname == instance.host.hostname`。
- `S6-service-read.py:22`、`S7-switch-start-readback.py:27`、`finalize-binding-inputs.py:21` 都要求 `socket.gethostname() == "__PKT_HOSTNAME__"`。
- `ci-vps-runner-runbook.md:57` 用 `/etc/cloud/cloud.cfg.d/99-ci-vps-hostname.cfg` 持久化主机名，可作为先例。

**建议**：首装前用 cloud-init 配置持久化 `himawari-prod`，重启后核对；把主机名写进 D 的“锁定清单”，和内核/受检程序一起验收。

---

## 二、推测 / 未核实

以下不能下确定结论，方案里应补验证：

1. **`34f2e1411ce4-plan.md` 未读到**，无法核对它和线程方案共享的事实是否准确。
2. **生产配置实际启用了哪些 `runPolicy` 键**未读到；A5 只关三个键是否足够，取决于 `webPush`/`applePush`/`homeFeed`/`deliveryTiming`/`perception`/`device`/`thinkInbox` 等是否在配置里。
3. **`onnxruntime-node` 1.30.0 是否真的带并加载 linux-arm64 二进制**：ADR 0253 只记录 `npm ci` 通过；安装通过不等于运行时加载通过。A2 应加一条真实 ARM 上加载 ONNX 的验收。
4. **fd 的 aarch64 发行物文件名和摘要**未核实；A1 说“按平台钉住”，但仓库里下载脚本仍写死 x86_64。
5. **Oracle 上实际的 apt 包名、GRUB menuentry id**未核实；D 不能直接照抄 Contabo。
6. **`socat1` 是否独立包**未核实；如果是，必须一并 hold。
7. **Oracle 的 `ubuntu` 账号是否有免密 sudo / docker 组**未核实；如果有，和“生产同机”组合会放大风险。
8. **`browser-acceptance-gate.py` 只校验 artifact sha，不校验跑验收的机器架构**；A2 的“在 ARM 上跑浏览器验收”没有自动证据。虽然 ARM 产物在 x64 上通常跑不起来，但方案应让 walkthrough 记录 platform/arch 并校验。
9. **`make-packet --reuse-materials` 能否跨平台复用**未核实；材料里有 native modules 和 Python 包，按平台复用会出错。

---

## 三、侧重检查

我按你给的侧重逐项查了这些路径：

- **错误路径**：空目标首装、目标服务不存在、目标目录为空、`/lib64` 不存在、首签名公钥缺失、uid/gid 冲突、artifact 数量为 0、平台不匹配、Python/fd 材料缺失。结论：首装、uid/gid、签名密钥是硬失败；`/lib64` 有现成 helper，但 A3 改法会破坏解析。
- **不合规范/不可信输入**：实例文件的 `platform` 字符串、hostname、artifact manifest 的 `platform.arch`、materials 文件名列表、`readOnlyToolchainPaths`、S0 readback、`runPolicy` 键。结论：`verify-artifact.mjs:147-156` 会核对 artifact 与主机 arch，这是好的；但安装脚本/collect/capture 仍写死 x64，且 instance `platform` 没有看到枚举校验。
- **安全**：生产 SQLite/Memory 复制到与 CI 同机的 Oracle、生产密钥/签名密钥、gid 988 与 `gh-ci-share`、runner 访问本机端口、`ubuntu` 的 docker/sudo、ufw/VCN。结论：B 和 E 的组合是最大风险；A5 的副作用关闭不完整。
- **资源耗尽**：CI runner CPU/内存/磁盘、在 Oracle 上原生构建、根盘 10 GiB + 1 GiB 预留、`/tmp/hXXXX` scratch、构建与生产争用。结论：CPU 上限不够；需要内存/磁盘/任务数和 OOM 监控，构建最好不在生产机。
- **不可撤销的操作**：authority transfer、epoch/fencing +1、cloudflared 切换、心跳迁移、复制生产数据、建服务账号、apt hold/GRUB。结论：C 的 epoch/fence +1 与 runbook 一致；但 cutover 顺序、回退、心跳先停旧再启新没写。
- **规则/文档/代码一致**：ADR 0253 与线程方案、prompt-prefix 规则、I-73、probe-sources、platform-assumptions、CI runner runbook。结论：A3 的 `probe-sources.json` 说法错误；A1/A3 会触发 `check:platform-assumptions` 的计数变化但方案没提；A4 与 `make-packet`/`deploy.sh` 代码不一致。

---

## 四、如果由我来定，我会怎样改这份方案

1. **先做平台显式化，但先不改生产流程**：集中一份 `platform` 配置；把 `ARTIFACT_PLATFORM_KEYS`、`make-packet`、`run-packet-checks`、`build-candidate`、`collect-installer-dependencies`、`capture-build-source-inputs`、fd/Python 下载、`aggregate` 全部改成从配置取；加平台矩阵测试，证明 x64 默认值不变、ARM 选 ARM、错配被拒。
2. **ARM 构建放到独立 ARM 机器或隔离的临时 VM**，不要在生产/CI 同机做构建；构建账号无 sudo、无生产目录、无本机回环访问；产物必须通过原生模块加载（better-sqlite3、rename-native、onnxruntime）和真实 ARM 浏览器走查。
3. **单独实现 first-install**：新包生成器/安装器，跳过 `discover`/`read_s0`/`S2_STOP`/`S3_COPY51`，支持空库、空目录、新 uid/gid、新 hostname、新签名密钥；在空 VM 上做反向测试，证明旧 `deploy.sh` 会拒绝。
4. **把 uid/gid、hostname、签名密钥路径、acceptanceUid 全部参数化**，加预检：uid/gid 已被占用、gid 与 CI runner 共享、首签名公钥缺失，都拒绝出包/上线。
5. **验证副本不要放 CI 同机**；如果必须同机，生产 uid/gid 与 `gh-ci-share` 分离、刷新 runner nft、验证副本用独立密钥、复制完整 Memory 目录、重建目录 grant、做 integrity/hash/解密检查。
6. **加显式 validationOnly 模式**：在服务装配层关闭所有出站通道和后台 worker，用白名单断言；实测没有外部连接/推送后再用生产数据。
7. **authority transfer 按 runbook 原样做**，另加 cutover 清单：ufw/VCN 只开 22、Cloudflare 隧道/DNS、OAuth 回调、web push、心跳先停旧再启新、失败回退到 Contabo。
8. **系统锁定按 Oracle 实际包名/GRUB 做**，不照抄 Contabo；显式关自动重启，保留重新验收后解锁的流程。
9. **CI 同机优先改成不同机**；不能改时，CPU/内存/磁盘/任务数、nft 端口刷新、runner 账号组隔离、OOM 监控一起做，不能只设 CPU 上限。
10. **把以上每条落成门槛**：平台矩阵、first-install 空机夹具、uid/gid 冲突夹具、签名密钥缺失/轮换测试、validationOnly 外部连接测试、runner 端口刷新测试、SQLite/Memory 完整性测试。

---

## 五、逐条回答必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？

**按方案目前的 prompt 相关部分，不会。** 但有几个前提必须守住。

- 发给模型的内容仍然是：工具定义 → 系统提示 → 历史 → 最后一条用户消息；每轮变化的值放在最后一条消息的上下文块里。规则见 `.agents/instructions/prompt-prefix.md:27-37`（固定在前、会变的在后；每轮会变的内容只放最后一条用户消息）。
- 运行环境说明是追加在最后一条用户消息里的：`packages/runtime-pi/src/runtime-environment-block.ts:114-133` 生成 `runtimeEnvironmentMessage`，`:135-154` 的 `splitRuntimeEnvironment` 只在内容变化时把它作为 environment block 附加；`apps/agent-service/src/production-run-policy.ts:83-101` 生成 environment，`:192-239` 渲染命令/工作目录/搜索/抓取。A1/A3 改变的是沙箱命令清单和只读目录，属于 environment block，不是系统提示或工具定义；迁移后第一次在 ARM 上运行时会追加一份新的 environment，旧历史不变，所以仍然是“只在末尾追加”。
- A4/A5/C 改的是主机、配置、receipt、数据；只要不改 `runPolicy.systemInstruction`、模型、推理强度、回答语言、数据分类和工具集合，就不动请求头。
- **必须避免的坑**：A5 如果为了关副作用把 `runPolicy.coding`、`publicSearch`、`publicFetch` 也删掉，会改变 `runCapabilityNotice`（`production-run-policy.ts:169-185`）进入系统提示的文字；C 如果换了模型或 systemInstruction，也会改变请求头。要关副作用，用运行模式/装配层开关，不要删这些会影响系统提示的配置。

结论：**是只在末尾追加；每轮会变的值在最后一条消息里。** 前提是 A5 不删 coding/search/fetch，C 保持模型与系统提示不变。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

**按当前 helper 的写法，不会引入新的不确定性。** 但实现时要守住顺序。

- `packages/testing/src/read-only-toolchain.mjs:5-23` 按输入顺序处理，`Promise.all` 保持顺序，`[...new Set(resolved)]` 保持首次出现顺序；同一台机器、同一组输入，结果稳定。
- `sandbox-command-inventory.ts:26-63` 的候选命令是固定数组，`:128-134` 按 `runtimeCommands` + `candidates` 固定顺序输出，`readdir` 只用于判断存在性，不决定输出顺序。
- `webProviderNames`（`production-run-policy.ts:187-190`）按配置的 provider 顺序输出。
- `cloud-seal` 的 `new Date().toISOString()` 只进 receipt/capability，不进模型请求；`runtime-environment-block.ts` 里没有时间字段。

风险点：如果 A1/A3 的实现用了 `Object.keys`、数据库返回顺序、未排序的 `readdir`，或把 `Set` 直接序列化，就会产生字节差异。建议加一条“同一输入重复渲染两次，字节完全一致”的测试，并把所有列表显式排序或固定顺序。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

**现有检查有一部分，但方案没有新增关键用例，而且 A1/A3 会先弄坏几道现有检查。**

现有可用：
- `npm run check:prompt-prefix`：检查请求头是否只追加；但它不会覆盖“ARM 平台选择/首装/uid”这些路径。
- `scripts/check-platform-assumptions.mjs`：按文件比较写死 x86 的次数；A1/A3 改代码后计数会变，**不更新 `scripts/platform-assumptions.json` 就会失败**（`:99-114` 对“多了”和“少了”都报）。
- `scripts/check-probe-sources.mjs`：只检查 `probe-sources.json` 里的三个 built 文件；**不覆盖 cloud-seal/probe 脚本**。
- `run-packet-checks.py` 的 `verify-s6-report-contract.py`、`check-packet-consistency.py`：能抓 S6/S7 字段契约，但不抓 uid/gid 写死、首装空机。
- `test_make_packet.py:496-505` 的 `SandboxReadPathsTest`：会解析 `cloud-seal` 的字面量；A3 改成 helper 调用会让它失败（这算是“反向用例”，但方案没说要改）。
- `browser-acceptance-gate.py`：只校验 artifact sha 和场景，不校验跑验收的机器架构。

**缺的反向用例**：
- `artifactPlatformKey("linux", "arm64")` 现在抛错，改成返回 `linux-arm64` 后要有测试；x64 仍返回 `linux-x64`。
- `make-packet` 用 ARM 实例时必须选中 ARM artifact；混入 x64 artifact 必须被 `verify-artifact` 拒绝。
- 空目标首装：旧 `deploy.sh`/`make-packet` 必须拒绝，新 first-install 必须通过。
- uid/gid 冲突：目标 uid 999 已存在时必须拒绝；gid 988 与 CI runner 共享时必须拒绝。
- 首签名公钥缺失时必须拒绝；新密钥生成后 receipt/S7 必须通过。
- validationOnly 模式下不能有任何外部连接/推送。
- runner 新端口（8400/3425/3430）必须被 nft 挡住。

结论：**现有检查不足以覆盖这份方案；而且 A1/A3 会触发 `check:platform-assumptions` 和 `test_make_packet` 的现有失败。** 方案必须把“更新清单/测试”写成实施步骤，并补上述反向用例。

### 4. 改动产生或修改的每个值，每个使用它的地方都能接受吗？

逐个核对后，**不是每个都能接受**。关键值如下：

| 值 | 产生处 | 使用处 | 结论 |
|---|---|---|---|
| `platform`（`linux-x64`/`linux-arm64`） | 实例文件 | `make-packet`、`run-packet-checks`、`build-candidate`、`collect-installer-dependencies`、`capture`、`aggregate`、`verify-artifact` | **不能全部接受**：多处仍写死 x64；`ARTIFACT_PLATFORM_KEYS` 没有 `linux-arm64`；`local.mjs:31` 会直接抛错 |
| `architecture`（`x64`/`arm64`） | artifact manifest、receipt | `verify-artifact.mjs:147-156`、`cloud-protected-prepare.mjs:40`、`S7-startup-readback.mjs:119` | 运行时校验能接受 arm64；但安装/收集/捕获脚本仍要求 x64，需同步 |
| `serviceUid/serviceGid` 999/988 | 实例、模板、`cloud-inputs.draft.json` | S6、S7、run-step、finalize、observe、cloud-protected-prepare | **不能接受**：目标机 999=ocarun、988=gh-ci-share；必须参数化并换值 |
| `hostname` `himawari-prod` | 实例、模板、receipt | `discover`、S6、S7、finalize | 只有目标机实际主机名持久化为该值才接受；否则 `PACKET_HOST_UNEXPECTED`/`STARTUP_RECEIPT_HOST_CHANGED` |
| `osRelease` `7.0.0-1013-oracle` | receipt | `cloud-protected-prepare`、S7、deploy-preflight | 只有内核锁定/GRUB 固定后才接受；换内核即拒绝 |
| 首签名公钥路径 | qualification | `cloud-seal`、S7、`cloud-protected-prepare` | **不能接受**：新机没有 `first-20261007`，`FIRST_SIGNING_KEY_REQUIRED`；复制源私钥又违反 runbook |
| Python 材料名/摘要 | `make-packet.py:49`、toolchain lock | `artifact-install.mjs:23,53`、`build-candidate.sh:75` | 名字写死 `python-3.12.10.tar.gz`；换 ARM 文件名会 `P5_MATERIAL_NAME_INVALID`，必须一起改 |
| fd 材料名/摘要 | 包清单、`cloud-inputs.draft.json` | `download-question-12.py`、`run-network-preparation.py`、`question-12-inputs.json` | 全部写死 x86_64；ARM 需换官方 aarch64 资产并更新所有摘要 |
| epoch/fencing token | authority transfer | import/activate、S7 | +1 与 runbook 一致，**这一条判断正确**；但目标 state root 必须为空、源写者必须全停 |
| `runPolicy` 外呼键 | 验证副本配置 | `service-main.ts`、`production-web-push.ts`、memory worker | 只关 `proactive`/`realEval`/`museIntake` **不够**；需显式 validationOnly 白名单 |
| `toolchainSha256` | `ci/toolchain-lock.json` | `context.mjs:143`、`aggregate.mjs:310-311`、`verify-artifact` source inputs | 改锁文件会改 x64 context；A1 的“x64 产出字节不变”可能不成立 |

---

**一句话总结**：这份方案的方向（ARM 原生构建、平台显式化、先验证再切权威）是对的；但 A4 首装、uid/gid、签名密钥、A2 构建链、A3 摘要清单、B 数据安全、A5 副作用关闭和 E 的 runner 隔离，都是会真实失败或留下安全口子的点。建议按上面的顺序重排，先把“首装”和“值两端”做成可执行、可反向测试的路径，再谈切换。
