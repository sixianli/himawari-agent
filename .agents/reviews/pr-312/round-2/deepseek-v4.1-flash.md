## 发现（按严重度从高到低）

### 1. 低 — 归档后的 Backlog 摘要仍说“现在有两份”，与本 PR 合并后的代码相反
- 文件:行：`docs/archive/backlog/BL-20261017-005-合-并-两-份-界-面-可-显.md:22`
- 问题：`record_state` 已改成 `done`、`result` 也写了合并结果，但正文 Summary 仍用现在时写“这份……清单 `SAFE_TOOL_REASON_CODES` 现在有两份：`thread-execution-state.ts`……和 `thread-execution-projection.ts`”。代码里 `thread-execution-projection.ts:29` 已改成从 `thread-execution-state.ts` import，`:420` 也只使用这一份，投影侧不再有本地副本。作者说第 1 轮 R1-3 的问题之一就是“摘要说白名单现在有两份”，这次只改了 frontmatter，没有改摘要。
- 证据：
  - `docs/archive/backlog/...:22`：`这份“可显示的原因码”清单 SAFE_TOOL_REASON_CODES 现在有两份：...thread-execution-state.ts...和...thread-execution-projection.ts...`
  - `packages/application/src/services/thread-execution-projection.ts:29`：`import { projectThreadExecutionState, SAFE_TOOL_REASON_CODES } from "./thread-execution-state.js";`
- 建议：把 Summary 改成过去时/历史描述（例如“合并前有两份”），或明确以 `result` 字段为准；不要让归档正文继续断言一个已不存在的现状。

### 2. 低 — 一处“反向断言”改成了一句任何代码路径都不会产生的字符串，等于永远不会失败
- 文件:行：`apps/agent-service/test/production-runtime-tools.unit.test.ts:527`
- 问题：这条断言原本是用 `/ 1_000_000` 重算默认上限，验证消息用的是本次生效的 `ceiling`（12.5 秒、256 MB），而不是 fixture 默认值。现在改成 `not.toContain("CPU 时间 1 秒、内存 1.0 MB")`。默认 fixture 是 `maxCpuTimeMs: 1000, maxMemoryBytes: 1_000_000`；按改后的 `limitBytes`，1,000,000 字节会显示成 `976.6 KB`，根本不可能是 `1.0 MB`。所以这条反向断言无论代码用哪个上限都不会失败。作者在 `f0425bce` 的提交说明里写“改成写明具体字符串”，但写错了具体字符串。
- 证据：
  - `apps/agent-service/test/runtime-tools.fixture.ts:307-311`：`ceiling: { ... maxCpuTimeMs: 1000, maxMemoryBytes: 1000000, maxOutputBytes: 1000 }`
  - `apps/agent-service/src/production-sandbox-tool-result.ts:147-152`：`limitBytes` 先判 `>= 1024 * 1024`，否则按 `/ 1024` 算 `KB`
  - `apps/agent-service/test/production-runtime-tools.unit.test.ts:527`：`not.toContain("CPU 时间 1 秒、内存 1.0 MB")`
- 建议：改成 `not.toContain("CPU 时间 1 秒、内存 976.6 KB")`，或直接用同一套格式化逻辑从 `f.options.ceiling` 算期望字符串；不过同一用例的 `:525-526` 正向断言已经能挡住“用错默认上限”，所以这条只是失效，不是功能风险。

### 3. 低 — 新加的 `inspectToolResultRecovery` 名叫“只判断”，实际仍会执行有副作用的 `recoverMissingResult`；作为组合对象的新公开字段偏宽
- 文件:行：`apps/agent-service/src/production-run-composition.ts:315-334`、`:764`
- 问题：`inspectToolResultRecovery` 由 `toolResultRecoveryParts` 创建，而这份参数包含 `recoverMissingResult`（`:315-318`）。`production-tool-result-recovery.ts:150-156` 会调用它，`production-sandbox-lost-result-recovery.ts:47-91` 在条件满足时会 `saveOutput` 并 `recordOperation` 写记录。也就是说这个“inspection”实例只是拿不到 `resultUnrecoverable` 写“不可恢复”标记的入口，并非只读。把它放进 `createProductionRunComposition` 的返回值，等于给一个能改状态的方法起了个只读名称并扩大了返回对象的表面。它不会暴露到 HTTP/跨进程，安全影响很低；主要风险是以后有人按名字误用。
- 证据：
  - `production-run-composition.ts:315-318`：`const toolResultRecoveryParts = { ...(options.recoverMissingToolResult ? { recoverMissingResult: ... } : {}), ... }`
  - `production-run-composition.ts:334`：`const inspectToolResultRecovery = createProductionToolResultRecovery(toolResultRecoveryParts);`
  - `production-run-composition.ts:764`：`inspectToolResultRecovery,`
  - `production-tool-result-recovery.ts:150-156`：`options.recoverMissingResult && ... admission = { ...admission, record: await options.recoverMissingResult(admission.record) };`
- 建议：改名为 `recoverToolResultWithoutUnrecoverableMarker` 之类，或只在测试注入的 `testHooks` 里暴露；若只想给测试一个入口，也可以导出一个显式的测试工厂，而不是把方法挂在生产组合对象上。

### 4. 低 — 新断言守的是返回对象里的 `inspectToolResultRecovery`，不是 `authorizeAuthorityChange` 实际选了哪个实例
- 文件:行：`test/integration/sqlite-sandbox-execution-v2.test.ts:6159-6172`，配合 `apps/agent-service/src/production-run-composition.ts:343`
- 问题：这次目标回归“把 `resultUnrecoverable` 挪进共享参数”确实会被这条断言抓住：一旦挪进去，`inspect` 调用会写 `sandbox-tool-result-unrecoverable:%`，`:6172` 的 `count: 0` 会变成 1（后面的 `:6211-6212` 又证明正常 pump 会写 1 条，形成对照）。但若以后有人把 `:343` 的 `inspectToolResultRecovery(request)` 直接换成 `prepareToolResultRecovery(request)`（写记录的那个实例），现有用例不会红：`late` 那一路虽然会走 `authorizeAuthorityChange`，但那时结果已恢复为 known，写记录条件不成立，新断言又只调用被导出的 `inspect` 实例。所以“调用点被换回写实例”仍是未覆盖的窄缺口。
- 证据：
  - `production-run-composition.ts:343`：`const prepared = await inspectToolResultRecovery(request);`
  - `test/.../sqlite-sandbox-execution-v2.test.ts:6160-6172`：对 `make("authority-inspection").inspectToolResultRecovery(...)` 断言 `undefined` 且 `operation_key LIKE 'sandbox-tool-result-unrecoverable:%'` 计数为 0
  - `test/.../sqlite-sandbox-execution-v2.test.ts:6211-6212`：pump 后 `markers()` 期望 `{ count: decisive ? 1 : 0 }`
- 建议：如果要在调用点也设门槛，可以断言 `prepareToolResultRecovery` 与 `inspectToolResultRecovery` 不是同一个函数，或为 `authorizeAuthorityChange` 构造一次“另一条 admission 结果未知且不可恢复”的请求；成本较高，可作为后续补强，不是本 PR 的阻断项。

## 侧重检查

- **错误路径**：`inspectToolResultRecovery` 的调用会经过 `checkpoints.read`、artifact 读取、`traceStore.readRun`（上限 10000 条，超限抛 `TOOL_RESULT_RECOVERY_TRACE_LIMIT`）和 `readRunInventory`。新增的测试调用会额外走一遍这条路径；在 `loss-unrecoverable` 里它发生在写终止记录之后、pump 之前。结论：读代码确认该次调用不写数据库（见下条必答问题 1 的细化），不会改变后续断言。
- **不可信输入**：新调用参数是测试常量 `runId/OWNER_ID/AGENT_ID`；函数内部仍校验 `candidate.ownerId/agentId` 与闭包一致，并校验 checkpoint/artifact/continuation 的身份，未引入新的输入面。
- **安全 / 不可撤销操作**：这次改动的核心是**把写“不可恢复”记录的能力留在 `prepareToolResultRecovery`**，让 `authorizeAuthorityChange` 用没有 `resultUnrecoverable` 的实例。读代码确认写记录条件在 `production-tool-result-recovery.ts:157-167` 以 `options.resultUnrecoverable &&` 为前提，而 `toolResultRecoveryParts` 不含该字段，所以延续授权那条路确实写不了。没有发现新的不可撤销操作。
- **资源耗尽**：新测试多跑一次恢复扫描（最多 10000 条 trace、分页读取），仅在测试中；生产没有新增调用点。未发现新的资源耗尽路径。
- **规则/文档与代码一致**：
  - I-84 行改后的“这条路的实例没有传入这个回调，写记录的条件永远不成立”与 `production-run-composition.ts:315-334`、`production-tool-result-recovery.ts:159` 相符。
  - `docs/lessons.md:668` 删掉 `safe-tool-reason-codes.test.mjs` 的说明与仓库现状相符；该文件已删除且全仓没有其他引用（grep 仅剩 docs 里的历史说明）。`prompt-catalog.unit.test.ts` 确实存在并按路径扫 `apps/*/src`、`packages/*/src`，`check:glossary` 也确实是 `package.json:31` 的脚本。
  - 但归档 Backlog 的 Summary 仍与代码相反，见发现 1。
- **合并**：`git diff --name-status 56857092..e29a3007` 显示合进来的都是 main 上的其他改动；`git diff --name-status 5530765e..e29a3007` 恰好只剩本 PR 的 19 个文件。没有看到合并把本 PR 文件的改动改回去（本 PR 文件不在合并带入的清单里）。

## 结论

未发现高、中严重度的功能回归。新加的“写记录实例 vs 只判断实例”门槛在目标回归（把 `resultUnrecoverable` 挪进共享参数）上确实会变红；`loss-unrecoverable` 里的新调用经读代码确认不会给后续断言带入副作用。剩余问题集中在文档现状描述、一条失效的反向断言、以及“inspection”实例的命名/暴露面和调用点覆盖缺口，均为低严重度。

## 证据性质：读代码证实的 vs 推测

**读代码证实：**
- `inspectToolResultRecovery` 由不含 `resultUnrecoverable` 的 `toolResultRecoveryParts` 创建（`production-run-composition.ts:315-334`）。
- 写记录条件以 `options.resultUnrecoverable` 为前提（`production-tool-result-recovery.ts:159`）；删除的 `purpose` 参数没有残留调用方（grep 只找到 `production-run-composition.ts` 的调用）。
- `loss-unrecoverable` 中 `recoverMissingResult` 的 `verifyExited` 为 false（测试 `:5786`），因此 `production-sandbox-lost-result-recovery.ts:42-46` 会直接原样返回，不会 `saveOutput`/`recordOperation`；`resultUnrecoverable` 不在 inspect 实例上，`markUnrecoverable` 不会执行。
- 同一变体后面 `:6211-6212` 期望正常 pump 后该记录数为 1，说明新断言的“0 条”与正常写入之间有对照。
- `production-runtime-tools.unit.test.ts:527` 的字符串在当前两种 ceiling 下都不会出现（默认是 `976.6 KB`，覆盖值是 `256 MB`）。
- `SAFE_TOOL_REASON_CODES` 现在只有 `thread-execution-state.ts:28` 一处定义，`thread-execution-projection.ts:29` import，`:420` 用 `.has`；没有序列化或迭代依赖。
- 删除的 `test/tooling/safe-tool-reason-codes.test.mjs` 在全仓没有其他有效引用。

**推测（未实际运行测试）：**
- “把 `resultUnrecoverable` 挪进 `toolResultRecoveryParts` 后新断言会以 `count: 1` 失败”：从代码路径看条件都会满足（诊断码 `RUNTIME_TOOL_RESULT_UNKNOWN`、bound/foreground/released/有 releaseReceipt、流终止原因 `resource_limit` 使 `sandboxStreamResultUnrecoverable` 为 true），作者也声称实测过；我没有运行测试验证。
- `authorizeAuthorityChange` 若被改成使用 `prepareToolResultRecovery`，现有测试不会变红：依据是 `late` 走该路径时结果已 known，且新断言只调用导出的 inspect 实例；这是逻辑推断，未构造反向用例验证。

**未核实：**
- 没有实际运行 `npm test` / `npm run typecheck` / `lint` / `check:*`，这些结论来自读代码和 diff。
- 作者提到的 `format:check` 在 main 上失败、`validate_docs.py --strict` 的 11 条 Runbook 哈希错误，我没有复跑。
- PR 描述中 R1-8 关于 `check:incident-gates` 的措辞，不在当前仓库文件里，未核实。

## 必答问题

**1. 这个改动会不会改变模型已经见过的请求开头？**
不会。本 PR 唯一改到发给模型内容的，是 `apps/agent-service/src/production-sandbox-tool-result.ts:147-152` 和 `:163` 的上限说明文字；它经 `production-runtime-tools.ts:2103-2106` 计算后写入工具结果的 `modelContent`（`:2144-2160`），属于追加的工具结果消息，不是系统提示、工具定义或历史改写。白名单合并、测试、文档和组合对象新增字段都不进入模型请求。已存储的历史仍保存当时实际发出的字节。仍符合“只在末尾追加”；会变的上限数值位于这次工具结果消息里。

**2. 同一段文字会不会在不同请求里变成不同字节？**
不会。`limitBytes` 只取决于传入的 ceiling 数值，无时间、无随机、无上下文依赖（`production-sandbox-tool-result.ts:147-152`、`limitAmount` 在 `:130`）。`SAFE_TOOL_REASON_CODES` 只被 `.has` 使用，`Set` 的遍历顺序不会进入输出。新测试的 SQL 过滤和 `inspectToolResultRecovery` 只影响测试/内部状态，不影响模型文本。

**3. 改动有没有对应的自动检查，反向用例是否真的会失败？**
- “不写记录的实例”门槛：有，`test/integration/sqlite-sandbox-execution-v2.test.ts:6159-6172`。其中真正会红的是记录数断言；`expect(inspected).toBeUndefined()` 单独看不会因共享参数回归而红。按代码路径推断，共享参数被改坏时记录数会从 0 变 1，故反向用例有效（作者称已实测）。
- 上限文字换算：单测覆盖了 1024 进制和字节分支（`production-sandbox-tool-result.unit.test.ts:162-173`）及运行时文案（`production-runtime-tools.unit.test.ts:525-526, 558, 563-565`）；但 `:527` 那条反向断言已失效（见发现 2），好在同一场景的正向断言仍能挡住用错上限。
- 白名单合并：原“两份拷贝一致”的测试已删除；合并后行为由 `packages/application/test/thread-execution-state.unit.test.ts` 的相关用例覆盖。若以后有人重新引入第二份本地副本，目前没有检查会失败——这是已知的维护性缺口，不改变现有行为。

**4. 改动产生/修改的每个值，使用它的一方都能接受吗？**
逐项核对：
- 新增字段 `inspectToolResultRecovery`：产生于 `production-run-composition.ts:334`；使用方是 `:343` 的 `authorizeAuthorityChange`（签名接受一个 candidate）和测试 `:6160`；返回对象其余使用方（如 `service-main.ts`）不依赖这个字段，新增字段不破坏它们。
- 删除的 `purpose` 参数：`createProductionToolResultRecovery` 的签名（`production-tool-result-recovery.ts:79`）已去掉；全仓没有其他调用方传第二个参数，旧的 `recordUnrecoverable` 条件已同步删除。
- `SAFE_TOOL_REASON_CODES`：产生于 `thread-execution-state.ts:28`；使用方 `thread-execution-state.ts:155,161` 和 `thread-execution-projection.ts:420` 都是 `.has(string)`，类型和语义一致；没有其他清单项/配置键引用旧的两份拷贝。
- 上限文本格式 `"MB"/"KB"/"字节"`：只作为字符串进入 `modelContent` 和测试，不参与解析或后端校验；未发现其他消费者依赖旧格式（全仓没有残留 `268.4 MB/32.8 KB` 等旧期望）。
- 新测试的 `operation_key LIKE 'sandbox-tool-result-unrecoverable:%'`：与 `sandboxUnrecoverableResultOperationKey` 实际生成的 `sandbox-tool-result-unrecoverable:${invocationId}` 前缀一致，且 `markUnrecoverable` 以 `purpose="trace"` 提交（`production-tool-result-recovery.ts:52-71`），测试的 `purpose='trace'` 和 `run_id` 过滤两端吻合，没有 I-73 那种“清单值过不了另一端校验”的问题。
- 归档 Backlog：`record_id`/状态字段自洽，旧路径没有其他文档引用；唯一问题是正文 Summary 仍断言“现在有两份”（发现 1）。
