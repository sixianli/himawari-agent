# PR 338 第 3 轮复核（0dbe73d8..ff9416de）

## 一、读代码证实的问题

### 1. 中 — 新单测用的 custom 消息不是生产形状，可能掩盖“正常路径误拒”

- 位置：`packages/runtime-pi/test/tool-batch-state.unit.test.ts:65-91`
- 问题：测试构造的 custom 消息 `customType` 是 `himawari.background_command`（下划线），而生产代码用的是 `himawari.background.command`（点）。生产里的 background command、tool-loop stopped、runtime environment 三类 custom 消息都带 `details`，测试里的消息没有 `details`，`appendCustomMessageEntry` 也只传了三个参数。作者声称“新单测覆盖插入 custom 消息后的捕获”，但覆盖的是自制形状，不是真实形状。
- 证据：
  - `packages/runtime-pi/src/pi-runtime-adapter.ts:384`：`const BACKGROUND_COMMAND_MESSAGE_TYPE = "himawari.background.command";`
  - `packages/runtime-pi/src/pi-runtime-adapter.ts:403-419`：`toolLoopStoppedMessage()` 返回 `details: {}`，`backgroundCommandMessage()` 返回 `details: { taskRef: notice.taskRef }`。
  - `packages/runtime-pi/src/runtime-environment-block.ts:114-120`：`runtimeEnvironmentMessage()` 返回 `details: {}`。
  - 测试 `tool-batch-state.unit.test.ts:69`：`customType: "himawari.background_command"`；`:77-81`：`appendCustomMessageEntry("himawari.background_command", "...", false)`，没有 `details`。
- 建议：把测试改成生产常量类型（`himawari.background.command` 或 `himawari.runtime-environment`），并在 live 消息和 `appendCustomMessageEntry` 两边都带上 `details: { taskRef }`，证明 `convertToLlm` / SessionManager 对真实 custom 消息不会误拒。

### 2. 低 — “entries 少了/多了一条 custom 消息仍会拒绝”缺少反向用例

- 位置：`packages/runtime-pi/test/tool-batch-state.unit.test.ts:93-101`
- 问题：现有反向用例只构造了“agent state 多一条 user 消息、entries 没有”的差异。作者这次的核心保证是“条目真的少了或多了一条消息时仍会拒绝”，但新增的 custom 场景没有反向用例证明这一点；一旦 `convertToLlm` 对某类 custom 消息返回空，这条保证就不成立，而现有测试不会发现。
- 证据：`tool-batch-state.unit.test.ts:93-101` 只 `unshift` 了 `{ role: "user", ... }` 并断言 `PI_CONTINUATION_PREFIX_INVALID`；新增用例 `:65-91` 只验证成功捕获，没有“少一条 custom”或“多一条 custom”的反例。
- 建议：加一个反向用例：live agent state 插入一条 custom 消息，但手工构建的 `sessionManager` 不追加对应 `custom_message` 条目，断言 `capturePiToolBatch` 抛 `PI_CONTINUATION_PREFIX_INVALID`。这才能证明“modelVisible 比较不会漏掉 custom 消息”。

### 3. 低 — Gitleaks 新用例没有覆盖本 PR 实际删除的 `published-synthetic-fixture` 分支，也没有断言合成密钥例外被保留

- 位置：`test/tooling/security.test.mjs:535-577`，`scripts/ci/security-exceptions.mjs:190-213`
- 问题：新用例里两个例外都是 `kind: "advisory"`，而本 PR 从 `ci/security-exceptions.json` 删掉的条目实际全是 `published-synthetic-fixture`。用例断言 `.exceptions` 为 `[]`，而所有 advisory 本来就会被 `gitleaksGateExceptions` 最后的 `kind === "synthetic-secret"` 过滤掉；因此它主要只证明了“不再抛 `SECURITY_EXCEPTION_DEPENDENCY_UNKNOWN`”，没有证明 `packageLockPath` 分支被正确跳过，也没有证明一条真正的 synthetic-secret 例外仍然保留。
- 证据：
  - `test/tooling/security.test.mjs:60-62`：`exception()` 默认 `kind: "advisory"`；`:562-568` 第二条也只是覆盖 id/path/package/version，仍是 advisory。
  - `scripts/ci/check-security.mjs:587-589`：`[...accepted, ...(ownerReview?.exceptions ?? [])].filter(entry => entry.kind === "synthetic-secret")`。
  - `scripts/ci/security-exceptions.mjs:196-208`：`withoutRemovedDependencies` 对 `published-synthetic-fixture` 使用 `packageLockPath`，与 advisory 的 `path` 分支不同。
  - 已有单测 `test/tooling/security.test.mjs:596-609` 覆盖了 `withoutRemovedDependencies` 的 published 分支，所以这不是无覆盖，而是“gitleaks 门禁这条集成路径”没有覆盖实际出问题的 kind。
- 建议：把第二条例外改成 `kind: "published-synthetic-fixture"`、带 `packageLockPath`，并加入一条应被保留的 `synthetic-secret`，断言结果里恰好留下它、删掉的 published 条目不导致校验抛错。

### 4. 低 — 文件预演测试标题与调用顺序不完全一致

- 位置：`packages/runtime-pi/test/prepare-file-mutation.compat.test.ts:74`
- 问题：标题说 “refuses edit arguments that are not plain JSON before Pi prepares the edit”，但代码顺序是 `tool.prepareArguments(...)` 先执行，`jsonToolArguments(normalized)` 之后才执行，`validateToolArguments` 最后。如果 “prepares” 指 `prepareArguments`，标题不准确；ADR 第 6 条说的是“再交给 Pi 的参数校验”，按 `validateToolArguments` 理解则代码顺序符合 ADR。
- 证据：`packages/runtime-pi/src/prepare-file-mutation.ts:54-62`：
  ```ts
  const normalized = tool.prepareArguments
    ? tool.prepareArguments(structuredClone(input.parameters))
    : structuredClone(input.parameters);
  const parameters = validateToolArguments(tool, {
    ...
    arguments: jsonToolArguments(normalized),
  });
  ```
- 建议：把测试名改成 “before Pi validates/runs the edit”，或在 ADR/注释里明确检查发生在 `prepareArguments` 之后、`validateToolArguments` 之前。

### 5. 低 — 资源：每个工具检查点把整段前缀序列化两次

- 位置：`packages/runtime-pi/src/pi-tool-batch-continuation.ts:65-71`，调用点 `:48-52`，生产调用 `pi-runtime-adapter.ts:1516-1521`
- 问题：旧写法用 `isDeepStrictEqual` 比较对象；新写法对两边各做一次 `convertToLlm` 和 `JSON.stringify`。一个批次里每个工具检查点都会处理整段前缀，带大附件/长历史时产生两份完整字符串的额外内存和 CPU。不是正确性缺陷，但属于资源开销回归。
- 证据：`modelVisible` 返回完整字符串，比较处调用两次；`saveToolCheckpoint` 在每次工具执行前调用 `capturePiToolBatch`。
- 建议：如要保留按模型可见内容比较，可先做浅层规范化（递归去掉 `timestamp`、过滤 system），再用 `isDeepStrictEqual`，避免整段字符串化；或至少在注释/测试里接受这个开销。

## 二、推测（未核实，需补证据）

### A. `convertToLlm` 丢弃某类消息会导致漏检

- 位置：`packages/runtime-pi/src/pi-tool-batch-continuation.ts:65-71`
- 推测：如果 Pi 1.5.0 的 `convertToLlm` 对某类角色返回空数组（例如某种 `custom` 类型，或把 `compactionSummary` 转成 `system`），那么 `modelVisible` 的比较就看不到这类消息。作者说“条目真的少了或多了一条消息时仍会拒绝”，对这类消息就不成立。仓库里能证明的只有：`custom` 会被转成非 `custom` 消息（`pi-runtime-adapter.compat.test.ts:3549-3551` 断言 outbound 里没有 `role: "custom"` 且内容仍出现），`compactionSummary` 被 `convertToLlm` 接受（`pi-native-history.compat.test.ts:24`），但看不到 Pi 源码，无法确认所有角色都被保留。工作区没有 `node_modules`，无法核对 `convertToLlm` 实现。
- 建议：用真实 Pi 加一条反向用例：从 entries 里删掉一条 `custom` / `compactionSummary`，断言 `capturePiToolBatch` 仍抛 `PI_CONTINUATION_PREFIX_INVALID`；如果 `convertToLlm` 丢弃了该类型，测试会失败并暴露问题。

### B. `JSON.stringify` 的键序/`undefined` 语义可能误拒或漏检

- 位置：`packages/runtime-pi/src/pi-tool-batch-continuation.ts:66-70`
- 推测：比较使用字符串相等，依赖对象键的插入顺序。如果 `convertToLlm` 对 user/assistant/toolResult 原样返回，而 live 消息与 SessionManager 重建消息的字段插入顺序不同（尤其是 `steer` 构造的 custom 消息与 `createCustomMessage` 重建的消息），会误拒。反过来，`JSON.stringify` 会丢掉值为 `undefined` 的属性，这类差异不会被发现。是否发生取决于 Pi 的消息构造方式，未核实。
- 建议：比较前做键序稳定的规范化（或对规范化后的对象用 `isDeepStrictEqual`），并补一条“字段顺序不同但内容相同”的正向用例。

### C. `details` 是否被 SessionManager 保留

- 位置：`packages/runtime-pi/src/pi-runtime-adapter.ts:412-419`、`packages/runtime-pi/test/tool-batch-state.unit.test.ts:67-81`
- 推测：生产 custom 消息带 `details`，新测试没有。如果 `convertToLlm` 采用 `{ ...message, role: "user" }` 这类保留字段的写法，live 侧有 `details`、entries 重建侧若丢掉 `details`，仍会在正常 background command 路径误拒；如果 `convertToLlm` 只取 `content`，则无影响。未读到 Pi 源码，无法确认。
- 建议：同问题 1，测试必须带 `details`。

### D. 文档“改适配器设置打开自动重试”是否足够

- 位置：`docs/adr/0198-upgrade-pi-to-1-5-0.md:55`，`docs/engineering-casebook.md:5439`，代码 `pi-runtime-adapter.ts:1388`、`:1069`
- 推测：适配器同时用 `SettingsManager` 的 `retry: { enabled: false, maxRetries: 0 }` 和 provider 流的 `maxRetries: 0` 两处关闭重试。ADR/casebook 说“手动改适配器的设置打开 Pi 自动重试后这条用例会失败”，如果 agent-session 的自动重试还受 stream 层 `maxRetries: 0` 影响，只改设置可能不足以让 503 用例失败。未核实 Pi 的重试分层，只把两处代码位置列出供核对。
- 建议：在 ADR 里写清具体改哪一处（settings 还是 stream 选项），或重新手动验证一次并记录结果。

## 三、侧重检查

- **错误路径**：`capturePiToolBatch` 的两类拒绝（`PI_CONTINUATION_PREFIX_INVALID`、`PI_CONTINUATION_RESULTS_INVALID`）在 `pi-tool-batch-continuation.ts:48-52`、`:119-132` 有明确分支。`convertToLlm` 本身抛错没有被包装成固定错误码，会以原始异常进入工具检查点路径；这是新引入的失败面，但没有证据表明普通输入会触发。
- **不合规范/不可信输入**：`jsonToolArguments` 拒绝 `undefined`、BigInt、Map、Date、函数、NaN/Infinity、符号键、稀疏数组、循环、深度 >64、节点 >100000（`json-tool-arguments.ts:11-45`）。沙箱执行器和文件预演都在 `validateToolArguments` / `execute` 之前调用它；测试确认拒绝时没有执行命令、没有改文件（`sandboxed-coding-executor.compat.test.ts:131-147`、`prepare-file-mutation.compat.test.ts:74-94`）。
  - 残余风险：`Object.values(value)` 在检查节点预算前会先为超大对象构造完整 values 数组；带 getter/Proxy 的对象不受保护。当前输入来自 `structuredClone` 或模型 JSON，Proxy 进不来，风险有限。
- **安全**：`PI_REQUEST_TOOLS_DIVERGED` 是固定字符串，加入 `loggableModelFailure` 不会泄露 provider 正文；`modelFailureCode` 仍把它归为 `PI_MODEL_ERROR`，`service-main.ts:1884-1891` 只记录该固定字符串。
- **资源耗尽**：除上面“整段前缀序列化两次”外，`jsonToolArguments` 的节点/深度上限有效；`Object.values` 的分配问题见上。
- **不可撤销操作**：本增量没有新增外部动作；工具检查点仍只保存快照，工具执行前的 JSON 检查发生在副作用之前。
- **规则/文档与代码一致**：`prompt-prefix.md` 第 4、6、7 条与代码一致；ADR 0198 决定 7 与 `retry: { enabled: false }` 一致；案例 86 的措辞比 ADR 略模糊（“改适配器的设置”），但方向一致。唯一的文字瑕疵是文件预演测试标题（问题 4）。
- **未核实**：Pi 1.5.0 的 `convertToLlm`、`SessionManager`、`_refreshFinalizedContext` 源码不在工作区（`node_modules` 不存在），上述 A/B/C/D 都只能靠仓库内的测试和调用点推断。

## 四、必答问题

### 1. 会不会改变模型已经见过的请求开头？

**本次增量不会。** `modelVisible` 只用于捕获工具批次时的本地一致性检查，不参与发送；发送路径仍是 `himawariRequestContext` 过滤 system、注入冻结 `systemPrompt` 与冻结 `tools`，再由 `normalizeContext` 生成请求（`pi-runtime-adapter.ts:641-661`、`:955`、`:1600-1605`）。发给模型的内容仍是“冻结开头 + 历史 + 最后一条用户消息”；prompt-prefix 测试在 `prompt-prefix.compat.test.ts:600-635` 断言时间、工作目录只出现在最后一条消息，头部不变。需要留意的是：新比较忽略的 `timestamp` 本身必须不进入请求体；从 `findPrefixBreak` 对真实请求体按字节比较且多轮通过（`:613`、`:891`）间接支持这一点，但我没有直接读到 provider 请求构造代码，**这一点未核实**。

### 2. 会不会让同一段文字在不同请求里变成不同字节？

**不会改变发送字节。** 改动只把本地比较改成 `convertToLlm` 投影并去掉 `timestamp`；没有改遮盖、序列化或消息顺序。比较字符串本身依赖 `JSON.stringify` 的键序，但那只是本地比较结果，不写回、不发送。潜在风险是“比较误判”，而不是“发送字节变化”。（见推测 B）

### 3. 有没有对应的自动检查？反向用例真的会失败吗？

有，但覆盖不完整：

- 新增正向单测：`tool-batch-state.unit.test.ts:65-91`。在旧实现下，live custom 消息时间戳 `-5` 与重建条目时间戳不同，`isDeepStrictEqual` 会失败，因此这条用例确实能区分新旧实现。
- 反向用例：`tool-batch-state.unit.test.ts:93-101`（entries 少一条 user 消息）在新比较下仍会因 user 消息被 `convertToLlm` 保留而抛错。
- 缺失：没有“entries 少/多一条 custom 消息”的反向用例（问题 2）；新正向用例用的 custom 类型和字段不是生产形状（问题 1），所以“正常路径不误拒”的保证没有真正被生产形状验证。
- 安全测试：`security.test.mjs:535-577` 能让“未过滤已移除依赖”的实现抛错，因此是一个有效回归；但它没有覆盖本 PR 实际删除的 `published-synthetic-fixture` 路径，也没有断言保留一条 synthetic-secret（问题 3）。

### 4. 改动产生/修改的每个值，所有使用方都能接受吗？

逐个核对如下：

- **快照版本 `pi-tool-batch.v3` / `entries` 字段**：生产者在 `pi-tool-batch-continuation.ts:53-57`；`RuntimeContinuationService` 把 `value` 当作不透明 JSON 加解密（`runtime-continuation-service.ts:40-60`、`:88-108`），不校验字段。恢复方 `piToolBatchSessionManager`/`restorePiToolBatch` 用 `checkedBatch` 校验版本和 `entries` 形状（`:103-145`），v2 抛 `PI_CONTINUATION_VERSION_INVALID`；恢复扫描 `inspectPiToolBatch` 对非 v3 返回 `undefined`（`:188-190`），`production-tool-result-recovery.ts:226-227` 随即 `continue`。两端可接受，且旧批次失效是 ADR 第 4 条已批准的行为。
- **`PI_REQUEST_TOOLS_DIVERGED`**：生产者在 `pi-runtime-adapter.ts:382`、`:1605`；消费方 `loggableModelFailure`（`:432-442`）现在放行精确常量，`modelFailureCode`（`:421-430`）把它归为 `PI_MODEL_ERROR`，`service-main.ts:1884-1891` 记录该字符串。固定字符串，不涉及用户/ provider 数据，消费方接受。
- **`gitleaksGateExceptions` 导出与返回值**：生产者 `check-security.mjs:567-597`；消费方 `security.test.mjs:20`、`:575`，生产入口 `runGitleaksGate` 仍在 `:602` 使用；返回值继续传给 `applySecurityExceptions`（`:625-629`）。`withoutRemovedDependencies` 对 advisory 和 published 两种 kind 分别用 `path` / `packageLockPath`（`security-exceptions.mjs:190-208`），已有单测 `security.test.mjs:579-620` 覆盖两种 kind。可接受。
- **`PI_TOOL_ARGUMENTS_INVALID`**：生产者在 `json-tool-arguments.ts:19-35`；两个真实入口 `sandboxed-coding-executor.ts:52`、`prepare-file-mutation.ts:61` 在副作用前抛错。调用方本来就以 rejection/worker error 处理失败（`prepare-file-mutation.ts:195-199`、`awaitPiPreparationWorker`），新测试确认拒绝时命令列表为空、文件未改。可接受。
- **测试里的 `himawari.background_command`**：只在测试内出现，不是生产值，不影响任何消费方；但它让测试与生产脱节（问题 1）。
