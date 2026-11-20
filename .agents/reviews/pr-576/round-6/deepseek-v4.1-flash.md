## 查过范围

- `git diff 12dc874e2cf555f9fe72f1e8bdf71e3cedffa2cc..4375043ebbadd791ae8ab6a8b77e1813ce4d5859` 中 PR 576 自己的非记录改动只有 ADR 0278 的两处（前提 3、回归测试清单）。
- 对 PR 576 的代码路径做增量核对：`git diff 12dc874..4375043 -- packages/application/src/rules/action-rules.ts packages/application/src/ports/run-execution-source.ts packages/application/src/services/run-execution-input-service.ts apps/agent-service/src/production-run-expiry.ts apps/agent-service/src/production-task-proposals.ts` 为空，代码确实没变。
- 对照阅读了 `action-rules.ts`、`run-execution-source.ts`、`run-execution-input-service.ts`、`production-run-expiry.ts`、`sqlite-thread-operations.ts`、`owner-scope-authorization.ts`、`policy-fact-registry.ts`、`production-task-proposals.ts`、相关测试、ADR 0257 和 `docs/architecture-v0.1.md`。
- 合并提交 `dabc0a8a9` 从 main 带入的其它 PR（#479、#578、#580、#581、#583、#585）改动没有逐行重审；只确认它们没有改 PR 576 上述文件。

## 上一轮意见核对

- 第 1 条未改：ADR 0278 的 `amends` 仍为空（见意见 1）。
- 第 2 条前提 3 已改好：现在写“风险为中等、可撤回、不对外”，和 `risk == "MEDIUM"` 一致；但决定 4 仍有同类遗漏（见意见 2）。
- 第 3 条已改好：ADR 第 77 行现在写明坏快照只有单元测试核对比对为不一致、没有端到端核对错误码，和代码、测试一致。

## 意见

### 1. 低：ADR 0278 的 `amends` 仍为空，和 ADR 0257 没有互链

文件:行：`docs/adr/0278-tasks-the-owner-agreed-to-ask-before-writing-after-external-content.md:7`；`docs/adr/0257-consequential-tool-calls-go-through-one-authorization-exit.md:1-8、148、216`

问题：ADR 0278 决定 3 明确说把 ADR 0257 决定 3 的 `refuseBackgroundAfterExternalContent` 升到第 2 版，但 0278 的 `amends` 仍是空串，0257 的开头也没有 `amended_by`。两份 ADR 都标 `status: active`，0257 第 148 行仍写着“后台发起的一轮，上下文里有外来内容，想做有后果的事 → 不做”，读者或后续代理只看 0257 会得到和代码相反的行为。同一 PR 还改了 0257 的事实代码表（第 216 行），但没有留下修订关系。

证据（读代码证实）：

- 0278 第 7 行：`amends: ""`
- 0278 第 48 行：`内置规则 refuseBackgroundAfterExternalContent（ADR 0257 决定 3 定的）升到第 2 版`
- 0257 第 148 行：`| 后台发起的一轮，上下文里有外来内容，想做有后果的事 | 不做，也不建等着的审批；…… |`
- 0257 第 1-8 行 frontmatter 没有 `amended_by`
- `packages/application/src/rules/action-rules.ts:249` 的实际表达式已加 `!("run_source_owner_approved_task" in facts)`，即已存在“主人同意过的任务”例外

建议：在 0278 的 `amends` 写入 `docs/adr/0257-consequential-tool-calls-go-through-one-authorization-exit.md`，并在 0257 加 `amended_by: "docs/adr/0278-…md"`；若认为这是整份替代，则改用 `supersedes`。文档治理要求决定改变时不要改写旧 ADR 的决定内容，加上互链即可，不需要改旧正文。

### 2. 低：决定 4 仍把“可撤回、不对外”写成预先放行的充分条件，漏了 `risk == "MEDIUM"`

文件:行：`docs/adr/0278-tasks-the-owner-agreed-to-ask-before-writing-after-external-content.md:49`；`packages/application/src/rules/action-rules.ts:86`；`docs/adr/0257-consequential-tool-calls-go-through-one-authorization-exit.md:144`；`docs/architecture-v0.1.md:435`

问题：决定 4 说“只动主人自己数据、可撤回、不对外的写入由内置规则预先放行”。内置规则 `action_preauthorize_owner_data` 还要求 `risk == "MEDIUM"`，所以高风险但可撤回、不对外、只动主人数据的写入不会被这条规则预先放行。上一轮第 2 条只修了前提 3；同一类不精确仍留在决定 4 和架构文档同一段里。另外，前提 3 的“只有……除外”没有列出 `owner_presence_required` 和 `standing_rule_change` 两个排除事实，虽然 ADR 0257 第 146-147 行另有规定，影响较小。

证据（读代码证实）：

- ADR 0278 第 49 行：`只动主人自己数据、可撤回、不对外的写入由内置规则预先放行`
- `action-rules.ts:86`：`action_kind == "CREATE_OR_UPDATE" && risk == "MEDIUM" && reversible == 1 && disclosure == "none" && recipient_count == 0 && !("context_external_content" in facts) && !("owner_presence_required" in facts)`
- ADR 0257 第 144 行：`上下文里没有外来内容，中风险、能撤销、只动主人自己的数据 | 直接做，和现在一样。`
- `docs/architecture-v0.1.md:435` 同样写成“只动主人自己数据、可撤回的写入由内置规则预先放行”，也漏了“中风险”

建议：决定 4 和架构文档补上“中风险”，或直接改成“满足 ADR 0257 决定 3 的预先授权条件时”。前提 3 若要完整复述例外，建议引用 `OWNER_INTENT_CONFIRMED_EXPRESSION` 或列出 `owner_presence_required`、`standing_rule_change` 两个排除项，避免以后规则再改时文档继续漂移。

## 侧重检查

- 错误路径：`production-run-expiry.ts:62-74` 在来源不匹配、来源缺失、版本或时间字段非法时抛 `RUN_EXPIRY_INPUT_INVALID`；`run-execution-input-service.ts:230-240` 在冻结来源变化时抛 `"Run execution snapshot source changed"`。坏来源（`undefined`、`null`、字符串）经 `run-execution-source.ts:33-38` 原样返回，`frozen-run-source-identity.unit.test.ts:47-54` 断言它和有效来源的规范快照不一致。读代码确认没有针对坏快照的端到端错误码断言；ADR 第 77 行现在明确写了这一点，属于已披露的测试缺口，本轮未升级为新意见。
- 不可信输入与安全：`sqlite-thread-operations.ts:1528-1533` 只认同 owner/agent、`type='task.run'`、`status='accepted'` 的提议，并要求 `source_proof_ref` 以 `proposal:<op.id>:` 开头；app 内 `sourceProofRef` 的产生点只有 `production-task-proposals.ts:163` 和 `production-think-runner.ts:208`。它做的是前缀匹配，不验证该提议是否就是创建这条运行的提议。推测：若将来有别的外部来源能写入以某个已同意提议编号开头的 `source_proof_ref`，该运行会绕过外部内容标记；当前 app 内没有找到这样的产生点，ADR 后果也写明了“来源凭据指向另一条还没同意的提议”这一情况。
- 不可撤销操作：`production-task-proposals.ts:190-192` 的 `undo()` 直接抛 `PROPOSAL_NOT_UNDOABLE`，ADR 第 74 行“`task.run` 提议没有撤销入口”与代码一致；本次增量没有新增不可撤销操作。
- 资源耗尽：本次增量只有文档，没有运行时代码变化，不涉及。
- 规则、说明文档和代码一致性：前提 3 已与 `action-rules.ts:15-16` 一致；决定 4 与 `action-rules.ts:86` 仍不一致；`amends` 互链缺失；回归测试描述与 `frozen-run-source-identity.unit.test.ts`、`thread-run-lifecycle.test.ts` 一致。

## 必答问题

1. **不会改变模型已经见过的请求开头。** 本轮 PR 576 的增量只有 ADR 0278 的两处措辞，没有改系统提示、工具定义、历史消息或遮盖结果；`ownerApprovedTask` 和 `run_source_owner_approved_task` 只在授权层、冻结快照和治理页使用，不进入模型请求。发给模型的内容仍然只在末尾追加；本轮没有产生每轮会变的值，所以“变化值是否在最后一条消息里”不涉及。合并带入的 main 改动（包括 #479 的 `packages/prompt-catalog` 新增对外 MCP 说明）属于其它 PR，`usedBy` 指向 `production-mcp-read.ts` 的对外 MCP 服务，不是 Himawari 自己的对话请求；本轮未逐行重审。

2. **不会让同一段文字在不同请求里变成不同字节。** 本轮增量没有运行时改动。PR 早先的 `ownerApprovedTask` 由数据库提议状态确定性推导；`runtimePolicyFacts` 对事实代码去重并排序（`policy-fact-registry.ts:149-153`），同一组事实的序列化稳定；`frozenRunSourceIdentity` 只在比对时剥离该字段，不改变存储字节。未发现依赖前后文的遮盖、时间字段或无序集合进入模型可见文本。

3. **增量没有新增或修改自动检查。** PR 已有的检查是 `frozen-run-source-identity.unit.test.ts`、`thread-run-lifecycle.test.ts`、`task-proposals.test.ts`、`tool-action-registry.test.ts`。读代码看，反向用例有区分力：单元测试第一条先断言不剥离时两个快照不同，若 `frozenRunSourceIdentity` 不剥离就会失败；坏来源用例若把 `undefined`/`null`/字符串规范化也会失败；端到端用例对改过的 `sourceId` 断言 `RUN_EXPIRY_INPUT_INVALID`。受工具限制没有运行测试，“反向用例真的会失败”只是按代码推断，未执行验证。ADR 第 77 行关于坏快照只有单元测试的说法与代码一致，上一轮第 3 条已改好。仓库脚本里没有找到对 `amends`/`amended_by` 的自动校验。

4. **本次增量没有产生或修改任何标识、字段、配置键、清单项或序列化格式**，所以没有新增的直接使用端需要核对。对 PR 早先的值抽查：`ownerApprovedTask` 的产生端 `sqlite-thread-operations.ts:1528-1562` 只在 `ownerApprovedTask === 1` 时写 `true`，类型 `run-execution-source.ts:26` 只允许 `true`；使用端 `owner-scope-authorization.ts:179` 做 truthy 判断、`:260` 用它取消外部事件标记，`run-execution-source.ts:33-37` 比对前剥离。`run_source_owner_approved_task` 在 `policy-fact-registry.ts:76-82` 有三种语言标签，`runtimePolicyFacts` 会校验事实代码，ADR 0257 第 216 行的事实表也已列入。规则 revision 2 的命中结果只在 `rule-judge.ts:35` 记录 id 和 revision，没有发现 action rule revision 被持久化后要求精确匹配的消费端；该规则是 `refuse`，不产生长期授权。未发现两端校验不接受的情况。

## 读代码证实与推测

- 读代码证实：上述 ADR、规则表达式、测试、SQL 来源推导、授权层事实组装和冻结快照比对都是直接读到的；`git diff` 确认增量没有改这些代码。
- 推测：`source_proof_ref` 只做前缀匹配带来的绕过风险，以当前 app 内只有两处产生点为前提判断为理论风险，未构造出实际可达路径。
- 未核实：没有运行测试，没有运行文档治理 `validate_docs.py --strict`；合并提交“没有冲突”只从合并记录判断，没有逐文件重放冲突检查。
