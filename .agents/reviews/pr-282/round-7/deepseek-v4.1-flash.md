## 结论

读代码逐条核对后，第 7 轮这一个提交（`8948124`）的核心说法基本成立：`finish()` 确实会无条件带 `exitCode`、`resource_limit` 在进程退出后才被观察到的状态可达、资源上限文案已改、三语门槛已加、假日志 `bind` 已接入生产校验。**未发现高危或中危的运行时缺陷**；发现三处低危的“门槛/说明与实现不完全一致”，以及一处测试覆盖缺口。

---

## 问题（按严重度）

### 低 1（已读代码证实）：三语内容门槛的“必须出现”只做了整组 `some()`，没有逐个原因词校验
- 文件:行：`apps/control-center/test/i18n-runtime.unit.test.ts:95-96`
- 问题：作者说“四个上限原因词……必须出现改后的说法”，但实现是“四个上限消息里**至少有一个**包含该句”，不是每一个原因词都包含。只要另外三条还保留新说法，某一条被改成别的（不含禁用词也不含新句）的文案可以通过。
- 证据：
  ```ts
  const required = {
    "zh-CN": ["执行已结束并完成清理", "已停止接收并完成清理"],
    ...
  }
  ...
  for (const text of required[locale])
    expect(ceilings.some((message) => message.includes(text))).toBe(true);
  ```
  注意 `forbidden` 是按每条消息逐条检查的（`:93-94`），所以“绝不出现已终止”这一半是逐条的；弱的只是“必须出现新说法”这一半。
- 建议：改成按消息 id 的期望表，例如 `expect(messages["chat.reason.toolCpuTimeLimit"]).toContain(...)`，逐个断言；禁用词继续逐条保留。这样既能防回退，也不会因为未来合理改写某一条就误报。

### 低 2（已读代码证实）：给模型的资源上限文案反向断言只禁「已被终止」，不禁「已终止」
- 文件:行：`apps/agent-service/test/production-runtime-tools.unit.test.ts:503-505`
- 问题：旧文案的完整回退仍会被 `toContain("执行已结束并完成清理")` 与 `not.toContain("在终止前")` 拦住；但如果有人写成“命令已终止，执行已结束并完成清理”，既不含“已被终止”、也不含“在终止前”，测试会绿。这与该用例“不得声称命令已被终止”的意图不完全一致。
- 证据：
  ```ts
  expect(result.modelContent).toContain("执行已结束并完成清理");
  expect(result.modelContent).not.toContain("已被终止");
  expect(result.modelContent).not.toContain("在终止前");
  ```
- 建议：与 i18n 测试一致，禁 `已终止`；或者直接断言完整期望文案（数值用本次上限拼出），这样最强的门槛就是“文案只能长这样”。

### 低 3（已读代码证实）：事故表把 `bind` 的绑定环境也说成“取已存事实”，与生产/假日志实现不完全一致
- 文件:行：`docs/incidents-and-gates.md:122`
- 问题：该行写“假日志现在在 `bind`、`append`、`operation` 三处都调用这个校验，绑定环境和生产一样取已存事实里的那一份”。但 `bind` 时不存在“已存事实”，生产 `bindAndStart` 用的是**本次传入事实**的 `environment`：
  - `packages/persistence-sqlite/src/sqlite-sandbox-execution-operations.ts:1163-1166`：`environment: input.facts.environment`
  - `test/integration/sandbox-v2-worker-lifecycle.test.ts:429-432`：`environment: command.facts.environment`
  只有 `append`/`operation` 才用已存事实（生产 `:1526`、假日志 `:523`）。作者 R6-3 的说法“`append`／`operation` 改成取已存事实”本身是对的，是事故表这句话把 `bind` 也带进去了。
- 证据：
  ```ts
  facts = validateSandboxExecutionFacts(plan, command.facts, {
    environment: command.facts.environment,
    operationContract: plan.operationContract,
  });
  ```
- 建议：把该句拆开写清楚：“`bind` 用本次传入的 environment（与生产一致）；`append`/`operation` 用已存事实里的 environment”。另外可补一句：生产 `bindAndStart` 还额外要求 `result === null`、`effect.kind === "unknown"`、`resource.sequence === 2`、`supervision === "initializing"`，假日志未复刻；这比只列 `operationOnly` 的三项更完整。

### 低 4（已读代码，属于覆盖缺口，不是已证实的缺陷）：SRT 任务环境路径的资源上限仍没有集成用例
- 文件:行：`apps/execution-worker/src/production-sandbox-execution-v2.ts:1810-1821`
- 问题：本地 job host 路径有 `[I-84] resource-limit`/`resource-limit-after-exit` 用例，但 SRT/容器路径的 `limitTermination` 分支没有用例。作者在未覆盖里已承认。判定函数 `sandboxResourceLimitReason` 有单测，`job-host-session` 也会保留 `resource_limit` 与 `resources`，读代码看是接通的；但“真实容器路径能写进 SQLite 并交给模型”没有自动证据。
- 证据：
  ```ts
  const limitTermination =
    outcome.reason === "output_limit"
      ? SANDBOX_OUTPUT_LIMIT
      : outcome.reason === "resource_limit"
        ? sandboxResourceLimitReason(plan.resourceCeiling, outcome.resources)
        : null;
  ```
- 建议：如果真进程成本不可接受，至少加一个“用假 session 返回 `reason: "resource_limit"` + `resources`”的 worker 层用例，覆盖这条分支和 `effect: unknown` 的写入；否则在事故表明确写“该分支只有判定函数级单测，没有 worker 级用例”，不要声称“三条路径走的是同一个判断”就好像已覆盖。

### 推测/未核实（不影响本轮结论）
- 我无法运行测试（工具限制），所以“改回旧值会失败”“36 条用例全过”只能按断言静态判断，**未实际执行**。
- 仓库没有 `origin/main` ref（`git log origin/main` 报 unknown revision），“`origin/main` 没有变化”**未核实**。
- 上限轮次 `effect.kind = "unknown"` 会使记录持续满足 `listPending` 的 `$.effect.kind='unknown'` 条件（`sqlite-sandbox-execution-operations.ts:422-423`）；启动恢复对无 recovery 的记录只会第一次写入 recovery 状态、之后幂等（`sqlite-sandbox-recovery-operations.ts:43-44`），不会每次启动重复写，但这类记录本身会长期留在待核对集合里。作者已在 I-84 未覆盖里把它写成保守代价，我未发现它会导致本轮主诉的“等原始期限”；如果担心长期累积，建议后续补一条人工/自动关闭这类 `effect=unknown` 有界失败的路径。

---

## 侧重检查

- **错误路径**：`sandboxCeilingExceededMessage` 对未知原因码返回 `null`，不会误把普通失败说成上限；`sandboxResourceLimitReason` 在 `resources` 为 `null` 或两项都在限内时统一回退 `SANDBOX_RESOURCE_LIMIT`，不会抛错。已核对 `packages/execution-contracts/src/sandbox-execution-v2.ts:276-287`。
- **不合规范/不可信输入**：原因码来自持久化事实，`SandboxOperationResult.reasonCode` 只要求 `machineString`（`sandbox-execution-v2.ts:238-242`），新码能写进 SQLite；插进模型文案只是字符串拼接，不参与路径/命令执行。`sandboxUnrecoverableResultOperationKey` 的 SQL 部分是固定前缀 + `json_extract` 拼接，无外部字符串代入 SQL，未发现注入面。
- **安全**：不可恢复标记使用固定常量明文 `SANDBOX_TOOL_RESULT_UNRECOVERABLE`、分类 `public`（`production-tool-result-recovery.ts:54-68`），不含秘密；只做“已尝试”标记，不改变结果内容。
- **资源耗尽**：新的数值格式化只有 `toFixed`/除法，上限值由计划校验保证；文案长度有界。未发现由本轮文案改动引入的新循环或大分配。
- **不可撤销操作**：`markUnrecoverable` 先 `lookup` 再 `commit`，重复调用基本幂等；`recover()` 对不可恢复终止返回 `null` 的既有行为未改变。未发现本轮引入新的破坏性写入。
- **规则/说明与代码一致**：`docs/adr/0035-tool-deadline-continues-run.md` 与 `SANDBOX_TOOL_DEADLINE_EXCEEDED_MESSAGE` 仍说“已被终止”，我核对了 deadline 只有在 `exitCode === null` 的确被杀路径才走该文案（`production-sandbox-execution-v2.ts:800-808、937-944、1849-1853`），因此这句话仍成立；资源上限的“已终止”已全部改掉，三语里剩余“已终止/terminated/停止と後処理”只属于 deadline，符合作者“deadline 不在本 PR 范围”的说明。

---

## 必答问题

1. **会不会改变模型已见过的请求开头？**
   不会。`8948124` 只改了：给模型看的资源上限尾巴文案（`production-sandbox-tool-result.ts:173`，经 `production-runtime-tools.ts:2103-2106、2149-2150` 作为工具结果 `modelContent` 返回）、三语 UI 文案、测试、事故表。系统提示、工具定义、历史消息、遮盖规则都没有动；新出现的值（原因码、上限数字）只在最新一条工具结果里。按 `.claude/rules/prompt-prefix.md` 的“只在末尾追加、会变的值放最后一条消息”，这个改动不触碰请求开头。**是。**

2. **会不会同一段文字在不同请求里变成不同字节？**
   不会由本轮改动引入。新文案是静态常量；`SANDBOX_CPU_TIME_LIMIT`/`SANDBOX_MEMORY_LIMIT`/`SANDBOX_RESOURCE_LIMIT`/`SANDBOX_OUTPUT_LIMIT` 由冻结的计划与已持久化事实决定，`sandboxResourceLimitReason` 的 CPU 优先顺序固定，没有时间、随机数或无序集合。唯一的条件是“`completion.resourceCeiling` 缺失时回退当前 `ceiling`”，但生产里 `completeSandboxToolResult` 总会返回带 `resourceCeiling` 的完成结果（`service-main.ts:1306`），且已交付的结果会落成记录复用；未发现同一记录在不同请求里被重新拼出不同文案的路径。

3. **有没有对应的自动检查，反向用例真的会失败吗？**
   有：模型文案在 `apps/agent-service/test/production-runtime-tools.unit.test.ts:470-508`；三语 UI 在 `apps/control-center/test/i18n-runtime.unit.test.ts:71-98`；原因码→消息 id 在 `execution-view.unit.test.ts`；契约层在 `sandbox-bounded-failure.unit.test.ts`；worker 层在 `sandbox-v2-worker-lifecycle.test.ts:85-89`；恢复/SQL 在 `sqlite-sandbox-execution-v2.test.ts`；两份白名单一致性在 `test/tooling/safe-tool-reason-codes.test.mjs`（`ci/policy.json` 的 `tooling` project 包含 `test/tooling/**/*.test.mjs`，会跑）。按断言读，把资源上限文案改回旧值会因“必须含新句/不得含在终止前”失败；把 zh-CN `toolResourceLimit` 改回旧值会因禁用词“已终止”失败。**但“必须出现新说法”不是逐条（见低 1），模型文案的禁用词也不含“已终止”（见低 2）**；我未实际运行测试。

4. **每个新值的使用端都能接受吗？**
   逐个核对过：新原因码由 `production-sandbox-execution-v2.ts:886-897、1810-1821` 产生；`isSandboxBoundedToolFailure`（`sandbox-execution-v2.ts:309-323`）、投影（`sandbox-execution-projection.ts:204-208`）、线程资源（`thread-execution-resources.ts:231-243`）、两份 `SAFE_TOOL_REASON_CODES`（`thread-execution-state.ts:29-35`、`thread-execution-projection.ts:32-40`）、UI 映射（`execution-view.ts:375-378`）、三语键（`message-ids.ts` 与三个 resources 文件）都接受；SQLite 的 `validateSandboxExecutionFacts` 对 `reasonCode` 只要求 `machineString`（`sandbox-execution-v2.ts:238-249`），不会拒绝新码。`resourceCeiling` 作为完成/回执字段没有更严格的 schema 拒绝。不可恢复标记的 `operationKey` 与 SQL 拼接一致（`production-tool-result-recovery.ts:54`、`sqlite-sandbox-tool-result-recovery.ts:20-24`）。**唯一两端不一致是文档对 `bind` 绑定环境的表述（低 3），不是代码校验问题。**

5. **有没有“测试绿了但生产写不进去”或“说明和实际行为不一致”？**
   本轮没有发现新的“写不进去”：假日志 `bind` 现在走生产同一个 `validateSandboxExecutionFacts`，`append`/`operation` 的绑定环境改成已存事实，和 `sqlite-sandbox-execution-operations.ts:1523-1528` 一致；`operationOnly` 的三项额外检查作者已在事故表写明未复刻，属已知差异。剩下的“说明与实际行为不一致”就是低 3 的 `bind` 表述，以及低 1/低 2 的门槛描述比实际实现更强。SRT 容器路径资源上限分支仍没有 worker 级用例（低 4），我把它标为覆盖缺口而不是已证实缺陷。
