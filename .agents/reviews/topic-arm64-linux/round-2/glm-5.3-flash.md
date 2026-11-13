# 方案审核：linux-arm64 支持方案 v2（基准 6e33c029）

## 侧重检查

我走的一条最普通流程：**ARM 测试机上跑一次本地 CI（`scripts/ci/local.mjs`）到沙箱集成测试**。路径：

1. `local.mjs:20-27` 平台白名单（PR2 放行 linux-arm64）→ 2. `install-tools.mjs:25` 平台列表 + `validateToolchainLock`（**卡住**，见问题 1）→ 3. `runCheck("build")` → `build.mjs:109/133` 平台名与产物记录（PR2 替换）→ 4. `test.mjs:151`/`browser.mjs:128` 从产物 manifest 读平台（PR2 替换）→ 5. `npm test` 里沙箱测试走 `test/fixtures/product-path-harness.ts:1593-1601` 等夹具 → 6. `compileSandboxPolicy`（`policy.ts:114-116`）对清单逐条 `canonicalPath`，缺失即抛。

结论：主链在方案里有对应改动；**没有测试覆盖的路径**是 `install-tools.mjs` 在 ARM 上的校验与安装审计（问题 1/2）、`cloud-seal.mjs` 的可选跳过逻辑（该脚本目前没有任何直接单测，只有 5 处文本扫描门）、以及「GITHUB_ACTIONS 下禁止合成」这条反向规则（方案提了，没说落成哪个测试文件、归属哪个项目）。文档一致性：`docs/runbooks/ci-vps-runner-runbook.md:105` 把含 `--symlink usr/lib64 /lib64` 的 bwrap 自检写进 CI VPS 手册，isolation.ts 若改，手册要跟着改，方案没提。

## 按严重度排列的问题

**1.（高，证实）ARM 锁文件过不了现有校验器，与「主锁一字节不改」矛盾。**
`scripts/ci/install-tools.mjs:25` `const platforms = ["darwin-arm64", "linux-x64"]`；`:80-83` `platformArtifacts` 用 `fields(value, platforms)` 断言每组下载物**恰好**只有这两个平台的键。独立的 `ci/toolchain-lock.linux-arm64.json` 若带 linux-arm64 条目，走同一个 `validateToolchainLock` 必然失败；若把 `linux-arm64` 加进 `platforms`，主锁文件里没有该键的每组下载物立即失败——而主锁不能改。方案没有给出解法。**建议**：为 ARM 锁写独立校验器（或校验器按「平台集合是参数」重构，主锁调用法不变），并在方案里写明；同时保留 Node 基线 22.22.3、npm 11.8.0 等合同断言。

**2.（高，证实）ARM 装机在证据链上没有身份：装的东西不在任何被记录的锁摘要之下。**
`context.mjs:143` `toolchainSha256: fileSha256(ci/toolchain-lock.json)` 只认主锁；`install-tools.mjs:417/567` 把它写进 installation.json；`check-coverage.mjs:134`、`export-evidence.mjs:117` 把锁字节摘要与 context 比对；`required.mjs:28`、`main-evidence.mjs:277`、`aggregate.mjs:288` 都直接读主锁。「只在 linux-arm64 上合并进内存」之后，ARM 机的安装和证据会被记在**主锁的摘要**名下，但实际装的并不是那个锁锁定的东西。这是 I-73 的镜像：「一个值只在一端认」——这里是一端记录、另一端实际装了别的东西。**建议**：要么给 context/证据加独立字段（如 `toolchainArm64Sha256`），两端都校验；要么在方案里明确声明并写文档：ARM 测试机的工具链在锁合同之外、不产生任何参与必过门槛的证据。

**3.（中偏高，可证伪的推测被当成了改动依据）isolation.ts 的 `--symlink usr/lib64 /lib64` 大概率在 ARM 上本来就能过，这个子项改动不该做。**
方案自己把「isolation 自检不改时在 ARM 上是否通过」标为未核实，却直接安排了改动。查证：bubblewrap 的 `--symlink SRC DEST` 是「在沙箱内 DEST 处创建指向 SRC 的符号链接」，不需要宿主机上存在该路径（man 页原话 "Create a symlink at DEST with target SRC"，https://github.com/alexlarsson/bubblewrap/commit/da38d86508ba6fe05fca03212e3b5b78a66eaf08 中 bwrap.xml 的条目；上游仓库 https://github.com/containers/bubblewrap ）。自检（`packages/platform-node/src/capabilities/isolation.ts:528-554`）其余全是沙箱内操作。改成条件化有三个代价：现有单测 `capability-isolation.unit.test.ts:99` 的假 bwrap 硬编码要求出现该参数，探测函数一旦默认按宿主机判定，macOS 开发机（无 /usr/lib64）上这条测试就会失败；在没有 /usr/lib64 的 x64 发行版上行为会偏离现状，违背「x64 不变」的承诺；`ci-vps-runner-runbook.md:105` 手册步骤也要改。**建议**：先在 ARM 机实测自检；通过就不动 isolation.ts（最小 diff），失败再另出方案。

**4.（中，证实）cloud-seal.mjs 是被多处「源码文本扫描」锚定的，方案只点名了其中两处。**
读它源码文本的门：`deploy-preflight.py:83`（正则抽 `readOnlyToolchainPaths: [`…`protectedPaths: [`，`:123-128` 抽路径）、`test_make_packet.py:470-484`（两个切点：`'].map('` 和 `'protectedPaths: ['`）、`test_deploy.py:144`（按同一种文本格式伪造 seal；`:551` 还把真实模板复制进夹具包跑部署检查）、`apps/agent-service/test/sandbox-command-inventory.unit.test.ts:76-80`（断言块内路径字面量**恰好**等于 `SANDBOX_READ_ROOTS` 的 17 条）、`test/tooling/walkthrough-command-permissions.test.mjs`（`directoryOperations`、`bashDirectoryOperations` 切点）、`test/tooling/sandbox-memory-manifest.test.mjs:11`（`maximumResourceCeiling` 正则）。这些都对结构调整敏感：挪出字面量会失败，好在全部是 fail-closed。**建议**：方案明确约束「可选/必选的区分写在块内，路径字面量数组保持扁平、留在原块」，并把这份门清单写进 PR1 的验收项，禁止实施者以「改格式」为由放宽任何一个门。

**5.（中，证实）新增交付侧模块与探针副本的记账范围写小了。**
`test_make_packet.py:24` 的 `ADDED_FILES` 是固定集合，往 packet-template 加新文件必须登记，否则 `TemplateTest`（`:322-327`，对照 `twelfth-frozen-sha256.json` 全量哈希）失败。探针副本的指纹散落在多个清单：`fixtures/twelfth-frozen-sha256.json:43-53`、`acceptance/cloud/carry-forward-audit.json`、`acceptance/cloud/question-12-inputs.json:37-42`、`adaptation-manifest.json`、`r2l6-source-manifest.json`、`acceptance/OWNED-SHA256SUMS`、`cloud-inputs.draft.json`——而 `check:probe-sources`（`probe-sources.json`）只记 `job-host-main.ts`、`sandbox-sdk.ts`、`sandbox-sdk-worker.ts` 三个源文件的指纹（I-79，`docs/incidents-and-gates.md:117`），**不管探针脚本副本**。方案写「同步 check:probe-sources 的指纹记录」指错了对象。`signing/cloud-seal.mjs` 已在 `INTENDED_CHANGES`（`test_make_packet.py:33`），这点是好的。**建议**：把上面这些清单逐一列进 PR1 的改动清单。

**6.（低，证实）新函数语义要与现状精确对齐，否则「x64 值级基线」不成立。**
现状是**对 realpath 结果**去重（`cloud-seal.mjs:335-352`、`product-path-harness.ts:1593-1601` 都是 `new Set(await Promise.all(...map(realpath)))`）。方案说「保序去重」，必须写明去重发生在 realpath 之后、清单存的是 realpath 结果；可选集合要显式枚举（沿用现有 `/etc/mime.types` 等 4 条的 ENOENT 容忍写法），不能让「全部条目都可选」。另注：merged-/usr 的机器上 `realpath('/lib')`=`'/usr/lib'` 由去重自然吸收，不必特判。

**7.（低，推测）ARM 上「模型可见命令清单」与沙箱真实能力可能出现 I-64 镜像式的不一致。**
命令可达性判断用静态的 `SANDBOX_READ_ROOTS`（`sandbox-command-inventory.ts:4-22`），`sandboxCanRead` 把 `/lib64` 映射到 `/usr/lib64` 后两边同映射比较（`:70-86`），所以即使 ARM 的 seal 清单里已没有 /usr/lib64，清单仍会把经 /lib64 的链接判为可达。概率低（arm64 Ubuntu 的 /usr/bin 命令少有经 /lib64 的链接），但建议 ARM 验收时加一条：模型可见的 available 清单与沙箱内真实执行逐条对得上。

**未核实**（代码外，无法从仓库核实）：前提 1 的机器实测数字（198/101）；Debian 邮件列表链接的内容；Playwright 各浏览器 linux-arm64 发行物是否齐全（webkit 存疑，影响 PR2/PR3 的 browser 检查在 ARM 上能否跑）；semgrep/gitleaks/actionlint 的 ARM 发行物；fd aarch64 的实际文件名与 SHA-256（方案要求固定进清单，须真下载核实）。

**已核实为正确的方案前提**：SRT seccomp helper 含 arm64（`srt-runtime-identity.ts:8-11`）；资格 schema 接受 arm64（`sandbox-qualification-v1.ts:45-46`）；policy.ts 严格校验（`policy.ts:64-72`）；`check-srt-boundary.mjs:149-165` 先过滤存在再 realpath（先例成立）；cloud-seal.mjs:334-364 与各前提行号全部对上；context.mjs:143、local/build/run/test/browser/install-tools 各行号对上；出包链写死 x64 的各处（`make-packet.py:385/428`、`run-packet-checks.py:163`、`hermes/build-candidate.sh:44/46`、`capture-build-source-inputs.template.mjs:115`、`artifact-install.mjs:14`、`collect-installer-dependencies.mjs:15`、`download-question-12.py:14`）对上；`cloud-protected-prepare.mjs:38-41` 按真实机器核对回执。业界对标成立：Anthropic sandbox-runtime `src/sandbox/linux-sandbox-utils.ts` 原话「A directory that is not there is skipped: bwrap cannot bind a missing source」（https://github.com/anthropics/sandbox-runtime/blob/main/src/sandbox/linux-sandbox-utils.ts ——注意完整路径是 `src/sandbox/`，方案里写的路径不完整）。

## 必答问题

**1. 会不会改变模型已见过的请求开头？** 不会，且「只追加、变化值在最后」两条都成立。本方案触及的唯一模型可见值是沙箱可用命令清单：`production-run-policy.ts:83-101` 把 `sandboxCommands` 放进 `runtimeEnvironmentNotice`，作为 `runtimeEnvironmentRef` 只出现在每轮最后一条消息（规则第 2 条明确把「运行环境说明」归入最后一条消息）；系统提示由固定的 `HIMAWARI_IDENTITY + systemInstruction + capabilities` 组成（`production-run-policy.ts:105-123`），不含本方案改的任何值；`SANDBOX_READ_ROOTS`、候选命令顺序方案明确不动。ARM 机的命令清单与 x64 不同是机器差异，本来就住在最后一条消息里。`check:prompt-prefix` 不需改、照常通过。

**2. 会不会让同一段文字在不同请求里变成不同字节？** 不会。方案不往模型请求加任何字段；新增值（seal 清单、平台名、ARM 锁）都不进模型请求，且清单生成「逐条 realpath + 保序（去重）」在同一主机上确定。唯一注意点是问题 6 的去重语义必须与现状对齐。

**3. 有没有对应的自动检查、反向用例会不会真失败？** 方向对，但有缺口：cloud-seal.mjs 目前没有任何直接单测，只有 5 处文本扫描门（问题 4 列举）；方案承诺的反向用例（EACCES 必抛、必选缺失必抛、x64 上 /lib64 必在清单、policy 拒绝不存在路径）需要落成测试并登记归属（`check:ci-policy` 的 planTestInventory 要求每个测试文件恰好一个归属）。「x64 /lib64 必在清单」的反向保护现成：把字面量挪出块会立即让 `sandbox-command-inventory.unit.test.ts:80` 的计数断言和 `test_make_packet.py:477-481` 失败。isolation 子项的反向失败恰好反证它不该做（问题 3）。

**4. 每个产生/修改的值，两端都能接受吗？** 逐值核对结果：seal 清单——产生（cloud-seal.mjs、6 处夹具/资格脚本、探针及副本）→ 使用（`sandbox-host-binding-v1.ts:92` 只查字面量形态、`sandbox-host-verifier.ts:252-255` 只 lstat 清单内的条目、`sandbox-host-binding-v1.ts:121/134` 与 `production-sandbox-control.ts:883/943` 的包含关系、`compileSandboxPolicy` 的严格 canonicalPath、bwrap 绑定、deploy-preflight 与 sandbox-command-links 的文本扫描）：除问题 4 的文本耦合外都能接住，且宽容只放生成层的设计正确。isolation symlink——产生与使用（单测 :99、runbook :105）两端都要改，方案没提（问题 3）。平台名——x64 映射不变、托管 CI 不改，一致。ARM 锁——两端对不上（问题 1/2），必须先解。

## 如果由我来定

1. **PR1 保留**（生成层可选跳过 + 夹具/探针共用函数 + 值级基线 + 反向用例），补四件事：可选集合显式枚举、去重语义对齐现状、新文件登记 `ADDED_FILES`、枚举全部文本锚定门并声明不许放宽。
2. **从 PR1 里删掉 isolation.ts 子项**，先在 ARM 机实测自检；通过即零改动（连 runbook 都不用动）。
3. **PR2 保留方向，先解决两个矛盾**：ARM 锁用独立校验器；证据链加独立摘要字段或在文档里明确 ARM 装机在锁外。浏览器检查的 ARM 可行性先实测再写进验收。
4. **PR3 保留**，按 I-73 把「谁产生、谁使用、两端校验、哪道检查守着」落成逐值表格；fd aarch64 的 SHA-256 真下载核实后固定。
5. 给 PR1 补一个 ADR（边界生成行为变化），并更新 `docs/adr/0118` 中「出包时会取真实路径」一句的表述（改为「必选条目仍必须存在，可选条目缺失时跳过」）。
