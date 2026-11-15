## 读代码证实的问题

### 1. 中：超时只停止等待，不会取消已经在跑的后台运行
- 文件:行：`apps/agent-service/src/production-think-worker.ts:96`、`apps/agent-service/src/production-think-runner.ts:230`
- 问题：`runTimeoutMinutes` 只作用于工人对运行的轮询等待，运行本身没有被取消。时间到后条目可能被记为失败，但那次运行仍可能继续调用模型、继续花钱。
- 证据：
  ```ts
  // production-think-worker.ts:96-102
  const run = await this.#options.runner.think({
    entry, summary,
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(this.#options.runTimeoutMs)])
      : AbortSignal.timeout(this.#options.runTimeoutMs),
  });
  ```
  ```ts
  // production-think-runner.ts:238-260
  for (;;) {
    const snapshot = await this.#options.threads.readDetailSnapshot({...});
    const run = snapshot?.runs.find((candidate) => candidate.runId === runId);
    if (run && TERMINAL.has(run.status)) { ... }
    await sleep(this.#options.pollMs ?? POLL_MS, signal);
  }
  ```
  整段新代码没有调用运行生命周期把运行转成 cancelled/failed，`signal` 只打断 `sleep`。文档 `docs/architecture-v0.1.md:437` 写“运行超过 `runTimeoutMinutes` 就算失败”，与实现不一致：失败的是入口条目，不是运行。默认 `deadlines.runMs` 是 5 分钟、小于 10 分钟，但配置允许 `runMs` 到 24 小时（`packages/platform-node/src/strict-configuration.ts:2381`），此时窗口很大。
- 建议：超时时通过运行生命周期/协调器把运行取消（或至少明确停掉本次运行），或把配置改名为“等待上限”；不要只停止轮询。

### 2. 中：`finally` 里的归档错误被吞掉，超时/取消时可能留下未归档的活对话
- 文件:行：`apps/agent-service/src/production-think-runner.ts:200`、`apps/agent-service/src/production-think-runner.ts:278`
- 问题：`#archive` 先读 revision，再按该 revision 归档；如果这时运行还在提交消息，revision 会变，归档冲突，而外层 `.catch(() => undefined)` 把错误完全吞掉，既没有诊断也不会重试。
- 证据：
  ```ts
  // production-think-runner.ts:200-204
  try {
    answer = await this.#await(ownerId, agentId, id.threadId, id.runId, signal);
  } finally {
    await this.#archive(ownerId, agentId, id.threadId, entry.id, id.contentRef).catch(
      () => undefined,
    );
  }
  ```
  ```ts
  // production-think-runner.ts:278-295
  const snapshot = await this.#options.threads.readDetailSnapshot({ ..., limit: 1 });
  if (!snapshot) return;
  await this.#options.commands.setLifecycle({
    expectedRevision: snapshot.thread.revision,
    status: "archived",
    ...
  });
  ```
  归档失败时条目仍会被记为 failed/skipped，对话保持 active，既可能被用户看到，也与文档“不管结果如何，这个对话最后都归档”不一致。
- 建议：归档冲突要重试或先确保运行终止；失败要写诊断；加一条“超时且运行恰好提交消息”的测试。

### 3. 中：同一条目归档后重试会重放准入并再次写提议，可能把已拒绝的提议重新打开
- 文件:行：`packages/persistence-sqlite/src/sqlite-thread-operations.ts:1053`、`apps/agent-service/src/production-think-runner.ts:174`、`apps/agent-service/src/production-think-runner.ts:238`
- 问题：工人崩溃或 `settle` 失败后，入口条目会保持 thinking，`recoverStalled` 之后重试。重试时 `commands.create`/`admitOwnerMessage` 走 replay 分支，而 replay 分支不检查对话是否已归档；`readDetailSnapshot` 也仍返回归档对话。于是重试会读到同一个已完成的运行和回复，再次调用 `#propose`。如果主人已在间隙拒绝过该提议，提议箱可能把它重新打开。
- 证据：
  ```ts
  // sqlite-thread-operations.ts:1053-1070
  const replay = this.replay(...);
  if (replay) {
    const thread = this.read(input.ownerId, input.agentId, replay.threadId);
    const message = this.readMessage(...);
    if (!thread || !message) this.fail("PORT_NOT_FOUND", "Replayed message state is missing");
    return { thread, message, receipt: replay };
  }
  // 活跃检查在 replay 分支之后：
  // sqlite-thread-operations.ts:1082-1085
  if (!current || current.status !== "active") {
    this.fail("PORT_CONFLICT", "Thread is not active");
  }
  ```
  ```ts
  // sqlite-thread-operations.ts:1470-1475
  const thread = this.read(...);
  if (!thread || thread.status === "deleted_verified") return undefined;
  return { thread, messages: ..., runs: ... };
  ```
  另外归档发生在 `try` 的 `finally` 里、`#propose` 之前：进程在归档后、写提议前崩溃时，重试窗口更大。
- 建议：重试前若对话已归档就直接复用已记录结果，不要重新提议；或者在 `#propose` 前检查提议状态；把“条目完成/提议已写”做成一个可幂等重放的结果，不再依赖归档对话的内容。补一条“归档后重试”的测试。

### 4. 中：`common()` 产出的来源引用/版本长度超过数据导出 schema 上限
- 文件:行：`apps/agent-service/src/production-think-actions.ts:26`、`packages/persistence-sqlite/src/sqlite-think-inbox-operations.ts:113`、`packages/persistence-sqlite/src/data-export/schemas.ts:263`
- 问题：入口允许 `sourceRef` 最长 256、`sourceVersion` 最长 256；`common()` 又给来源引用加上 `${sourceKind}:` 前缀（种类最长 64），所以写进提议时 `sourceRef` 最长可达 321，`sourceVersion` 最长 256。提议存储层不校验长度，但数据导出用 `OWNER_PROPOSAL_SCHEMA` 校验时要求 `sourceRef` 最长 256、`sourceVersion` 最长 128。一条合法的想一想来源就可能让数据导出校验失败。
- 证据：
  ```ts
  // sqlite-think-inbox-operations.ts:113-115
  const sourceRef = this.text(input.sourceRef, 256, "source reference");
  if (typeof input.sourceVersion !== "string" || input.sourceVersion.length > 256)
    this.invalid("Think inbox source version is invalid");
  ```
  ```ts
  // production-think-actions.ts:26-29
  source: {
    ref: `${context.entry.sourceKind}:${context.entry.sourceRef}`,
    version: context.entry.sourceVersion || null,
  },
  ```
  ```ts
  // data-export/schemas.ts:263-264
  sourceRef: nullable(text(1, 256)),
  sourceVersion: nullable(text(1, 128)),
  ```
- 建议：在入口或 `common()` 里把来源版本/引用截断或哈希到导出 schema 的长度内，或放宽导出 schema；并加一条“最长来源写提议后导出能通过”的测试。这正是 I-73 那类“清单里的 id 能不能过后端校验”的问题。

### 5. 中：想一想对话、消息、运行载荷和提示词包没有清理路径
- 文件:行：`apps/agent-service/src/production-think-runner.ts:286`、`apps/agent-service/src/production-think-inbox.ts:256`
- 问题：每个入口条目都会新建一个对话、写入一条任务消息、开一次运行并生成提示词包；结束后只归档，不删除。入口的 `maintain` 只清理摘要载荷（`summaryRef`），不清理 `think-task:*` 任务载荷，也不清理归档对话。按每天 50 条、没有保留期计算，会持续增长，且这些对话还会进入数据导出/备份。
- 证据：
  ```ts
  // production-think-runner.ts:286-295
  await this.#options.commands.setLifecycle({
    ...
    status: "archived",
    reasonCode: "think_finished",
  });
  ```
  ```ts
  // production-think-inbox.ts:256-265
  for (const { id, summaryRef } of settled) {
    const gone = await this.#options.payloads.delete(summaryRef as never)...
    if (gone) await this.#options.store.clearSummary(...)
  }
  ```
  仓库里归档对话的清除只走治理删除路径（`sqlite-governed-deletion.ts:790` 一带），本 PR 没有触发。
- 建议：给想一想对话/载荷定保留期和清理任务，或写完后立即按治理删除路径删掉对话（保留提议和入口行即可）；至少在文档里写明这些归档对话会永久保留。运维侧是否有额外清理未核实。

### 6. 中低：`readOnlyRun` 把“查不到来源”当想一想，普通运行可能被静默降成只读
- 文件:行：`apps/agent-service/src/service-main.ts:1698`、`apps/agent-service/src/production-runtime-tools.ts:605`
- 问题：`source === undefined || isThinkRunSource(source)` 把所有来源读不到的运行都按只读处理。来源读不到不只发生在想一想运行上：普通运行如果触发载荷已不 active、对话被归档、或来源查询不到，也会被当成只读。工具集合按对话冻结，一旦第一次运行被降成只读，后续同一对话都会沿用这个工具集合；而这条 service-main 里的判断没有任何自动测试。
- 证据：
  ```ts
  // service-main.ts:1698-1701
  readOnlyRun: async (runId) => {
    const source = await runSources.read(runId);
    return source === undefined || isThinkRunSource(source);
  },
  ```
  ```ts
  // production-runtime-tools.ts:605-606
  const readOnly = (await this.#options.readOnlyRun?.(runId)) === true;
  return this.#registry.offer(descriptors, { readOnly });
  ```
- 建议：只对 `isThinkRunSource(source) === true` 收紧；`source === undefined` 应该作为异常处理（报错、记诊断、或让运行失败），不要静默改变一个普通运行的工具集合。补一条“来源读不到时普通运行不丢工具/明确失败”的反向测试。

### 7. 低：`common()` 无条件写 `externalContentSeen: true`，推断来源会被标成外部内容
- 文件:行：`apps/agent-service/src/production-think-actions.ts:25`、`apps/agent-service/src/production-proposals.ts:385`
- 问题：`origin` 按 `entry.externalContent` 计算，但 `externalContentSeen` 永远是 true；提议箱看到它后会把 origin 强制改成 `external_content`，因此 `externalContent: false` 的条目也永远显示为外部内容。文档 `docs/architecture-v0.1.md:437` 写“提议的来源记为外部内容或推断”，与实现不一致。对 `task.run` 还会无条件要求读全文。
- 证据：
  ```ts
  // production-think-actions.ts:23-25
  origin: context.entry.externalContent ? ("external_content" as const) : ("inferred" as const),
  threadId: context.threadId,
  externalContentSeen: true,
  ```
  ```ts
  // production-proposals.ts:385-390
  const origin: OwnerProposalOrigin =
    input.externalContentSeen === true ? "external_content" : input.origin;
  ...
  (origin === "external_content" && !(handler !== undefined && isAction(handler)));
  ```
- 建议：改成 `externalContentSeen: context.entry.externalContent`，或在文档里明确“想一想提议一律按外部内容处理”。补一条非外部来源提案 origin 为 `inferred` 的测试。

### 8. 低：`ThinkLoop` 的诊断回调抛错会让循环永久停止
- 文件:行：`apps/agent-service/src/production-think-composition.ts:97`
- 问题：`#tick` 的 catch 直接调用 `this.#onFailure(error)`，如果诊断写入抛错（例如输出管道关闭），异常会跳出 `#tick`，`#schedule` 不会执行，循环就停了，而且没有日志。
- 证据：
  ```ts
  // production-think-composition.ts:92-100
  async #tick(signal: AbortSignal): Promise<void> {
    let busy = false;
    try {
      const step = await this.#worker.runOnce(signal);
      busy = step.status === "done";
    } catch (error) {
      this.#onFailure(error);
    }
    this.#schedule(busy ? 0 : this.#intervalMs);
  }
  ```
- 建议：把 `onFailure` 包在 `try/catch` 里，保证无论如何都重新调度；加一条“诊断回调抛错后循环仍继续”的测试。

### 9. 低：ADR 0274 的工具过滤描述和实现/架构文档不一致
- 文件:行：`docs/adr/0274-new-things-go-through-one-think-entrance.md:66`、`packages/application/src/services/tool-action-registry.ts:86`
- 问题：ADR 决定 6 说“只给读类工具（按动作登记表的 `actionKind` 过滤，不写工具名清单）和联网搜索”；实现还要求 `sideEffect === "none"` 且 `family` 为 `builtin`/`web`，因此排除了 `read`/`ls`/`find`/`grep` 这些 READ 类的 coding 工具。架构文档已经按实现写了，ADR 没改。方案里还提到“外部内容引出的想一想能否上网”的配置开关和搜索词长度/次数上限，本 diff 里没有看到对应配置，是否已在别处实现未核实。
- 证据：
  ```ts
  // tool-action-registry.ts:86-91
  const READ_ONLY_FAMILIES: readonly ToolActionFamily[] = Object.freeze(["builtin", "web"]);
  export function readOnlyRow(row: ToolActionRow): boolean {
    return (
      row.actionKind === "READ" &&
      row.sideEffect === "none" &&
      READ_ONLY_FAMILIES.includes(row.family)
    );
  }
  ```
- 建议：更新 ADR 0274 决定 6，明确排除 coding READ 工具的理由；如果“能否上网”开关/搜索上限属于本 PR 范围，补实现和测试，否则在文档里写明延后。

## 推测与未核实

### 10. 低：`#await` 只取前 50 条消息，极长工具循环可能读不到最后一条 agent 消息（推测）
- 文件:行：`apps/agent-service/src/production-think-runner.ts:244`
- 问题：`readDetailSnapshot` 使用 `afterSequence: 0, limit: 50`，然后在返回的消息里找最后一条 agent 消息。当前实现下一次运行通常只提交一条最终 agent 消息，所以影响小；如果将来一次运行提交多条中间 agent 消息且总数超过 50，最后一条可能不在返回结果里，导致 `answer_invalid`。
- 证据：
  ```ts
  const snapshot = await this.#options.threads.readDetailSnapshot({
    ownerId, agentId, threadId, afterSequence: 0, limit: SNAPSHOT_LIMIT, // 50
  });
  ```
- 建议：根据 `thread.messageWatermark` 取尾部一段，或按 runId 读最后一条 committed agent 消息；至少加一条消息数超过 50 的测试。

### 11. 低：文档说“不留在对话列表里”，但归档对话仍可被列表查询到（未核实 UI）
- 文件:行：`docs/architecture-v0.1.md:437`、`packages/application/src/services/thread-query-service.ts:43`
- 问题：想一想对话只是 `status: "archived"`，而线程查询默认状态包含 `active` 和 `archived`。如果控制中心有“归档”列表，想一想对话会出现在那里；文档的“不留在对话列表里”可能只指主列表。UI 实际怎么展示未核实。
- 建议：在文档里写清是“不在默认列表”，或者给想一想对话一个不进入普通列表的标记。

## 侧重检查

- 错误路径：模型回复不是 JSON、动作未登记、字段多/少、`due` 非法、`reminderId` 不存在——这些都会在 `parseThinkRunAnswer`、动作白名单或 `proposeReminder*` 里被拒，不会写提议。只有提议箱/数据库异常会向外抛，工人会记失败。
- 不可信输入：摘要和来源说明进 `<<<资料>>>` 前做了 `<<<`/`>>>` 替换；模型输出的 `text` 将来进入任务运行前由 `taskRunMessage` 再做一次替换。来源种类/说明来自登记表，模型不能改。未发现把外部文本直接拼进系统提示或工具定义的路径。
- 工具边界：想一想运行的工具在 `ProductionRuntimeTools.listAuthorized` 里按 `readOnlyRow` 过滤；`read` 工具虽然 actionKind 是 READ，但 family 是 coding，会被排除。真正能被拿到的只有 web_search、web_fetch、recall、reminder_list、rule_list、perception_read。授权规则 `refuseBackgroundAfterExternalContent` 仍是第二道防线。
- 幂等/重试：建对话和放消息用了固定 idempotencyKey 和固定编号，正常重试不会重复开运行；但归档后重试会重放准入并重新提议，见第 3 条。
- 超时/取消/资源：见第 1、2、5 条。运行本身没有取消逻辑，归档失败被吞，归档对话和任务载荷没有清理。
- 来源兜底：`source === undefined` 按只读处理，能保护想一想运行，但也会影响普通运行，见第 6 条。
- 跨边界取值：动作名、`due`/`repeat`、`reminderId` 两端一致；来源引用/版本长度与数据导出 schema 不一致，见第 4 条；`externalContentSeen` 与 origin 不一致，见第 7 条。
- 规则/文档一致性：ADR 0274 决定 6 与实现的工具过滤条件不一致，见第 9 条；架构文档里“超时就算失败”和“不留在对话列表里”的措辞也不够准确。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   对这个 PR 新增的想一想运行：不会。每一条都是新对话，任务说明是这条新对话的第一条用户消息；系统提示和工具定义没有改已有文字。`listAuthorized` 在运行开始时调用一次（`pi-runtime-adapter.ts:1365`），之后冻结，所以 `readOnlyRun` 不会在一轮运行中途改变工具集合。每个入口的摘要、来源说明、动作清单都在第一条消息里；动作清单在 `ThinkActionRegistry.list()` 里按 type 排序，摘要来自固定的加密载荷，没有时间戳。
   唯一风险是第 6 条：普通运行的来源读不到时也会被按只读处理；如果这发生在一个对话的第一次运行，工具集合会被冻结成只读，之后要换新就会让请求开头变化。作者说“查不到来源时也只读”是故意的，但它把“来源缺失”和“想一想运行”混在一起了。

2. **同一段文字会不会在不同请求里变成不同字节？**
   想一想运行自己发给模型的任务消息是确定的：`summary` 来自条目载荷，`sourceDescription` 来自登记表，`actions` 按 type 排序（`production-think-runner.ts:61` 一带），没有当前时间、随机数或数据库遍历顺序。重试时如果 `think-task:<key>` 载荷已存在就直接复用，不重写。
   提议里的时间（`localTimeText`）只影响提议存储和以后新建的任务对话，不进入当前想一想请求的前缀；新建的任务运行本身也是新对话，所以不影响已有对话的缓存。
   需要注意：如果以后在 `THINK_RUN_TASK` 里加入“当前时间”或把动作顺序改成 Map 插入顺序，就会破坏这个确定性；当前没有。

3. **有没有对应的自动检查，反向用例真的会失败吗？**
   有，但不完整：
   - `prompt-catalog.unit.test.ts` 会检查新提示词在 manifest 里有记录、sha256 对得上；改文字不更新会失败。
   - `prompt-output-contracts.unit.test.ts` 把 `think.run-task` 列为结构化输出并映射到 `parseThinkRunAnswer`。
   - `think-run-pieces.unit.test.ts` 的反向用例覆盖：`readOnly` 不包含 `reminder_set`、`rule_set`、`bash`、`write`、`device_action`；`parseThinkRunAnswer` 拒绝纯文本、JSON 外文字、缺 reason、空 reason、非法 action、截断 JSON、数组、超长 reason、超长答案。
   - `production-runtime-tools.unit.test.ts` 覆盖 `readOnlyRun` 为 true 时工具为空、false 时保留工具；但它用的是合成回调，不是 service-main 里的真实判断。
   - `startup-configuration.unit.test.ts` 覆盖 `idleSeconds`/`runTimeoutMinutes` 的边界。
   - `think-runner.test.ts` 用真 SQLite 覆盖：成功写提议并归档、`none`、未登记动作、多字段、运行失败、非 JSON、来源是 `external_event` 且消息编号前缀正确、归档后来源读不到。
   - `ThinkLoop` 测试覆盖 done→done→idle、抛错后继续、stop。

   缺口：没有 `isThinkRunSource` 的反向用例（例如 `user_message` 来源但 sourceId 带 `message:think:` 应返回 false）；没有 service-main 里 `readOnlyRun` 的接线测试；没有“归档后重试”“归档冲突”“超时不取消运行”“运行被取消时条目不记失败”的测试；没有来源引用/版本长度与导出的兼容性测试。这些反向用例如果补上，按当前实现至少第 3、4 条会失败。

4. **改动产生/修改的每个值，使用它的地方都能接受吗？**
   逐个核对结果：
   - 动作名 `task.run`、`reminder.create`、`reminder.reschedule`：提示词文字、`ThinkActionRegistry` 注册键、`TASK_RUN_PROPOSAL_TYPE`/`REMINDER_*_PROPOSAL_TYPE` 常量、提议箱类型完全一致。
   - `due`、`repeat`：提示词写 `YYYY-MM-DDTHH:MM`/`YYYY-MM-DD` 和 `none`/`yearly`；`proposeReminderCreate`/`schedulePreview`/`reminderSchedule` 接受这些格式；`repeat` 缺省按 `none`。
   - `reminderId`：`reminder_list` 返回的字段名和 `writer.describe` 读取的 id 一致，且 `describe` 会校验 owner/agent。
   - `message:think:`：产生于 `#ids`，由 `isThinkRunSource` 消费，长度和格式都没问题；但它只检查 `external_event` + 前缀，不检查 `sourceProofRef` 是否是 `think:`，所以安全边界依赖没有别的路径能产生这种 sourceId。
   - `source.ref`/`source.version`：**不能都接受**。入口允许 ref 到 256、version 到 256，`common()` 加种类前缀后 ref 可到 321；提议存储层不校验，但数据导出 schema 要求 ref ≤256、version ≤128，见第 4 条。
   - `externalContentSeen`：产生处无条件 true，消费处 `ProductionProposalBox` 用它覆盖 origin，导致推断来源被标成外部内容，见第 7 条。
   - 条目 id/线程 id/消息 id/运行 id/会话 id：长度都在存储层普通字符串范围内；`entry.id` 最长 128，哈希后 32 位十六进制，没有发现超限。

   作者说法的核对：第 1 条成立（READ + sideEffect none + builtin/web；来源查不到也只读），但“查不到来源也只读”有第 6 条的风险。第 2 条成立。第 3 条**不完全成立**：超时会让工人记 failed，但“取消”时工人返回 `aborted`，并不调用 `settle`（`production-think-worker.ts:106-107`），条目会保持 thinking 等 `recoverStalled`；而且“运行失败”不等于运行被取消。第 4 条成立。第 5 条基本成立：`stop` 会中止 controller、清掉定时器、等待已开始的 tick；但已排队的 timer 回调仍可能在 `stop` 返回后执行一次，只是 `signal.aborted` 会让 `runOnce` 立即返回，不产生实际工作；另外第 8 条说明诊断回调抛错会让循环停住。
