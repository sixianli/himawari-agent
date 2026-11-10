# PR 338 复核报告（Pi 0.84.2 → 1.5.0）

## 读代码证实的问题（按严重度）

### 1.【中】文档声称存在一个并不存在的反向用例：“打开 Pi 的自动重试，检查必须报告失败”
- **文件**：`.claude/rules/prompt-prefix.md:74`、`docs/engineering-casebook.md`（案例 86“我们的方案”段）、`docs/adr/0198-upgrade-pi-to-1-5-0.md` 决定 7。
- **问题**：三处都说 `check:prompt-prefix` “还带反向用例：……打开 Pi 的自动重试（失败的回答会被重发并用 `context_edit` 拿掉），检查都必须报告失败”。仓库里没有这个用例。
- **证据**：
  - 全仓库测试中 grep `retry:\s*\{\s*enabled:\s*true` 无命中；
  - 重试开关在适配器里写死：`packages/runtime-pi/src/pi-runtime-adapter.ts:1386` `retry: { enabled: false, maxRetries: 0 }`，测试没有注入缝可以打开它；
  - `prompt-prefix.compat.test.ts:793` 新增的 `[ADR-0198]` 用例是**正向**的（重试关闭时 503 不重发、`bodies` 不含 `context_edit`、前缀不变），不是“打开重试必须失败”。
- **建议**：要么给适配器加一个 settings 注入缝并补上真正的反向用例，要么把三处文档改成如实描述（“关闭重试是硬编码，用例证明 503 不重发”）。规则文字是硬规则的载体，声称的检查不存在属于规则与代码不一致。

### 2.【中】新增的保护分支 `PI_REQUEST_TOOLS_DIVERGED` 没有任何测试
- **文件**：`packages/runtime-pi/src/pi-runtime-adapter.ts:642-657`（`himawariRequestContext`）、`:1603`。
- **问题**：工具名集合不一致时返回 `undefined` → 不发请求、直接失败。这是本 PR 新增的“宁可不发也不改请求开头”的防线，但全仓库没有任何测试引用该字符串，既没有证明它会触发，也没有证明正常轮次（执行句柄出现/消失）不会误触发。
- **证据**：`himawariRequestContext` 里 `if (piTools.length !== declared.size || piTools.some(({ name }) => !declared.has(name))) return undefined;`（649-651）；grep `PI_REQUEST_TOOLS_DIVERGED` 只命中 src、ADR 文档，无测试。
- **影响**：一旦误触发（例如 Pi 未来往 transcript 里加内部工具），对外只表现为 `modelFailureCode` 折叠后的通用 `PI_MODEL_ERROR`（`pi-runtime-adapter.ts:420-428`），日志记 `provider_message_withheld`，很难排查。
- **建议**：补两条用例：构造 `piTools` 与冻结工具不一致的 `TranscriptContext` 断言不发请求；断言句柄工具增减的正常轮次不触发。

### 3.【中低】新文件 `json-tool-arguments.ts` 完全没有测试
- **文件**：`packages/runtime-pi/src/json-tool-arguments.ts`（46 行新文件）。
- **问题**：grep 全仓库测试无 `jsonToolArguments` 引用。它有真实行为边界：深度 >64、节点 >10 万、稀疏数组、循环引用、`Number.isFinite` 之外的数都会把工具执行变成失败，而且插在 Pi 自己的 `validateToolArguments` 之前（`prepare-file-mutation.ts:61`、`sandboxed-coding-executor.ts:52`）。
- **建议**：补单元测试：正常 JSON 通过、循环引用拒绝、深度/节点上限。

### 4.【低】`production-tool-result-recovery.ts:227` 的 `if (!batch) continue;` 没有测试
- **文件**：`apps/agent-service/src/production-tool-result-recovery.ts:226-227`。
- **问题**：v2 快照在恢复扫描中被跳过，语义符合 ADR 决定 4（Andy 同意作废旧批次），但这条路径在升级上线时会真实走到，`apps/agent-service/test/` 下没有相关用例（docs/incidents-and-gates.md I-84 列的测试也不涉及它）。跳过之后该运行如何收尾没有任何自动检查。
- **建议**：加一条用例：v2 快照不产生 `matches`，运行按既定失败路径收尾。

### 5.【低】审批续跑那轮的请求开头只有消息级断言，没有字节级比对
- **文件**：`packages/runtime-pi/test/pi-tool-batch-continuation.compat.test.ts:160-166`。
- **问题**：续跑改用 `SessionManager.inMemory(cwd, options, entries)` 重建历史（`pi-runtime-adapter.ts:1496-1500`）。compat 测试检查了 `observed[1]` 的 `toolResult` 顺序和“不重发第一次请求”，但没有把续跑请求的头部与挂起前请求逐字节比。若 Pi 的 entries→messages 重建有任何字段差异，挂起过的对话缓存会静默断裂，现有门禁不报（门禁没有覆盖“挂起→批准→续跑”流程）。
- **建议**：在 compat 测试里把 `observed[1]` 的头部切片（到最后一条 user 消息之前）与 `observed[0]` 做逐字节比较；或在门禁里加挂起/续跑轮次。

### 6.【信息】删除了三段解释性注释
- `prepare-file-mutation.ts`、`sandboxed-coding-executor.ts` 删掉了“Pi write 工具把 UTF-16 长度当字节数”“shell 非零退出在 Pi 里以抛出呈现”等说明，补偿逻辑本身保留（`sandboxed-coding-executor.ts:68-77`）。不改变行为，但丢失了维护者上下文，Pi 下次升级时容易再踩。

## 推测 / 未核实
- ADR 0198“前提”1-7 引用的 Pi 1.5.0 内部事实（`normalizeContext` 唯一入口、`SessionManager.inMemory` 恢复、`context_edit` 只在自动重试/溢出恢复出现）——本环境 `node_modules` 未安装，**未核实**，只有测试间接支持（`faux-model-fixture.ts` 的 mid-system 守卫、compat 测试走真实 Pi）。
- “同一份 Context 在 0.84.2/1.5.0 下请求体逐字节相同”——只见到 ADR/案例书的实验记录，方法合理但**未复核**。
- “npm run check 44/46、未过的 2 步 main 上同样失败”——未运行，未核实。

## 作者说法逐条核对
- `himawariRequestContext` 去掉 system 消息、用冻结提示/工具重组、`normalizeContext(withPlaceholderLegend(...))`、工具名不一致返回失败流：**证实**（pi-runtime-adapter.ts:642-657、953、1598-1603）。
- 存历史时过滤 system 消息：**证实**（pi-runtime-adapter.ts:1644-1646）。
- 续跑用快照条目建 SessionManager、续跑前核对冻结提示：**证实**（pi-runtime-adapter.ts:1496-1500；pi-tool-batch-continuation.ts `piToolBatchSessionManager` 抛 `PI_CONTINUATION_SYSTEM_PROMPT_CHANGED`；外层 identity 已含 systemPrompt，1314-1325，双保险）。
- 快照 v3、非 v3 `inspectPiToolBatch` 返回 undefined、recovery 跳过：**证实**（pi-tool-batch-continuation.ts `PI_TOOL_BATCH_VERSION`、`inspectPiToolBatch`；production-tool-result-recovery.ts:227），但 recovery 跳过无测试（见问题 4）。
- json-tool-arguments 检查：**证实存在**，无测试（问题 3）。
- security-exceptions：base 已接受例外里指向已移除依赖的条目不再参与校验、候选清单仍严格校验：**证实**（security-exceptions.mjs:230 先严格校验候选，233 只对 base 字节过滤；过滤判据与 validator 的 `SECURITY_EXCEPTION_DEPENDENCY_UNKNOWN` 完全一致，security-exceptions.mjs:190-208 对照 148-156/54-62，只可能删掉本来会被拒的条目）；有双向测试（test/tooling/security.test.mjs 新 describe：先断言抛错、清理后断言加载成功）。例外清单删掉了全部 0.84.2 条目且未加 1.5.0 新条目——ADR 已披露“CI security 作业不阻断、需 Andy 重批”，与作者说法一致。
- 自动重试关闭：**证实**（pi-runtime-adapter.ts:1386）。但“check:prompt-prefix 带打开自动重试的反向用例”**不成立**（问题 1）。
- 其余（Pi 1.5.0 内部事实、逐字节对照实验、测试全过、check 44/46）：未核实。

## 侧重检查
走的最普通流程（读代码 + 测试定位，未运行）：
`produce`（pi-runtime-adapter.ts:1221）→ 解析投影/冻结 bundle（1283-1308）→ 建 SessionManager + 会话（1496-1532）→ `session.prompt`（1755）→ Pi 循环 → `streamFunction`（1598）→ `himawariRequestContext`（642）→ `admitPiStream` 内 `normalizeContext(withPlaceholderLegend(context))`（953）→ `restoreModelStream` 转发原 streamFunction（1061）→ 出口遮盖。审批分支：`suspend`（1563）→ `saveToolCheckpoint` → `capturePiToolBatch` v3（1514-1519）→ 恢复运行走 `piToolBatchSessionManager`（1496）→ `restorePiToolBatch` replay（1601）→ `agent.continue`（1753）。
结论：
- 主链路的请求开头组装、冻结、遮盖、存历史过滤 system 都有测试覆盖（prompt-prefix 门禁 8+ 条 `[I-66]`、compat 套件），且新检查（mid-system 反向、503 正向）与被改代码同文件、会被 `check:prompt-prefix` 跑到（`scripts/check-prompt-prefix.mjs:37-39` 按 fullName 含 `[I-66]` 过滤，新用例在该 describe 内）。
- **无测试覆盖的路径**：① `himawariRequestContext` 返回 undefined → `PI_REQUEST_TOOLS_DIVERGED`（1603）；② `json-tool-arguments.ts` 整个文件；③ recovery 的 `if (!batch) continue`（227）；④ 挂起→续跑请求开头的字节级稳定性（只有消息级）。
- 文档与代码不一致一处（问题 1），ADR 与代码决定一致。

## 必答问题
1. **会不会改变模型已见过的请求开头？** 读代码证实：仍是只在末尾追加。每轮请求 = 冻结提示 + 冻结工具（+本轮句柄工具）经 `normalizeContext` 折成的头部 system 消息，加只增的历史；`himawariRequestContext` 过滤 Pi 的 system 消息、冻结内容按对话不变；每轮变化的值（时间、记忆、运行环境）仍在最后一条 user 消息（`turnPrompt`，pi-runtime-adapter.ts:604-623）；出口遮盖未改，历史仍存遮盖前内容。门禁还新增“请求中间出现 system/developer 判破坏”的检查。保留意见：续跑那轮的开头改由 SessionManager 条目重建，字节级没有测试（问题 5）；“升级不改变老对话开头字节”依赖 ADR 记录的对照实验，未复核。
2. **同一段文字会不会在不同请求里变成不同字节？** 读代码证实：未发现新引入的来源。工具列表来自冻结 bundle JSON（顺序固定）或同一 transcript 派生，无时间字段进请求头，无集合乱序；Pi 自动重试（唯一会删回答的路径）写死关闭且有用例断言无 `context_edit`。前提是 `normalizeContext` 对相同输入确定（Pi 源码未核实）；续跑重建历史是唯一可能产生字节差的点（问题 5）。
3. **有没有对应的自动检查，反向用例会不会真的失败？** 门禁增强了：mid-system 反向用例直接驱动 `findPrefixBreak`，断言能报出 `mid-system-message`（prompt-prefix.compat.test.ts:860-872，反向会失败）；security-exceptions 有双向用例；tool-batch v1/v2 拒绝+跳过有正反用例（tool-batch-state.unit.test.ts:145-160）。缺口：文档声称的“打开 Pi 自动重试必须报失败”反向用例不存在（问题 1）；`PI_REQUEST_TOOLS_DIVERGED`、`json-tool-arguments`、recovery 跳过三处新代码零测试（问题 2/3/4）。
4. **每个产生/修改的值，两端都能接受吗？** 逐个核对：`pi-tool-batch.v3`——产生端校验条目/助手消息/结果一致性，消费端（restore、sessionManager、inspect）校验版本、parallel、systemPrompt 一致，外层 identity 再兜底；v2 旧快照按约定作废（问题 4 是覆盖缺口而非语义错误）。`PI_REQUEST_TOOLS_DIVERGED`——消费端折成 `PI_MODEL_ERROR`，不泄露内部信息，但分支无测试。`PI_TOOL_ARGUMENTS_INVALID`——两处使用都在 Pi 校验之后、执行之前，错误码与既有的 host-read-only-executor 同名一致；它在该文件 try 块之外抛出（sandboxed-coding-executor.ts:47-53），上层包装如何接住未核实。`withoutRemovedDependencies`——判据与 validator 完全一致、只可能更严，候选清单先严格校验，有测试。`piSessionId`——值不变，续跑复用。均未发现两端校验不匹配的问题。
