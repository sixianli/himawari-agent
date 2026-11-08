## 侧重检查

- **错误路径**：查了 `production-runtime-tools.ts:1413-1432`（规划时取 min）、`1753-1764`（派发前二次读 binding 并检查）、`1475-1509`（queued 恢复用原请求）、`production-execution-worker.ts:209-225`（Worker 准入）、`sandbox-host-verifier.ts:220-238`（plan ≤ binding）、`production-task-environments.ts:279-312`（SRT 环境轮换）。提高上限只会放宽这些 `<=` 检查，旧 256/512 的排队请求不会被新上限拒绝；但下面「发现 5」的容器路线是例外。
- **不合规范/不可信输入**：签名的上限是源码字面量，不来自模型/用户输入；`sandbox-host-binding-v1.ts:95-101`、`execution-environment-v1.ts:136-141`、`capability-deployment.ts:663-668` 都只要求正整数且没有上界，1 GiB 能通过；`isolation.ts:150-155` 只要求 safe positive integer 且 CPU ≥ 1000。
- **安全**：没有新增密钥、日志或外发数据；但上限放大后，提示注入/大文件命令更容易造成内存压力（见发现 1）。
- **资源耗尽**：见发现 1。SRT 的内存上限是「观察后停止」而不是硬配额（`docs/execution/specs/2026-09-07-srt-unified-execution-design.md:399`、`resource-observer.ts:220-227`），峰值可短暂越界。
- **不可撤销操作**：改动本身不引入删除/覆盖；但 SRT 环境因 policyDigest 变化会轮换（停旧建新），若部署时仍有在途命令，旧命令会被停掉（升级场景本来就要恢复，未新增不可逆动作）。
- **规则/文档一致性**：`.claude/rules/prompt-prefix.md` 不受影响；提示词目录没有内存上限文字。作者把 `production-task-environments.ts:218` 说成“读常量”不准确，它读的是签名 binding（见发现 3）。

## 发现（按严重度从高到低）

### 1. 中：最坏内存不是 3 × 1 GiB，单个 run 可同时有 command 和 file_write 两个沙箱会话

**文件:行**：`apps/execution-worker/src/production-sandbox-execution-v2.ts:135`、`1335-1367`、`1617-1620`；`packages/execution-contracts/src/pi-runner-v1.ts:57-72`；`apps/agent-service/src/service-main.ts:1342`

**问题**：每个 SRT 环境有 `command` 和 `file_write` 两个 session；预热时两者是 `Promise.all` 同时启动的。每个 session 的真实命令都用 `plan.resourceCeiling.maxMemoryBytes`（现在 1 GiB）作为 job host 的观察阈值。因此单个 run 的最坏值应是 2 GiB（bash + write/edit），而不是 1 GiB；3 个 run 就是 6 GiB，已接近作者给出的 available 6409 MB，再叠加两个常驻 runner、Pi 准备线程 256 MiB 和服务自身内存，可能耗尽。

**证据（读代码证实）**：
- `production-sandbox-execution-v2.ts:135`：`const SRT_PREWARM_SESSIONS = ["command", "file_write"] as const;`
- `production-sandbox-execution-v2.ts:1335-1337`：`const started = await Promise.all( SRT_PREWARM_SESSIONS.map(async (kind) => {`
- `pi-runner-v1.ts:67-72`：`bash` → `"command"`，`write/edit` → `"file_write"`。
- `production-sandbox-execution-v2.ts:1617-1620`：`resourceLimits: { maxCpuTimeMs: plan.resourceCeiling.maxCpuTimeMs, maxMemoryBytes: plan.resourceCeiling.maxMemoryBytes }`

**推测/未核实**：后台 bash 跨轮继续运行时，模型在后续轮次可以写文件，所以 command + file_write 两个 session 可以重叠；未在生产上实测这种组合。SRT 是观察后停止，真实峰值还可能略高于阈值。

**建议**：要么让 SRT 在 environment 层按整个 run 执行统一硬上限（目前 `SrtTaskEnvironmentBackend.create` 只存 identity/deadline，完全不用 envelope 的 `resources`），要么在资源预算里按 2 × totalRuns 计算并留足余量；至少在 PR 说明里把“最坏 3 × 1 GiB”改正。

### 2. 中：三处关键值没有自动检查串起来，改回 256 MiB 测试仍会全过

**文件:行**：`apps/agent-service/src/service-main.ts:1342`；`scripts/delivery-mode/packet-template/signing/cloud-seal.mjs:380`；测试 `apps/agent-service/test/production-runtime-tools.unit.test.ts:313-336`、`packages/execution-contracts/test/sandbox-memory-limit.unit.test.ts:6-11`、`test/tooling/sandbox-memory-manifest.test.mjs:18-22`

**问题**：真正必须一致的是「service-main 的工具 ceiling」和「签名 binding 的 maxMemoryBytes」；现有测试只覆盖常量值、cloud-seal 模板、以及手动把 `options.ceiling` 设成常量后的 min 逻辑。没有任何测试读取 `service-main.ts` 或 `production-worker-composition.ts` 的接线。把 `service-main.ts:1342` 改回 `PI_FILE_PREPARATION_MEMORY_BYTES`，所有测试仍会通过，实际生效值退回 256 MiB。

**证据**：
- 新测试自己设置上限，不验证生产接线：`production-runtime-tools.unit.test.ts:322` `ceiling: { ...f.options.ceiling, maxMemoryBytes: SANDBOX_TOOL_MEMORY_LIMIT_BYTES }`。
- 常量测试只断言数值：`sandbox-memory-limit.unit.test.ts:6-8` `expect(SANDBOX_TOOL_MEMORY_LIMIT_BYTES).toBe(1_073_741_824);`。
- 清单测试只读 cloud-seal 模板：`sandbox-memory-manifest.test.mjs:18-22`。

**建议**：增加一个像 `test/tooling/walkthrough-command-permissions.test.mjs` 读 cloud-seal 那样的源码接线测试，或更实的组合测试：用 mock 的 sandbox 跑 `runAgentService`，断言最终 `work.execute` 的 `resourceCeiling.maxMemoryBytes` 是常量；同时断言加载到的 binding 不低于常量（否则加日志）。目前 `npm run check` 也不跑 `test/tooling`，它只在 CI 的 `policy` job 里跑。

### 3. 低：作者说“容器内存硬上限也读它（常量）”不实；实际读的是签名 binding，旧 binding 会静默把上限压回去

**文件:行**：`apps/agent-service/src/production-task-environments.ts:216-219`；`apps/agent-service/src/production-runtime-tools.ts:1429`

**问题**：`production-task-environments.ts:218` 读的是 `input.binding.maximumResourceCeiling.maxMemoryBytes`，不是 `SANDBOX_TOOL_MEMORY_LIMIT_BYTES`。所以代码改常量并不会自动把容器硬上限提到 1 GiB，必须同时用新 `cloud-seal.mjs` 重新签署；如果某次部署沿用了旧 receipt（512 或 256），`runtime-tools` 的 `Math.min` 会静默返回旧值，没有任何日志或失败。

**证据**：
- `production-task-environments.ts:218`：`memoryBytes: input.binding.maximumResourceCeiling.maxMemoryBytes,`
- `production-runtime-tools.ts:1429`：`maxMemoryBytes: Math.min(configured.maxMemoryBytes, maximum.maxMemoryBytes),`
- `cloud-seal.mjs:377-383` 的 `maximumResourceCeiling` 是签名模板值。

**建议**：修正作者说法；启动时或本次调用时在 `binding.maxMemoryBytes < SANDBOX_TOOL_MEMORY_LIMIT_BYTES` 的情况下记一条诊断，避免“以为改到 1 GiB、实际还是 512”无声发生。

### 4. 低：新增的“反向用例”没有真正验证拒绝路径

**文件:行**：`test/tooling/sandbox-memory-manifest.test.mjs:24-29`

**问题**：这个用例只是把合成字符串喂给解析函数并断言数字小于常量；它没有调用任何“检查/拒绝”逻辑。如果真实 `cloud-seal.mjs` 回退到 512 MiB，真正会失败的只有上面第 18-22 行那条，而这个名为“is rejected”的用例仍然通过，给出错误的安全感。

**证据**：
```js
it("is rejected when the manifest still says 512 MiB or 256 MiB", () => {
  const stale = (bytes) =>
    `maximumResourceCeiling: {\n maxWallTimeMs: 1,\n maxMemoryBytes: ${bytes},\n}`;
  expect(signedMemoryCeiling(stale(536870912))).toBeLessThan(SANDBOX_TOOL_MEMORY_LIMIT_BYTES);
```

**建议**：把“读清单 + 比较”抽成一个函数，用真实 cloud-seal 内容和一份临时改成 512/256 的副本分别调用，断言后者失败；或者直接对渲染后的 packet 做检查，而不是只测解析器。

### 5. 低（推测，取决于是否使用容器路线）：已有容器环境从 512 MiB 扩到 1 GiB 时会报 `EXECUTION_ENVELOPE_EXCEEDED`

**文件:行**：`apps/agent-service/src/production-task-environments.ts:318-338`；`packages/application/src/services/task-environment-coordinator.ts:304-305`

**问题**：SRT 路线在 `acquireSrt` 里用包含 `envelope` 的 `policyDigest` 做轮换判断（`production-task-environments.ts:82-117`、`297-310`），上限变化会触发停旧建新，安全。但容器路线的 `acquire` 直接 `coordinator.acquire`，没有轮换逻辑；已有 ready 环境 envelope 只有 512 MiB 时，`executionEnvelopeCovers` 返回 false，`acquireInOrder` 直接抛 `EXECUTION_ENVELOPE_EXCEEDED`。

**证据**：
- `task-environment-coordinator.ts:304-305`：`if (!executionEnvelopeCovers(record.envelope, input.envelope)) throw new ExecutionEnvironmentError("EXECUTION_ENVELOPE_EXCEEDED");`
- `production-task-environments.ts:318-338` 的 `acquire` 没有 `srtEnvironmentRotationReason` 那样的检查。

**推测/未核实**：生产 `cloud-seal.mjs` 的 `backendRef` 是 `"srt"`（第 422 行附近），所以生产大概率走 SRT；容器路线是否在别的部署中跨升级复用旧环境，未核实。

**建议**：如果容器路线需要支持升级，给 `acquire` 加同样的 envelope 变化轮换，或启动恢复时先停掉旧 envelope 的环境。

### 6. 低：其他签署/资格脚本和探针仍写死 512 MiB，容易让验证结果看起来仍是旧上限

**文件:行**：`scripts/operations/hermes-e2e-fixes-seal.mjs:139-145`（`hermes-*-seal.mjs` 约 10 个文件同样）、`test/qualification/sandbox-install-restart-model.mjs:430-436`、`scripts/delivery-mode/packet-template/measurement/probe/read-driver.mjs:47`

**问题**：这些不是生产 packet 的 `cloud-seal.mjs`，但它们的 binding/请求仍写死 `536870912`。如果某次资格验证或测量走这些路径，实际生效上限仍是 512 MiB，而不是新的 1 GiB。

**证据**：`test/qualification/sandbox-install-restart-model.mjs:430-436` 的 `maximumResourceCeiling` 中 `maxMemoryBytes: 536_870_912,`；`hermes-*-seal.mjs` 同样。

**建议**：确认这些脚本是否仍在使用；如果用于判断“生产行为”，同步改成 1 GiB 或明确标注它们不是生产签名路径。

## 作者说法核对

| 说法 | 核对结果 |
|---|---|
| 新增常量并导出 | 属实：`packages/execution-contracts/src/sandbox-memory-limit.ts:1`，`src/index.ts` 新增导出 |
| worker `maximumCeiling` 初值改为常量 | 属实：`production-worker-composition.ts:263` |
| service-main 工具 ceiling 改为常量 | 属实：`service-main.ts:1342` |
| 实际生效是两者较小值 | 属实：`production-runtime-tools.ts:1429`；但“两者”的另一边是签名 binding，不是 worker 的 `maximumCeiling` |
| “所以必须两处一起改” | 表述不准确：真正必须一起改的是 service-main 和 cloud-seal 签名清单；worker 的 `maximumCeiling` 用 `Math.max(constant, binding)`，binding 已为 1 GiB 时改不改它都不影响生效值 |
| Pi 文件预热池 256 MiB 不变 | 属实：`service-main.ts:167`、`914` |
| 容器内存硬上限“读它（常量）” | 不实：`production-task-environments.ts:218` 读的是 `input.binding.maximumResourceCeiling.maxMemoryBytes` |
| 签名清单已同步 1 GiB | 属实（模板）：`cloud-seal.mjs:380`；但实际安装 receipt 必须重新签署，旧 receipt/旧环境仍是 512 |
| 生产 total/available、无 swap、totalRuns=3 | 仓库内没有这些数字（`scripts/delivery-mode/instances/andy-production.json` 不含内存/并发），未核实 |
| “最坏 3 × 1 GiB” | 不完整：每个 run 有 command/file_write 两个 session，见发现 1 |
| “超限明确失败由 PR #282 做” | 本仓库没有 #282 内容，未核实 |

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会。改动只影响运行时资源上限：`work.execute` 的 `resourceCeiling`、签名 binding/receipt、任务环境 envelope、容器/SRT 资源。这些都不进入系统提示、工具定义、历史消息或遮盖结果。`packages/prompt-catalog` 里没有“内存/MiB/GiB/maxMemory/256”的提示词文字（已 grep，无匹配），运行环境说明也不含内存数字。发给模型的内容仍然只在末尾追加，每轮会变的值（时间、本轮资料、运行环境说明）仍在最后一条用户消息里。依据 `.claude/rules/prompt-prefix.md` 第 27-29、35 行。

**2. 会不会让同一段文字在不同请求里变成不同字节？**
不会。`SANDBOX_TOOL_MEMORY_LIMIT_BYTES` 是固定字面量 `1024 * 1024 * 1024`，cloud-seal 的 `1073741824` 也是固定十进制字面量；不依赖时间、前后文、对象遍历顺序或集合顺序。变化只发生在“新旧版本之间”（256/512 → 1 GiB），不是同一版本不同请求之间。也没有改动遮盖逻辑。

**3. 有没有对应的自动检查？反向用例真的会失败吗？**
部分有，但不够：
- 常量值：`sandbox-memory-limit.unit.test.ts:6-11`，改常量会失败。
- `min(configured, binding)`：`production-runtime-tools.unit.test.ts:313-336`，把 `Math.min` 改成 `Math.max` 会让第 1、3 组失败。
- 签名模板 ≥ 常量：`sandbox-memory-manifest.test.mjs:18-22`，cloud-seal 回退到 512/256 会失败。
- 但 `sandbox-memory-manifest.test.mjs:24-29` 的“is rejected”只是解析合成字符串，不是真正的拒绝用例；真正保护文件的是第 18-22 行。
- **没有**测试覆盖 `service-main.ts:1342` 和 `production-worker-composition.ts:263` 的生产接线；改回 256 MiB 后所有测试仍通过。
- 新测试只进入 CI 的 `policy`（tooling project）作业，不在 `npm run check` 的 `check:steps` 里；CI required 作业会跑，但本地 `npm run check` 不会。

**4. 每个产生或修改的值，使用它的地方都能接受吗？**
逐项核过：
- `SANDBOX_TOOL_MEMORY_LIMIT_BYTES = 1 GiB`：从 `index.ts` 导出，两个 app 都能编译；所有相关契约只要求正整数/safe integer（`sandbox-host-binding-v1.ts:95-101`、`execution-environment-v1.ts:136-141`、`capability-deployment.ts:663-668`、`isolation.ts:150-155`），1 GiB 通过。
- worker `maximumCeiling.maxMemoryBytes`：`production-execution-worker.ts:155-156` 用 `<=`，等于 1 GiB 通过。
- service-main 工具 ceiling：`production-runtime-tools.ts:1429` 取 min；`1757-1764` 再用 binding 检查；worker `withinCeiling`；`sandbox-host-verifier.ts:232-236` 要求 plan ≤ binding；都接受 1 GiB。
- cloud-seal `maximumResourceCeiling.maxMemoryBytes = 1 GiB`：`parseCeiling` 无上界；`sandboxHostBindingSchema` 接受；`production-task-environments.ts:218` 把它写进 `executionEnvelopeSchema` 的 `memoryBytes`（integer(1)）；container backend 再作为 docker `memory` 字符串使用；都接受。
- 跨版本旧值：`production-runtime-tools.ts:1485-1488` 对旧排队请求的比较是 `original > 新上限`，提高上限只会放宽，旧 256 能过；SRT 的 `policyDigest` 包含 envelope（`production-task-environments.ts:82-117`），旧环境会被轮换；同一请求内的 receipt/parent binding 精确比较用的是新请求自己的 1 GiB，不会与旧 receipt 混用。
- **唯一不一致**：容器路线已有 ready 环境时不会轮换，会抛 `EXECUTION_ENVELOPE_EXCEEDED`（发现 5，生产大概率是 SRT，未核实）。
- 旧的 `test/qualification` 512 MiB 是测试夹具，不是生产 receipt；不影响产品，但会误导验证（发现 6）。
