### 1. 高：“读全文才能同意”的任务提案从不向主人显示任务原文

文件:行：`apps/agent-service/src/production-task-proposals.ts:229-235`、`apps/agent-service/src/production-proposal-control.ts:100-113`、`apps/agent-service/src/production-proposals.ts:949-965`、`packages/gateway-contracts/src/contracts-v2.ts:2355-2359`

问题：任务正文只存在提议的 `data` 里；展示给主人的 `summary` 只截前 60 字，`evidence.text` 是调用方传的 `reason`，全文并不在列表/快照里。`openFull` 只发一个 `fullReadToken`，不返回正文。于是超过 120 字、或由外部内容引出的任务被要求“读全文”，但主人根本看不到要执行的原文，等于盲签。

证据（读代码证实）：
- `summary: \`交给我去办：${clip(text, SHOWN_TEXT_LENGTH)}\``，`SHOWN_TEXT_LENGTH = 60`。
- `evidence: [{ kind: "detail", text: context.reason, sources: input.basis, figures: [] }]`，正文在 `data: { text, basis }`，不在 evidence。
- `const opened = await this.#options.box.openFull(...)` 只返回 `fullReadToken`/`expiresAt`。
- `proposals.push({ ... evidence: basis?.evidence ?? [], ... })`。
- 网关快照的 `evidence.text` 上限 500 字，且没有别的正文字段。

推测：`context.reason` 可能被调用方拿来塞正文，但这不是契约，且被 500 字截断；2000 字任务仍看不全。

建议：把任务正文作为一条独立的 evidence（例如 `text: 任务原文`）展示，或让 `openFull` 返回服务端校验/裁剪后的可读全文；并加测试证明“要求读全文时，主人看到的字节与执行时用的字节一致”。

### 2. 高：`external_event` 运行会被自动当作“外部内容”，写操作被规则直接拒绝

文件:行：`apps/agent-service/src/production-task-proposals.ts:151-167`、`apps/agent-service/src/owner-scope-authorization.ts:243-252`、`packages/application/src/rules/action-rules.ts:233-239`、`docs/architecture-v0.1.md:435`

问题：任务运行被记成 `external_event`。授权层对任何 `external_event` 都会写入 `external_event` 来源标记，于是每个工具动作都带 `context_external_content`。内置规则 `refuseBackgroundAfterExternalContent` 对“非 READ、非 managed-task”的所有动作直接 `refuse`，且严格度高于 `ask_owner`，不会弹审批。这使“交给我去办”的任务只要涉及写（发消息、建提醒、改文件等）就被拒绝，而不是文档说的“仍要你另外批准”。

证据（读代码证实）：
- `triggerSource: "external_event"`（任务运行）。
- `if (source.sourceType === "external_event") await marks.mark(invocation.runId, "external_event"); ... return [...new Set(found.map(({ origin }) => origin))].sort();`
- 规则：`'action_kind != "READ" && target_type != "managed-task" && run_source != "user_message" && "context_external_content" in facts'`，`outcome: "refuse"`。
- `owns` 的严格度：`allow_preauthorized: 0, ask_owner: 1, refuse: 2`。
- 文档：“对外发送、花钱、删除仍要你另外批准”。

建议：明确产品语义。如果确实要允许主人同意后的写操作，应给这种“主人已同意的任务运行”一个不同于普通后台外部事件的来源/事实，避免被 `refuseBackgroundAfterExternalContent` 命中；如果不允许写，文档应改成“会被拒绝”，不要让主人以为会来问。

### 3. 中：执行中途崩溃会留下空对话或永远“未知”的提议

文件:行：`apps/agent-service/src/production-task-proposals.ts:144-171`、`apps/agent-service/src/production-proposals.ts:575-602`、`apps/agent-service/src/production-proposals.ts:696-710`

问题：创建对话、写入消息/运行、记录执行原样是三个独立步骤，不在一个事务里。恢复逻辑只有在 `executionRef` 已存在时才做 `readBack`；否则一律把提议移到 `unknown`。因此：
- 对话已建、运行未开就崩溃：留下一个空对话（线程列表会显示，`thread.list` 不按消息数过滤），提议变成 `unknown` 或 `failed`，且不会补偿删除。
- 运行已开、但在 `handler.execute` 返回后、`#recordExecution` 写入前崩溃：运行其实已经存在，但提议永远 `unknown`，不会读回确认。

证据（读代码证实）：
- `const created = await commands.create(...)` 后紧接 `await commands.admitOwnerMessage(...)`，二者是独立命令。
- `if (!handler || !isAction(handler) || !basis || !execution) { ... to: "unknown" ... }`：`execution` 为空就直接 unknown。
- `executed = await handler.execute(...)` 之后才 `#recordExecution`，即执行返回值落盘前有一个窗口。
- `list()` 查询线程不要求有消息，空对话会出现在列表。

推测：若执行耗时超过提议租约（默认 120 秒），并发的 `list()`/`adopt()` 触发 `#recover`，也可能在原始执行还在跑时把提议标成 `unknown`，随后原执行 `moveExecution` 失败。该路径概率低，但代码没有续租。

建议：把“已开始的执行原样”在调用 `execute` 前写入（或让 `execute` 本身可幂等重入），使恢复能靠提议编号推导出的确定性 ID 做 `readBack`；失败时至少补偿删除已建的空对话，或在文档明确承认空对话。

### 4. 中：任务正文固定按 `private` 保存，可能把敏感内容降级

文件:行：`apps/agent-service/src/production-task-proposals.ts:129-142`、`apps/agent-service/src/production-task-proposals.ts:161`、`apps/agent-service/src/production-proposals.ts:335-346`

问题：提议依据（basis + data）用 `classificationWithIdentifiers(body, "private")`，含证件号/凭据时会升到 `sensitive`；但生成的对话消息和触发器载荷硬编码 `dataClassification: "private"`，没有同样的标识符检测，也没有让调用方指定更高分级。若任务正文来自敏感记忆或含敏感标识，消息分级会低于提议依据，影响模型选择、导出和后续处理。

证据（读代码证实）：
- `dataClassification: "private"`（消息载荷）。
- `dataClassification: "private"`（`admitOwnerMessage` 入参）。
- basis 存储用 `classificationWithIdentifiers(body, "private")`。

推测：正文是否真的含敏感内容取决于未来调用方；但当前 API 没有阻止，也没有声明限制。

建议：对 `taskRunMessage(...)` 使用 `classificationWithIdentifiers(text, "private")`，并让 `proposeTaskRun` 至少能接收/校验建议分级，或在文档明确禁止用敏感依据生成任务。

### 5. 中：同一 pending 任务重新提议可把“读全文/外部内容”标记降级

文件:行：`apps/agent-service/src/production-task-proposals.ts:226-237`、`apps/agent-service/src/production-proposals.ts:384-390`、`packages/persistence-sqlite/src/sqlite-owner-proposal-operations.ts:156-186`

问题：`proposalId` 由内容算出，因此同一条 pending 提议可被后续 `propose`“刷新”。刷新会把 `requires_full_read`、`origin` 直接覆盖成本次调用的值。若先以 `externalContentSeen: true` 建立（要求读全文、origin 为 `external_content`），再用同一 text/basis 但不带该标志地提议一次，就会把 `requires_full_read` 置 0、origin 降为 `inferred`，从而绕过“外部内容必须读全文”。另外，`requiresFullRead` 只看 `externalContentSeen === true`，不看 `context.origin === "external_content"`，与文档“由外部内容引出就要读全文”不一致。

证据（读代码证实）：
- `requiresFullRead: long || context.externalContentSeen === true`。
- `propose` 的 `origin = input.externalContentSeen === true ? "external_content" : input.origin`；对 action handler 不会因 `origin === "external_content"` 强制读全文。
- store 的 refresh 分支 `UPDATE ... requires_full_read = ?, ... origin = ? ...`，没有保留更高要求。

推测：目前没有来源调用 `proposeTaskRun`，所以这是下一步接入时会踩到的问题。

建议：刷新时至少取“旧值或新值中更严格者”；`requiresFullRead` 同时判断 `origin === "external_content"`；并补一条“先外部内容、后普通提议不能降级”的反向测试。

### 6. 中：`proposalId` 的哈希输入有歧义且 `basis` 未排序，不同提议会撞号

文件:行：`apps/agent-service/src/production-task-proposals.ts:221-224`

问题：`proposalId = sha256([text, ...basis.map(kind + ":" + ref)].join("\n"))`。分隔符是裸 `\n`，而 `text`、`kind`、`ref` 都没有禁止 `\n` 或 `:`，所以不同的 (text, basis) 组合可以拼出完全相同的字符串，得到同一个提议编号。例如：
- text=`"x\ny:z"`, basis=`[{kind:"k",ref:"r"}]`
- text=`"x"`, basis=`[{kind:"y",ref:"z"},{kind:"k",ref:"r"}]`
两者都拼成 `"x\ny:z\nk:r"`。这会让两条不同提议共用编号：后者可以刷新前者，前者成功后后者永远 `closed`；也会让“同一提议”的线程/运行 ID 复用。`kind`/`ref` 顺序变化同样会得到不同编号，破坏去重。

证据（读代码证实）：上述哈希输入没有排序、没有长度前缀、没有 JSON 序列化。

推测：如果未来来源是模型或数据库无序结果，basis 顺序抖动会额外放大该问题。

建议：用长度前缀或 `canonicalJson({text, basis})` 计算编号，并对 basis 排序（或明确这是集合）。注意这会改变已有编号语义，应在还没有来源调用前定下来。

### 7. 中：store 返回 `closed` 时仍返回 `proposalId`，成功过的同一任务永远不能再提议

文件:行：`apps/agent-service/src/production-task-proposals.ts:226-239`、`apps/agent-service/src/production-proposals.ts:399-440`、`packages/persistence-sqlite/src/sqlite-owner-proposal-operations.ts:156-157`

问题：`ProductionProposalBox.propose` 在 `outcome === "closed"` 时直接返回（不抛错），但 `proposeTaskRun` 仍返回 `{ proposalId }`。`closed` 恰好发生在“该 id 已执行过”（`execStatus !== "not_started"`）。因此同一个 text+basis 的任务成功执行一次后，再提议会返回一个编号，但实际上没有 pending 提议；调用方会误以为它在等确认。若这是希望“同一任务可以再次交办”，当前设计做不到。

证据（读代码证实）：
- `if (existing && existing.execStatus !== "not_started") return "closed";`
- `if (outcome === "closed") { await drop(); return; }`（只有 `limit_reached` 才抛 `PROPOSALS_FULL`）。
- `return { proposalId };`。

建议：让 `propose` 返回 outcome，或 `closed` 时抛一个明确错误；如果任务应可重复交办，把发起上下文/时间/来源加入编号，而不是只按内容去重。

### 8. 中低：`readBack` 只确认存在，不确认运行是否已开始、失败或取消

文件:行：`apps/agent-service/src/production-task-proposals.ts:173-185`、`apps/agent-service/src/production-proposals.ts:547-572`

问题：`readBack` 只检查对话里有没有这条消息和这次运行，不看运行状态。运行刚建好即为 `accepted`；之后的 `failed`/`cancelled`（包括还没派发就被取消）仍会让读回返回 `matches`，提议标成 `succeeded`。文档把 `succeeded` 定义为“已经开始办”，但代码实际是“已经被创建”。这会在恢复路径（例如租约过期很久后读回）把一次从未真正开始的运行算成成功。

证据（读代码证实）：
- `const hasRun = snapshot?.runs.some((run) => run.runId === made.runId) === true;`
- `return hasRun && hasMessage ? "matches" : "differs";`
- `handler.readBack(...) === "matches" ? "succeeded" : "failed"`。

建议：至少在首次读回时区分 `accepted` 与 `cancelled`/`failed`，或明确把成功定义为“运行已被受理”，并在提议详情中展示运行状态，避免主人误以为任务已在办。

### 9. 低：自动检查覆盖不足，若干反向场景不会被测试抓到

文件:行：`test/integration/task-proposals.test.ts:229-242`、`test/integration/task-proposals.test.ts:258-274`

问题：现有测试覆盖了开运行、普通消息来源、无依据/空文本/超长、外部内容读全文、无会话、撤销。但：
- “同意两次只开一次”依靠的是提议状态机（第二次 `adopt` 直接因 `accepted` 失败），即使删掉两个幂等键测试仍会通过，未真正验证幂等键。
- 没有测试 `triggerSource` 不进入 `user_message` 的语义指纹（老指纹不变）。
- 没有测试外部事件的审批/动作规则（因此没发现第 2 条）。
- 没有测试执行中途崩溃后的恢复、孤儿对话或 `executionRef` 缺失时的读回。
- 没有测试“要求读全文时主人能看到什么”。
- 外部内容测试同时传了 `origin: "external_content"` 和 `externalContentSeen: true`，抓不到第 5 条的降级路径。

证据（读代码证实）：上述测试的断言只比对 `runs` 数量和异常码，没有验证幂等键是否真的参与去重，也没有覆盖恢复/审批/展示。

推测：我无法运行测试（环境只允许读取和 git 命令），所以“反向用例是否会失败”只做了代码阅读判断，未核实实际执行结果。

**侧重检查**

- 错误路径/崩溃恢复：查了 `#adoptAction`、`#recover`、`#recordExecution` 与任务 handler 的 `execute`/`readBack`；结论见第 3、8 条。失败时 `execute` 抛错会被标成 `failed`，但崩溃窗口会落成 `unknown` 或空对话。
- 不可信输入/规范：查了 `taskData`、`proposeTaskRun` 的输入校验；空文本/超长/无依据会被拒。但 `basis.kind/ref` 可含换行与冒号，参与编号计算时产生第 6 条的歧义；`context.reason` 长度没有限制。
- 安全/敏感信息：查了会话校验和分级；无会话时 `verify` 在 `claim` 前抛 `PROPOSAL_INVALID`，不会标成 `superseded`，也不会开运行（与作者说法一致）。但任务正文固定 `private`，见第 4 条。`sourceProofRef` 里带 `authenticationRef` 是身份层哈希，未发现直接泄漏凭据。
- 资源耗尽：正文 2000 字、basis 最多 8 条、pending 提议有上限；崩溃留下的 `proposal-task:<key>` 载荷和空线程不会被回收，属于低量残留。
- 不可撤销：`undo` 一律 `PROPOSAL_NOT_UNDOABLE`（作者说法 5 正确）；因此空线程/已开运行没有撤销或补偿路径。
- 规则/文档一致性：第 1、2、5 条均有文档与代码不一致。另有两处表述需要澄清：文档说“不调模型”，但同意后必然启动一次普通运行（会调模型，标题生成也可能调模型）；文档说“最坏情况是首页两边都没有”，实际还会留下空对话。
- I-73 式跨端核对：`task:<32hex>` 同时满足应用层 `PROPOSAL_ID_PATTERN` 与 SQLite 层 `PROPOSAL_ID`，也满足导出校验；`triggerSource: "external_event"` 满足 `0001_initial_product_schema.sql:133` 的 CHECK；线程/消息/回合/运行 ID 符合 `MACHINE_IDENTIFIER_PATTERN`；两个幂等键长度在 128 以内。`user_message` 的语义指纹不含 `triggerSource`（`thread-command-service.ts:225-227`），老回执不受影响。
- 下游 `source_type` 假设：运行派发（`listClaimable`）、上下文快照（`readContextSnapshot` 对 `external_event` 与 `user_message` 一样解析触发消息）、模型选择（`modelSelection` 为空时用 primary，`production-run-policy.ts:72-76`）、标题生成（取第一条 owner 消息）都不要求 `user_message`。`production-owner-intent.ts:66` 和 `production-memory-capture.ts:1087` 会跳过 `external_event`，属于“不启用该功能”而非阻塞。真正会改变行为的是第 2 条的授权规则。

**必答问题**

1. **会不会改变模型已经见过的请求开头？** 不会。这个改动没有改系统提示、工具定义、已有对话的历史或遮盖规则；任务运行总是新建对话（ID 由提议编号派生），任务消息作为新对话的第一条/唯一一条 owner 消息追加，写入后固定不变。抬头里的时间、时区和提议编号都在那条消息内部（首轮的最后一条消息），后续轮次不会重算。`triggerSource` 只影响触发器插入和（非默认时）语义指纹；默认 `user_message` 不进指纹，老回执指纹不变。依据是 `prompt-prefix.md` 的“只追加/会变的值放最后一条消息”和 `thread-command-service.ts:219-227`。

2. **同一段文字会不会在不同请求里变成不同字节？** 任务消息本身是确定的：`taskRunMessage` 在 `execute` 时生成一次并 `payloads.put`，之后每个请求从同一 `contentRef` 读取；`decidedAt` 固定为那次执行的 `clock.now()`，`neutralized` 也是纯函数。没有依赖上下文的自适应遮盖或时间字段出现在系统提示/工具里。需要留意的是提议编号/指纹层面：`basis` 未排序且有拼接歧义（第 6 条），如果未来调用方用不同顺序或不同切分生成 basis，同一逻辑任务会得到不同编号，进而开不同对话；但这不影响已写入那条消息的字节。

3. **有没有对应的自动检查，反向用例真的会失败吗？** 有 `test/integration/task-proposals.test.ts`，覆盖了成功开运行、普通消息来源、输入拒绝、外部内容读全文、无会话、撤销。反向用例中“无会话”“读全文”“空/超长/无依据”“撤销”在对应行为被删掉后应当失败；但“同意两次只开一次”实际验证的是提议状态机而不是幂等键，此外缺少指纹不变、审批规则、崩溃恢复、孤儿对话、全文展示等用例（第 9 条）。我无法运行测试，未核实实际执行结果。

4. **`readBack` 在运行被取消/失败时仍判成功，符合“succeeded 指已经开始办”吗？** 代码确实只查存在（第 8 条），所以运行被取消或失败仍会 `succeeded`。如果“已经开始办”严格指运行已被派发并开始，这不符合；如果只是“已经被受理”，则需要把文档和字段语义写清楚。建议区分“已受理”和“已开始”，或在读回时检查运行状态。

5. **抬头里没有配置时区时显示 UTC 会误导吗？** 默认 `timeZone` 是 `UTC`（`production-http-composition.ts:1221`），抬头明确写成 `...（UTC）`，所以不会被误标成当地时间；但在主人配置了本地时区却没配 `runPolicy.timeZone` 的情况下，显示的是 UTC 而不是本地时间，UX 上仍可能困惑。建议任务提案要求明确的时区，或复用主人已配置的时区；这不是代码正确性问题，是配置/展示问题。

仓库外计划文件 `/mnt/project-files/ambient-sensing/proposal-run-trigger-plan.md` 和 `proposed-actions-plan.md` 不在当前仓库内，计划原文未核实。
