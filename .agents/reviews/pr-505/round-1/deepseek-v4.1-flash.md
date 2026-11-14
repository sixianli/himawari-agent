## 结论前提

我按 `git diff f4480f9..32f3b4b` 逐处核对了两处源码改动和测试，并追踪了规则值、动作枚举和错误码的使用方。**我没有运行任何测试**（本次只允许读文件和 git 命令），所以“反向用例会失败”是按代码推断，不是实测。仓库是 61% 的 sparse checkout，未读到的文件我会标“未核实”。

## 意见（按严重度从高到低）

### 1、低、内置规则表达式改了语义，`revision` 仍是 1，同一修订号对应两段不同规则

- 文件:行：`packages/application/src/rules/action-rules.ts:201-204`
- 问题：这次把 `action_preauthorize_own_task_cancel` 的表达式从“managed-task 的 CREATE_OR_UPDATE”改成“再加 `reversible == 0`”，但 `revision: 1` 没变。改动前后同一个 `action_preauthorize_own_task_cancel@1` 实际是两条不同的授权规则。
- 证据（读代码证实的）：

  ```ts
  // action-rules.ts:200-204（改后）
  id: ACTION_RULE_IDS.preauthorizeOwnTaskCancel,
  revision: 1,
  gate: "action",
  expression:
    'target_type == "managed-task" && action_kind == "CREATE_OR_UPDATE" && reversible == 0',
  ```
  `git show f4480f9:packages/application/src/rules/action-rules.ts` 显示改前是同一 id、同一 `revision: 1`、表达式为 `'target_type == "managed-task" && action_kind == "CREATE_OR_UPDATE"'`。
  修订号不是纯展示值：统一出口把它写进长期授权记录并核对（`owner-scope-authorization.ts:294-296`），拒绝记录里也存 `ruleRevision`（`owner-scope-authorization.ts:330`），规则页快照和 MCP `rule_book` 也返回 `revision`（`action-rule-switches.ts:64`、`production-mcp-read.ts:1483`）。
  现有先例是语义变了就升修订号：邮件规则 `money_words` 现在是 `revision: 2`（`rule-book.ts:148`），对应提交 `f6f496669`“涉钱地板规则改由模型判断，不再读词表”。ADR 0257 也写明“内置规则换了修订号（只会随代码发布发生）时，仍开着的记录自动更新到新修订号”（`docs/adr/0257-...md:222`）。
- 建议：除非有理由固定为 1，建议把该规则升到 `revision: 2`，并按 ADR 0257 的开关机制补一条“开着的预授权继续、关掉的仍问”的检查。注意：升修订号会让 `rule_book` 工具结果和网关快照里的 `revision` 变化，但那是末尾追加的工具结果/页面数据，不是请求开头。
- 说明：这条修订号约定是我从先例和 ADR 推断出来的；ADR 没有一句“改表达式必须升修订号”的硬性规定，所以标“低”，不是功能性错误。

### 2、低、新增反向用例用的是网关枚举外的动作并绕过了网关校验，证明不了线上路径

- 文件:行：`test/integration/production-memory-capture.test.ts:2269-2277`、同文件 `3167-3174`
- 问题：用例传的是 `future_action`，它不在网关契约允许的动作里；而且测试助手直接调 `control.execute(... as never)`，没有经过 `gatewayV2MessageSchema` 校验。线上真正到达这个兜底分支的输入，网关会先拒掉，所以这条用例测的是防御性死分支，不是真实入口。
- 证据（读代码证实的）：

  ```ts
  // contracts-v2.ts:2016-2022
  export const OWNER_RULE_ACTIONS = [
    "undo", "confirm", "reconfirm", "ask_first", "allow_directly",
  ] as const;
  // contracts-v2.ts:2065-2070
  const memoryRuleRespondCommandSchema = object({
    ...commandEnvelope("memory.rule.respond"),
    payload: object({
      target: machineString,
      action: enumeration(OWNER_RULE_ACTIONS),
    }),
  });
  ```
  ```ts
  // production-memory-capture.test.ts:3167-3174
  const command = (control, type, payload, key = type) =>
    control.execute({
      ...envelope, idempotencyKey: key, kind: "command", type, payload,
    } as never);
  ```
  线上入口确实会校验：`packages/platform-node/src/http-gateway-server.ts:374`、`apps/agent-service/src/in-process-gateway.ts:35` 都调用 `gatewayV2MessageSchema.parse`。
  另外，去掉新分支后这条用例也会失败，但失败原因是目标 `action_preauthorize_owner_data` 是内置规则 id，`control.undo` 会报 `RULE_NOT_FOUND`（同文件 `2620-2627` 已有这个断言），不是“未知动作被当成撤销”被抓住。
- 建议：保留这条防御性用例，但把目标换成一个真实存在、`undo` 本来会成功的 `owner:` 规则，才能证明“未知动作不会误撤销”；或者另加一条网关契约反向用例，断言 `future_action` 在进入 handler 前就被拒绝。现有 `expect(context.actionRules.setAskFirst).toHaveBeenCalledTimes(2)`（2277 行）是有价值的，说明未知动作没走 `ask_first/allow_directly` 分支。

### 3、低、`reversible == 0` 把“停任务”绑定到工具登记表的“不可撤销”标签，语义耦合并非“动作=取消”

- 文件:行：`packages/application/src/rules/action-rules.ts:204`、`apps/agent-service/src/production-tool-actions.ts:126-130`
- 问题：规则真正想表达的是“取消自己这一轮开的任务”，但动作闸门没有 operation 字段（`field-catalog.ts:87-129` 只有 `action_kind`、`target_type`、`reversible` 等），只能用 `reversible == 0` 代理“取消”。今天恰好只有 cancel 是 managed-task 的 CREATE_OR_UPDATE 且不可撤销，所以行为不变；但以后若有人按规则 `source` 里写的“停了可以重开”把 cancel 改成 `reversible: true`，这条规则会悄悄不再预授权停任务，变成每次都要主人点头。
- 证据（读代码证实的）：

  ```ts
  // production-tool-actions.ts:126-130
  actionKind: action === "cancel" ? "CREATE_OR_UPDATE" : "READ",
  reversible: action !== "cancel",
  sideEffect: action === "cancel" ? "irreversible" : "none",
  ...
  targetType: "managed-task",
  ```
  ```ts
  // action-rules.ts:207
  source: "ADR 0257 第 2 步：停止这一轮自己开的任务，最坏是一件自己开的活停了，可以重开",
  ```
  现有端到端测试会兜住这种改动：`test/integration/tool-action-registry.test.ts:614-631` 断言 cancel 仍然 `allow_preauthorized` 命中该规则。因此这不是当前缺陷。
- 建议：在该规则或 cancel 行加一句注释/断言，明确“cancel 必须保持 `reversible: false`，否则这条预授权失效”；如果以后动作闸门增加 operation 字段，再换成直接匹配“取消”。

## 侧重检查

- **错误路径与不可信输入**：`memory.rule.respond` 进来先 `assertOwner(command)`（`production-memory-control.ts:1657`）；`action` 来自网关枚举；`future_action` 这类输入在 HTTP/in-process 入口就会被 schema 拒绝（`http-gateway-server.ts:374`、`in-process-gateway.ts:35`）。新兜底抛 `PORT_INVALID_OPERATION`/`MEMORY_RULE_ACTION_UNSUPPORTED`，不会误落到 `undo`。**结论：比改动前更安全，属防御性改进。**
- **安全/不可撤销操作**：停任务仍是 `reversible: false`、`sideEffect: "irreversible"`，且仍被预授权，未新增任何不可撤销操作；行为与 ADR 0257:247“取消直接放行、读过外来内容也不问”一致。未发现新秘密或日志泄露。
- **资源耗尽**：只增加了一个常量时间的 helper 和一次规则 AND 判断，没有新增循环、无界集合或文件/网络访问。
- **规则、文档与代码一致性**：ADR 0257:247 的“停自己任务直接放行”与代码一致；规则页三语文案仍是“停掉自己开的任务”，未被本次改动破坏；作者说“reversible 字段是 int，1 能撤销、0 不能”与 `field-catalog.ts:99-102`、`actionGateFacts` 的 `intent.reversible ? 1 : 0`（`action-rules.ts:44`）一致。唯一不一致是上面第 1 条的修订号约定。
- **未核实**：未运行 `npm run check:rule-registry`、`npm test` 或 `check:prompt-prefix`；未逐一阅读所有历史文档（sparse checkout 少 39% 文件）；第 1 条的“必须升修订号”是推断，不是文档明文。

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**

不会。依据 `prompt-prefix.md:35`（第 4 条：只能追加，不得改动已发内容）逐项核对：

- 内置动作规则的表达式和例子不进入系统提示或工具定义。它们只被 `RuleJudge`、`assertRuleExamples`、规则页的 `action-rule-switches.list()`（`action-rule-switches.ts:57-75`）使用。
- 模型能看到的规则入口是 MCP `rule_book`，它只输出 `id/revision/gate/outcome/origin/source/status`（`production-mcp-read.ts:1474-1495`），不输出 `expression` 或 `examples`。本改动没有改 `source` 和 `revision`，所以连 `rule_book` 的追加工具结果都没变。
- `memory.rule.respond` 是网关命令，只影响 UI 操作结果和错误，不进入模型请求。
- 唯一的可见数值变化是规则页 `memory.rules.snapshot` 的 `examplesMiss` 从 2 变 3（新增第 225 行那条 false 例子；契约字段见 `contracts-v2.ts:2057-2058`）。这是控制中心的页面数据，不是发给模型的内容。
- 发给模型的内容仍然只在末尾追加；本次没有新增每轮变化的值。

*注：规则语义如果命中，会影响授权结果、审批卡片和后续工具结果，但这些也是追加在对话末尾，不会改请求开头。*

**2. 会不会让同一段文字在不同请求里变成不同字节？**

不会。改动没有引入依赖前后文的遮盖、带时间的字段或无序集合。规则事实 `facts` 本来就在 `actionGateFacts` 里排序（`action-rules.ts:49`），新增例子是构建期常量。`memory.rule.respond` 的错误分支不参与任何发送给模型的序列化。

**3. 有没有对应的自动检查，反向用例是否真的会失败？**

有，规则部分的反向用例是硬的：

- `packages/application/test/policy-fact-registry.unit.test.ts:117-135` 遍历所有内置动作规则并调用 `assertRuleExamples(rule)`（实现在 `rule-book.ts:463-469`）。新增的 `example(false, { targets: [{ type: "managed-task" }], reversible: true })`（`action-rules.ts:224`）在去掉 `reversible == 0` 后会算成命中，这条测试会失败。`npm run check:rule-registry`（`package.json:66`）确实包含这个文件，也包含 `test/integration/tool-action-registry.test.ts`。
- `test/integration/tool-action-registry.test.ts:614-631` 正向锁住 cancel 仍命中该规则；`:633-646` 反向锁住去掉规则后改问主人。

内存命令部分的反向用例按代码推断也会失败，但证明力有限：`production-memory-capture.test.ts:2269-2276` 期望 `MEMORY_RULE_ACTION_UNSUPPORTED`。去掉新分支后，`future_action` 会落到 `undo`，而目标 `action_preauthorize_owner_data` 不是 `owner:` 规则，会先报 `RULE_NOT_FOUND`（同类断言见 `2620-2627`），所以测试仍会失败，但不是因为“误当成 undo”。这与第 2 条意见一致。

**4. 每个新产生/修改的值，使用它的地方都能接受吗？**

逐项核对：

- **规则表达式字符串** `... && reversible == 0`：使用方是 `compileRuleExpression`/`RuleJudge`；`reversible` 在字段目录里是 `int`（`field-catalog.ts:99-102`），生成侧是 `intent.reversible ? 1 : 0`（`action-rules.ts:44`）。类型和取值都通过。
- **新增例子**：使用方是 `assertRuleExamples`（测试里 122-125 行循环）、`action-rule-switches.list()` 的 `examplesHit/examplesMiss`（`action-rule-switches.ts:66-67`）以及网关 `memory.rules.snapshot` 的 `integer(0)` 字段（`contracts-v2.ts:2057-2058`）。两端都接受；只是该规则的 `examplesMiss` 从 2 变 3，没有测试对这条规则写死该数字。
- **新错误字符串** `MEMORY_RULE_ACTION_UNSUPPORTED`：用合法的 `PORT_ERROR_CODES.INVALID_OPERATION` 抛出（`production-memory-control.ts:133-138`）；控制中心 `run` 统一 catch 成失败态（`memory.ts:200-213`），不依赖具体错误字符串；集成测试按字符串断言。没有发现需要同步登记的错误码清单。
- **网关允许的动作是否都被处理**：允许的是 `undo`、`confirm`、`reconfirm`、`ask_first`、`allow_directly`（`contracts-v2.ts:2016-2022`）。前两个特殊动作在更早的独立分支处理并 `return`（`production-memory-control.ts:1757-1769`），其余三个在新三元表达式里各自处理（`:1822-1829`）。**5 个合法动作全部有处理，没有被新兜底拒绝的合法动作。**
- **停任务是否仍命中规则**：命中。`taskManagement("cancel")` 产生 `targetType: "managed-task"`、`actionKind: "CREATE_OR_UPDATE"`、`reversible: false`（`production-tool-actions.ts:126-130`），映射为 `reversible == 0`；已有测试 `tool-action-registry.test.ts:614-631` 断言它仍命中 `action_preauthorize_own_task_cancel`。
- **规则修订号**：使用方（长期授权 `ruleRevision`、拒绝记录、规则页、MCP `rule_book`）都能接受 `1`，功能不会坏；但如第 1 条所述，改动前后同一个 `@1` 语义不同，历史记录和页面无法区分，建议按先例升到 `2`。

作者的说法总体与代码一致，需要修正/补充的点是：`memory.rule.respond` 并不是“只认 undo”，而是 `confirm`/`reconfirm`/`undo` 在后一个分支、`ask_first`/`allow_directly` 在前一个分支，5 个合法动作都处理了；另外“例子数”会变，虽然它不是发给模型的内容。
