## 结论摘要

根因不是“ARM 不支持”，而是代码把 **x86-64 的 usrmerge 目录布局**（`/lib64`）和 **x64 的平台名字**当成了所有 Linux 的固定事实。SRT/seccomp、bwrap、Node ABI、资格 schema 本身已经有 arm64 支持（`packages/runtime-sandbox/src/srt-runtime-identity.ts:8-11`、`packages/execution-contracts/src/sandbox-qualification-v1.ts:45-46`），真正要改的是：

1. 生成 `readOnlyToolchainPaths` 时，对不存在的目录 **跳过而不是 `realpath` 抛 ENOENT**；对存在的目录仍然 `realpath`、去重、保序。
2. 平台名字从 `process.platform/process.arch` 统一推导，ARM 本地验证不进 hosted CI。
3. x64 的工具链锁和 `context.toolchainSha256` 保持不变，ARM 用独立的锁覆盖文件。
4. 出包/安装/资格链路里所有写死 `linux-x64` / `x64` / `abi127` / Hermes 主机身份的地方，改成从产物清单或构建配置读取并交叉校验。
5. 增加“同一平台值从产生到使用”的自动门槛，避免 I-73 的“清单里的 id 过不了后端校验”重演。

下面严格分开「已读代码/来源证实」和「推测/未核实」。

---

## 一、方案依赖的前提

### A. 已读代码或一手来源证实

| # | 前提 | 来源与原话 |
|---|---|---|
| P1 | 模型请求只允许在末尾追加；每轮变化的值只能放最后一条用户消息 | `.claude/rules/prompt-prefix.md:35`：「已经发给过模型的内容，不得改动、重排或删除，只能在末尾追加。」`:28`：「每轮都会变的内容只放在最后一条用户消息里。」 |
| P2 | 运行环境说明本身是“最后一条消息里、只有变化时才追加”的块 | `packages/runtime-pi/src/runtime-environment-block.ts:123-154`：`runtimeEnvironmentAfterCompaction` 在 `previousRuntimeEnvironment(...) === environment` 时返回 `undefined`；`splitRuntimeEnvironment` 只在内容变化时保留该块。`apps/agent-service/src/production-run-policy.ts:205-210` 把沙箱命令清单写进这个说明。 |
| P3 | 当前 ENOENT 的直接来源是对 `/lib64` 无条件 `realpath` | `scripts/delivery-mode/packet-template/signing/cloud-seal.mjs:334-364`：第一组 `["/usr/bin", ..., "/lib64", ...].map((p) => realpath(p))` 没有 `ENOENT` 处理；第二组才有 `.catch((error) => error?.code === "ENOENT" ? null : ...)`。同样的写法在 `test/fixtures/mac-sandbox-deployment.ts:135-158`、`test/fixtures/product-path-harness.ts:1593-1600`、`test/integration/sandbox-preparation-control.test.ts:580-596`。 |
| P4 | 沙箱策略要求工具链路径必须存在且是规范路径 | `packages/runtime-sandbox/src/policy.ts:64-72`：`if ((await realpath(value)) !== value) throw new Error("SRT_POLICY_PATH_NOT_CANONICAL")`，随后 `stat(value)`。所以只在 seal 里吞掉 ENOENT 不够，交给策略的每个路径都必须是已存在、已规范化的路径。 |
| P5 | 对不存在的只读来源，跳过是合理做法；不要用 `--ro-bind-try` 掩盖所有缺失 | bubblewrap 手册：「Equal to --ro-bind but ignores non-existent SRC」（https://github.com/containers/bubblewrap/blob/main/bwrap.xml）。Anthropic sandbox-runtime 源码注释：「A directory that is not there is skipped: bwrap cannot bind a missing source and there is nothing to rename. one that exists but cannot be inspected is still pinned」（https://raw.githubusercontent.com/anthropics/sandbox-runtime/main/src/sandbox/linux-sandbox-utils.ts，约 1896 行）。本仓库 `packages/runtime-sandbox/scripts/check-srt-boundary.mjs:149-165` 已经采用 `.filter((entry) => existsSync(entry)).map((entry) => realpathSync(entry))` 的正确先例。 |
| P6 | x64 产物/上下文的字节与工具链锁文件绑定，不能直接往共享锁里加 ARM 条目 | `scripts/ci/context.mjs:143`：`toolchainSha256: fileSha256(path.join(root, "ci/toolchain-lock.json"))`。`scripts/ci/build.mjs:107-125` 把这个 context 写进 `artifact-record.json`。`scripts/ci/verify-artifact.mjs:151-153` 逐字段比较 `record.context` 与 `context`。因此改 `ci/toolchain-lock.json` 会改变 x64 的 `artifact-record.json`，不再是逐字节不变。 |
| P7 | 工具链锁当前只接受两个平台 | `scripts/ci/install-tools.mjs:25`：`const platforms = ["darwin-arm64", "linux-x64"];`；`:80-83` 的 `fields(value, platforms, ...)` 要求键集合完全一致；`:464-465` 在运行平台不在列表时直接失败。`ci/toolchain-lock.json:13-22`、`:59-69` 也只有 `darwin-arm64` 和 `linux-x64`。 |
| P8 | 本地 CI 入口和平台标签写死为 Darwin ARM 或 Linux x64 | `scripts/ci/local.mjs:20-26` 只接受 `darwin-arm64` 和 `linux-x64`；`:38` 把非 Darwin 一律叫 `linux-x64`。`scripts/ci/build.mjs:133`、`scripts/ci/run.mjs:283/477/561`、`scripts/ci/test.mjs:151`、`scripts/ci/browser.mjs:128` 同样。`scripts/ci/aggregate.mjs:201` 更直接把消费者平台写成 `"linux-x64"`。 |
| P9 | 出包/安装/资格链路里有多处写死 x64 或 Hermes 主机身份 | `scripts/delivery-mode/make-packet.py:385/428`：`materials.glob('linux-x64-abi127-' + commit + '-*-1.tar.gz')`；`scripts/delivery-mode/run-packet-checks.py:163` 同样。`scripts/delivery-mode/hermes/build-candidate.sh:44-46`：`report=$out/report/build-linux-x64`、`linux-x64-abi127-...`；`run-release-walkthrough.sh:31` 同样。`hermes/capture-build-source-inputs.template.mjs:115` 要求 `process.arch === "x64"`、`os.hostname() === "hermes-home"`、uid 1000。`packet-template/install/collect-installer-dependencies.mjs:15`、`packet-template/install/__PKT_LABEL__-artifact-install.mjs:14` 都要求 `process.arch === "x64"`。 |
| P10 | 资格回执已经按真实主机绑定平台、架构、内核，schema 允许 arm64 | `scripts/delivery-mode/packet-template/signing/cloud-protected-prepare.mjs:37-41`：校验 `hostname()`、`process.platform`、`process.arch`、`release()`。`packages/execution-contracts/src/sandbox-qualification-v1.ts:45-46`：`platform: enumeration(["darwin", "linux"])`、`architecture: enumeration(["arm64", "x64"])`。`cloud-seal.mjs:498-499` 也写 `platform: process.platform, architecture: process.arch`。 |
| P11 | SRT 的 seccomp helper 和 pivot_root 已经支持 aarch64 | `packages/runtime-sandbox/src/srt-runtime-identity.ts:8-11` 同时有 `x64` 和 `arm64` 的 helper SHA-256；`:35-36` 接受 `x64`/`arm64`。`packages/runtime-sandbox/scripts/check-srt-boundary.mjs:53`：`PIVOT_ROOT = {"x86_64": 155, "aarch64": 41}[platform.machine()]`。 |
| P12 | 当前 ARM 上的 101 个失败是测试夹具/探针/seal 的 `/lib64` 假设，不是所有失败都与架构无关 | 本次材料实测：「101 条报错是 `ENOENT ... realpath '/lib64'`」；`test/fixtures/mac-sandbox-deployment.ts:147`、`test/integration/sandbox-preparation-control.test.ts:588`、`test/qualification/sandbox-install-restart-model.mjs:420` 都硬编码 `/lib64`。另有 JOB_HOST_NOT_READY、JOB_HOST_DEPENDENCIES_UNAVAILABLE、Playwright 缺失等，需单独归类。 |
| P13 | 验收辅助下载物里还有 x86_64 二进制 | `scripts/delivery-mode/packet-template/acceptance/cloud/download-question-12.py:14`：`fd-v10.5.0-x86_64-unknown-linux-musl.tar.gz`；`:88/:100` 按这个文件名解包。`run-question12-downloads.sh:63` 也把这个文件名和摘要写死。 |
| P14 | 部署预检从 seal 源码里抽取只读根列表 | `scripts/delivery-mode/deploy-preflight.py:83`：`SANDBOX_READ_ROOTS = re.compile(r'readOnlyToolchainPaths: \[(.*?)protectedPaths: \[', re.DOTALL)`；`:123-128` 再从块里 `re.findall` 出字符串。改 seal 时不能把这组字面量移出该块，否则预检会失效。 |

### B. 推测 / 未核实

- 未核实：ARM 上 `JOB_HOST_NOT_READY`、`JOB_HOST_DEPENDENCIES_UNAVAILABLE` 是否全部由 `/lib64` 或工具链路径引起；需要按失败堆栈逐条归类。
- 未核实：生产/资格用的 `runtimeRoot` 是由哪段安装脚本生成、是否包含 `/lib64`。我只确认了 `createLaunch` 把 `runtimeRoot` 通过 `--ro-bind` 挂到 `/`（`packages/platform-node/src/capabilities/isolation.ts:399-415`），没有追到它的构建来源。
- 未核实：`semgrep` 1.152.0 是否有完整可用的 `linux-arm64` wheel 闭包；这决定 `npm run check` 能否完整在 ARM 上跑，而不只是 `npm test`。
- 未核实：Oracle ARM 机器上 `/usr/bin/bwrap`、`/usr/local/libexec/bubblewrap-0.11.2/bwrap`、AppArmor profile、`socat`、`rg` 是否都已按生产要求安装。
- 未核实：Playwright 的 Chromium 在 ARM 上是否有可用的官方下载/系统浏览器替代；当前 7 个失败被材料归因为“没装 Playwright Chromium”，不是代码根因。
- 未核实：`make-packet.py` 的 Hermes 流程除上述写死项外，是否还有依赖 `hermes-home`、uid 1000、特定路径的隐含假设；我只读了 `Hermes` 类和 `build-candidate.sh`。

---

## 二、方案本身

### 阶段 0：先冻结 x64 的“值级”基线

不改代码，先在当前 x64 上记录这些**值**，作为后续比对基准：

1. `cloud-seal.mjs` 在 x64 上生成的 `readOnlyToolchainPaths` 完整数组（顺序、去重结果）。
2. `productPathToolchainPaths({platform:"linux"})` 经 `realpath` 后的结果。
3. `LinuxBubblewrapIsolationBackend` 的 `qualify()` probe 参数（尤其 `--symlink usr/lib64 /lib64`）和 `createLaunch()` 参数。
4. 固定输入下 `compileSandboxPolicy()` 的 `policyJson` 和 `policyDigest`。
5. `make-packet.py` 用现有 `twelfth` 夹具生成的 `packet-parameters.json` 中与平台/归档相关的字段。

注意：代码一改，整个源码摘要和归档 SHA 必然变化，所以“逐字节不变”只能证明到**值/序列化结构**这一层；不要承诺改代码后 x64 的整个 tar.gz 仍逐字节相同。可以承诺：相同输入下，平台相关列表、bwrap 参数、策略 JSON、artifact-record 的平台字段不变。

### 阶段 1：修沙箱根因（优先级最高）

**1.1 引入一个“存在才纳入、规范化、保序去重”的根路径解析器**

对候选路径逐个：

- `realpath(p)`；`ENOENT` → 跳过；其他错误（`EACCES`、`ELOOP` 等）→ 抛出，不能静默丢掉。
- `stat` 必须是目录。
- 按输入顺序 `new Set` 去重，不排序、不删除嵌套根，以保持 x64 现有顺序。

放在两处并互相测试：

- 产品/探针侧：`packages/runtime-sandbox/src/...` 的共享函数。
- 交付侧：`scripts/delivery-mode/packet-template/signing/` 内一个纯模块，供 `cloud-seal.mjs` 使用。

不要只改一处。现有 `check-srt-boundary.mjs:149-165` 已经是同思路，但它是先过滤再 realpath、并且过滤嵌套根；交付侧要改成“保留顺序、只跳 ENOENT”，否则 x64 的列表会变。

**1.2 改所有产生 `readOnlyToolchainPaths` 的地方**

- `scripts/delivery-mode/packet-template/signing/cloud-seal.mjs:334-364`：两组合并为一个解析器；**保留 `readOnlyToolchainPaths: [` 到 `protectedPaths: [` 之间的字面量列表**，满足 `deploy-preflight.py:83/123-128` 的抽取。x64 上结果与现在完全一致，ARM 上自动少掉不存在的 `/lib64`。
- `test/fixtures/mac-sandbox-deployment.ts:135-158`、`test/fixtures/product-path-harness.ts:1593-1600`、`test/integration/sandbox-preparation-control.test.ts:580-596`、`test/integration/prepared-file-runner.test.ts:265-280`、`test/qualification/sandbox-install-restart-model.mjs:408-420`：改用同一逻辑。
- `packages/runtime-sandbox/scripts/probe-*.mjs`、`packages/runtime-pi/scripts/probe-foreground.mjs`：同样处理。注意 `packet-template/acceptance/cloud/probe-source/...` 是这些探针的“携带副本”，要同步更新，并更新 `adaptation-manifest.json` / carry manifest 里的摘要；否则 packet 一致性检查会拒绝。
- `scripts/operations/hermes-*-seal.mjs`：这些是历史发布脚本，建议**不改**，以免破坏旧证据的可重放性；新资格走 `cloud-seal`。如果团队要求统一，另出一份兼容迁移，不要混在本次根因修复里。

**1.3 修 bwrap 自检里的 `/lib64` 符号链接**

`packages/platform-node/src/capabilities/isolation.ts:537-542` 无条件执行：

```text
--symlink usr/lib /lib
--symlink usr/lib64 /lib64
```

ARM 没有 `/usr/lib64`，会造出悬空链接。建议：

- 只有当被绑定的宿主根下 `usr/lib64` 存在时才追加第二个 `--symlink`；`/lib` 仍按约定处理。
- 为了可测，不要把 `existsSync("/usr/lib64")` 直接写死；给 backend/probe 注入一个根目录或文件系统探测函数，测试用临时目录分别模拟“有 lib64 / 无 lib64”两种情况。
- 现有 `packages/platform-node/test/capability-isolation.unit.test.ts:98-99` 的假 bwrap 同时要求两个 `--symlink`，要改成两种用例：有 lib64 时参数与 x64 基线完全一致；无 lib64 时只要求 `usr/lib`，并断言没有 `usr/lib64`。

**1.4 `SANDBOX_READ_ROOTS` 不要改成“只保留存在的”**

`apps/agent-service/src/sandbox-command-inventory.ts:4-22` 是**允许读取的候选根**，不是“必须存在”的列表；`:70-86` 的 `merged()` 已经把 `/lib`、`/lib64` 映射到 `/usr` 下的对应位置。ARM 上 `/lib64` 这个候选不会让任何真实命令变成可用，去掉它也不会让 ARM 多出命令，但改它会破坏 `apps/agent-service/test/sandbox-command-inventory.unit.test.ts:68-81` 与 seal 列表的相等性守卫，并可能让模型看到的命令清单变化。保持候选列表不变，只让“实际传给策略/封签的路径”跳过不存在项。

### 阶段 2：让 `npm test` 在 linux-arm64 跑起来

**2.1 统一平台名字**

新增一个函数（放在 `scripts/ci/contracts.mjs` 或独立小模块）：

```text
darwin + arm64 -> macos-arm64
linux  + x64   -> linux-x64
linux  + arm64 -> linux-arm64
其他           -> 明确报错，不猜
```

替换 `local.mjs:38`、`build.mjs:133`、`run.mjs:283/477/561`、`test.mjs:151`、`browser.mjs:128`。

- `test.mjs`/`browser.mjs` 最好从 `verified.manifest.platform` 推导（`os`+`arch`），而不是只看 `process.platform`，避免“在 ARM 上验证了 x64 包却标成 arm64”的 I-73 类问题。
- `aggregate.mjs:201`、`check-policy.mjs` 里的 hosted 矩阵、`ci/policy.json`、`ci/quality-policy.json` **不要改**：ARM 不进 GitHub 必过检查，也不应改变 x64 CI 行为。

**2.2 本地 build 矩阵只加 ARM 覆盖，不改 `ci/policy.json`**

`local.mjs:74` 用平台键调用 `execute("build", platform)`，而 `ci/policy.json:39-61` 只有 `linux-x64`/`macos-arm64`。建议：

- 给本地 `runCheck` 增加一个仅本地生效的 policy/member 覆盖参数；在 ARM 上克隆 build 成员，键改为 `linux-arm64`，`os:linux, arch:arm64`，其他超时/输出不变。
- 该覆盖不写入 `ci/policy.json`；hosted 路径完全不经过它。
- 不建议把 `linux-arm64` 加进 `ci/policy.json`：那会让 `check:ci-policy`、hosted matrix、`aggregate.mjs` 都要求 ARM job，直接违反“ARM 不能成为必过检查依赖”。

**2.3 工具链用独立 ARM 覆盖文件**

新增例如 `ci/toolchain-lock.linux-arm64.json`，只放 `linux-arm64` 的 Node 22.22.3、Python 3.12.10 等条目；Node/npm/headers 版本与主锁一致，URL 和 SHA-256 按官方发布物固定。

- `install-tools.mjs` 的 `loadToolchainLock()` 在 `process.platform+arch === linux-arm64` 时把覆盖合并进内存中的锁；`ci/toolchain-lock.json` 文件本身**一个字节不改**。
- `context.toolchainSha256` 继续只哈希主锁文件，保持 x64 artifact-record 不变；在 `installation.json` 里额外记录 `laneToolchainSha256` 供审计。
- 如果 `npm test` 只需要 coverage，可先让 ARM 的 `ci:tools` 使用 `--without-scanners`；如果要求 ARM 上也能跑 `npm run check` 的 gitleaks/semgrep，则覆盖文件必须补齐 actionlint/gitleaks/semgrep wheel 闭包。两者是一个需要拍板的范围问题，见后文。

**2.4 测试夹具与探针**

阶段 1 已覆盖 `/lib64`。另外：

- `scripts/ci/quality.mjs:176-184` 用 `${process.platform}-${process.arch}` 查 `nodeObservation.artifacts`；`ci/quality-policy.mjs:68` 只声明 `linux-x64`/`darwin-arm64`。这不在 `npm test` 路径上，但如果 ARM 要跑 `qualify:*`，需要另加 ARM 质量策略条目，或明确不支持。
- `scripts/check-gitleaks.mjs:22` 用 `${process.platform}-${process.arch}` 查工具；只有补齐 ARM scanners 后才可用。
- Playwright 缺失是环境前提，不要通过跳过测试“修复”；在 ARM 上安装官方 Chromium 或配置可用系统浏览器，否则那 7 个失败仍会被计为环境未就绪。

### 阶段 3：让出包链路接受 linux-arm64

原则：**所有平台值必须来自同一处，并在两端校验**，而不是每个脚本各自字符串替换。

**3.1 `make-packet.py` / `run-packet-checks.py`**

- 把 `linux-x64-abi127-` 改成从材料或构建配置读出的 `platform` 与 `abi`；匹配两个平台，最终仍要求“恰好一个归档”。
- 增加产物内部交叉校验：读取归档里的 `artifact-record.json`，确认 `platform.os === "linux"`、`platform.arch` 与目标一致、`abi` 与 Node 运行时的 `process.versions.modules` 一致。
- x64 现有 `twelfth` 夹具必须仍产生相同的 `ARTIFACT_NAME` 和 `candidate.*` 字段；加 golden/回归测试。

**3.2 `build-candidate.sh` / `run-release-walkthrough.sh`**

- `report=$out/report/build-$platform`、`$platform-abi$abi-...` 从 builder 配置/`context.json` 推导。
- 不要只把 `linux-x64` 换成 `linux-arm64`；值必须与归档中的 artifact-record 一致。

**3.3 Hermes builder 身份参数化**

`hermes/capture-build-source-inputs.template.mjs:115` 的固定断言是 ARM 出包的最大隐藏门槛：

```text
process.arch === "x64" && ... os.hostname() === "hermes-home" && uid === 1000
```

建议：

- 把 `platform`、`arch`、`hostname`、`uid`、Node 版本、ABI 作为 builder 配置字段，渲染进模板；断言“运行环境与配置一致”，而不是与 Hermes 字面量一致。
- `builder.json` 保持现有 x64 值；新增一个 ARM 的 builder profile（可由机器探测生成，避免写死 Oracle 主机名/路径），通过环境变量或参数选择。
- `make-packet.py` 的 `Hermes` 类改成按 profile 取 `platform/arch/hostname`，上传/执行逻辑不变。这样 x64 Hermes 行为不变，ARM 可复用同一套包结构。

**3.4 安装/依赖证据脚本**

- `packet-template/install/collect-installer-dependencies.mjs:15`（以及 `acceptance/helpers/collect-installer-dependencies.mjs:15`）不能要求 `arch === "x64"`；应要求 `platform === "linux"`，并断言 `process.arch` 与目标产物 `artifact-record.platform.arch` 一致。
- `packet-template/install/__PKT_LABEL__-artifact-install.mjs:14` 同样：从归档内 `artifact-record.json` 读期望平台/架构，再与当前进程比对；不一致给出明确错误码，而不是笼统的 `P5_ENVIRONMENT_INVALID`。
- 这直接对应 I-73：清单/产物里产生的 `linux-arm64` 必须能被安装端的平台校验接受，两端用同一映射。

**3.5 验收辅助物**

`download-question-12.py` / `run-question12-downloads.sh` 里的 fd 是 `x86_64-unknown-linux-musl`。如果 ARM 验收会走 question-12 流程，需要：

- 按架构选择 fd 发布物，并把 aarch64 的文件名和 SHA-256 固定到 manifest；
- 在下载前后校验“目标架构与包名一致”；
- 不要用“ARM 上也放一个 x86_64 fd”绕过。

### 阶段 4：ARM 上的资格验证与真实收发

按顺序做，任何一步失败都停下修根因：

1. 安装并验证 `bwrap 0.11.2`（`/usr/bin/bwrap` 与 `/usr/local/libexec/bubblewrap-0.11.2/bwrap`）、AppArmor profile、`socat`、`rg`、`bash`；用 `inspect-bwrap.mjs` 同样的身份检查记录版本、真实路径、SHA-256。
2. 用 ARM 工具链覆盖安装 Node 22.22.3/Python 3.12.10，跑 `npm test`；先确认 101 个 `realpath '/lib64'` 清零，再逐条归类剩余失败。
3. 跑真实沙箱探针：`check-srt-boundary.mjs`、foreground/network/workspace-access 探针，确认 `--unshare-all`、seccomp helper、只读根、写拒绝都实际生效。
4. 用 `ci/local.mjs --check build` 生成 `linux-arm64-abi127-...tar.gz`，检查 `artifact-record.json` 的 `platform.os/arch/abi` 和归档内原生模块（`better-sqlite3`、`onnxruntime-node`、`@napi-rs/canvas`）。
5. 用 ARM builder profile 走 `make-packet.py prepare`；跑 `run-packet-checks.py`、`deploy-preflight.py`（若目标是测试机则明确它是非生产预检）、`cloud-seal.mjs`、`cloud-protected-prepare.mjs --prepare`。
6. 核对 `installation-receipt` 的 `host/platform/architecture/osRelease` 与 ARM 机实际值一致；`verifySandboxHost` 必须通过。
7. 启动真实服务，用真实模型配置发一条消息并收到回复；记录请求/响应、数据库消息、日志和沙箱证据。这是人工验收，不能只靠 mock 测试。
8. 全程最后跑一次 `npm run check:prompt-prefix`（x64 或 ARM 均可），确认没有模型请求开头变化。

### 阶段 5：证明 x64 行为不变

建议新门槛（本地 + x64 CI 都跑）：

- **根路径解析器单测**：
  - 全部候选存在 → 输出与旧实现完全相同的顺序/去重结果；
  - `/lib64` 不存在 → 结果不含它，且不抛 ENOENT；
  - `/lib` 是符号链接 → `realpath` 成 `/usr/lib` 后去重；
  - `EACCES` → 必须抛出，不能跳过；
  - 反向用例：把“跳过 ENOENT”改成“跳过所有错误”，测试必须失败。
- **x64 基线快照**：固定 fixture 下 `readOnlyToolchainPaths`、bwrap probe 参数、`policyJson`/`policyDigest` 与阶段 0 记录逐值相等。
- **平台值一致性门槛**：给定归档，断言 `artifact-record.platform`、文件名里的 `linux-arm64`/`linux-x64`、`context`、builder profile、安装端期望值全部一致；故意把归档名或 receipt 架构改错，测试必须失败。
- **出包回归**：x64 `twelfth` 夹具的 `ARTIFACT_NAME`/`candidate.*` 不变；ARM 夹具能生成合法的 `linux-arm64` 名称并被 `run-packet-checks.py` 接受；两者互换必须被拒绝。
- **资格反向用例**：ARM 产物配 x64 receipt、x64 产物配 ARM receipt、`osRelease` 不匹配，都必须被 `cloud-protected-prepare`/`verifySandboxHost` 拒绝（现有 `cloud-protected-prepare.mjs:37-50` 已有基础，补成自动用例）。
- 现有 `npm test`、`check:delivery-packet`、`check:delivery-deploy`、`check:product-path-configuration`、`check:srt-boundary`、`check:prompt-prefix` 全部保持通过。

---

## 三、考虑过但不选的做法

1. **直接把 `linux-arm64` 加进 `ci/policy.json` 和 hosted CI**
   - 不选：违反“ARM 测试机可能被 Oracle 回收，不能成为必过检查依赖”，并且会改变 hosted 矩阵。保留为本地覆盖，ARM 不进必过门。

2. **把 `linux-arm64` 直接加进 `ci/toolchain-lock.json`**
   - 不选：`context.toolchainSha256` 哈希整个文件（`context.mjs:143`），会改变 x64 artifact-record 和所有 x64 产物的上下文字节。用独立覆盖文件，主锁字节不动。

3. **在 seal 里对 `/lib64` 用 `--ro-bind-try` 或吞掉所有 `realpath` 错误**
   - 不选：`--ro-bind-try` 会让“本该存在但被误删/权限坏掉的根”也静默消失，削弱权限边界；只应跳过明确的 ENOENT，并且只对“可选系统根”生效。其他错误必须 fail closed。

4. **把 `SANDBOX_READ_ROOTS` 改成运行时只保留存在的目录**
   - 不选：它是候选允许列表，被模型命令清单和 seal 列表相等性测试使用；改它会让 x64 的命令清单/封签列表语义变化。只改实际生成策略路径的地方。

5. **为了 ARM 让所有探针都“跳过失败”**
   - 不选：这会把真正的沙箱回归藏起来。ARM 必须实际执行 bwrap/seccomp 探针，而不是把失败标成 skip。

6. **改历史 `hermes-*-seal.mjs`**
   - 不选作为本次根因修复的一部分：它们是特定历史发布的签署脚本，改动会影响旧证据的可重放性。新链路走 `cloud-seal`，历史脚本保持原样；若要统一，另立迁移方案。

7. **在环境说明里加平台名/架构来“帮助模型”**
   - 不选：会把新的每轮/每机变化值带进请求；且没有必要。平台差异通过已有的命令可用性说明表达即可，且该说明本来就在最后一条消息里。

---

## 四、风险与反例

1. **跳过条件写宽**：把 `ENOENT` 写成“任何错误都跳过”会让权限损坏的 `/usr/lib` 静默消失，命令大面积不可用，甚至让某些路径落到更宽的根。反例测试必须覆盖 `EACCES` 抛出。
2. **x64 的 `/lib64` 被误判为不存在**：如果 helper 用错根（例如检查 `runtimeRoot/usr/lib64` 而不是实际绑定的 `/usr`），x64 会漏掉动态加载器路径，沙箱命令启动失败。x64 基线快照必须覆盖。
3. **符号链接规范化后去重顺序变化**：`new Set` 保留插入顺序；如果先排序再 realpath，x64 列表顺序可能变化，进而改变 policy JSON 和封签字节。必须“先 realpath，再按原顺序去重”。
4. **`deploy-preflight.py` 抽取失败**：如果把字面量列表移出 `readOnlyToolchainPaths: [...]` 块，预检会报 `PREFLIGHT_CHECK sandbox read paths not found`。保留字面量块是硬约束。
5. **ARM 上悬空的 `/lib64` 链接**：不改 isolation probe 虽然多数命令不影响，但会让“沙箱里存在 /lib64”成为假事实；某些探针/程序若探测 `/lib64` 会得到错误结论。应改成条件添加，并实际执行 ARM 二进制验证。
6. **产物/回执平台值不一致**：这是 I-73 的同类风险。`linux-arm64` 文件名、artifact-record、builder profile、receipt、安装脚本必须走同一个映射；任何一端只认 `linux-x64`/`x64` 都会让 ARM 包装不上或资格被拒。
7. **ARM 上浏览器/扫描器缺失被误当成平台失败**：Playwright、semgrep wheel 等是环境/工具链覆盖问题，不应通过改测试来“清零”；要么安装，要么明确排除并记录。
8. **x64 产物“逐字节不变”表述过度**：代码一改，源码摘要、归档内容、packet 文件哈希必然变化。能证明的是平台相关值、策略 JSON、bwrap 参数不变；不能证明整包 SHA 不变。方案和验收文档要把这句话写准确。

---

## 五、需要人拍板的取舍

1. **ARM 工具链覆盖的范围**：只覆盖 `npm test` 需要的 Node/Python，还是连 actionlint/gitleaks/semgrep wheel 一起覆盖，使 `npm run check` 也能在 ARM 跑？建议先做前者，ARM 只作为 `npm test` 和资格机；后者另开任务。
2. **ARM 是否要成为正式发布平台**：建议现阶段只做“一次性资格/验收包”，不进 `ci/policy.json`、不进 hosted 必过矩阵；等 ARM 机器稳定后再谈正式支持。
3. **Hermes builder 的改法**：把 `builder.json` 参数化为多平台 profile，还是新增一个完全独立的本地 builder 流程？建议前者，能复用现有包结构，也能保持 x64 Hermes 默认值不变。
4. **历史 `hermes-*-seal.mjs` 是否同步修 `/lib64`**：建议不改，避免破坏历史证据；如果团队要求所有脚本都能在 ARM 重放，再单独做兼容层。
5. **`/lib64` 不存在时 bwrap probe 的行为**：跳过符号链接（推荐）还是保留悬空链接但加注释。前者更符合“沙箱里的事实”，后者改动更小但会留下假路径。

---

## 六、必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里？

**不会改变请求开头。** 本方案不触碰系统提示、工具定义、历史消息、压缩和遮盖；改动集中在 CI 平台名、沙箱工具链路径、出包/安装/资格脚本。

模型唯一可能感知的是 `runtimeEnvironmentNotice` 里的“沙箱可用命令”文字（`apps/agent-service/src/production-run-policy.ts:205-210`）。这个块由 `runtimeEnvironmentAfterCompaction`/`splitRuntimeEnvironment` 控制，只有内容变化时才追加到最后一条消息，内容相同就不重复（`packages/runtime-pi/src/runtime-environment-block.ts:123-154`），符合 `.claude/rules/prompt-prefix.md:28/35`。ARM 上命令可用性可能和 x64 不同，但那本来就是该块要表达的“本机运行环境”，且只在末尾；x64 的候选列表和命令顺序保持不变。

依据：`.claude/rules/prompt-prefix.md:35`「已经发给过模型的内容，不得改动、重排或删除，只能在末尾追加。」`:28`「每轮都会变的内容只放在最后一条用户消息里。」

### 2. 这个改动会不会让同一段文字在不同请求里变成不同的字节？

**按本方案不会引入新的请求字节不确定性。** 不把 `process.arch`、主机名、时间、路径、工具链 SHA 等写进系统提示或工具定义；不新增按请求变化的遮盖规则。

需要守住的确定性点：

- `SANDBOX_COMMAND_CANDIDATES` 的顺序固定，`inspectSandboxCommands` 输出按这个固定顺序过滤（`sandbox-command-inventory.ts:120-134`），不依赖 `readdir` 顺序。
- 新根路径解析器按输入顺序去重，不排序、不依赖 `Promise.all` 的完成顺序（`Promise.all` 结果数组仍按输入顺序）。
- 不要把文件系统遍历结果、`Set` 的插入顺序以外的东西序列化进请求。
- 封印/资格值虽然在不同机器上不同（ARM vs x64），但它们不进入模型请求；如果未来进入运行环境说明，也只能在最后一条消息里，不能进系统提示。

依据：`.claude/rules/prompt-prefix.md:51`「同样的内容，每次都要序列化成同样的字节。JSON 的键顺序、工具的顺序、列表的顺序……都要固定」。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

有，且必须按“反向用例真的会失败”来设计：

- **根路径解析器单测**：不存在项跳过、存在项保留、`/lib` 符号链接规范化、`EACCES` 抛出；反向用例把 ENOENT 判断删掉/放宽，必须失败。
- **x64 基线快照**：固定 fixture 下 `readOnlyToolchainPaths`、bwrap 参数、`policyJson/policyDigest` 与旧值逐项相等；反向用例把 `/lib64` 从 x64 列表里误删，必须失败。
- **平台一致性门槛**：归档名、`artifact-record.platform`、`context`、builder profile、安装端期望值必须一致；分别改错一端，必须被拒绝。这直接复刻 I-73 的教训：不能只测“清单生成”，要把清单里的平台值交给安装/资格校验。
- **出包回归**：x64 `twelfth` 夹具输出不变；ARM 夹具生成合法 `linux-arm64` 名称并被 `run-packet-checks.py` 接受；x64/ARM 互换必须被拒绝。
- **资格反向用例**：ARM 产物 + x64 receipt、x64 产物 + ARM receipt、`osRelease` 不匹配，必须拒绝（`cloud-protected-prepare.mjs:37-50` 已有主机/平台/架构/内核比对基础）。
- **现有门槛**：`npm test`、`check:delivery-packet`、`check:delivery-deploy`、`check:product-path-configuration`、`check:srt-boundary`、`check:prompt-prefix` 继续跑。

`check:prompt-prefix` 仍是模型请求开头的阻断检查（`.claude/rules/prompt-prefix.md:74`），本次不需要改它。

### 4. 改动产生或修改的每个值，每一个使用它的地方都能接受吗？

逐个核对如下：

| 值 | 产生处 | 使用处 / 校验 |
|---|---|---|
| `linux-arm64` 平台名 | 统一平台函数（由 `process.platform/arch`） | `build.mjs` 文件名、`run.mjs` artifact 标签、`local.mjs` 输出目录、packet glob、安装/资格回执。使用处必须接受同一个映射；`aggregate.mjs:201`、`ci/policy.json` 继续只认 `linux-x64`，ARM 不喂给它们。 |
| `artifact-record.platform.arch = "arm64"` | `build.mjs:109`（`process.arch`） | `verify-artifact.mjs:37-41` 的 schema 已允许 `arm64`；`:146-157` 与当前进程比较。ARM 上生成/验证一致；x64 上仍是 `x64`。 |
| ARM 工具链覆盖文件里的平台键 | `ci/toolchain-lock.linux-arm64.json` | `install-tools.mjs` 的 `installTools`/`verifyInstalledTools` 必须用合并后的锁查表；`context.toolchainSha256` 仍只哈希主锁。x64 不使用覆盖文件。 |
| `readOnlyToolchainPaths` 条目 | `cloud-seal.mjs`、测试夹具、探针 | `compileSandboxPolicy` 的 `canonicalPath` 要求存在且 realpath 相等（`policy.ts:64-72`）；`job-policy.ts`/`job-host-main.ts` 做重叠检查；`srt-runtime-identity`/SRT 接受 arm64 helper。ARM 上不含 `/lib64`，x64 上保持原列表。 |
| bwrap 参数 `--symlink usr/lib64 /lib64` | `isolation.ts:537-542` | 只用于 probe/资格；x64 保留，ARM 在 `usr/lib64` 不存在时省略。测试 fake bwrap 需接受两种参数集。 |
| packet 归档名 `linux-arm64-abi127-...` | `build.mjs` 文件名 | `make-packet.py:385/428`、`run-packet-checks.py:163`、`build-candidate.sh:44-46`、`run-release-walkthrough.sh:31`、安装脚本。全部改成从平台值/artifact-record 推导；x64 生成值不变。 |
| `abi127` | `build.mjs:136`（`process.versions.modules`） | packet glob、安装断言、artifact-record schema（`verify-artifact.mjs:40` 目前是 `const: "127"`）。ARM 的 Node 22.22.3 也是 127，但应把 `127` 改成从 Node/ABI 动态校验；若未来 ABI 变化，不能写死。 |
| `process.arch === "x64"` 断言 | `collect-installer-dependencies.mjs`、`__PKT_LABEL__-artifact-install.mjs`、`capture-build-source-inputs.template.mjs` | 安装端/构建端。必须改成“linux + 与 artifact-record/builder profile 一致”；否则 ARM 包在第一道安装就失败。 |
| Hermes 主机名/uid | `builder.json`、capture template | 构建证据。改成 builder profile 字段并与运行时比对；x64 默认值保持 `hermes-home`/1000，ARM 用探测/配置值。 |
| fd 下载物 `x86_64-unknown-linux-musl` | `download-question-12.py`、`run-question12-downloads.sh` | ARM 验收若走 question-12，必须换成 aarch64 并固定 SHA-256；否则在 ARM 上执行 x86_64 二进制会失败。 |
| 资格回执 `platform/architecture/osRelease` | `cloud-seal.mjs`/`cloud-protected-prepare.mjs` | `verifySandboxHost` 与 `sandbox-host-verifier.ts:212-214` 比较当前主机；ARM 回执只对 ARM 有效，不会污染 x64 生产。schema 已允许 arm64。 |

I-73 的核心教训是：只测“清单生成”不够，必须把清单里的值交给实际使用端校验。本方案把平台值做成一条链：**构建产物 → artifact-record → 包名/安装脚本 → 资格回执 → verifySandboxHost**，每一段都做双向断言；任何一段仍只认 `x64`/`linux-x64`，对应反向用例就会失败。

---

## 七、最重要的实施顺序

1. 先修 `readOnlyToolchainPaths` 的 ENOENT 根因 + isolation probe 的 `/lib64` 条件链接；这是让 ARM integration 失败清零的关键。
2. 统一平台名，放行本地 `linux-arm64`，加 ARM 工具链覆盖，让 `npm test` 真正跑起来。
3. 再改出包/安装/资格链路的平台值和 x64 断言，补平台一致性门槛。
4. 最后在 ARM 上做真实沙箱探针、真实收发验收；x64 侧用基线快照和现有门槛证明行为不变。
5. ARM 相关检查只作为本地/人工资格，不写进 `ci/policy.json`，不依赖 Oracle 机器长期存在。
