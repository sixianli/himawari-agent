# 方案：让 Himawari 支持 linux-arm64（以测试机为目标）

## 一、方案依赖的前提（读代码证实）

**A1. 根因是「工具链路径列表被写死，且消费端强制 realpath 必须成功」，不是沙箱机制本身。**
- 沙箱策略编译端严格校验：`packages/runtime-sandbox/src/policy.ts:66` `canonicalPath` 对每条 `readOnlyToolchainPaths` 执行 `realpath`，不存在就抛错——101 条 `ENOENT: realpath '/lib64'` 全部源于生产者给出的列表里有 ARM 机上不存在的 `/lib64`。
- 生产者写死 `/lib64` 的位置（已逐一读源码确认）：出包签署 `scripts/delivery-mode/packet-template/signing/cloud-seal.mjs:334-352`（`/lib64` 在**硬失败组**，注意同文件 356-363 行已经存在「`/etc/mime.types` 等 4 条 ENOENT 容忍组」的现成模式）；测试夹具 `test/fixtures/product-path-harness.ts:396` + `:1593-1600`（`.map(realpath)` 无 catch）、`test/fixtures/mac-sandbox-deployment.ts:145-157`、`test/qualification/sandbox-install-restart-model.mjs:410-427`、`test/integration/prepared-file-runner.test.ts:278`、`test/integration/sandbox-preparation-control.test.ts:588`；探针脚本 `packages/runtime-sandbox/scripts/probe-{public-search,authorized-network,network-boundary,linux-worker-loss,job-host-control,supervision,managed-tasks}.mjs` 及 `packages/runtime-pi/scripts/probe-foreground.mjs`（`.map(realpath)` 无 catch）；包内副本 `scripts/delivery-mode/packet-template/acceptance/cloud/adapters/*.mjs` 与 `probe-source/**`、`measurement/probe/read-driver.mjs:43`。
- `JOB_HOST_NOT_READY`/`JOB_HOST_DEPENDENCIES_UNAVAILABLE` 我判断是策略编译失败的下游连锁（job host 起不来），**未核实**（需修完 A2 后在 ARM 上复跑验证）。

**A2. `/lib64` 是 x86-64 ABI 特有路径，arm64 上本来就不该存在。**
- Debian 开发者邮件（Simon McVittie，一手）：「`/lib64 -> /usr/lib64` is needed because the x86-64 ABI says the runtime linker is canonically named `/lib64/ld-linux-x86-64.so.2`」 https://www.mail-archive.com/debian-devel@lists.debian.org/msg337212.html
- Debian tech-ctte 邮件（Helmut Grohne，一手）：「On amd64, it also installs /lib64 that way, **but not on arm64**」 https://www.mail-archive.com/debian-ctte@lists.debian.org/msg09818.html
- 与材料给出的 bubblewrap 手册（`--ro-bind-try` 忽略不存在的 SRC）和 Anthropic sandbox-runtime（不存在的目录跳过）一致：对不存在的路径「跳过而非失败」是业界做法。
- 本仓库已有同一模式的先例：`packages/runtime-sandbox/scripts/check-srt-boundary.mjs:53` `PIVOT_ROOT = {"x86_64": 155, "aarch64": 41}[platform.machine()]`——机器布局相关值按机器取。

**A3. `npm test` = `node scripts/ci/local.mjs --check coverage`**（package.json:79），coverage 检查需要先跑 build（local.mjs:70），而 build 的 matrixKey 必须能在 `ci/policy.json` 里选中成员（`scripts/ci/run.mjs:43-49` `selectCheck` → `CI_MATRIX_UNSUPPORTED`）。同时 local.mjs:20-27 按 `platform+arch` 白名单直接抛 `CI_LOCAL_PLATFORM_UNSUPPORTED`，local.mjs:38 和 build.mjs:133、run.mjs:283/477/561、test.mjs:151、browser.mjs:128 用同一个三元表达式把 linux 一律命名成 `linux-x64`。

**A4. ci/policy.json 与 check-policy.mjs 是托管 CI 的合同**：check-policy.mjs:304-326 强制 build 成员恰好是 `{linux-x64, macos-arm64}`、非 mac 成员必须 `arch === "x64"`、「Only macOS members may pause」。改动它或 policy.json 就会碰到托管 CI 生成物，与约束冲突。

**A5. 工具链锁 `ci/toolchain-lock.json` 按 `${process.platform}-${process.arch}` 取键**（install-tools.mjs:328-344：`lock.node...artifacts[platform]`、`lock.python.artifacts[platform]`、`lock.tools.*.artifacts[platform]`、`lock.tools.semgrep.wheels[platform]`），且 `npm test` 前必须有 `installation.json`（local.mjs:29-30）。`linux-arm64` 的 node/python/actionlint/gitleaks/semgrep 官方产物都存在，只是没进锁。

**A6. 模型可见面的现状**：沙箱命令清单在服务启动时算一次并冻结在 Promise 里（`apps/agent-service/src/service-main.ts:234-236`），输出顺序由固定候选数组决定（sandbox-command-inventory.ts:129-133），放进「运行环境说明」，按 ADR 0164（docs/adr/0164...md:63）它只出现在**最后一条消息**里；系统提示与工具定义不含架构、路径或主机相关值（I-66 门槛 `check:prompt-prefix` 全程逐字节把关）。

## 二、方案本体（按顺序）

### 阶段 1：修根因——「机器布局相关路径」从机器取（先动沙箱，因为它同时是 npm test 失败主因和权限边界）

1. **新增一个共享助手**（放 `packages/runtime-sandbox`，从 dist 导出，供探针脚本和签署脚本经已装运行时导入——现有探针就是这么导入的，如 probe-public-search.mjs:11-16）：
   `canonicalToolchainPaths(required, optional)` = 逐条 `realpath`，仅对 `code === "ENOENT"` 的条目（optional 组）返回 null 并过滤，其余错误照抛；结果 `Set` 去重（`Promise.all` 保序，确定性同现状）。
2. **`cloud-seal.mjs`：把 `/lib64` 从必选组挪进可选组**（334-365 行），其余 13 条保持硬失败。x64 上 `/lib64` 存在 → 输出列表与今天逐条相同。
3. **所有 `.map(realpath)` 的调用点换成该助手**：product-path-harness、mac-sandbox-deployment、sandbox-install-restart-model、prepared-file-runner、sandbox-preparation-control、packages/runtime-sandbox 与 runtime-pi 的 probe-*、packet-template 的 acceptance adapters、probe-source 副本、read-driver.mjs。
4. **反向用例（必须真红）**：
   - 助手：非 ENOENT 错误（如 EACCES）必须抛出；required 组里缺路径必须抛出（模拟 x64 上 `/lib64` 消失的机器：.required 组传 `/lib64` 时必须失败）；
   - `compileSandboxPolicy` 保持不收不存在的路径（对它直接传不存在的 toolchain 路径仍 `ENOENT`/`NOT_CANONICAL` 失败）——证明「宽容只发生在取值层，不发生在边界校验层」；
   - `test/tooling/product-path-platform.test.ts` 增加行为用例：注入「/lib64 不存在」的环境时夹具产出的策略里没有 /lib64、有 /lib；该文件改用可注入 helper 后旧断言照跑。
5. **不改**：`isolation.ts:537-542` 的 `--symlink usr/lib64 /lib64`（bwrap 在沙箱内建 symlink，目标不存在也能建，探针只跑 `/usr/bin/true`，ARM 上应通过；保持 x64 字节不变优先）、`SANDBOX_READ_ROOTS`、`sandbox-command-links.py`、`compileSandboxPolicy`、`MERGED_DIRECTORIES`。

### 阶段 2：CI 本地通道允许 linux-arm64（不碰托管合同）

1. 新增 `scripts/ci/platform.mjs`：`currentPlatformKey()` = darwin-arm64→`macos-arm64`、linux-x64→`linux-x64`、linux-arm64→`linux-arm64`、其余抛错；替换 A3 列出的 6 处三元表达式（x64/mac 输出逐字节不变）。
2. `local.mjs`：白名单增加 `(linux, arm64)`（local.mjs:20-27）；platform 变量用 helper。**托管侧零改动**：`run.mjs runCheck` 增加仅在 `hosted === false` 生效的本地成员注入（build 缺 `linux-arm64` 成员时按 `{key, os, arch, node}` 现取值合成，并写进 result 以便审计）；hosted 分支代码路径不变。
3. 反向用例：本地模式下合成成员外的 matrixKey（如 `build-linux-armv7`）仍报 `CI_MATRIX_UNSUPPORTED`；`GITHUB_ACTIONS=true` 时绝不允许合成成员；`local.mjs` 的 platform 命名错配（如 linux-arm64 机器被叫成 linux-x64）要有一条用例锁住。
4. `install-tools.mjs`：platforms 加 `linux-arm64`；`ci/toolchain-lock.json` 补 `linux-arm64` 的 node 22.22.3、headers、npm、python-build-standalone `aarch64-unknown-linux-gnu`、actionlint/gitleaks arm64 包、semgrep manylinux_aarch64 wheel 组，全部从官方发布源取 URL+SHA256（nodejs.org、astral-sh releases、files.pythonhosted.org——工具 URL 校验 install-tools.mjs:51-57 本来就只放行这些主机）。x64 锁条目不动。
5. aggregate.mjs:201 的字面量 `linux-x64` 只在托管聚合路径用，**不动**（降低回归面）。

### 阶段 3：出包与资格

1. `make-packet.py:385/428` 与 `run-packet-checks.py:163` 的 glob `linux-x64-abi127-...`：加 `--candidate-platform`（默认 `linux-x64`），两处共用同一参数；不传参数时行为与今天完全一致（找不到 arm 包会照旧报 `PACKET_ARTIFACT_COUNT`，反向用例）。
2. 验收探针里 x86_64 专用的东西一并修掉（见「未列出的写死点」第 6 条）。
3. ARM 机上完成：出 linux-arm64 包 → 装到 ARM 机 → cloud-seal 在 ARM 机上签署（架构/内核/主机名都是 `hostname()/release()/process.arch` 动态取的，cloud-protected-prepare.mjs:38-41 的相等断言天然按机器成立）→ 资格收据验证 → 真实收发一条消息。

### 阶段 4：验收与门槛

- **x64 不变的证明**：(a) `git status` 显示 `ci/policy.json`、`.github/workflows/*`、`scripts/ci/check-policy.mjs` 未改；(b) 在 x64 上出包前后跑 `SandboxReadPathsTest`、`sandbox-command-inventory.unit.test.ts`（I-64 一致性用例： seal 源文本引号路径数 == `SANDBOX_READ_ROOTS.length`，因为 `/lib64` 字符串仍留在源码里、只是进了容忍组）、`npm run check:delivery-packet`；(c) 在 x64 机器对 cloud-seal 的 `readOnlyToolchainPaths` 产出做改动前后快照比对（逐条相同）；(d) `npm run check:prompt-prefix` 通过。
- **ARM 验证**：`npm test` 全绿（原 101 条 ENOENT 失败清零）；`HIMAWARI_LIVE_SANDBOX_PROBE=1` 跑真实沙箱探针（含 awk/sed 经 /etc/alternatives 链接可解析——I-64 机制在 ARM 上真实生效）；`npm run check:srt-boundary`；包检查 `run-packet-checks.py` 全过；资格收据签名验证通过；真实收发消息。

## 三、自己找到的、材料没列的写死点

1. `scripts/delivery-mode/packet-template/acceptance/cloud/download-question-12.py:14/88` 与 `run-network-preparation.py:20`、`question-12-inputs.json`：fd 只下载 `fd-v10.5.0-x86_64-unknown-linux-musl` 且摘要写死——**ARM 机的验收探针会拿到跑不起来的二进制**。改法：按 `platform.machine()` 选 `aarch64-unknown-linux-gnu/musl` 变体，两种摘要都进 pin 清单，未知机器拒绝。
2. `scripts/delivery-mode/hermes/build-candidate.sh:44` 与 `packet-template/acceptance/cloud/basis-04/run-stage-03.py:260/478` 写死 `build-linux-x64` 目录名（Hermes/托管 basis-04 路径，ARM 验收若复用会踩）。
3. `check-policy.mjs:304-326` 的成员白名单本身就是「x64 才能进矩阵」的编码（这是选不碰它的原因）。
4. `test/fixtures/mac-sandbox-deployment.ts:153-154` 把 `@anthropic-ai/sandbox-runtime` 的 `vendor/seccomp` 目录放进 toolchain——该 vendor 目录是否随 npm 在 arm64 装出、路径是否含 x86 专用的 seccomp 二进制，**未核实**（ARM 上跑 sandbox-preparation-control 类测试时若再报 ENOENT/EXEC，查这里）。
5. `scripts/delivery-mode/packet-template/acceptance/cloud/probe-source/**` 是探针脚本的**独立副本**，与 `packages/runtime-sandbox/scripts` 内容重复，漏改一份就会两边行为分叉（I-79 的教训：探针副本有独立指纹门槛 `check:probe-sources`，改了要同步记录）。
6. Hermes 运维签署脚本 `scripts/operations/hermes-*-seal.mjs:113-121` 同样硬编码 `/lib64`——它们是 x64 Hermes 的一次性部署证据脚本，本次**不改**（避免扩大回归面），只登记。
7. `scripts/model-review/gateway-lock.json` 已含 `linux-arm64` magpie 产物键（gateway.mjs:32），说明仓库里平台键有两种命名系（`linux-arm64` vs `linux-x64`），CI 侧沿用 `${platform}-${arch}` 系（`linux-arm64`），与工具锁一致，不要再引入第三个名字。

## 四、考虑过但不选

| 做法 | 不选原因 |
|---|---|
| 放宽 `compileSandboxPolicy`（policy.ts）容忍 ENOENT | 单点改动看似省事，但把「路径写错→静默放行不装」引入权限边界的核心校验；现有全部反向用例都依赖它严格。宽容应只发生在「取值层」（helper），边界层保持硬失败（有反向用例证明）。 |
| 在 `ci/policy.json` 加 paused 的 `linux-arm64` build 成员 | 必须同时改 check-policy.mjs 的成员白名单/暂停规则/平台断言（A4），托管工作流生成物跟着动；ARM 机随时可能被 Oracle 回收，不值得让它进 CI 合同。 |
| 在 ARM 机上手工 `ln -s usr/lib /lib64` 或 `mkdir /usr/lib64` | 机器端补丁，机器被回收即失效；且 Debian base-files 明确视 `/lib64→/usr/lib` 为非法状态（2025 tech-ctte 争议一手材料），未来升级反而炸。 |
| 给只读绑定改用 `--ro-bind-try` | Himawari 的沙箱走 sandbox-runtime 策略层而非直接拼 bwrap 参数，`--ro-bind-try` 会把**任何**写错/消失的路径（包括本该报错的）静默吞掉，代价大于收益；Anthropic 的做法是在构建绑定时跳过，不在 bwrap 参数层兜底。 |
| qemu/box64 在 ARM 上跑 x64 包 | 沙箱（user namespace + 挂载）与性能语义都会失真，验证不出真问题。 |
| 只改 fixture 让测试过，seal/探针不动 | 目标明说「找到并修掉根因」；seal 不改则 ARM 上连出包安装都过不去。 |

## 五、风险与反例

- **静默丢路径**：容忍组引入后，某台机器上本该有的目录因安装残缺被静默丢掉。反例防线：required 组保持硬失败；真实命令探针（I-81 已把 probe-foreground 纳入包检查）会因命令跑不起来而红；`check:prompt-prefix` 与 I-64 一致性用例继续把关清单文本。
- **平台键改名连锁**：`linux-arm64` 值流经 build 归档名、`--input` 生产者校验（run.mjs:561-568）、make-packet glob、工具锁键、`installation.platform`。漏一端就会在最后一步才炸（I-73 的教训）。上面第 1、2、3 阶段各自配了端到端用例；实施时按值逐个核对两端（见必答 4）。
- **ARM 包误装上生产**：cloud-protected-prepare.mjs:40 `process.arch == receipt.architecture` 会在 x64 生产机上拒绝 ARM 收据，另建议 make-packet 的 `--candidate-platform linux-arm64` 模式把包标成非生产候选（例如包元数据里记 `candidate.platform`，deploy 预检遇到不等于 linux-x64 的候选直接拒）——是否加这道锁请 Andy 拍板。
- **未核实项**：JOB_HOST_* 是否纯属连锁；`isolation.ts` 探针在 ARM 的实测结果；`vendor/seccomp` 的 arm64 形态；Playwright 官方不发布 linux-arm64 Chromium，那 7 条失败可能要改用系统 Chromium 通道才能清零（需要看这些测试怎么起浏览器，未核实）。

## 六、需要人拍板

1. ARM 包是否要显式「非生产」标记（上面第三条风险）。
2. x64 上若 `/lib64` 意外消失，容忍组会静默降级——是否接受「真实命令探针」作为唯一防线，还是再加一条 deploy-preflight「ELF 加载器目录必须在 seal 清单内」。
3. `ci/toolchain-lock.json` 新增 arm64 条目意味着今后工具升级要同时 pin 三个平台（darwin-arm64/linux-x64/linux-arm64）——接受这个长期维护成本吗。

## 七、必答问题逐条

**1. 会不会改变模型已见过的请求开头？** 不会。改动全部落在：CI 脚本、沙箱工具链路径列表（沙箱策略输入，不是模型输入）、出包/资格脚本、测试夹具。唯一模型可见面是沙箱命令清单，它在服务启动时算一次并冻结（service-main.ts:234-236），且按 ADR 0164 只出现在最后一条消息的「运行环境说明」里（docs/adr/0164...md:63）；系统提示、工具定义、历史、遮盖全部不动，本轮请求仍只在末尾追加、每轮变化值仍在最后一条消息。依据：.claude/rules/prompt-prefix.md:29（追加告知）、:36（遮盖确定性）。佐证门槛：`check:prompt-prefix`（含反向用例）与 `production-http-composition-process.test.ts` 的 [PR-A]/[PR-B] 逐字节比对在改动后必须继续通过。

**2. 会不会让同一段文字在不同请求里变成不同字节？** 不会。清单输出顺序由固定候选数组决定、与 readdir 顺序无关（sandbox-command-inventory.ts:129-133）；且它按进程冻结，不随轮次变。seal 的路径列表经 `Promise.all`（保序）+ `Set` + 现有 sort，确定性同现状；`/lib64` 只在安装时评估一次，同一台机器每次结果相同。工具链锁是 pin 死的 URL+SHA256。无时间戳、无无序集合引入请求内容。（推测，需实施时验证：seal 在 ARM 上的产出对同机重复运行应逐字节一致——跑两次比对即可。）

**3. 有没有对应的自动检查，反向用例会不会真失败？** 现有：`check:prompt-prefix`（自带 3 条反向）、I-64 一致性用例（seal 文本 ↔ `SANDBOX_READ_ROOTS`，本次改动后字符串计数不变所以仍有效）、`SandboxReadPathsTest`、`check:delivery-deploy`。新增并要求「先红后绿」：helper 的 ENOENT-容忍/非-ENOENT-拒绝两向用例、x64 机器上 `/lib64` 必须仍被算进清单（防容忍组吞掉应有路径）、`compileSandboxPolicy` 对不存在路径仍拒绝、本地 ARM 模式下非法 matrixKey 仍被拒、托管模式下禁止本地成员注入、make-packet 默认拒绝 arm 归档。

**4. 每个产生/使用的新值两端都核对了吗？** 逐个：`linux-arm64`（平台键）——产生：platform helper（7 处调用点）；使用：build 归档名、`run.mjs --input` 生产者校验（561 行需同步改）、`installation.platform`（install-tools.mjs:328 本来就按 `${platform}-${arch}` 取，锁里补键即闭合）、make-packet/run-packet-checks glob（新参数闭合）、aggregate.mjs:201（托管专用，保持字面量，不经过 ARM 值）；锁键 `linux-arm64`——产生：install-tools 安装记录；使用：verifyInstalledTools 各 `lock.*[platform]` 查表（5.1 节已核对四个查表点）；本地合成成员——产生：run.mjs hosted=false 分支；使用：`selectCheck`、`validateRecord("CheckResult")`（result 里带合成标记，聚合门槛在托管路径不读它）；新包参数 `--candidate-platform`——产生：make-packet/run-packet-checks 参数解析；使用：verify-packet-consistency 等 inputs 脚本读的是包内替换后的 `ARTIFACT_NAME`（模板替换链），需在 test_make_packet.py 里对 ARM 模式补端到端用例。这正是 I-73（incidents-and-gates.md:112）的教训：不能只看 diff，要问「清单里的值能通过最远端校验吗」——最远端是 ARM 机上的 cloud-protected-prepare 相等断言（动态值，天然闭合）和真实收发验收。
