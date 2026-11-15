## 查过的范围

本轮对照 `91ff65c3..8725f5403` 的增量 diff，重点读了 `production-think-runner.ts`、`production-think-inbox.ts`、`production-think-settings.ts`、`production-think-worker.ts`、`production-think-composition.ts`、`production-http-composition.ts`、`production-approval-gateway.ts`、`sqlite-think-inbox-operations.ts`、`contracts-v2.ts`、`strict-configuration.ts`、迁移与 schema catalog、相关测试，以及第 1 轮意见指向的 proposal 存储和数据导出 schema。`round-1/judgments.md` 被工具规则以 records-path 拒绝读取，所以没有依赖它，按你列出的第 1 轮意见逐条对代码核对。生成文件、Swift 文件和 UI 没有逐行读；UI 的“已归档列表”行为标注为未核实。

### 1. 中：归档先于写提议，新的“已归档就跳过”会把崩溃窗口里的提议永久丢掉

文件:行：`apps/agent-service/src/production-think-runner.ts:161`、`:224`、`:233`

问题：`think()` 先执行 `finally` 里的归档，归档成功后才调用 `#propose`。新加的开头检查只要发现对话不是 `active` 就直接返回 `run_already_finished`。如果进程在归档成功后、写提议前崩溃，或 `#propose` 本身抛错后条目仍处于 `thinking` 被恢复重试，重试会看到已归档对话并跳过，原本该写的提议就永久丢失了。

证据（读代码证实）：

```ts
// :161
const earlier = await this.#options.threads.readDetailSnapshot({...});
if (earlier && earlier.thread.status !== "active")
  return { outcome: "skipped", reasonCode: "run_already_finished" };
...
// :224
} finally {
  await this.#archive(ownerId, agentId, id.threadId, id.key, id.contentRef).catch(...)
}
if (answer.status !== "completed")
  return { outcome: "skipped", reasonCode: `run_${answer.status}` };
...
// :233
return this.#propose(parsed, entry, id.threadId);
```

推测：这个窗口很窄，但一旦崩溃/异常落在这里，结果是静默丢一次已经判断为值得做的动作；概率未实测。

建议：把“提议已写”做成持久的条目状态或幂等标记，写入成功后再归档；或者归档前先写提议，并把跳过条件从“对话已归档”改成“已确认这条条目写过提议”。至少要覆盖“归档成功、提议失败/进程崩溃”的测试。

### 2. 中低：归档连续失败只写诊断，条目照常结案，活对话不会再有归档重试

文件:行：`apps/agent-service/src/production-think-runner.ts:224`、`:320`

问题：`#archive` 最多重试 3 次，仍失败时抛出；但 `finally` 里用 `.catch(...)` 把它吞掉，只调用 `#report("think.archive_failed", ...)`。随后 `think()` 正常返回 `proposed`/`skipped`，worker 会把条目 settle 成终态，之后不会因为这个条目再尝试归档。第 1 轮意见 2 说的“归档错误被吞掉、留下未归档活对话”只修成了“写诊断”，没有修掉残留状态。

证据（读代码证实）：

```ts
// :224
await this.#archive(...).catch(
  (archiveError: unknown) => this.#report("think.archive_failed", entry.id, archiveError),
);
...
// :341
} catch (error) {
  if (attempt >= ARCHIVE_ATTEMPTS) throw error;
}
```

测试也把这个行为固定了下来：`test/integration/think-runner.test.ts` 的归档持续失败用例同时断言 `failures` 有 `think.archive_failed`、`thread()` 仍是 `archived: 0`。

建议：归档失败时不要把条目 settle 成正常终态，保留可重试状态；或者把待归档对话交给一个持久清理任务，按退避重试到成功为止。

### 3. 低：`readOnlyRun` 仍把“查不到来源”当想一想，普通运行可能被静默降成只读（上一轮 #6 未改）

文件:行：`apps/agent-service/src/service-main.ts:1695`

问题：运行来源读不到时返回 `true`，于是该运行只拿到只读工具。普通对话运行如果因为数据缺失、旧数据或读取异常导致来源查不到，不会被报错，而是静默少给写工具。

证据（读代码证实）：

```ts
readOnlyRun: async (runId) => {
  const source = await runSources.read(runId);
  return source === undefined || isThinkRunSource(source);
},
```

建议：只有 `source !== undefined && isThinkRunSource(source)` 才进入只读；来源查不到时按运行失败/拒绝处理，而不是降级成只读，并加一条普通运行来源缺失的反向测试。

### 4. 低：默认值并非只在 `THINK_SETTING_DEFINITIONS` 定义一次，ADR 0274 的描述也与实现不一致

文件:行：`packages/application/src/ports/configuration.ts:393`、`:420`、`packages/platform-node/src/strict-configuration.ts:1418`、`docs/adr/0274-new-things-go-through-one-think-entrance.md:59`、`:66`

问题：作者说“10 项设置的名称、单位、范围和默认值都只在这里写一次”，但 `THINK_WORTH_DEFAULTS` 仍然重复定义了 `yesAtLeastPermille: 700` 和 `noAtMostPermille: 300`；配置解析在缺省时取的也是 `THINK_WORTH_DEFAULTS`，不是 `THINK_SETTING_DEFINITIONS`。现在数值相同，但以后只改一处就会让 snapshot 的 `defaultValue` 和实际生效值分叉。

另外 ADR 0274 第 59 行仍写“默认值在 `production-think-inbox.ts`”，现在默认值已经搬到 `configuration.ts`；第 66 行说只按 `actionKind` 过滤，而实现 `readOnlyRow` 还要求 `sideEffect === "none"` 且属于 `builtin`/`web`。第 1 轮意见 9 的文档不一致没有完全修掉。

证据（读代码证实）：

```ts
// configuration.ts
export const THINK_WORTH_DEFAULTS = Object.freeze({
  yesAtLeastPermille: 700,
  noAtMostPermille: 300,
...
export const THINK_SETTING_DEFINITIONS = Object.freeze([
  { key: "yesAtLeastPermille", ..., defaultValue: 700 },
  { key: "noAtMostPermille", ..., defaultValue: 300 },
```

```ts
// strict-configuration.ts
const yesAtLeastPermille =
  input["yesAtLeastPermille"] === undefined
    ? THINK_WORTH_DEFAULTS.yesAtLeastPermille
    : integer(... thinkSettingDefinition("yesAtLeastPermille").minimum ...)
```

```ts
// tool-action-registry.ts
export function readOnlyRow(row: ToolActionRow): boolean {
  return (
    row.actionKind === "READ" &&
    row.sideEffect === "none" &&
    READ_ONLY_FAMILIES.includes(row.family)
  );
}
```

建议：`THINK_WORTH_DEFAULTS` 的两个门槛默认值改成从 `THINK_SETTING_DEFINITIONS` 取；同步更新 ADR 0274 的默认值位置和只读工具过滤条件，避免规则文件与代码继续漂移。

### 5. 低：`changeSettings` 的存储层校验比应用层松，端口本身能写入超出定义范围的值

文件:行：`packages/persistence-sqlite/src/sqlite-think-inbox-operations.ts:102`、`apps/agent-service/src/production-think-settings.ts:104`

问题：应用层按 `THINK_SETTING_DEFINITIONS` 检查 key 和范围，但存储层 `changeSettings` 只检查 key 是字母、值是非负安全整数、最多 32 项。当前唯一生产调用方是 `ProductionThinkSettings.change`，所以还不会出错；但端口契约本身允许直接写入 `yesAtLeastPermille: 0`、未知 key 或超范围值，之后 `#views` 和 `overrides()` 会原样信任这些值。这违反“产生端和使用端两端校验”的要求。

证据（读代码证实）：

```ts
// sqlite-think-inbox-operations.ts
entries.some(
  ([key, value]) =>
    !/^[a-zA-Z]{1,64}$/u.test(key) || !Number.isSafeInteger(value) || value < 0,
)
```

```ts
// production-think-settings.ts
if (
  value !== null &&
  (!Number.isSafeInteger(value) || value < definition.minimum || value > definition.maximum)
)
  return refuse("THINK_SETTING_OUT_OF_RANGE");
```

建议：在存储层也按定义校验 key/范围，或让端口只接受已校验的 `ThinkSettingKey`；加一条绕过应用层直接调用 store 的反向测试。

### 6. 低：新功能测试没有覆盖读失败回落、并发 revision 和两个新时长设置

文件:行：`test/integration/think-settings.test.ts:250`、`:279`、`:305`

问题：现有测试覆盖了固定顺序/defaultValue、越界、未知 key、过期 revision、非主人、下一次 submit 的队列上限、下一次判断的门槛。但作者说法里的这些关键点没有对应测试：

- 读设置失败时入口/工人/循环退回配置值（说法 4）；
- 并发修改同一 revision 时 SQL 层只成功一次（重点核对 1、2）；
- `idleSeconds`、`runTimeoutMinutes` 覆盖值在下一轮真正生效（说法 3）；
- 名字叫 “crossed values” 的用例实际只测了下限 501，没有测两个门槛真正交叉，因为范围已经让交叉不可能。

证据（读代码证实）：测试只断言了 `THINK_SETTING_OUT_OF_RANGE` 的 450、501 边界，没有构造 store 并发调用，也没有让 `ProductionThinkInbox`/`ProductionThinkWorker` 在 `overrides()` 抛错时运行。

建议：补读失败回落、`changeSettings` 并发 revision、`idleSeconds`/`runTimeoutMinutes` 生效、以及“归档成功但提议写入失败/崩溃”这几条反向用例。

## 侧重检查

- 错误路径：查了超时取消、取消失败、归档冲突、归档持续失败、设置读失败、`changeSettings` revision 冲突。取消路径现在会在 `signal.aborted` 时调用 `cancelRun`；归档重试有 3 次上限；但归档失败后被吞成诊断，引发上面第 2 条；归档先于提议引发第 1 条。
- 不合规范或不可信的输入：网关 schema 对 `expectedRevision` 用 `integer(0)`、对 `value` 用 `nullable(integer(0))`、key/unit 用 `machineString`；应用层再按定义检查 key 和范围；source ref 和 version 在 `production-think-actions.ts` 用 SHA-256 截断到 256/128，符合数据导出 schema 的 `sourceRef(1,256)`、`sourceVersion(1,128)`。存储层校验偏松的问题见第 5 条。
- 安全：`think.settings.change` 要求 `actorType === "owner"` 且 scope 匹配；查询不要求 owner，但设置不是秘密，且 control 固定使用本租户 scope。未发现新的越权修改路径。
- 资源耗尽：设置范围都有上下限，`idleSeconds >= 5`、`runTimeoutMinutes <= 120`、queue/daily ≤ 1000/10000、summary ≤ 4000、overrides ≤ 32 项；归档最多 3 次；没有新的无界循环。`readSettings` 被注册成写通道操作，会让读设置走写队列，但不会造成数据不一致。
- 不可撤销操作：设置修改可以用 `value: null` 恢复默认；没有新增删除/发送类不可逆动作。
- 规则、说明和代码一致性：模型请求开头规则见 `prompt-prefix.md` 第 1、2、4 条；本轮设置值没有进入系统提示、工具定义或历史。ADR 0274 的默认值位置和只读工具过滤描述与代码仍有偏差，见第 4 条。归档后的 UI 列表行为未核实。

## 上一轮意见逐条核对

- #1 超时只停止等待、不取消运行：已改。`production-think-runner.ts:218-223` 在 `signal.aborted` 时调用 `#cancel`，测试覆盖超时取消。
- #2 归档错误被吞、留下活对话：部分改。现在会重试并写 `think.archive_failed` 诊断，但最终仍被吞掉，条目照常结案，第 2 条残留。
- #4 来源引用/版本超过导出上限：已改。`production-think-actions.ts:22-47` 对 ref 256、version 128 截断哈希，测试断言数据库长度。
- #3 归档后重试重放准入并再次写提议：对“已归档”场景已改。`production-think-runner.ts:161-169` 会在对话非 active 时跳过；但归档成功、提议未写的窗口变成丢失，见第 1 条。
- #6 `readOnlyRun` 把查不到来源当想一想：未改，见第 3 条。
- #7 `common()` 无条件写 `externalContentSeen: true`：行为保留，且现在 `origin` 也一律 `external_content`，架构文档已同步说明“运行能上网，提议一律记为外部内容”；这符合当前安全取舍，不算未修。
- #8 `ThinkLoop` 诊断回调抛错会永久停循环：已改。`ThinkLoop.#tick` 用 `try { this.#onFailure(error); } catch {}`，并有对应单测。
- #9 ADR 0274 工具过滤描述和实现/架构文档不一致：未完全改，见第 4 条。
- #11 文档说“不留在对话列表”但归档仍可查询：文档已改成“主列表看不到，已归档和全部列表看得到”；UI 行为未核实。

## 必答问题

1. 不会改变模型已经见过的请求开头。新增设置只影响排队上限、摘要截断、Jev 门槛、运行超时和空闲间隔，不进入系统提示、工具定义或历史。`think.run-task` 的来源、摘要和动作清单仍然只出现在新对话的第一条用户消息里；已有对话不会因为改设置而改写前缀。依据 `prompt-prefix.md` 第 1、2、4 条：固定内容在前，会变的值在最后一条用户消息，已发出内容只追加。摘要截断发生在入队时，之后存的是固定载荷，不会改写已发请求。

2. 没有发现新的“同一段文字在不同请求里变成不同字节”的模型输入。设置写库时 `overrides` 的键排序后再 JSON.stringify，`ProductionThinkSettings.#views` 按 `THINK_SETTING_DEFINITIONS` 固定顺序返回；来源 ref/version 的截断是确定性 SHA-256。唯一随每次读取变化的是 `think.settings.snapshot` 的 `generatedAt`，它是 API 快照时间，不进入模型请求。不同设置值会让新提交的摘要截断长度不同，但那是不同配置下的新提交，不是同一已发请求被改写。

3. 有自动检查，但覆盖不全。新增 `test/integration/think-settings.test.ts` 对范围、未知 key、过期 revision、非主人、队列上限下一次 submit、门槛下一次判断都有真实断言，这些反向用例如果去掉校验会失败。缺口是：读失败回落、并发 revision、`idleSeconds`/`runTimeoutMinutes` 生效、真正的门槛交叉、归档成功但提议未写的窗口都没有用例；`test/integration/think-runner.test.ts` 则覆盖了超时取消、归档冲突重试、归档持续失败诊断、归档后不重复提议、来源截断。测试未运行（本次只允许读代码和限定的 git 命令），结论基于断言审阅。

4. 逐项核对了新值的产生端和使用端：`THINK_SETTING_DEFINITIONS`/`THINK_LOOP_DEFAULTS` 被入口、工人、循环和配置解析读取，数值范围互相兼容；`ThinkSettingsRecord` 的 `revision`/`overrides`/`updatedAt` 与 SQLite `readSettings`/`changeSettings` 返回一致；迁移、`schema-catalog`、`durable-adapters` 的端口方法一致；`think.settings.read/change` 已在 `GATEWAY_V2_MESSAGE_TYPES`、schema、client capabilities、Swift 生成文件、fixture 和 `operations-pending.json` 中登记；`resultRef` 是合法的 `think-settings:<revision>`；`PRODUCTION_THINK_OPERATIONS` 在网关和 browser 的已安装操作列表中都能通过契约校验。发现两处两端不一致：默认值仍有一份重复在 `THINK_WORTH_DEFAULTS`（第 4 条）；存储层 `changeSettings` 的范围校验比应用层松（第 5 条）。`think_settings` 不在数据导出中，我没有找到要求它必须导出的规则，这点标为未核实产品预期。
