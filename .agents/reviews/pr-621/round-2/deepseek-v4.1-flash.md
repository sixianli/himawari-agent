本轮查过的范围：`git diff 554a61c..ca9b63e` 的增量（含合入的 PR 618 工具结果清理/取回、`3f1e544c2` 对第 1 轮意见的修复、迁移与设置改名），以及这些增量产生的值在存储层、工具动作登记、运行时适配器、网关契约和检查脚本里的直接使用端。未运行任何测试/typecheck/lint（工具限制），相关结论标「未核实」。

### 1、中低：`tool_result_recall` 的 preflight 放行但 `execute` 必然拒绝，两端校验不一致，只靠 Pi 适配器拦截才不报错
- 文件:行：`apps/agent-service/src/production-runtime-tools.ts:987-990`、`:1353-1357`、`:681`
- 问题：新增的工具动作行 `executor: RUNTIME_CONTEXT_EXECUTOR`（`"runtime_context"`），preflight 明确允许它；但真正执行时 `#builtinExecutor` 只接受 `"owner_scoped"`，`ProductionRuntimeTools.execute` 会直接 `reject()`。当前唯一调用方 `PiAgentRuntimeAdapter` 在 preflight 之后、调用 `tools.execute` 之前用 `descriptor.definition === "tool-result-recall"` 本地拦截（`packages/runtime-pi/src/pi-runtime-adapter.ts:2252-2269`），所以现在不触发；但 `RuntimeToolPort` 的接口并不保证这一点，任何新的调用方或适配器遗漏拦截都会失败。
- 证据：
  ```ts
  // production-runtime-tools.ts:987-990
  (row.executor === RUNTIME_CONTEXT_EXECUTOR || this.#builtinExecutor(row) !== undefined)
  // production-runtime-tools.ts:1353-1357
  const row = this.#builtinRow(invocation);
  if (row) {
    const run = this.#builtinExecutor(row);
    if (!run) reject();
  // production-runtime-tools.ts:681
  if (row.executor !== "owner_scoped") return undefined;
  ```
- 建议：让 `execute` 对 `RUNTIME_CONTEXT_EXECUTOR` 也有一条明确的处理路径（例如在工具端口内执行 recall，或显式抛出一个已登记的“由运行时处理”错误），或在 `RuntimeToolPort` 契约里写明这类工具不得进入 `execute`，并加一条测试锁住“preflight 允许的工具 execute 不会 reject”。

### 2、中低：`handled` 结果被存储层拒收时，`recorded` 吞掉所有存储错误，临时错误也会把真实结局写成 `result_invalid` 并报一次假失败
- 文件:行：`apps/agent-service/src/production-inbox-worker.ts:166-186`
- 问题：第一轮修复为避免成功投递被重新投递，把第一次 `settle` 的任何异常都转成第二次 `settle(..., "result_invalid", ...)`。这能避免重复执行，但也会把数据库繁忙等临时错误当成“结果不合法”，永久丢掉 delivery 返回的真实 `outcome`/`runId`，并先调用 `#report` 发出一次 `inbox.failed` 诊断（随后又成功记为 done）。
- 证据：
  ```ts
  const recorded = (to: Parameters<typeof settle>): Promise<boolean> =>
    settle(...to).then(
      () => true,
      (error: unknown) => {
        this.#report(deliveredIds[0] ?? "", error);
        return false;
      },
    );
  if (
    !(await recorded([deliveredIds, "done", result.outcome, result.reasonCode, result.runId])) &&
    !(await recorded([deliveredIds, "done", null, "result_invalid", null]))
  )
  ```
- 建议：只对存储层的输入校验错误（如 `PORT_INVALID_OPERATION`）回退到 `result_invalid`；其他错误至少不要先报失败，或把“回退记录成功”和“真失败”区分成不同诊断事件。若坚持“宁可记错结局也不重复投递”，请在注释/ADR 里写明这一取舍。

### 3、低：`stalledAfterMinutes` 的实际下限已变成“运行时限 + 1 分钟”，但设置说明仍写“超过这么多分钟就算卡住”
- 文件:行：`apps/agent-service/src/production-inbox.ts:261`、`apps/agent-service/src/production-inbox-settings.ts:41-47`
- 问题：修复让恢复阈值取 `max(stalledAfterMinutes, runTimeout + 1min)`。用户把“卡住判定时间”调到 1 分钟时，实际要等运行时限（默认 10 分钟）+1 分钟才恢复；设置页仍写“超过这么多分钟还没结束，就当它卡住”，与实际行为不符。
- 证据：
  ```ts
  // production-inbox.ts:261
  const stalledAfterMs = Math.max(limits.stalledAfterMinutes * 60_000, input.runsLastUpToMs ?? 0);
  // production-inbox-settings.ts:44-45
  "一件事交给运行后超过这么多分钟还没结束，就当它卡住，重新排队或记为失败。"
  ```
- 建议：在设置说明里写明“实际不会短于一次运行的最长时间 + 1 分钟”，或把该项改成“至少”语义并在 UI 上展示生效值。

### 4、低：上一轮意见 7 只在代码/检查脚本层面修干净，活跃文档仍有已删除服务的引用，“没有任何剩余引用”的说法不成立
- 文件:行：`docs/execution/specs/2026-11-24-main-thread-subthreads-inbox-design.md:115`、`docs/adr/0274-new-things-go-through-one-think-entrance.md:57`、`:64`、`docs/adr/0277-the-system-deletes-expired-think-threads.md:46`
- 问题：`scripts/check-egress-redaction.mjs` 和 `ci/operations-pending.json` 已清理（本轮确认），`apps/`、`packages/` 里也搜不到对 `production-think-*`、`autonomy-gateway-adapter` 等已删除模块的 import；但设计文档和已被取代的 ADR 仍把 `production-think-actions.ts`、`production-think-inbox.ts`、`production-think-worker.ts`、`production-think-retention.ts` 当作现存代码引用。若“剩余引用”只指代码，意见 7 已修好；若按作者原话“没有任何剩余引用”，则不成立。
- 证据：`glob` 确认 `apps/agent-service/src/production-think-*.ts` 已不存在；设计文档第 115 行仍写 `apps/agent-service/src/production-think-actions.ts:58`，ADR 0274 第 57 行仍写 `production-think-inbox.ts`。
- 建议：活跃设计文档改成“当时存在、已在 PR 621 删除”，或把历史引用明确标成历史；已被取代的 ADR 可以保留原样，但不要再用它们作为当前代码依据。

### 5、低（推测）：压缩请求的清理集合与最后一次普通请求可能不是同一份，某些历史下摘要请求会退回 Pi 默认开头
- 文件:行：`packages/runtime-pi/src/compaction-prefix.ts:26-32`、`packages/runtime-pi/src/pi-runtime-adapter.ts:1569-1572`
- 问题：普通请求的 `context` 钩子用 `clearToolResults(event.messages, clearing)`（即对完整消息列表算清理集），压缩请求却用 `clearedToolResultIds(all.slice(0, lastAssistant), clearing)`。如果最后一次普通请求是靠“最后一条 assistant 的 usage”才越过清理线，而 `all.slice(0,lastAssistant)` 排除了这条 assistant，压缩侧算出的清理集会少一些，`sharedSummaryContext` 因前缀不一致返回 `undefined`，摘要请求退回 Pi 默认请求。这是缓存命中问题，不是正确性问题；现有 `[CLEAR-5]` 只覆盖了一种历史。
- 证据：
  ```ts
  // compaction-prefix.ts:28-32
  const lastAssistant = all.findLastIndex((message) => message.role === "assistant");
  const cleared = clearing
    ? clearedToolResultIds(all.slice(0, Math.max(0, lastAssistant)), clearing)
    : new Set<string>();
  ```
- 建议：压缩侧直接复用“最后一次普通请求实际使用的清理集”（或对完整 `all` 计算后再裁剪到 prefix），并补一个“只有最后一条 assistant 的 usage 越线”的 `[CLEAR-*]` 用例；若确认退回默认请求可接受，请在文档里把“压缩请求套用同一份清理结果”改成“尽量复用，对不上时退回”。

**侧重检查**

- 重复执行/不可撤销操作：逐行核对了 `claimBatch`、`recoverStalled`、`release`、`finish` 与 `handle` 的 `putBack`/`signal.aborted` 分支。第 1 轮意见 1 的修复（`runsLastUpToMs = runTimeout + 60s`，`stalledAfterMs = max(...)`）确实把“运行时限内被当成卡住”的窗口关掉了；`recoverStalled` 用 `updated_at <= stalledBefore`，新测试在 00:05 不恢复、00:11 恢复，反向用例成立。仍存在的残留风险是 `finish` 返回 0 行时 `settle` 不报错（并发恢复后可能静默丢一次结束），但这是旧代码且不在增量行内，未作为本轮新问题。
- 错误路径/不合规范输入：核对了 `finish` 的 `OUTCOME` 正则、`reasonCode` 64 字符截断、`runId` 256 上限，以及新回退值 `result_invalid`/`outcome=null` 能被 `inbox_events` 约束接受（`outcome IS NULL OR length 1..32`，`reason_code` 1..64）。`result_invalid` 可通过。
- 安全/分类：`tool_result_recall` 只读当前 run 的 session 消息，不跨对话；返回的原文会再走出口遮盖，`owner_data` 不重复标记外部内容。未发现越权读取；`recalled.content` 无大小上限，属于模型主动取回的资源风险，未单独列为意见。
- 删除引用：代码与检查脚本层面已清；文档仍有历史引用（见意见 4）。
- 配置键/迁移：`runPolicy.inbox` 由 `INBOX_SETTING_DEFINITIONS` 解析，网关 `think.settings.*` 的 `key` 是 `machineString` 不是枚举，`inbox_settings` 的 `changeSettings` 只校验 `/^[a-zA-Z]{1,64}$/`，6 个新键全部通过；迁移的 `thinking→queued`、`proposed→done/proposed`、`skipped/expired→done/silent` 与测试一致。

**必答问题**

1. **会不会改变模型已经见过的请求开头？** 收件箱部分（PR 621）不改提示词、工具定义或历史，只在末尾追加，无影响。增量里合入的 PR 618 会改变已发内容：`tool-result-clearing.ts` 把较早的工具结果原地换成占位，这是 `.agents/instructions/prompt-prefix.md:36` 新增的第 14 条例外（ADR 0285），不是纯追加；工具列表还会因为新增 `tool_result_recall` 换新一次（第 6 条的“换新”）。除此之外仍然只在末尾追加；每轮会变的时间/记忆日期仍在最后一条消息里。注意文档说“清理之后照常只在末尾追加”，但实现保留最近 3 次、窗口滑动，后续请求可能再次成批清掉之前保留的结果，所以“之后只追加”不是严格保证（见 `tool-result-clearing.ts:62-73`）。
2. **同一段文字会不会在不同请求里变成不同字节？** 占位文本只含 `toolName`/`toolCallId`，无时间字段；清理集合按消息顺序重放计算，输出按消息顺序映射，没有无序集合遍历。同一段历史每次算出的字节相同。会变的是“同一工具结果在清理前后分别为原文/占位”，这是第 14 条例外允许的；另外 `compaction-prefix.ts` 用 `all.slice(0,lastAssistant)` 算清理集，和普通请求的完整列表可能不同，但这只会导致摘要请求退回默认开头（见意见 5，推测），不是同一请求内的不确定字节。
3. **有没有对应的自动检查，反向用例是否真的会失败？** 有：`packages/runtime-pi/test/prompt-prefix.compat.test.ts` 新增 `[CLEAR-1..5]`（`check-prompt-prefix.mjs` 要求这些标签），`tool-result-clearing.unit.test.ts` 有 `REVERSE` 用例（不到 5000 不清、声明保留不清、不规范结果不抛错、找不到不说“重新执行”），`test/integration/inbox.test.ts` 新增两条收件箱反向用例。按代码推断，第 1 轮的两条收件箱测试在没有修复时会失败（00:05 会被提前恢复；无效 outcome 会走 retry 而不是 result_invalid），但我没有运行测试，实际通过情况「未核实」。
4. **增量产生/修改的每个值，使用端都能接受吗？** 逐项核对：`inbox_events` 的列/约束、`result_invalid`、`runsLastUpToMs`（只有 worker 传入，`ProductionInbox.maintain` 接受默认 `{}`）、`tool_result_recall` 的 descriptor/`capabilityRef="context.tool_result_recall"`/`executor="runtime_context"`/`targetType="conversation-context"`/`reasonCode="CONTEXT_RECALL_RUNTIME"`（工具登记表、preflight、adapter 的 `toolDefinition`/execute 分支、未知 reasonCode 回退到通用阻断文案，均能接受）、`contextRetention?: "keep"`（目前只有测试设置，生产描述符尚未使用，属于设计预留）、6 个新设置键（配置解析、网关 `machineString`、`inbox_settings` 键名校验、`INBOX_SETTING_TEXT` 全覆盖）、3 条新提示词 id（`runtime.ts` 导出、`index.ts` 再导出、`prompt-manifest.json` 有条目）。唯一两端不一致的是意见 1 的 `RUNTIME_CONTEXT_EXECUTOR`：preflight 接受、`execute` 拒绝，目前靠适配器拦截。
