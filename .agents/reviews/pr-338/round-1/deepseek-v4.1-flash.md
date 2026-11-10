按照你给的约束，我只读了代码和 git 内容，没有运行任何东西，也没有改文件。下面先给结论，再逐条回答必答问题。

## 一、读代码证实的问题（按严重度）

### 1【中】规则和 ADR 声称的“打开 Pi 自动重试后反向用例会失败”并不存在
- 文件：`.claude/rules/prompt-prefix.md:74`、`docs/adr/0198-upgrade-pi-to-1-5-0.md:55`、`packages/runtime-pi/test/prompt-prefix.compat.test.ts:796`
- 问题：规则写“打开 Pi 的自动重试…检查都必须报告失败”，ADR 决策 7 写“把 Pi 自动重试打开，这条用例会失败”。实际新增的 `[ADR-0198]` 用例只是让真实适配器跑一次 503，断言 `server.bodies` 恰好 3 条、且不含 `context_edit`；它没有任何开启 retry 的分支，适配器设置仍是 `retry: { enabled: false, maxRetries: 0 }`（`pi-runtime-adapter.ts:1383-1389`）。全仓 grep `retry: { enabled: true` / `maxRetries: [1-9]` 无结果。也就是说，“反向用例”只验证了当前配置，没有验证“若打开重试则检查会失败”。
- 证据：
  - `prompt-prefix.compat.test.ts:796` `it("[ADR-0198] never retries a failed attempt inside Pi..."`
  - `prompt-prefix.compat.test.ts:856` `expect(server.bodies.join("\n")).not.toContain("context_edit");`
  - `pi-runtime-adapter.ts:1386` `retry: { enabled: false, maxRetries: 0 },`
- 建议：要么在测试里提供可注入的 `SettingsManager`/retry 开关，真的打开 Pi 自动重试并断言检查报告失败（或保留失败即证明反向有效），要么把规则/ADR 的表述改成“只验证了重试保持关闭”，不要声称已有反向门禁。

### 2【中低】新增的 `jsonToolArguments` 安全校验没有被任何自动测试覆盖
- 文件：`packages/runtime-pi/src/json-tool-arguments.ts:1-46`
- 问题：这是本次新增的、直接面向“不可信工具参数”的边界检查（拒绝 `undefined`/BigInt/Map/循环引用/非有限数，限制深度 64、节点 100k），但仓库里没有任何测试文件或断言调用 `jsonToolArguments`，也没有对 `PI_TOOL_ARGUMENTS_INVALID` 的反向用例。`prepare-file-mutation.ts:61` 与 `sandboxed-coding-executor.ts:52` 两处消费它，只有正向运行路径可能间接经过。
- 证据：`jsonToolArguments.ts:19/22/25/26/35/43` 每个拒绝分支都抛同名错误；全仓 grep `jsonToolArguments|PI_TOOL_ARGUMENTS_INVALID` 只命中 src 文件，未命中测试。
- 建议：加单元测试覆盖非对象顶层、数组、`undefined`、BigInt、函数、Symbol 键、`Date`/`Map`/Buffer、循环引用、深度 65、节点超限；并各加一条“去掉检查会通过”的反向证明。否则这段新校验以后被删掉不会有人发现。

### 3【中低】`PI_REQUEST_TOOLS_DIVERGED` 保护没有测试
- 文件：`packages/runtime-pi/src/pi-runtime-adapter.ts:642-651`、`:1603`
- 问题：ADR 决策 2 明确把“Pi 当前可执行工具名和声明不一致就不发请求”列为核心保护，但全仓没有构造“工具名不一致”的测试；`getCurrentTools`/`himawariRequestContext` 也没有直接单测。这个 fail-closed 分支是否真的会触发、是否返回可观测的失败流，未验证。
- 建议：加一个 compat/unit 用例，构造 `requestTools` 与 Pi 当前工具名差一个的情况，断言返回 `runtime.failed` 且错误码可映射（目前会落成 `PI_MODEL_ERROR`）。

### 4【低】`withoutRemovedDependencies` 的测试只覆盖 `advisory`，没覆盖本 PR 真正用到的 `published-synthetic-fixture`
- 文件：`scripts/ci/security-exceptions.mjs:190-213`；`test/tooling/security.test.mjs` 新增 describe
- 问题：新增过滤函数有两个分支：`advisory` 用 `entry.path`，`published-synthetic-fixture` 用 `entry.packageLockPath`。新增测试里的 `exception()` 默认 `kind: "advisory"`，因此只验证了 `entry.path` 分支。本 PR 的动机恰恰是 Pi 的 `published-synthetic-fixture` 条目（`ci/security-exceptions.json` 大量此类）。`packageLockPath` 分支、以及“非 dependency 类（synthetic-secret）必须原样保留”没有断言。
- 证据：`security.test.mjs` 中 `removed = exception({ id: "GHSA-...", path: "node_modules/removed", ... })`，未带 `kind`，落到 `advisory`；`security-exceptions.mjs:192` 才处理 `packageLockPath`。
- 建议：补一条 `kind: "published-synthetic-fixture"`（含 `packageLockPath`）的用例，并断言 `synthetic-secret`/`semgrep` 条目不会被过滤。

### 5【低】仍在“active”状态的架构文档把 Pi 固定版本写成 0.84.2
- 文件：`docs/architecture-v0.1.md:190`（同文 :31、:37、:434、:613、:647、:661 也有）
- 问题：代码/manifest/lock 已是 `1.5.0`（`packages/runtime-pi/package.json:10-11`、`package-lock.json:9197-9198`），但活跃架构文档仍说“直接固定 … 0.84.2”。归档的 BL-20261002-004 明确要求“同一提交更新受影响的文档（架构文档、相关 Spec 和 ADR）”。当前自查门槛与文档不一致。
- 建议：要么更新 `architecture-v0.1.md` 的版本陈述，要么把它明确标注为历史快照；至少不要保留“当前固定 0.84.2”的句子。

### 6【低】规则把 `context_edit` 写成“只和压缩一起发生”，与 ADR 前提 5 自相矛盾
- 文件：`.claude/rules/prompt-prefix.md:35`；`docs/adr/0198-upgrade-pi-to-1-5-0.md:40`
- 问题：ADR 前提 5 明说 Pi 会在“自动重试”和“溢出/截断恢复”两处追加 `context_edit`；Himawari 只是关掉了自动重试。规则新文案直接说“只和压缩一起发生”，在一般意义上不成立，只在本仓库当前配置下成立。
- 建议：改成“Himawari 关闭自动重试后，`context_edit` 只随压缩出现”，避免以后有人打开重试时误以为规则仍然成立。

### 7【低】v3 恢复没有断言 `entries` 重建出的前缀等于捕获时的模型投影前缀
- 文件：`packages/runtime-pi/src/pi-tool-batch-continuation.ts:36-55`、`:118-120`
- 问题：v2 直接把 `messages.slice(0,index)` 存成 `prefix`，续跑时用的就是模型真正见过的前缀。v3 改成存 entries，再靠 `buildSessionContext()` 重建；`checkedBatch` 只检查“最后一条不是 assistant”，没有比对重建结果与捕获时 `state.messages`（去掉 system）是否逐条一致。若 Pi 的投影逻辑与捕获时状态出现偏差（版本变化、context_edit、压缩边界），续跑可能悄悄从另一份前缀继续。
- 证据：`capturePiToolBatch` 用 `messages` 取 assistant/completedResults，却用 `branch` 取 `entries`；`checkedBatch` 只做 `const last = prefix.at(-1); if (!last || last.role === "assistant") throw ...`。
- 建议：在 capture 时增加一致性断言：`buildSessionContext(entries).messages`（去 system）应等于 `messages.slice(0, index)`（去 system）；不一致就拒绝保存，而不是静默续跑。

### 8【低】历史 `sha256` 与过滤后的有效例外集合不完全对应（审计口径）
- 文件：`scripts/ci/security-exceptions.mjs:232-234`、`:257`、`:269`；`scripts/ci/security-published-fixtures.mjs:75`
- 问题：`withoutRemovedDependencies` 过滤后，`exceptions` 是子集，但 `sha256`/`sourceSha` 仍按**原始 base bytes** 计算。`security-published-fixtures.mjs:75` 把该 hash 当 `policySha256` 发布。审计时“policySha256 对应的文件”里包含不再生效的条目，和实际受审阅集合不一致。不是安全漏洞（过滤只会减少豁免），但证据语义容易误读。
- 建议：要么在证据里同时记录“原始 base hash”和“过滤后集合 hash”，要么在 `finish()` 里注明过滤规则。

## 二、推测 / 未核实（不能从仓库确认）

- **0.84.2 与 1.5.0 请求体逐字节相同**：仓库里没有可复现的对比脚本，安装目录也没有 node_modules，无法核对。ADR:79 和案例库:5452 的“一个字节都没变”只能算作者自述。
- **Pi 1.5.0 `getCurrentTools`/`normalizeContext`/`SessionManager.inMemory(cwd, options, entries)` 的实际行为**：node_modules 不在仓库中，只能依据 ADR 引用的上游描述；`entries` 是否会带 `type:"session"` 头、`getCurrentTools` 返回顺序/去重行为都未核实。代码里的 `batchSessionManager` 显式拒绝 `type:"session"`（`pi-tool-batch-continuation.ts:79`），说明作者也把这点当成未定风险。
- **`jsonToolArguments` 会触发 getter**：它用 `Object.values(value)` 遍历；若传入带访问器属性的“普通对象”，会执行 getter。当前两处入参都来自 JSON/structuredClone，风险低，属于防御性建议，不是已证实缺陷。
- **新增 Pi 1.5.0 安装包里的合成密钥 findings**：已核对的候选例外（`google-auth-library@10.9.1`、`zod@3.25.76`、嵌套 `zod@4.4.3` 等）在新锁文件里仍存在（`package-lock.json:4993-4996`、`:9047-9050`、`:1748-1751`），但新 Pi tarball 是否会产生未登记 findings 无法在此环境验证；ADR 已承认需要重做例外。

## 三、侧重检查（错误路径、不可信输入、安全、资源、不可逆）

- **不可信输入**
  - `jsonToolArguments` 对顶层非对象/数组、循环引用、非有限数、非普通对象、Symbol 键、数组空洞有明确拒绝，深度/节点有上限（`json-tool-arguments.ts:13-43`）；但无测试（见问题 2）。
  - `batchSessionManager` 校验 persisted entries 是数组、每项是对象、有 string `type/id`、拒绝 `session` 头（`pi-tool-batch-continuation.ts:73-85`）；快照本身经 `RuntimeContinuationService` 的 protector 加密存储（`runtime-continuation-service.ts:43-51`），不是攻击者可直接写的明文。
  - `withoutRemovedDependencies` 只做“减少豁免”的过滤，候选清单仍被 `validateSecurityExceptions` 严格校验（`security-exceptions.mjs:230`），未发现可利用的放宽路径；候选里保留的 published 条目与锁文件抽样核对一致。

- **错误路径**
  - 工具名不一致 → `failedPiStream(model, "PI_REQUEST_TOOLS_DIVERGED")`（`pi-runtime-adapter.ts:1603`），fail-closed；它最终映射为 `PI_MODEL_ERROR`（`modelFailureCode` 只识别 429/402/401/403/5xx 和 context exhausted）。
  - 快照版本不对 → `checkedBatch` 抛 `PI_CONTINUATION_VERSION_INVALID`（`:89`）；生产恢复扫描遇到非 v3 直接 `continue`（`production-tool-result-recovery.ts:226-227`），不会误重放旧批次。
  - checkpoint 保存失败 → `createTool` 返回 `RUNTIME_TOOL_CHECKPOINT_FAILED` 的 not_sent 失败结果（`pi-runtime-adapter.ts:2030-2043`），不会执行工具。
  - `sandboxed-coding-executor` 中 `jsonToolArguments` 抛错在 `try` 之外，但最终由 container main 的 `catch` 变成 `PI_RUNNER_EXECUTION_FAILED`、退出码 1（`container-pi-main.ts:110-112`），属于 fail-closed，可接受。

- **安全**
  - 例外过滤不会隐藏 findings：它只会把“依赖已不存在的 base 例外”丢掉，丢掉后扫描更严格；候选清单仍严格校验。未发现可以通过删除锁文件依赖来“洗掉”仍在扫描范围内的 finding 的路径。
  - 新增错误码只输出错误名，不包含参数/消息内容，未见新的敏感信息泄露点。

- **资源耗尽**
  - `jsonToolArguments` 的深度/节点上限有界。
  - 但 v3 的捕获路径变重：`capturePiToolBatch` 每个 tool checkpoint 都调用 `checkedBatch`，后者 `batchSessionManager()` 对**整段会话** `structuredClone` 并 `buildSessionContext()`，返回时又 `structuredClone` 一次；续跑时 `piToolBatchSessionManager` 再 `checkedBatch` + `batchSessionManager`，`restorePiToolBatch` 又 `checkedBatch`。长对话 + 多工具时是多次全量克隆/会话重建（`pi-tool-batch-continuation.ts:118-130`、`:139-142`、`:146`）。不是正确性 bug，但属于本次引入的性能/内存放大，建议 capture 时复用已校验结果、只 clone 一次，或把重建校验延迟到 restore。

- **不可逆操作**
  - 已完成工具的防重放仍成立：续跑时 `completedResult` 直接返回保存结果（`pi-runtime-adapter.ts:1543-1545`、`1964-1970`），compat 测试用 `effects` 断言第一个已完成工具没有被再次真实执行（`pi-tool-batch-continuation.compat.test.ts:158`）。
  - 并行批次仍要求 `completedResults.length === 0`（`:106`），即并行情况下已完成结果不会被冻结；这是与 v2 相同的既有约束，未因本次改动放宽。

## 四、逐条回答必答问题

1. **会不会改变模型已经见过的请求开头？**
   读代码看，仍然只在末尾追加，前提是 Pi 把全部“请求开头”放在 `role:"system"` 的首条消息里。
   - `himawariRequestContext` 过滤掉全部 system 消息，用冻结的 `systemPrompt`/`tools` 重新组成 `Context`（`pi-runtime-adapter.ts:642-657`），再在 `admitPiStream` 里 `normalizeContext(withPlaceholderLegend(context))`（`:953`、`:1064`）。
   - 历史落盘时过滤 system（`:1644-1645`），下一轮 history 回填后又被过滤，系统提示/工具由冻结 bundle 重新放回开头；本轮变化的记忆/时间在 `turnPrompt` 的最后一条 user 消息里（`turnPrompt`，`:604-622`）。
   - 因此“系统提示、工具定义、历史消息、遮盖结果只追加、每轮变化值在最后一条消息”在**当前 Pi 只产生首条 system 消息**的前提下成立。
   - 需要注意的例外/未核实：`himawariRequestContext` 会丢弃**所有** system 消息（不只是首条）；若 Pi 1.5.0 在对话中间产生 system/developer 消息，这些内容会被静默删除而不是报告，`faux-model-fixture.observedRequest` 也只对 `role === "system"` 报错（`faux-model-fixture.ts:16-24`），没有覆盖 `developer`。这是“数据丢失”风险，不是前缀追加破坏，但没有测试证明不会发生。

2. **同一段文字会不会在不同请求里变成不同字节？**
   未发现本次改动新增不确定性来源：
   - `messages.filter(...)` 和 `withoutRemovedDependencies` 都保持原顺序，不重排；
   - 工具集合在 bundle 存在时来自冻结 JSON，顺序稳定；
   - 出口图例是常量，追加位置与原来一致；
   - `jsonToolArguments` 只做校验不做重写；
   - 没有新增时间字段或无序集合进入请求。
   - 未核实项：无 bundle 时工具来自 Pi 的 `getCurrentTools`，其顺序/去重依赖 Pi 内部实现（仓库无 node_modules），无法确认跨请求稳定。除此之外没有读到新的字节不确定来源。

3. **改动有没有对应自动检查，反向用例是否真的会失败？**
   部分有，不完全：
   - 有：`findPrefixBreak` 新增“中途 system/developer 判破坏”，反向用例 `prompt-prefix.compat.test.ts:860-872` 直接构造报文并断言返回 `mid-system-message`，**这个反向用例是真的会失败**（读代码可确认）。
   - 有：安全例外过滤的测试 `test/tooling/security.test.mjs` 新增用例，去掉过滤会重新抛 `SECURITY_EXCEPTION_DEPENDENCY_UNKNOWN`，**有效**，但只覆盖 `advisory`。
   - 缺：规则/ADR 宣称的“打开 Pi 自动重试”反向用例不存在（见问题 1）。
   - 缺：`jsonToolArguments` 各拒绝分支、`PI_REQUEST_TOOLS_DIVERGED`、`published-synthetic-fixture` 过滤分支都没有专门测试。
   - 未验证：0.84.2↔1.5.0 请求体逐字节对比没有提交为自动检查，只有作者自述。

4. **改动产生/修改的每个值，每个使用它的地方都能接受吗？**
   逐个核对如下（读代码证实）：
   - `"pi-tool-batch.v3"`：产生于 `capturePiToolBatch`（`:47`）；`checkedBatch` 严格相等，否则抛 `PI_CONTINUATION_VERSION_INVALID`（`:89`）；`inspectPiToolBatch` 对非 v3 返回 `undefined`（`:174`）；唯一生产消费者 `production-tool-result-recovery.ts:226-227` 已改成 `if (!batch) continue;`。旧 v2 续跑会明确失败，符合 ADR。两端接受。
   - `entries: SessionEntry[]`：产生于 `sessionManager.getBranch()` 切到 assistant 之前（`:41-48`）；消费者 `batchSessionManager` 校验数组/`type`/`id` 并 `SessionManager.inMemory(cwd, options, structuredClone(entries))`（`:68-86`）；compat 测试还做了 `JSON.parse(JSON.stringify(saved))` 往返（`pi-tool-batch-continuation.compat.test.ts:100`），说明 JSON 序列化可接受。接受。
   - `systemPrompt`：产生于适配器 `:1297-1302`，捕获时存入（`:49`），续跑时由 `piToolBatchSessionManager` 与当前值严格比较（`:140`），不参与建会话；两端都是 string，接受。冗余但安全（`identity` 已经先校验）。
   - `jsonToolArguments` 返回值：交给 `validateToolArguments` 的 `arguments` 字段（`prepare-file-mutation.ts:57-62`、`sandboxed-coding-executor.ts:48-53`），类型为 `JsonObject`，可赋给期望 `Record<string, unknown>` 的位置。接受。
   - `withoutRemovedDependencies` 返回值：交给 `validateSecurityExceptions`（`check-security.mjs:576-582`、`security-exceptions.mjs:233-234`），过滤条件与 `validateSecurityExceptions`/`validatePublishedEntry` 使用的 `path/name/version` 完全一致（`:143-162`、`:190-213`）；候选清单仍先严格校验（`:230`）。接受，且失败方向是更严格。
   - `inspectPiToolBatch` 的“undefined 表示旧版本”：唯一消费者已适配（见上）；无其它调用方（全仓 grep 确认）。
   - 错误码 `PI_CONTINUATION_PREFIX_INVALID` / `PI_CONTINUATION_SYSTEM_PROMPT_CHANGED` / `PI_TOOL_ARGUMENTS_INVALID` / `PI_REQUEST_TOOLS_DIVERGED`：没有专门的错误码枚举/映射表需要同步，最终按 `modelFailureCode` 落到 `PI_MODEL_ERROR` 或向上抛出；未见因新增值导致某处校验拒绝。
   - 小问题：测试里把 `"pi-tool-batch.v3"` 写死为字面量（`pi-runtime-adapter.compat.test.ts:3761`、`tool-batch-state.unit.test.ts:145`），没有引用导出的 `PI_TOOL_BATCH_VERSION`；运行时不会出错，但常量变更时测试不会提示。

总体：**没有读到会直接破坏“请求只追加”或“已完成工具被重复执行”的高严重度缺陷**；主要风险集中在“文档/规则声称的门禁与真实测试不符”、以及新增参数校验/快照恢复路径缺少反向测试和一致性断言。
