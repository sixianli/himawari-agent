# 方案：把 Himawari 生产从 x86-64 迁到 Oracle ARM64（第一阶段不切流量）

## 一、方案依赖的前提（每条附来源和原话）

### 已核实：现有链路的事实

1. **现有上线包是“升级包”，不是“首装包”。** `make-packet.py` 在发现阶段要求目标机服务处于 active：`scripts/delivery-mode/make-packet.py:328-329` 原话 `if facts.get('active') != 'active': refuse('PACKET_SERVICE_NOT_ACTIVE', ...)`；上线前检查同样要求 active：`scripts/delivery-mode/deploy-preflight.py:184` 原话 `('SERVICE_ACTIVE', facts.get('active') == 'active')`。它还读取旧的 `authority.json`、旧配置和旧 unit（`make-packet.py:1035-1038,1055`）。
2. **出包、安装、验收只认 x64。** `scripts/delivery-mode/packet-template/install/__PKT_LABEL__-artifact-install.mjs:14` 原话 `process.platform === "linux" && process.arch === "x64"`；`install/collect-installer-dependencies.mjs:15` 同样；`hermes/build-candidate.sh:44-46` 原话 `report=$out/report/build-linux-x64`、`linux-x64-abi127-...`；`make-packet.py:509` 原话 `materials.glob('linux-x64-abi127-' + commit + '-*-1.tar.gz')`；`run-packet-checks.py:166` 同样。
3. **产物平台键还没有 ARM。** `scripts/ci/platforms.mjs:15` 原话 `const ARTIFACT_PLATFORM_KEYS = Object.freeze(["macos-arm64", "linux-x64"]);`；`:19-20` 原话 `throw new Error(\`CI_ARTIFACT_PLATFORM_UNSUPPORTED: ${key}\`)`。所以即使 `buildPlatformKey` 已认 `linux-arm64`，ARM 上跑 `local.mjs --check build` 仍会在产物命名处失败。
4. **Node 运行时不在包里，摘要写死 x64。** `packet-template/install/p5-materials.json:5-6` 原话 `"nodeAlreadyInstalled": true`、`"nodeSha256": "e6ec2c188d83d813f81f2de8aea084d74dce603ac1abedd0a30ad941b10087b2"`。同一摘要出现在 `packet-template/` 下 9 个文件（`S6-service-read.py:63`、`S7-switch-start-readback.py:144`、`S7-startup-readback.mjs:91`、`sign-__PKT_LABEL__.sh:16`、`observe-production-npm.py:111`、`maintenance-common.mjs:446`、`S9-control-files.py:307`、`bindings.draft.json:62`、`p5-materials.json:6`）。
5. **ARM 工具链条目已经存在。** `ci/toolchain-lock.json:23-27` 原话 `"linux-arm64": { "filename": "node-v22.22.3-linux-arm64.tar.gz", ... }`；`:75-79` 有 `cpython-3.12.10+20250529-aarch64-unknown-linux-gnu-install_only_stripped.tar.gz`。
6. **原生依赖必须按目标平台构建。** `ci/toolchain-lock.json:1582-1588` 对 `better-sqlite3` 原话 `"decision": "build"`；`scripts/package-node-runtime.mjs:118-127` 用 `cc ... rename-native.c` 在构建机上编译 `rename-native`。
7. **封存脚本无条件对 `/lib64` 取真实路径。** `packet-template/signing/cloud-seal.mjs:342` 原话 `"/lib64"`，`:351` 原话 `realpath(p)`。ADR 0253 的 PR 1 只在测试包加了可选跳过：`packages/testing/src/read-only-toolchain.mjs:3` 原话 `OPTIONAL_TOOLCHAIN_PATHS = Object.freeze(["/lib64"])`，`:11-17` 原话 `catch (error) { if (error?.code === "ENOENT") continue; ... }`；这份函数没有进上线包。
8. **首装需要新的主机身份和签名根。** `cloud-seal.mjs:441` 原话 `firstPublicKeyPath = root + "/qualification/first-20261007/host-qualification-public-key.pem"`；`:446` 原话 `"FIRST_SIGNING_KEY_REQUIRED"`。`cloud-protected-prepare.mjs:38-41` 原话 `assert.equal(hostname(), receipt.host)`、`assert.equal(process.arch, receipt.architecture)`、`assert.equal(release(), receipt.osRelease)`。
9. **权威迁移要求目标机独立装好，且 epoch/fence 各加一。** `docs/runbooks/authority-transfer-runbook.md:272` 原话 `目标 epoch 与 fencing token 必须各等于源值加一`；`:274` 原话 `目标 host 的配置、秘密、能力部署快照和本平台 runtime root 必须独立准备；迁移包不携带机器秘密、可执行绑定或平台资格`；`:201` 原话 `导出一旦进入 retired_pending_transfer，源部署不能自动恢复为 active`。
10. **同一 Cloudflare tunnel 的多个 connector 是副本，会分走流量。** https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-availability/ 原话 `Replicas do not support traffic steering`。所以 Contabo 的 token 不能在新机器上启动。
11. **SQLite 文件跨架构可移植。** https://www.sqlite.org/onefile.html 原话 `SQLite databases are portable across 32-bit and 64-bit machines and between big-endian and little-endian architectures.`
12. **Node 的 GNU/Linux arm64 是一级支持平台。** https://github.com/nodejs/node/blob/main/BUILDING.md 的平台表；https://nodejs.org/dist/v22.22.3/SHASUMS256.txt 有 `node-v22.22.3-linux-arm64.tar.xz`。
13. **Magpie 有 ARM 发行物。** https://github.com/yetone/magpie-releases/releases 有 `magpie-cli-linux-arm64`。
14. **better-sqlite3 有 ARM 预编译包，但项目选择从源码构建。** https://github.com/WiseLibs/better-sqlite3/releases/tag/v12.11.1 有 `better-sqlite3-v12.11.1-node-v127-linux-arm64.tar.gz`；项目仍按 `ci/toolchain-lock.json` 的 `"decision": "build"` 构建。
15. **模型请求只追加、按对话冻结、遮盖确定。** `.agents/instructions/prompt-prefix.md:4` 原话“发给模型的内容包括系统提示、工具定义、历史、资料块、遮盖和压缩”；`:27-30` 原话“固定的在前，会变的在后”“每轮都会变的内容只放在最后一条用户消息里”；`:42` 原话“系统提示和工具按对话冻结”；`:54` 原话“一条消息遮成什么样，只能取决于它自己和它前面的内容”。
16. **生产上线只能走生成器和 deploy.sh，服务器构建/测试不在 Mac 上跑。** `.agents/instructions/delivery-mode.md:29` 原话“生产变更由 Claude 自己执行……`bash scripts/delivery-mode/deploy.sh <frozen packet directory>`”；`:21` 原话“在云服务器上以 `himawari-ci` 身份或在 Hermes 上运行它们；绝不在 MacBook 上运行”。
17. **大改动先出方案。** `.claude/rules/owner-standing-rules.md:25-29` 原话“大改动先出方案、讨论后再动工”“方案先和 Andy 讨论，他同意之后才能改代码、改文件或开 PR”。
18. **内核和受检查程序被锁定，上线前检查会读重启后进哪个内核。** `docs/runbooks/production-server-access-runbook.md:65` 原话“GRUB 长期默认启动 6.8.0-142-generic……apt-mark hold 了……bubblewrap、socat、bash、ripgrep”；`:66` 原话“上线前检查会读重启后进哪个内核”；`deploy-preflight.py:193-194` 原话 `NEXT_BOOT_KERNEL_IS_RUNNING_KERNEL`、`RUNNING_KERNEL_MATCHES_QUALIFICATION`。
19. **I-73 的教训：只看改动本身不够，要核对每个值的产生处和使用处。** `docs/incidents-and-gates.md:112` 原话“双模型复核只看了 diff，没问「清单里的 id 能通过后端校验吗」”。

### 未核实/推测（实现前必须实测）

- 目标机 `himawari-prod` 上 uid 999/gid 988 是否空闲；现有 CI runner、docker、`oracle-keepalive.service` 是否占用。
- 目标机是否有 `/usr/bin/socat`；`cloud-seal` 要求 `bwrap`、`socat`、`bash`、`rg` 四个系统工具都存在且 root 拥有（`cloud-seal.mjs:194-200`）。
- Oracle 内核 `7.0.0-1013-oracle` 的 apt 包名、GRUB 菜单项格式、`unattended-upgrades` 是否会自动重启；`deploy-preflight.py` 的 GRUB 解析器能否直接读 Oracle 的 `grub.cfg`。
- `onnxruntime-node` 在当前锁定版本是否有 linux-arm64 原生文件；如果没有，本地 ONNX embedding 在 ARM 上不可用，必须显式禁用或另找方案。
- ARM 上 Playwright Chromium 能否安装；ADR 0253 只说“ARM 机上显式安装 Playwright 的浏览器”，本次没有实测。
- fd v10.5.0 的 `aarch64-unknown-linux-musl` 发行物 URL、SHA-256 和压缩包内成员名；本次没有从官方 release 取到可信值（GitHub 页面被 403），实现时必须从官方 release 页面钉死。
- reminders 是否有独立开关；`runPolicy.proactive` 不配置时不创建轮询（`apps/agent-service/src/service-main.ts:1983` 起），但提醒发送端是否单独可控未核实。
- 同机 CI runner 的 Docker 是否能读到 `/opt/himawari`、`/var/lib/himawari`；如果能，同机不是安全边界。
- 权威迁移能否在“只验证、不激活”的状态下跑一遍真实数据；runbook 有 inactive-ready，但没有本次目标机的现场证据。

---

## 二、方案本身

### 2.0 总体判断

这次不改模型请求组装，只改**出包、安装、封存、验收、运维**。核心做法是：

1. **先把“平台”变成参数**，让同一套生成器能产出 `linux-x64` 和 `linux-arm64` 两种包；x64 的默认值保持今天的字节和行为。
2. **新增独立的“首装包（bootstrap packet）”路径**，专门用于从没装过 Himawari 的新主机；现有升级包保持不变。
3. **首装包在新机器上跑完整验收、生成新的主机签名根和安装回执**；`cloud-protected-prepare` 的断言一行不改，新回执必须自己通过它。
4. **第一阶段用独立验证实例和一致性备份**，不碰 Contabo 的数据库、tunnel、心跳和主动推送。
5. **第二阶段走已有的停机权威迁移**，新机器用自己的 config、secret、能力快照和新的 Cloudflare tunnel。

### 2.1 代码改动与 PR 顺序

建议 5 个 PR，按顺序做，每个都能单独回退。

#### PR 1：linux-arm64 产物平台化（x64 行为不变）

修的根本原因：产物平台键和所有包选择器写死 x64，ARM 构建在 `artifactPlatformKey()` 就失败，包也找不到 ARM 产物。

改动：

- `scripts/ci/platforms.mjs:15`：`ARTIFACT_PLATFORM_KEYS` 加入 `"linux-arm64"`。
- `ci/result.schema.json:233`、`ci/evidence.schema.json:123`：平台枚举加入 `"linux-arm64"`；如果 `scripts/ci/aggregate.mjs:219` 需要处理本地 ARM 结果，也一并加。
- 新增 `scripts/delivery-mode/platforms.json`：按平台钉住 `artifactPattern`、`abi`、`arch`、`nodeTar`、`nodeBinarySha256`、`pythonMaterial`、`fd`。x64 的值必须等于今天的常量；ARM 的 Node/Python 用 `ci/toolchain-lock.json` 的条目，fd 在实现时从官方 release 钉死。
- 新增 `scripts/delivery-mode/hermes/builder-arm.json`：固定主机名、workRoot、scriptRoot、source、tools、browsers、piToolBin、pythonMaterial；`build-candidate.sh` 按平台选择 `builder.json`/`builder-arm.json`，仍核对固定主机名，仍不从当前机器现场探测身份。
- `build-candidate.sh`、`run-release-walkthrough.sh`、`make-packet.py`、`run-packet-checks.py`：把 `linux-x64-abi127` 换成平台模式；默认仍是 x64。
- `scripts/platform-assumptions.json` 按新计数更新；`npm run check:platform-assumptions` 仍按次数拦。

验收：

- x64 的 golden 测试不变；同一提交的 x64 产物名、`context.json`、包参数不变。
- ARM 在 Oracle 上能产出 `linux-arm64-abi127-<提交>-...tar.gz`，`npm run check:delivery-packet`、`check:delivery-deploy` 通过。
- 反向用例：把 ARM 从 `ARTIFACT_PLATFORM_KEYS` 去掉，ARM 构建必须报 `CI_ARTIFACT_PLATFORM_UNSUPPORTED`。

#### PR 2：安装/签名材料平台化（x64 默认值不变）

修的根本原因：Node 摘要、Python 包、fd、`/lib64`、服务账号 uid/gid、主机签名根路径都写死 x64/Contabo；这些值在 ARM 上会产生或使用不一致。

改动：

- `p5-materials.json`、`bindings.draft.json` 和上述 9 个 node 摘要文件：把 `e6ec...` 换成 `__PKT_NODE_SHA256__`，由 `make-packet.py` 从 `platforms.json` 填入。x64 填入后必须仍等于 `e6ec...`，加 golden 测试。
- `artifact-install.mjs:14`、`collect-installer-dependencies.mjs:15`：`process.arch === "__PKT_TARGET_ARCH__"`；平台仍要求 `linux`。
- `make-packet.py:49` 的 `PYTHON_MATERIAL` 改为平台值；`build-candidate.sh` 的 `pythonMaterial` 从 builder 配置取。
- fd 的 URL/SHA/成员名改为占位符，覆盖 `question-12-inputs.json:13-14`、`download-question-12.py:16-17,109,121`、`run-question12-downloads.sh:63`、`cloud-inputs.draft.json:35-36`、`run-stage-03.py`、`run-network-preparation.py`、`prepare-runtime-tools.py:49,56,68`。
- `/lib64`：在 `packet-template/signing/` 放一个与 `packages/testing/src/read-only-toolchain.mjs` 语义相同的本地 helper（不要把这个测试包打进生产 runtime），`cloud-seal.mjs` 和 `scripts/operations/*seal.mjs` 的副本改用它；保留 `readOnlyToolchainPaths` 的字面数组，避免 `deploy-preflight.py:123-128` 的提取正则失效。
- `cloud-seal.mjs:441` 的 `first-20261007` 改成 `__PKT_FIRST_QUALIFICATION__`；首装时在新机器上生成新的主机签名密钥和 `first-<安装日期>` 公钥，绝不复制 Contabo 的私钥。
- `S1-publish-and-install.py:60-69,90`、`prepare-__PKT_LABEL__-snapshot.sh:65,72`、`run-cloud-acceptance.sh:10-17,74-75`、`run-question12-downloads.sh:10-17,68-69`、`cloud-inputs.draft.json:6`、`cloud-seal` 的 `acceptanceUid`：把 999/988 换成 `__PKT_SERVICE_UID__`/`__PKT_SERVICE_GID__`，由实例文件提供；加 `getent passwd/group`、`id -G`、home/shell、是否被其他服务占用的检查。

验收：

- ARM 在一次性测试账号里能装、能签名、能验收；错误 arch、错误 node 摘要、错误 uid/gid、错误 fd 都必须失败。
- x64 的 `p5-materials.json`、`bindings.draft.json`、签名/安装模板字节与今天一致（或至少行为一致，`check:delivery-packet`/`check:delivery-deploy` 通过）。
- 反向用例：去掉 `/lib64` 的可选跳过，ARM 封存必须报 `ENOENT`；把 `/lib64` 换成存在但坏掉的符号链接，必须报错而不是跳过。

#### PR 3：首装包（bootstrap）路径

修的根本原因：项目没有受支持的首装路径；升级包要求旧服务、旧配置、旧 authority。

改动：

- 新增 `scripts/delivery-mode/instances/andy-arm.json`：地址 `138.2.31.252`、主机名 `himawari-prod`、平台 `linux-arm64`、`serviceUid/Gid`（实测后钉住）、`expectedKernel`、`firstQualification`、`mode: first-install`。
- `make-packet.py` 增加 `bootstrap` 命令（或 `prepare --mode first-install`）：
  - 只读发现目标机：hostname、`uname -m`、`uname -r`、账号/uid/gid、目标路径是否不存在、`systemctl is-active himawari-prod.service` 必须不是 active、`himawari-heartbeat.timer` 必须不存在、cloudflared 配置必须不存在、端口、磁盘、bwrap/AppArmor、系统工具、GRUB/apt hold。
  - 在 ARM 构建账号上构建候选、在 ARM 上跑浏览器 walkthrough、取回材料。
  - 渲染首装包：新的 `himawari.first-install-bindings.v1`，没有 `oldPrefix/oldConfig/oldUnit`，只绑定目标主机事实和新安装身份。
- 新增首装步骤（可复用现有模板和模块，不复制安全校验）：
  - `S0-bootstrap`：创建 `himawari-prod` 账号/组、`/opt/himawari`、`/var/lib/himawari`，权限 0700/0750，root 拥有；确认 uid/gid 没被别的服务占用。
  - `S1-bootstrap-install`：从包里的 `node-v22.22.3-linux-arm64.tar.gz` 安装 `/opt/himawari/node`，核对解压后的 `bin/node` SHA 等于平台清单；然后走现有 `S1` 的安装核心（staging、copy packet、安装候选、独立读回）。
  - `S6-acceptance`：复用现有 `run-cloud-acceptance.sh`、`run-question12-downloads.sh`、`prepare-runtime-tools.py`、`cloud-seal`；它们本来就不要求旧服务 active，只要求账号/目录/候选存在（`run-cloud-acceptance.sh:46` 允许 `not-found`）。
  - `S6-sign-bootstrap`：生成新的主机签名密钥和 `first-<日期>` 公钥，运行 `cloud-seal` 生成新回执；`cloud-protected-prepare.mjs` 一行不改。
  - `S7-first-start-readback`：安装 `himawari-prod.service`，启动，读回 `cloud-protected-prepare` 通过、服务 active、无自动重启。
- 新增 `deploy-bootstrap.sh`：复用 `generated-packet-gate.py`、`script-checkout-gate.py`、`browser-acceptance-gate.py`、`release-cleanup.py`，但预检是**服务不存在、目标路径不存在、state root 为空**；`deploy.sh` 拒绝首装包，首装脚本拒绝升级包，避免两种包混用。

验收：

- 在一台干净 ARM 主机/账号上完成首装、完整验收、新回执、`cloud-protected-prepare` 通过。
- 反向用例：服务 active、`/opt/himawari/releases/*` 已存在、hostname/arch/kernel 不符、node 摘要不符、bwrap/系统工具缺失、`himawari-heartbeat.timer` 已启用、cloudflared 已配置，首装预检都必须失败。

#### PR 4：ARM 生产资格与副本安全

修的根本原因：ADR 0253 把 ARM 定为测试/资格平台、“线上不切换”；第一阶段需要安全的并行副本，目标机又与 CI runner 同机、内核会自动更新。

改动：

- 新增 ADR（当前看到最大号 0281，建议 0282）：把 linux-arm64 提升为生产目标，修订 ADR 0253 的“线上不切换”和“ARM 包标为非生产候选”；保留“ARM 不进必过 CI 检查”的 CI 部分，除非 Andy 另定。
- 增加“并行/验证配置”：
  - 不配置 `runPolicy.proactive`、`runPolicy.museIntake`、web push、reminder 发送端、Gmail OAuth、heartbeat、cloudflared。
  - **不删工具定义**，只关轮询/发送端，避免工具集合变化触发系统提示换新（`prompt-prefix.md:42,45`）。
  - 首装预检扫描 config 和 systemd：出现主动推送/定时任务/cloudflared/心跳就拒绝。
- 增加主机预检：端口 8400/3425/3430/20241 空闲、磁盘、uid/gid、`unattended-upgrades`、GRUB、bwrap/AppArmor、系统工具、没有 `himawari-heartbeat.timer`、没有 cloudflared 配置。
- 增加内核/系统工具锁定步骤：`apt-mark hold` 当前内核和 `bubblewrap/socat/bash/ripgrep`，`/etc/apt/apt.conf.d/52himawari-hold` 排除 `^linux-` 等，`GRUB_DEFAULT=saved` + `grub-set-default` 指向运行内核，关闭自动重启；任何内核/工具变化都必须重新验收并重新封存，不绕过 `cloud-protected-prepare`。
- 增加 systemd 资源控制：`himawari-prod.service` 用 `CPUWeight`/`MemoryMin`/`IOWeight`，CI runner 用 `CPUQuota`/`MemoryMax`；如果不动 CI runner 就改用独立 VM。

验收：

- 验证配置下没有任何主动推送/定时任务/cloudflared/心跳；反向用例：把 `runPolicy.proactive` 加回验证配置，预检必须失败。
- 内核与回执不一致时 `cloud-protected-prepare` 必须失败（现有断言，不改）。
- 同机隔离测试：CI runner 账号读不到 `/opt/himawari`、`/var/lib/himawari`；Docker 能绕过则记录为残余风险，交由 Andy 决定是否独立 VM。

#### PR 5：运维手册与切换步骤

- 更新 `authority-transfer-runbook.md`：加入 ARM 目标前置条件、新的 Cloudflare tunnel/心跳交接、回滚/反向迁移演练。
- 新增首装 runbook、数据同步与核对 runbook、内核/系统工具变更后的重新验收 runbook。
- 更新 ADR 0253/0266 的引用和“ARM 非生产候选”的表述。

### 2.2 ARM 候选包在哪里、怎样构建

**推荐：独立的 ARM 构建/测试主机，或现有 Oracle ARM 机上的专用非生产账号。**

- 不要用 `himawari-prod` 账号构建，不要把构建工具装进 `/opt/himawari`，不要在生产账号里跑 `npm test`。
- 构建账号（例如 `himawari-builder`）有自己固定的 `builder-arm.json`：hostname、workRoot、scriptRoot、source、tools、browsers、piToolBin、pythonMaterial 都提交进仓库，不从当前机器现场探测。
- 构建流程沿用 `build-candidate.sh`：固定主机名 → `flock` → `npm ci` → `scripts/ci/local.mjs --check build` → `layer3-verdict.py` → 取 `linux-arm64-abi127-...` → 生成 `source-build-inputs.json`、`node-modules.json`、`npm-ls.json`、Python 材料 → `SHA256SUMS`。
- 在 ARM 构建账号上跑 `run-release-walkthrough.sh`（Playwright ARM 浏览器），针对同一个 ARM artifact 生成 `browser-acceptance.json`。
- 产物必须可复现：干净检出、`npm ci` 锁文件、`sourceTreeDigestBefore == After`、无未提交改动、无跨架构二进制；`better-sqlite3` 和 `rename-native` 在 ARM 上从源码编译；`onnxruntime-node` 如果锁定版本没有 ARM 原生文件，构建必须显式失败或明确禁用本地 ONNX embedding，不能静默漏掉。
- 产物取回 Mac 后，由 Mac 上的 `make-packet.py prepare --instance andy-arm --target-platform linux-arm64` 生成包；构建材料按今天的方式在冻结后删除。
- 如果只能用同一台 Oracle ARM 机：用 `systemd-run` 瞬态 scope + `CPUQuota`/`MemoryMax` + 专用账号 + `ProtectSystem=strict` 隔离；但 Docker/CI runner 仍在同一内核上，不能当成安全边界。**这是 Andy 要拍板的取舍。**

### 2.3 新主机第一次安装和验收

**首装包和升级包是两条明确分开的路径，不是绕法。**

- 首装包：`make-packet.py bootstrap --instance andy-arm --target-platform linux-arm64`；只用于“服务不存在、目标路径不存在、state root 为空”的新主机。
- 首装步骤：创建账号/目录 → 安装固定版本的 `/opt/himawari/node` → 安装候选 → 跑现有 acceptance（沙箱探针、question-12 下载、浏览器 walkthrough）→ 生成新的主机签名密钥和 `first-<日期>` 公钥 → `cloud-seal` 生成新回执 → 安装 unit → 启动 → `cloud-protected-prepare` 通过。
- 现有升级包：首装成功后，主机有运行中的 release 和回执，之后用 `make-packet.py prepare --instance andy-arm --target-platform linux-arm64`，步骤和今天 x64 的升级包一样（S1/S2/S3/S6/S7/S8）。
- 关系：首装包只负责“平台 + 运行时 + 验收 + 回执”，不搬运生产数据和 authority；第二阶段用 `authority-transfer-runbook.md` 的 export/import/activate 把生产状态搬过来。这样首装验收不受生产数据/密钥影响，权威迁移仍走原有 critical 流程。
- 新回执绑定的是新主机的 hostname、platform、arch、osRelease；Contabo 的 x64 回执不能在新机器上用，反过来也一样（`cloud-protected-prepare.mjs:38-41`）。

### 2.4 第一阶段：数据同步和验证

- Contabo 继续服务，不停机、不切 tunnel。
- 在 Contabo 上用 SQLite 一致性备份（`VACUUM INTO`/`.backup`，或项目自己的 `backup create`）生成副本；复制到 ARM 后核对：
  - 文件大小、`PRAGMA integrity_check`、`foreign_key_check`；
  - 关键表行数（沿用 `s0-db/read-s0-db.mjs` 的 `historyTables` 和 `MIGRATION_COMPARED_TABLES`，再加 threads/runs/messages/memories 等实际关键表）。
- 在 ARM 上用**独立的验证 state root/prefix**恢复副本；不要指向 Contabo 的 state root，不要共享 SQLite 文件。
- 验证配置：关闭 `runPolicy.proactive`、`museIntake`、web push、reminder 发送端、Gmail OAuth、heartbeat、cloudflared；只保留模型调用、搜索、抓取、文件读写、记忆读写所需的路径。工具定义保持不变。
- 浏览器访问用**单独的测试 tunnel**或 SSH 端口转发；绝不在 ARM 上启动 Contabo 的 cloudflared token（Cloudflare 副本会分走真实流量）。
- 记忆读写：默认用合成/验证数据验证代码路径；如果 Andy 要求用真实记忆内容，走权威迁移包或重新加密的副本，不默认把生产 payload 密钥复制到 ARM。这是要拍板的点。
- 不双写：验证实例只写自己的副本；Contabo 的数据库不共享、不回写。不重复发消息：所有主动推送/提醒/心跳/cloudflared 在验证配置里都不存在；日志里检查没有 `proactive`、`web_push`、`reminder`、`heartbeat`、`cloudflared` 的出站行为。
- 不影响 Contabo：除了只读备份，ARM 不连 Contabo 的数据库、不连生产 tunnel、不发生产消息；CI runner 的资源隔离按 2.6。

### 2.5 第二阶段：切换的大致步骤（只设计，不执行）

1. 确认首装验收、验证实例、数据副本核对全部通过。
2. 选维护窗口，停 Contabo 服务及所有 writer；确认无活动 Run、无未释放沙箱；做最终一致性备份。
3. 在目标机独立准备生产 config、模型 provider 密钥、`payload-encryption`、`transfer-recipient`、能力部署快照；不复制 Contabo 的机器密钥。
4. 按 `authority-transfer-runbook.md` export（源进入 `retired_pending_transfer`）→ 目标空 `data/` 导入 → inactive-ready 验证 → 激活；目标 epoch/fencing 各等于源值加一。
5. 新建 ARM 专用的 Cloudflare tunnel/token，先用测试主机名验证，再把生产主机名的 CNAME 切到新 tunnel；停掉 Contabo connector。**不要在两台机器上同时用同一个 tunnel token。**
6. 启动 ARM 服务，验证 `cloud-protected-prepare`、readiness、真实问答、搜索、抓取、文件读写、记忆读写；确认没有重复推送/消息。
7. 启用 ARM 的 heartbeat，暂停/移除 Contabo 的 Healthchecks 检查，避免两个心跳互相掩盖。
8. 保留 Contabo 停机现场和切换前备份一个观察窗口；回滚按 runbook 的 reverse transfer，不手工改 authority/SQLite。
9. 观察窗口结束后再决定是否删除 Contabo 的旧数据/旧 tunnel。

### 2.6 新机器和 CI runner 同机、内核会自动更新

**同机：**

- 首选：给生产单独一台 Oracle ARM VM，现有机器继续做 CI。这样没有资源争抢、没有 Docker 越权、没有端口冲突。
- 如果必须同机：
  - 生产用 `himawari-prod` 账号，`/opt/himawari`、`/var/lib/himawari`、`/etc/himawari` 权限 0700/0750，root 拥有；CI runner 账号不能读。
  - 用 systemd slice/cgroup 给生产 `CPUWeight`/`MemoryMin`/`IOWeight`，给 CI runner `CPUQuota`/`MemoryMax`；不停止/不重配 CI runner 服务，除非 Andy 同意。
  - 预留 8400/3425/3430/20241；启动前检查端口空闲；`ufw` 只放行 22 入站，生产端口只绑回环。
  - 注意：CI runner 能跑 Docker 就是 root 等价，同机不是安全边界。如果 CI 任务不可信，必须独立 VM。这是 Andy 要拍板的点。
- 不动 CI runner 的代码、配置、服务；不碰 `oracle-keepalive.service`；不碰 docker。

**内核自动更新：**

- 首装封存前先锁定：`apt-mark hold` 当前内核 image/modules/headers 和 `bubblewrap/socat/bash/ripgrep`；写 `/etc/apt/apt.conf.d/52himawari-hold` 排除 `^linux-` 等；`GRUB_DEFAULT=saved` + `grub-set-default` 指向运行内核；关闭 `unattended-upgrades` 的自动重启；核对 `uname -r`、`grub-edenv list`、下一次启动内核。
- `cloud-protected-prepare` 的内核断言不改；内核一变，服务就应该拒绝启动。唯一受支持的路径是：安排维护窗口，更新后重新跑完整验收并重新封存，再上线。不要 `apt upgrade` 随手升级，不要改断言。
- Oracle 的包名/GRUB 菜单项和 Contabo 不同，必须只读实测后写进 `andy-arm.json`；如果 Oracle 不允许关闭自动内核更新，必须换独立 VM 或接受重新验收的频率。

---

## 三、考虑过但不选的做法及原因

| 做法 | 不选的原因 |
| --- | --- |
| 在 ARM 上伪造一个“运行中的旧服务”，继续用升级包 | 违反 Andy 的约束，也违反升级包的语义；会把首装和升级混在一起，容易误删/误覆盖。 |
| 把 Contabo 的 `/opt/himawari` 整个复制到 ARM | `better-sqlite3`、`rename-native`、`onnxruntime`、`fd`、node 都是架构相关的；跨架构二进制不可用，runbook 也要求目标独立装好。 |
| 第一阶段就用 Contabo 的 cloudflared token | 同一 tunnel 的多个 connector 是副本，会把真实流量分走（Cloudflare 原文 `Replicas do not support traffic steering`）。 |
| 在 Hermes 上交叉编译 ARM 产物 | 原生模块和浏览器 walkthrough 必须在真实 ARM 上跑；交叉编译不可信，也违反“在目标平台验收”的原则。 |
| 继续把 ARM 标为非生产候选、永不切换 | 与本次目标冲突；可以保留“先验收再提升”的顺序，但不能永远不切。 |
| 用 `rsync`/`cp` 直接复制运行中的 SQLite | 不是一致性备份；必须用 SQLite backup API 并核对 integrity/row counts。 |
| 把生产 payload 密钥默认复制到 ARM 验证实例 | 生产密钥扩散到第二台机器；默认用合成/验证数据，真实记忆验证走权威迁移包或重新加密副本。 |
| 把现有 Cloudflare tunnel token 直接搬到 ARM | 同上，会分流量；应新建 tunnel/token，先测试主机名，再切生产主机名。 |
| 通过删除工具定义来禁用主动推送/提醒 | 会改变工具集合，触发系统提示换新（`prompt-prefix.md:42,45`），改变模型已见过的请求开头；应只关轮询/发送端。 |
| 在生产账号里构建/跑测试 | 违反“不把构建工具和测试动作带到生产账号”；用专用构建账号或独立 VM。 |
| 改 `cloud-protected-prepare` 跳过内核/架构断言 | Andy 明确不许绕过；应锁定内核、重新验收、重新封存。 |
| 用 pm2 部署 | Andy 明确要求照搬 systemd 模型。 |

---

## 四、风险和反例

1. **首装包被误用成升级包**：可能清空/覆盖已有数据。反例：服务 active、目标路径已存在时，首装预检必须失败；包类型和部署脚本必须互相拒绝。
2. **ARM 产物漏掉原生依赖**：例如 `onnxruntime-node` 没有 linux-arm64 文件，构建却“成功”。反例：对每个原生模块做真实 import/加载测试；缺失时构建失败，不静默跳过。
3. **系统命令清单跨主机不同**：新对话在 ARM 上的系统提示与 x64 不同。反例：`check:prompt-prefix` 之外，增加“同一对话迁移后冻结提示逐字节不变”的测试；如果 Andy 要求跨主机完全一致，需要固定命令集合。
4. **同机 CI runner 的 Docker 越权**：CI 任务可读生产密钥/数据。反例：用 CI runner 账号实际尝试读 `/opt/himawari`、`/var/lib/himawari`、`/etc/himawari`；Docker 场景单列，不能靠文件权限证明隔离。
5. **内核自动更新导致服务启动失败**：`cloud-protected-prepare` 会拒绝启动。反例：模拟内核变化，确认服务拒绝；同时确认锁定步骤和重新验收流程可执行。
6. **uid/gid 999/988 在目标机被占用**：可能把文件给错服务。反例：`getent` 和 `id -G` 检查；占用时首装必须停下报告，不能改常量硬上。
7. **fd ARM 摘要/成员名钉错**：验收会失败，或更糟，下载到错误二进制。反例：从官方 release 钉死 URL/SHA，校验 `fd --version` 和压缩包成员名；本次未核实具体值。
8. **权威迁移是单向的**：激活后源不能自动恢复 active。反例：切换前做反向迁移演练；保留切换前备份和停机现场；回滚按 runbook，不手工改 authority。
9. **心跳/tunnel 双活**：两个心跳写同一个 Healthchecks 检查会掩盖故障；两个 connector 用同一个 tunnel token 会分流量。反例：用独立测试 tunnel/独立 Healthchecks 检查；切换时先停旧再启新。
10. **验收成本**：首装/第一阶段可能调用真实模型。反例：用测试 key/免费路由；预计超过 0.5 美元先问 Andy（`.claude/rules/owner-standing-rules.md:17`）。

---

## 五、需要 Andy 拍板的取舍

1. **生产是否独立一台 Oracle ARM VM**：独立 VM 解决 CI 同机、Docker 越权、资源争抢；同机省钱但需要接受残余风险。
2. **第一阶段是否允许把生产 payload 密钥放到 ARM 验证实例**：默认不允许，用合成数据；如果要验证真实记忆内容，需要明确授权和密钥处理方式。
3. **是否把 linux-arm64 提升为生产目标**：需要新 ADR 修订 ADR 0253 的“线上不切换”和“ARM 包非生产候选”。
4. **内核/系统工具锁定的代价**：接受这些包暂时收不到安全补丁；确定谁批准未来的重新验收窗口。
5. **构建位置**：独立 ARM 构建机，还是现有 Oracle ARM 机的专用账号；同机需要接受构建/测试与生产共享内核和资源。
6. **新主机签名根**：是否同意在 ARM 上生成全新的 `first-<日期>` 密钥，而不是沿用 `first-20261007`；这是新的主机信任根，不能复制 Contabo 私钥。
7. **第二阶段切换方式**：新建 Cloudflare tunnel 并切 DNS，还是先测试主机名再切；维护窗口长度；回滚用 reverse transfer 还是保留 Contabo 热备。
8. **切换后是否立即启用主动推送/心跳**：建议先观察一段时间再启用；启用时用独立的 Healthchecks 检查，避免和 Contabo 双活。
9. **是否把 linux-arm64 加进 CI 必过检查**：本方案不要求；如果加，Oracle 停机时会影响合并。
10. **同机 CI runner 的资源限制**：是否允许给 CI runner 加 systemd drop-in；如果不允许，只能靠独立 VM。

---

## 六、已核实 vs 推测

**读代码/一手来源证实的：**

- 升级包要求运行中服务、旧配置/旧 authority；首装没有受支持路径。
- 安装、出包、产物选择、Node 摘要、Python 材料、fd、`/lib64`、uid/gid、首签名根都有 x64/Contabo 写死。
- `ARTIFACT_PLATFORM_KEYS` 还没有 `linux-arm64`，ARM 构建会失败。
- `ci/toolchain-lock.json` 已有 ARM Node/Python；better-sqlite3 从源码构建；`rename-native` 用 `cc` 编译。
- `cloud-protected-prepare` 把主机名、平台、架构、内核绑定到回执。
- 权威迁移要求目标独立装好、epoch/fence+1、源 retired。
- SQLite 跨架构可移植；Node arm64 一级支持；Magpie 有 ARM 发行物；Cloudflare 同 tunnel 多 connector 是副本。
- 模型请求只追加、按对话冻结、遮盖确定；本次改动不碰这些代码。

**推测/未核实：**

- 目标机 uid/gid 999/988 是否空闲、`socat` 是否存在、Playwright ARM 是否可装。
- `onnxruntime-node` 当前锁定版本是否有 linux-arm64 原生文件。
- Oracle 内核包名、GRUB 菜单格式、`unattended-upgrades` 自动重启行为。
- fd v10.5.0 ARM 发行物的 URL/SHA/成员名。
- reminders 是否能单独关闭而不影响工具定义。
- 同机 CI runner 的 Docker 是否能读生产目录。
- 权威迁移能否在目标机“只验证不激活”地跑真实数据。

---

## 七、必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？

**结论：不会改变请求组装代码；按本方案的隔离和冻结做法，已见过的请求开头不变。**

- 本次要改的文件集中在 `scripts/ci`、`scripts/delivery-mode`、`scripts/package-node-runtime.mjs`、安装/签名/验收模板；这些都不在 `packages/runtime-pi`、`packages/prompt-catalog`、出口遮盖、历史存储的请求组装路径上（`prompt-prefix.md:4` 定义的范围）。
- 发给模型的内容仍然只在末尾追加：迁移不改变 `pi-runtime-adapter` 的追加逻辑；每轮变化的时间、记忆、运行环境说明仍只在最后一条用户消息（`prompt-prefix.md:27-30`）。
- 唯一可能影响模型可见字节的是沙箱命令清单 `apps/agent-service/src/sandbox-command-inventory.ts`。它进入系统提示，且依赖主机上实际可执行的命令。ARM 与 x64 的命令集合可能不同，**新对话**在 ARM 上会得到不同的系统提示；**已有对话**按对话冻结（`prompt-prefix.md:42`），迁移必须保留数据库里的冻结字节，不能触发 `thread prompt rebuild`。第一阶段用独立验证实例，不碰生产对话；第二阶段切换后已有对话继续用冻结提示，新对话才用 ARM 的清单。
- 禁用主动推送/定时任务不能通过删工具实现；应只关轮询/发送端，保留工具定义，否则工具集合变化会触发一次换新（`prompt-prefix.md:42,45`）。第一阶段用独立验证配置，第二阶段恢复生产配置，避免改变生产对话的工具集合。
- 如果实现时改了命令清单或工具集合，就会在换新点改变一次开头；那必须在 PR 里明确标出并请 Andy 同意。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

**结论：不会让同一段模型文本在同一对话的不同请求里变成不同字节；跨主机的新对话可能有不同的命令清单，但那是新提示，不是同一段文字被改写。**

- 出口遮盖代码不变；遮盖仍只取决于消息本身和它前面的内容（`prompt-prefix.md:54`），不依赖后面的内容。
- 新引入的时间字段（`cloud-seal` 的 `issuedAt`、`observedAt`、`new Date().toISOString()`；packet 的 `DATE`、`run_id`）只进入安装回执/能力清单/包参数，不进入模型请求。它们是有意的时间字段，不是模型输入。
- 命令清单是固定顺序：`SANDBOX_RUNTIME_COMMANDS` + `SANDBOX_COMMAND_CANDIDATES` 的固定数组顺序，`readdir` 只用于集合判断（`sandbox-command-inventory.ts:121-133`），所以同一主机上字节确定。跨主机可能不同（见第 1 条），但同一对话内不会因为请求顺序变化。
- 新包的 `sourceTreeDigest`、`node-modules` 使用排序后的记录（`collect-installer-dependencies.mjs:84` `entries.sort`；`package-node-runtime.mjs:303-308` 排序），不是无序集合。`cloud-seal` 的 `readOnlyToolchainPaths` 用 `Set` 去重，但它是沙箱策略，不是模型文本；顺序不影响模型字节。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

**有，但要新增；现有门槛不够。** 计划新增/扩展：

1. `platforms.mjs`：`artifactPlatformKey('linux','arm64') === 'linux-arm64'`；不支持平台仍抛错。反向：删掉 ARM 条目，测试失败。
2. 包生成矩阵：x64 输出 golden 不变；ARM 选 ARM artifact/python/fd/node 摘要；错误平台/错误摘要必须拒绝。反向：写死 x64，ARM 测试失败。
3. 安装脚本：arch 不符报 `P5_ENVIRONMENT_INVALID`；node 摘要不符报 `P5_MATERIAL_CHANGED`/`NODE_CHANGED`。反向：去掉检查，测试失败。
4. `cloud-seal`：`/lib64` 不存在时跳过；存在但坏掉的符号链接必须报错。反向：恢复无条件 `realpath`，测试失败。
5. 首装预检：服务 active、目标路径已存在、hostname/arch/kernel 不符、node 摘要不符、bwrap/系统工具缺失、heartbeat/cloudflared 已存在，逐项必须失败。反向：去掉任一检查，对应用例失败。
6. 验证配置：出现 proactive/muse/webpush/heartbeat/cloudflared 必须拒绝；模拟运行中不得有出站推送。反向：把 `runPolicy.proactive` 加回，测试失败。
7. 提示迁移：源数据库里的冻结提示迁移到 ARM 后逐字节相同；`check:prompt-prefix` 通过。反向：重新生成提示或改工具集合，测试失败。
8. 数据同步：SQLite backup 的 integrity/foreign key/row counts 与源一致；篡改副本必须失败。反向：跳过核对，测试失败。

**诚实说明：** 本次没有改代码，也没有运行这些用例。每个 PR 必须按项目规则先提交“修之前失败”的证据，再提交修复后的通过结果。现有 `check:prompt-prefix` 已有反向用例；新增的 ARM/首装/副本安全用例要挂在同一类门槛下，不能只做单测。I-73 的教训是“只看了 diff，没问清单里的 id 能通过后端校验吗”，所以每个值都要有端到端测试。

### 4. 每个值的产生处和使用处是否都能接受？

下面按 I-73 的要求逐个列。**“已核对”表示我读了产生处和使用处；“需实测”表示代码上已定位，但目标机现场未验证。**

| 值 | 产生处 | 使用处 | 两端校验/风险 |
| --- | --- | --- | --- |
| `linux-arm64` 产物平台键 | `scripts/ci/platforms.mjs:24-28` `buildPlatformKey`；`scripts/ci/build.mjs:134` `artifactPlatformKey` | `build-candidate.sh:44-46`、`run-release-walkthrough.sh:31`、`make-packet.py:509,552`、`run-packet-checks.py:166`、`ci/result.schema.json:233`、`ci/evidence.schema.json:123`、`aggregate.mjs:219` | **已核对：** `ARTIFACT_PLATFORM_KEYS` 现在没有 `linux-arm64`，构建会抛 `CI_ARTIFACT_PLATFORM_UNSUPPORTED`；result/evidence schema 枚举也没有，记录会被拒。必须全部加，且 x64 golden 不变。 |
| `TARGET_ARCH`/`process.arch` | 实例文件 + `platforms.json` | `artifact-install.mjs:14`、`collect-installer-dependencies.mjs:15`、`S1:39-41`、`cloud-seal` 的 `architecture`、`cloud-protected-prepare.mjs:40` | **已核对：** 安装脚本写死 `x64`；`cloud-protected-prepare` 比较 `process.arch` 和回执 `architecture`。ARM 回执必须是 `arm64`。需正反向测试。 |
| `nodeSha256` | 平台清单/目标观察 | `p5-materials.json:6`、`bindings.draft.json:62`、`S1:40`、`artifact-install:28`、`S6-service-read.py:63`、`S7-switch-start-readback.py:144`、`S7-startup-readback.mjs:91`、`sign-...sh:16`、`observe-production-npm.py:111`、`maintenance-common.mjs:446`、`S9-control-files.py:307`、`finalize-bindings.py:169,213` | **已核对：** 全部写死 `e6ec...`；ARM 上观察到的 node SHA 不同，`finalize-bindings.py` 会交叉核对，必须全部换成平台值。需 ARM 实测和错误值拒绝。 |
| `serviceUid`/`serviceGid` | 实例文件/目标 `getent` | `S1:60-69,90`、`prepare-snapshot.sh:65,72`、`run-cloud-acceptance.sh:10-17,74-75`、`run-question12-downloads.sh:10-17,68-69`、`cloud-inputs.draft.json:6`、`cloud-seal` `acceptanceUid`、systemd `User/Group` | **已核对：** 多处字面 999/988；目标机可能被占用。必须从实例渲染，并核对 `getent`、`id -G`、home/shell、是否被别的服务占用。需实测。 |
| `pythonMaterial` 名称/SHA | `ci/toolchain-lock.json:75-79` + 平台清单 | `make-packet.py:49,515`、`build-candidate.sh:25,75`、`p5-materials.json:26-28`、`artifact-install:53-58`、`S9-clean-transport.py`、`finalize-bindings.py:215`、`verify-finalize-bindings.py` | **已核对：** `PYTHON_MATERIAL` 写死 x64；ARM 要用 `235d...` 的 aarch64 包。包内文件名可仍叫 `python-3.12.10.tar.gz`，但 SHA/来源必须换。需 ARM Python 3.12.10 实测。 |
| `fd` URL/SHA/成员名 | 官方 fd release（实现时钉） | `question-12-inputs.json:13-14`、`download-question-12.py:16-17,109,121`、`run-question12-downloads.sh:63`、`cloud-inputs.draft.json:35-36`、`run-stage-03.py`、`run-network-preparation.py`、`prepare-runtime-tools.py:49,56,68` | **已核对写死 x86_64；未核实 ARM 值。** ARM 需要 `fd-v10.5.0-aarch64-unknown-linux-musl.tar.gz` 的 URL/SHA/成员名；`fd --version` 必须是 `fd 10.5.0`，`prepare-runtime-tools` 会核对 `report['fdBinarySha256']`。实现时必须从官方 release 钉死。 |
| `hostname`/`address`/`kernel`/`osRelease` | 实例文件 + 首装发现 | `make-packet.py:326,438`、`S1:13`、`cloud-seal:34,496-499`、`cloud-protected-prepare:38-41`、`deploy-preflight:183,193-194`、`run-cloud-acceptance.sh:7,62`、`prepare-runtime-tools.py:29`、`run-question12-downloads.sh:7` | **已核对：** 新机是 `himawari-prod`/`138.2.31.252`/`7.0.0-1013-oracle`，Contabo 是 `vmi3618928`/`84.247.157.41`/`6.8.0-142-generic`。不能泄漏 Contabo 值；`cloud-protected-prepare` 要求精确匹配。需内核锁定和错误值拒绝。 |
| `first` 签名公钥路径 | `cloud-seal.mjs:441` 写死 `first-20261007` | `cloud-seal:442-446`；`cloud-protected-prepare` 从回执的 qualification 目录读公钥 | **已核对：** 新机没有 `first-20261007`。必须生成新的 `first-<日期>` 并参数化，或改连续性检查；不能复制 Contabo 私钥。需缺失/错误密钥拒绝。 |
| `qualificationRoot`/回执路径 | `make-packet.py` 的 `OLD_QUALIFICATION`、`cloud-seal:16`、`cloud-protected-prepare:13` | `deploy-preflight:150` `READ_QUALIFIED_KERNEL`；`cloud-seal` 写回执；`cloud-protected-prepare` 读回执 | **已核对：** 新机是新 qualification 目录；`deploy-preflight` 读最新回执的 `osRelease`。首装必须先产生回执。需无回执时 preflight 失败。 |
| `authorityEpoch`/`fencingToken` | 权威迁移 export/import | `deploy-preflight:143,180,189`、`authority-transfer-runbook:272,423` | **已核对：** 目标各等于源+1；源 `retired_pending_transfer`；目标 active。需核对目标 `authority.json` 和 SQLite 一致，不能两个 active。 |
| `config` 的 proactive/muse/webpush/heartbeat/cloudflared 键 | 目标 config/systemd | `service-main.ts:1983+`、`production-web-push.ts`、heartbeat runbook、cloudflared 服务 | **已核对部分：** `runPolicy.proactive` 不配置时不创建轮询；但 reminders/webpush 的独立开关未核实。第一阶段必须用验证配置，预检扫描这些键/服务，出现就拒绝。 |
| `systemToolPaths`（bwrap/socat/bash/rg）和 bwrap 0.11.2 路径 | 目标观察 | `collect-system-tools.mjs:7`、`cloud-seal:194-234`、`finalize-bindings.py:96-111`、`deploy-preflight` `SANDBOX_COMMAND_LINKS_REACHABLE` | **已核对路径；未核实目标机 socat。** 目标有 bwrap 0.11.2 和 AppArmor；必须确认四个工具都存在、root 拥有、不可写、可执行。缺失/错误 mode 必须失败。 |
| `readOnlyToolchainPaths` 的 `/lib64` | `cloud-seal:333-364`、`sandbox-command-inventory.ts:4-22` | 沙箱策略、命令清单 | **已核对：** ARM 没有 `/lib64`；`cloud-seal` 必须可选跳过，`sandbox-command-inventory` 的字符串匹配无害。需确认 `deploy-preflight.py:123-128` 的提取正则仍能读到字面数组，`sandbox-command-links.py` 不会因 `/lib64` 不存在而报错。 |

**结论：** 每个值都找到了产生处和使用处；其中 `nodeSha256`、`serviceUid/Gid`、`fd`、`/lib64`、`first` 公钥、`artifactPlatformKey` 是当前最可能“产生处改了、使用处没改”的地方，必须按 I-73 做端到端测试，而不是只看 diff。
