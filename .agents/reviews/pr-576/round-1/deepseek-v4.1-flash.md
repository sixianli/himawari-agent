## 范围说明

`git log --left-right 3cbd...c66` 显示：基准 `3cbd` 有 37 个提交不在 PR 分支里（#542/#570/#571/#572/#574/#575 等），PR 分支只有 `2f1f35c72` 和复核简报两个提交。因此 `git diff 3cbd..c66` 里的大量删除（`.agents/reviews/*`、delivery-mode、macOS 设置等）不是本 PR 的改动，而是分支落后于基准造成的“反向差异”。下面只复核真正的功能提交 `2f1f35c72`（10 个文件）。我没有运行测试（本环境只允许 git 命令），测试是否通过标注为“未核实”。

---

### 1. 中：设备动作读到外部内容后仍是硬拒绝，A' 的“改成问主人”没有覆盖到

文件：`apps/agent-service/src/production-device-action-authorization.ts:59`、`apps/agent-service/src/production-device-actions.ts:92`、`packages/application/src/services/device-action-registry.ts:503`

问题：`device_action` 走的是另一条授权入口。它先检查 `readUntrustedContent`，为真且该动作不允许外部来源时直接 `deny`，根本到不了 `ownerScope.authorize`，所以拿不到 `run_source_owner_approved_task` 的“问主人”分支。

读代码证实：

```ts
// production-device-action-authorization.ts:59-60
if (!intent.untrustedOriginAllowed && intent.readUntrustedContent)
  return { decision: "deny", reasonCode: "authorization_denied" };
```

`readUntrustedContent` 来自运行级外部内容标记（`production-device-actions.ts:92`，`externalContent.read(runId).length > 0`）；`calendar.create`、`calendar.update`、`calendar.delete`、`contact.update`、`home.control` 都是 `untrustedOriginAllowed: false`（registry 第 503、530、566、604、701 行）。所以主人同意的任务一旦读过网页/任务输出，这些设备写入仍然直接失败，不是弹出审批。这与 ADR 0278 决定 3、后果第 1 条以及新效果句“读过网页、邮件这类外部内容之后，任何写入也都先问你”（`production-task-proposals.ts:256`）不一致。

推测：这不是安全倒退（比“问主人”更严），但“同意了却办不成”的问题在这类动作上仍然存在；如果产品目标是“写操作一律转审批”，这一块需要补。

建议：把运行来源（或只把 `ownerApprovedTask`）传进设备授权层，对 `ownerApprovedTask` 的运行把第 59 行的 `deny` 改成进入 `ownerScope.authorize` 走 `ask_owner`；对明确不允许外部来源的动作仍保持拒绝。或者把效果句/ADR 收窄为“owner-scope 工具”，并补 `calendar.create` 等用例。

---

### 2. 中低：提议撤销后，已经问过的审批仍按冻结事实判定，与 ADR“回到直接拒绝”不一致

文件：`apps/agent-service/src/owner-scope-authorization.ts:240`、`:289-295`；`docs/adr/0278-...md:73`

问题：`authorize` 把动作意图冻结进 artifact，`approvalOutcome` 再次判定时只重新读 `source.sourceType`，不重新判断 `ownerApprovedTask`。因此快照里已经有 `run_source_owner_approved_task` 的审批，在提议被撤销后仍会按“问过、可批准”处理；同一个工具调用的重试还会复用旧的冻结意图。

读代码证实：

```ts
// owner-scope-authorization.ts:240
const intent = (await freeze(`owner-scope-intent:${id}`, proposed)) as GovernedActionIntent;
// :289-295
const source = await this.#options.source.read(approval.runId);
if (!source) return { kind: "refused", reasonCode: "run_source_unavailable" };
const decision = await this.decide(
  approval.intentSnapshot as GovernedActionIntent,
  source.sourceType,
  signal,
);
```

`production-runtime-tools.ts:698-706` 的 freeze 在 artifact 已存在时直接返回旧快照；`action-policy-service.ts:340-343/405` 对已有审批/授权走批准或授权路径。ADR 第 73 行却写“提议被撤销后，这次运行还没做完的写操作会回到‘直接拒绝’”。

推测：如果撤销的语义是“立刻停止这个任务的一切后续写入”，那么已存在/已重试的审批不会被撤销，会违背主人预期；如果撤销只影响“新的动作”，则 ADR 的表述过强。

建议：二选一：在 `approvalOutcome` 里重新读当前运行来源，当快照含该事实但当前 `ownerApprovedTask !== true` 时返回 `refused`；或者把 ADR 改成“撤销只影响尚未发起过的动作”，并在测试里明确这一点。

---

### 3. 低：新增的事实文字没有任何生产界面显示，ADR 承诺的审批卡内容是空的

文件：`packages/application/src/services/policy-fact-registry.ts:76-82`、`packages/application/src/services/action-policy-service.ts:544-559`、`clients/apple/Sources/HimawariManage/DeviceActions/DeviceActionViews.swift:364-365`、`apps/control-center/src/governance-control-center.tsx:358`

问题：新增了三种语言的 `run_source_owner_approved_task` 标签，但生产代码里没有任何地方使用 `POLICY_FACT_REGISTRY` 的 label（整仓引用只有 registry 自身和两个测试）。审批卡的 `approvalDisplay` 只返回 `displayTitle/bodyPreview/origin/askedBecause`；Apple 端只渲染 `askedBecause.ruleText`；控制中心治理页直接显示原始代码。

读代码证实：

```ts
// action-policy-service.ts:554-559
return Object.freeze({
  displayTitle: input.displayTitle,
  bodyPreview: input.bodyPreview,
  origin: input.origin,
  askedBecause: Object.freeze(askedBecause ?? { kind: "no_rule_allows" as const }),
});
```

```swift
// DeviceActionViews.swift:364-365
let because = approval.display?.askedBecause
let text = because?.ruleText.map { L.format("approval.why.rule", $0) } ?? L.text("approval.why.noRule")
```

ADR 0278 后果第 3 条说“审批卡片上会显示‘这一轮是你同意过的一件任务’”，但实际只会显示规则文案和原始事实代码（或什么都不显示）。

建议：要么在 `approvalDisplay`/`askedBecause` 里把该事实的本地化文字拼进卡片，要么删掉未使用标签并修正 ADR，避免“清单里有、消费端不认”的 I-73 类问题。

---

### 4. 低：控制中心的规则说明没随 revision 2 更新，仍说这条规则“不做也不弹卡片”

文件：`apps/control-center/src/i18n/resources/zh-CN.ts:884`（`en.ts:936`、`ja.ts:942` 同）

问题：`refuseBackgroundAfterExternalContent` 第 2 版对“主人同意过且带 `run_source_owner_approved_task`”的运行不再命中，改由 `askAfterExternalContent` 弹卡。控制中心仍写：

```text
action_refuse_background_after_external_content {例如定时任务或外部事件发起的一轮读过外来内容后想改规则：不做，也不弹卡片，只记下它想做什么。}
```

对 owner-approved 任务来说，“不弹卡片”已经不对；而且这条规则并不只管“改规则”，而是所有非 READ、非 managed-task 的动作。

建议：三种语言都补上“主人同意过的任务除外，会先问你”的说明，或改成更一般的描述；如果 i18n 有快照检查，补一个反向用例。

---

### 5. 低：效果句“任何写入也都先问你”超出代码实际，且旧待定提议会继续显示旧文案

文件：`apps/agent-service/src/production-task-proposals.ts:256`、`packages/application/src/rules/action-rules.ts:249`、`packages/persistence-sqlite/src/sqlite-owner-proposal-operations.ts:228-252`

问题：效果句承诺“任何写入”，但 `refuse`/`ask` 两条规则都排除了 `target_type == "managed-task"`；设备动作也如上所述会直接拒绝。另外 `effect` 是提议创建时写进 `owner_proposals.effect` 的固定文本，本次上线前已经存在的待定 `task.run` 提议不会被改，主人仍会看到旧版“写入会被直接拒绝”。

读代码证实：

```ts
// production-task-proposals.ts:256
"新开一个对话，把这段任务说明原样交给我去办；这次运行在后台，发送、花钱、删除照常先问你；读过网页、邮件这类外部内容之后，任何写入也都先问你",
```

```ts
// action-rules.ts:249
'action_kind != "READ" && target_type != "managed-task" && run_source != "user_message" && ...'
```

建议：把“任何写入”改成准确范围（例如“除停掉本轮任务外的写入”），或在规则层补 managed-task 的审批；对旧待定提议，至少在 accept 时提示行为已变，或迁移 effect 文案。

---

### 6. 低：ADR 0278 没记 `amends`，而它描述的“撤销”在现有代码里没有真实入口

文件：`docs/adr/0278-...md:7`、`:73`、`docs/architecture-v0.1.md:435`、`apps/agent-service/src/production-task-proposals.ts:190-192`、`packages/application/src/services/.../production-proposals.ts:865-886`

问题：ADR 修改了 ADR 0257 决定 3 的规则语义，但 frontmatter 是 `amends: ""`；ADR 和测试都依赖“提议被撤销”，但 `task.run` 的 `undo()` 直接抛 `PROPOSAL_NOT_UNDOABLE`，`reject()` 只处理 `pending`，架构文档还明确写着“它没有撤销”。

读代码证实：

```ts
// production-task-proposals.ts:190-192
async undo() {
  throw new ProposalError("PROPOSAL_NOT_UNDOABLE", "TASK_RUN_NOT_UNDOABLE");
},
```

```text
// architecture-v0.1.md:435（该段末尾）
……它没有撤销。
```

建议：把 `amends` 指向 `docs/adr/0257-...md`；如果要保留“撤销后回到拒绝”的承诺，先实现 accepted→withdrawn 的真实路径；否则把 ADR/测试改成描述“数据库状态被外部改掉时”的防御行为。

---

### 7. 低：测试覆盖不足，关键反向用例不会因回滚本改动而失败

文件：`test/integration/tool-action-registry.test.ts:88-101`、`:649-699`、`test/integration/task-proposals.test.ts:184-193`

问题：
- 授权测试通过包装 `RunExecutionSourcePort` 直接注入 `ownerApprovedTask: true`，没有覆盖“SQL 读出来的标记 → 授权层”这条真正的集成链路。
- `task-proposals.test.ts` 用 `UPDATE owner_proposals SET status = 'revoked'`，但 `STATUSES` 只有 `pending/accepted/rejected/expired/superseded/withdrawn`（`sqlite-owner-proposal-operations.ts:16`），表级 CHECK 只限制长度；这模拟的是一个生产代码永远不会写入的状态，且没有走真实的 `withdrawn` 转换。
- 没有测试作者特别声称的“p1 不会误配 p12”前缀边界；代码本身用 `'proposal:' || op.id || ':'` 是安全的，但无回归用例。
- 没有“审批通过后动作真的执行”的用例；新的正例只断言 `approvals` 有 1 条，没走 `approvalOutcome`/grant 的完成路径。
- `test/integration/task-proposals.test.ts` 的正例会在回滚改动后失败；但第 683 行的“REVERSE 没有标记仍拒绝”在改动前后都会通过，它验证的是既有行为，不是新条件的反向用例。

建议：补一条使用真实 SQLite 的端到端用例（接受提议 → 读来源 → authorize → 批准 → 执行）；把 `revoked` 改成真实状态或走真实转换；补前缀碰撞（p1/p12、相同前缀）用例；补 think/schedule/其他 external_event 源的对照用例。

---

## 侧重检查

**不可信输入与伪造标记（读代码证实）**：客户端消息走 `product-thread-gateway-adapter.ts:753-778` 的 `thread.message.submit`，没有传 `triggerSource`，因此默认是 `user_message`；`trigger.admit` 不在生产 HTTP 路由里（`client-capabilities.ts` 也把它标成 v1 不在手机端），生产代码里只有 `production-task-proposals.ts:155` 和 `production-think-runner.ts:200` 会写 `external_event`。前者写 `proposal:<id>:<session.proofRef>`，后者写 `think:<entry.id>`；后台通知写 `run:<parentRunId>`。`proposal:` 前缀只由任务提议处理方产生，SQL 的匹配带末尾冒号且 task 提议 id 定长，p1/p12 不会互配，查询无字符串拼接注入。作者说法 1 在我核到的生产路径上成立；部署级是否暴露了未接入的 `trigger.admit` 标注“未核实”。

**错误路径（读代码证实）**：`readRunExecutionSource` 找不到运行/来源时返回 undefined，授权层拒绝；外部内容标记写失败时工具不会继续；提议状态不是 accepted 时标记消失；`accepted` 不会被 `expire()` 清掉（`expire` 只动 `pending`）。撤销后的冻结事实问题见第 2 条。

**安全/越权（读代码证实）**：没有发现本改动新增的绕过审批路径。读到外部内容后 owner-approved 任务由 `askAfterExternalContent` 接手；不可逆/高风险动作仍不满足 `preauthorizeOwnerData`（要求 `reversible == 1`、MEDIUM）。未读外部内容时，中风险可逆的 owner-scope 写入（reminder/rule/部分 device_action）会按 ADR 决定 4 预先放行，这是方案明说的放宽，但效果句应写准。没有新增密钥、路径、URL 或外部回显。

**资源耗尽/不可逆操作（读代码证实）**：新逻辑没有循环、分页或外部资源创建；授权仍是一次性、按意图冻结。主要影响是写能力从“全拒绝”扩到“问主人/少量预授权”，不是资源型风险。`execution.task.cancel` 这类 managed-task 动作在两条规则里都被排除、且由 `preauthorizeOwnTaskCancel` 预授权，这是既有行为，本次未改。

**规则、说明与代码一致（读代码证实）**：控制中心 i18n 过时（第 4 条）；ADR `amends` 为空、撤销句子无真实入口（第 6 条）；效果句过宽且旧提议文案不迁移（第 5 条）；新事实标签没有生产消费端（第 3 条）。

**提示词（读代码证实）**：`ownerApprovedTask` 只出现在 `owner-scope-authorization.ts:179/260` 和测试里；授权事实与审批卡都不进入模型请求。`readOnlyRun` 仍只看 `sourceType/sourceId`（`service-main.ts:1718-1721`），工具定义不变。因此没有发现请求开头被改动。

---

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。改动只在运行来源读取、授权事实、内置规则和提议效果文案；`ownerApprovedTask`/`run_source_owner_approved_task` 不进入系统提示、工具定义、历史或遮盖结果。会变的是工具结果（拒绝 / 等待审批 / 成功），它们只追加在末尾。每轮会变的值也没有被新增到前面：新事实和外部来源只进授权/审批展示。`taskRunMessage` 里的 `decidedAt` 本来就在新对话的第一条消息、且首次执行时写入载荷，本次未改。结论：仍满足“只在末尾追加”，且没有新的每轮变化值进入请求头。

2. **同一段文字会不会在不同请求里变成不同字节？** 不会（就模型输入而言）。新事实由 `runtimePolicyFacts` 去重并按 code 排序；`externalSources` 也做了去重和排序；SQL 布尔值只取决于数据库状态，不进入模型文本。提议状态变化会影响授权结果和审批卡内容，但那是给主人的界面，不是模型字节。推测：如果将来把事实标签拼进模型提示，必须先按 KV 缓存规则重新设计；当前没有。

3. **有没有自动检查，反向用例真的会失败吗？** 有，但不够。正例（`tool-action-registry.test.ts:649/664`、`task-proposals.test.ts:184-193`）在回滚改动后会失败，能挡住主要回归；但第 683 行的 REVERSE 验证的是改动前就存在的“没有标记就拒绝”，不会因回滚而失败。缺失的检查见第 7 条：SQL→授权集成、真实撤销状态、p1/p12 前缀碰撞、批准后执行、think/schedule 对照。测试文件本次未执行，是否通过“未核实”。

4. **每个新值的使用端都能接受吗？** 逐项核对：
   - `ownerApprovedTask`：产生于 `sqlite-thread-operations.ts:1528-1533/1560-1562`，只被 `owner-scope-authorization.ts:179/260` 消费；接口字段可选，其他 `RunExecutionSource` 读取方会忽略多余字段，能接受。
   - `run_source_owner_approved_task`：在 fact registry 注册且有中英日文字；`assertPolicyFactCodes`、`test/tooling/policy-fact-codes.test.ts` 会检查未注册/未排序；网关契约里 `deterministicFactCodes` 是任意 `machineString`，能接受；控制中心显示原始代码，能接受。唯一问题是本地化标签没有生产 UI 消费（第 3 条）。
   - 规则 revision 2：规则 id 未改名，`rule-ids.frozen.json` 不受影响；拒绝规则不可“先问我”，没有按 revision 命名的长期授权记录；旧的拒绝审计仍保留 revision 1，不需要迁移。能接受。
   - 提议 `effect` 文案：在提议创建时写死进 `owner_proposals.effect`。新提议接受新文案；旧待定/旧已同意提议仍显示旧文案“写入会被直接拒绝”，与上线后的行为不一致（第 5 条）。
   - ADR/架构文档：架构已更新，但 ADR 的 `amends` 为空、撤销描述没有真实代码路径（第 6 条）。
   - 清单/配置键：本次功能提交没有新增清单项或配置键；`3cbd..c66` 里其他 manifest 变化来自基准分支，不属于本 PR。
