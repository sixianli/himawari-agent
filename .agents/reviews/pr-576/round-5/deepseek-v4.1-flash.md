**本轮查过的范围**：`git diff 2c8c61f2..12dc874e` 的全部非评审记录改动（`docs/adr/0278…`、`packages/application/src/ports/run-execution-source.ts`、`packages/application/test/frozen-run-source-identity.unit.test.ts`、`test/integration/thread-run-lifecycle.test.ts`）；并追到使用端 `apps/agent-service/src/production-run-expiry.ts`、`packages/application/src/services/run-execution-input-service.ts`、`packages/application/src/services/action-intent-snapshot.ts`、`packages/application/src/services/thread-command-service.ts`、`packages/application/src/rules/action-rules.ts`、`packages/persistence-sqlite/src/sqlite-run-dispatch-operations.ts`、`packages/persistence-sqlite/src/sqlite-thread-operations.ts`、`docs/adr/0257…`。未运行任何测试（工具限制只允许 git 命令），下文的失败/通过均为读代码推断。

### 1. 低：ADR 0278 的 `amends` 仍为空，上一轮第 1 条未改
文件: `docs/adr/0278-tasks-the-owner-agreed-to-ask-before-writing-after-external-content.md:7`、`:48`
- 问题：作者声明“第 1 条不改”，核对属实：`amends: ""` 没动。但这份 ADR 明确说自己把 ADR 0257 决定 3 的内置规则“升到第 2 版”，改变了“后台读过外来内容一律不做”的旧决定，属于部分修正。
- 读代码证实：`docs/adr/0278…:7` 为 `amends: ""`；同文件 `:48` 写着“`refuseBackgroundAfterExternalContent`（ADR 0257 决定 3 定的）升到第 2 版”；`docs/adr/0257…:148` 的决定 3 表格原文是“后台发起的一轮，上下文里有外来内容，想做有后果的事 | 不做…”。仓库既有做法（`docs/adr/0031…:139`）也说明部分修正用 `amends`/`amended_by`。
- 建议：填 `amends: "docs/adr/0257-consequential-tool-calls-go-through-one-authorization-exit.md"`，或在正文明确写“不算 amend、理由是什么”。这是上一轮未解决项，不是新回归。

### 2. 低：ADR 0278 前提 3 新写的“低风险可撤回写入”与代码要求的 MEDIUM 不一致
文件: `docs/adr/0278-tasks-the-owner-agreed-to-ask-before-writing-after-external-content.md:38`、`packages/application/src/rules/action-rules.ts:15-16`、`:122`
- 问题：改后的前提 3 说 `askAfterExternalContent` 只把“运行来源是 `user_message`、主人确认过意图的**低风险**可撤回写入”除外；代码里这个例外是 `OWNER_INTENT_CONFIRMED_EXPRESSION`，要求 `risk == "MEDIUM"`，即**中风险**，并且还要求 `disclosure == "none"`、`recipient_count == 0`、不要本人在场、不是改长期规则。按文字理解，“低风险 + 有 owner_intent_confirmed”的动作不会被排除，仍会 `ask_owner`；真正被排除的是中风险。
- 读代码证实：`:16` 原文 `'action_kind == "CREATE_OR_UPDATE" && risk == "MEDIUM" && reversible == 1 && disclosure == "none" && recipient_count == 0 && run_source == "user_message" …'`；`:122` 原文 `expression: ... && !(${OWNER_INTENT_CONFIRMED_EXPRESSION})`。
- 建议：把“低风险可撤回写入”改为“中风险、可撤回、不外发、不涉及本人到场/长期规则的写入”，与 ADR 0257 和规则表达式一致。

### 3. 低：坏快照的“受控错误”没有端到端断言，ADR 的回归清单说得比实际强
文件: `docs/adr/0278-tasks-the-owner-agreed-to-ask-before-writing-after-external-content.md:77`、`packages/application/test/frozen-run-source-identity.unit.test.ts:47-54`、`apps/agent-service/src/production-run-expiry.ts:62-74`、`packages/application/src/services/run-execution-input-service.ts:230-240`
- 问题：ADR 说“快照里的来源缺失或不是对象时，仍报原来的‘快照不一致’错误”，但新增单测只断言 `canonicalAuthorizationSnapshot(...)` 两边不相等；它没有走恢复路径实际使用的 `threadCommandFingerprint`，也没有断言 `Run execution snapshot source changed` 或 `RUN_EXPIRY_INPUT_INVALID`。新增的到期集成测试只改 `sourceId` 和加 `ownerApprovedTask`，没有喂入坏 `frozen.source`。
- 读代码证实：单测 `:47-54` 只做 `expect(frozenRunSourceIdentity(malformed)).toBe(malformed)` 和 `canonicalAuthorizationSnapshot(...)not.toBe(...)`；到期路径 `:65-66` 用 `canonicalAuthorizationSnapshot`，恢复路径 `:236-237` 用 `threadCommandFingerprint`；集成测试 `:4252-4316` 没有构造缺失/`null`/字符串来源。
- 建议：恢复路径和到期路径各加一个坏 `frozen.source` 用例，直接断言受控错误（存下 `PORT_ERROR_CODES.INVALID_OPERATION` / `RUN_EXPIRY_INPUT_INVALID`）；否则把 ADR 这句改成“单元级比较覆盖，未做端到端错误码断言”。

**侧重检查**
- **错误路径/不可信输入**：`frozen.source` 为 `undefined`、`null`、字符串、数组、空对象时，`frozenRunSourceIdentity` 会原样返回或返回空身份；到期路径与有效来源比较必然不等，抛 `RUN_EXPIRY_INPUT_INVALID`；恢复路径把 `undefined` 交给 `threadCommandFingerprint`，其内部 `canonical`/`JSON.stringify` 不会抛错，结果与有效来源不同，抛 `Run execution snapshot source changed`。读代码证实，未运行。
- **类型层隐患**：`canonicalAuthorizationSnapshot(value: unknown): string` 对 `undefined` 实际返回 `undefined`（`JSON.stringify(undefined)`），类型声明与运行时不符；本增量靠“`undefined` 与字符串不相等”得到受控结果，当前不会出错，但这是旧函数已有的脆弱点，不是本轮新错。
- **安全/不可撤销操作**：到期结算在来源身份比较通过后才执行；唯一放宽是忽略 `ownerApprovedTask`，而该标记由数据库按提议状态在每次读取时重算，授权层读的也是 live source，未发现新的提权路径（这部分是前几轮已审的旧代码，本轮只核对未改变）。
- **资源耗尽**：本增量只增加一次浅层解构和一次字符串比较，没有新增无界循环、正则或外部调用。
- **文档/代码一致**：发现上面第 2、3 条；第 1 条仍是上一轮遗留。

**必答问题**
1. **不会**。本轮增量只改运行快照的来源身份比较和测试/文档，没有触碰系统提示、工具定义、历史消息或遮盖结果；`ownerApprovedTask`/`frozen.source` 只出现在恢复、到期结算和授权判断里，没有进入发给模型的 messages。就本增量而言，“只在末尾追加、每轮变化值在最后一条消息”的约束不被改变；整个 PR 的模型可见变化前几轮已审，本轮未重读提示词构造全链路。
2. **不会**。增量里的比较是确定性的：`canonicalAuthorizationSnapshot` 对对象键排序，`frozenRunSourceIdentity` 一致地去掉 `ownerApprovedTask`；没有新增时间字段、随机字段或无序集合。live source 的 `ownerApprovedTask` 虽可能随数据库提议状态变化，但它在比较前被剥离，也不会发送给模型，因此不会让同一段模型可见文字在不同请求里变成不同字节。
3. **有**，但覆盖不完整。到期路径新增了正向（加 `ownerApprovedTask` 仍结算）和反向（`sourceId` 不同仍拒绝）用例；读代码可确认：若删掉 `production-run-expiry.ts` 的剥离逻辑，正向用例会以 `RUN_EXPIRY_INPUT_INVALID` 失败，反向用例本身不依赖剥离。坏 `frozen.source` 的单测能守住“不再抛 TypeError”，但没有端到端断言受控错误（见第 3 条）。作者自报“回退剥离会 2 个失败”，我未运行验证。
4. **能接受**。被修改的值只有导出函数 `frozenRunSourceIdentity` 的签名（`RunExecutionSource → RunExecutionSource` 改为 `unknown → unknown`）和返回值；直接使用端仅 `production-run-expiry.ts:65-66` 与 `run-execution-input-service.ts:236-237`，分别接收给 `canonicalAuthorizationSnapshot(unknown)` 和 `threadCommandFingerprint(unknown)`，两端签名都接受 `unknown`，无其他调用点。新增的 `ownerApprovedTask: true` 测试值也符合 `RunExecutionSource` 的 `true` 联合类型。改动本身没有新增标识、配置键或清单项；ADR 的 `amends` 仍是空值（第 1 条）。
