本轮查过的范围：先看 `git diff 7ff6d134..3c4eefa5` 的 12 个文件增量，再沿增量里的“事实上报”和“提议状态”追到 `sqlite-thread-operations.ts`、`owner-scope-authorization.ts`、`production-task-proposals.ts`、`production-proposals.ts`、`run-execution-input-service.ts`、`production-run-expiry.ts`、设备动作授权和治理页。测试只做了静态核对，没有运行。

### 1. 中低：新增 `ownerApprovedTask` 进入运行输入快照指纹，部署时在途的旧 task.run 运行会因快照不一致而无法恢复/收尾

文件: `packages/application/src/services/run-execution-input-service.ts:235`、`:250-256`；`apps/agent-service/src/production-run-expiry.ts:62`

问题：`ownerApprovedTask` 是本次新加进 `RunExecutionSource` 的可选字段，但 `run-execution-input.v2` 版本号没变，旧快照里没有这个键。

证据（读代码证实）：

```ts
// run-execution-input-service.ts:235
threadCommandFingerprint(frozen.source) !== threadCommandFingerprint(source)

// run-execution-input-service.ts:250-256
const frozen: FrozenRunInput = {
  version: "run-execution-input.v2",
  startedAt,
  deadlineAt,
  source,
  policy,
};

// production-run-expiry.ts:62
canonicalAuthorizationSnapshot(frozen.source) !== canonicalAuthorizationSnapshot(source)
```

`canonicalAuthorizationSnapshot` 和 `threadCommandFingerprint` 都会把对象的所有键算进去。升级前冻结的 task.run 运行，`source` 里没有 `ownerApprovedTask`；升级后同一个运行读出来是 `ownerApprovedTask: true`（`sqlite-thread-operations.ts:1528-1533,1560-1562`），两边的指纹就不一致。`production-run-expiry` 会抛 `RUN_EXPIRY_INPUT_INVALID`，`#freeze` 会抛 “Run execution snapshot source changed”。

（推测）影响取决于部署时是否真有升级前已冻结、尚未完成收尾的 task.run 运行。task.run 功能在基准提交里已经存在，所以这个窗口不是理论上的；若有，这些运行可能卡在到期结算或恢复路径上。

建议：给 `run-execution-input` 升版本并兼容旧快照；或在比较快照时排除这个可从提议状态重新算出的可选字段；或迁移/补写旧快照。至少要有一条针对旧快照的自动检查。

### 2. 低：ADR 0278 的 `amends` 仍为空，ADR 0257 的事实代码清单也没记新代码，上一轮第 2 条没有完全改好

文件: `docs/adr/0278-tasks-the-owner-agreed-to-ask-before-writing-after-external-content.md:7`；`docs/adr/0257-consequential-tool-calls-go-through-one-authorization-exit.md:1-8`、`:216`

问题：ADR 0278 实际修改了 ADR 0257 决定 3 定义的 `refuseBackgroundAfterExternalContent`，但元数据仍写 `amends: ""`；ADR 0257 也没有反向的 `amended_by`。同时 0257 第 216 行列出的事实代码没有 `run_source_owner_approved_task`。

证据：

```yaml
# ADR 0278:7
amends: ""
```

```yaml
# ADR 0257:6-8
superseded_by: ""
# 没有 amended_by
```

```md
# ADR 0257:216
事实代码 `run_source_user_message`、`run_source_schedule`、`run_source_external_event`、`context_external_content`、...
```

仓库里其他修改旧 ADR 决定的 ADR 都用了双向 `amends`/`amended_by`（例如 0259、0264、0272）。上一轮指出的“撤销”表述问题本身已改好：ADR 决定和后果里不再把“提议被撤销”当真实路径；架构文档改成“它没有撤销”；测试里 `box.undo` 报 `PROPOSAL_NOT_UNDOABLE` 是对真实接口的检查，不是错误说法。

建议：把 `amends` 指向 0257，并在 0257 加 `amended_by`；同时在 0257 的事实代码清单加一句“0278 新增 `run_source_owner_approved_task`”，避免读者按旧清单理解。

### 3. 低：新增的规则说明把“同意过的任务改为弹卡片”写成通用例外，但日历、联系人、家居会在设备动作层直接拒绝

文件: `apps/control-center/src/i18n/resources/zh-CN.ts:884`；`apps/control-center/src/i18n/resources/en.ts:936`；`apps/control-center/src/i18n/resources/ja.ts:942`

问题：增量在 `action_refuse_background_after_external_content` 的说明末尾加了“你同意过的任务除外，改为弹卡片问你”。但设备动作授权层在进入这两条内置规则之前就会直接拒绝一部分设备动作，不会弹卡片。

证据：

```ts
// production-device-action-authorization.ts:59-60
if (!intent.untrustedOriginAllowed && intent.readUntrustedContent)
  return { decision: "deny", reasonCode: "authorization_denied" };
```

```ts
// device-action-registry.ts:503,530,566,604,701
calendar.create  ... untrustedOriginAllowed: false
calendar.delete  ... untrustedOriginAllowed: false
calendar.update  ... untrustedOriginAllowed: false
contact.update   ... untrustedOriginAllowed: false
home.control     ... untrustedOriginAllowed: false
```

ADR 0278 决定 3 已正确写明“这些设备动作到不了这两条规则”；问题只在控制中心这条规则说明的措辞覆盖范围过宽，主人读规则页时可能以为同意过的任务连日历、联系人、家居也会弹卡片。

建议：在规则说明里加限定，例如“对能到这条规则的动作”；或单独说明设备动作授权层仍会直接拒绝哪些动作。

## 侧重检查

- **错误路径**：来源运行不存在、来源凭据为空、提议不是 `task.run`、提议状态不是 `accepted` 时，SQL 的 `EXISTS` 都为假，不会误加标记；task.run 处理方注册为 `kind: "action"`（`production-task-proposals.ts:118-119`），执行失败走 `production-proposals.ts:668-695` 的 `running -> failed`，提议状态仍是 `accepted`，与 ADR 新说法一致；通用测试 `test/integration/owner-proposal-execution.test.ts:249-256` 覆盖了这条路径。发现的错误路径问题是上面的旧快照兼容性。
- **不合规范/不可信输入**：`sourceProofRef` 虽然来自触发记录，但网关 `thread.message.submit` 不暴露 `triggerSource`（`product-thread-gateway-adapter.ts:755` 不传，`sqlite-thread-operations.ts:1103` 默认 `user_message`），所以远程客户端不能靠伪造来源凭据直接拿到 `ownerApprovedTask`；SQL 还要求服务器自己写入的 `task.run` 提议且状态为 `accepted`。
- **安全**：标记不会绕过审批；带标记的运行读到外部内容后由 `askAfterExternalContent` 接手，不命中 `refuse` 规则；设备动作层的拒绝仍在授权前发生。没有新增秘密或提示词内容。
- **资源耗尽**：每次读运行来源都会多一次相关子查询；`owner_proposals` 有 owner/agent/status 索引，短期内没有明显问题。长期看，`accepted` 提议没有清理路径，子查询会随历史提议增长，但目前不构成阻断问题。
- **不可撤销操作**：task.run 仍没有撤销入口，ADR 已如实写明；本改动只把“直接拒绝”改成“问主人”，没有新增绕过人工闸门的不可撤销动作。
- **规则/文档/代码一致性**：治理页确实显示事实代码本身（`governance-control-center.tsx:243-245,356-358` 的 `Values` 直接 `join(", ")`），上一轮第 4 条已改好；设备动作说法与代码一致，上一轮第 5 条已改好；规则说明文案的设备动作覆盖面见第 3 条。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。增量只改 ADR、架构文档、i18n 和测试，没有碰系统提示、工具定义、历史组装、遮盖或压缩；`ownerApprovedTask` 是授权层和内部运行快照里的值，不在发往模型的 `context.trigger` 或提示词目录里。task 运行的第一条消息抬头代码也没改。依据 [prompt-prefix.md:27-29](/tmp/opencode-review-07mwG2/repo/.agents/instructions/prompt-prefix.md:27) 和 [:36](/tmp/opencode-review-07mwG2/repo/.agents/instructions/prompt-prefix.md:36)，仍然是固定内容在前、变化内容只追加在末尾。第 1 条的旧快照问题是运行恢复/收尾的兼容性，不是提示词前缀变化。

2. **会不会让同一段文字在不同请求里变成不同字节？** 不会新增这种不确定性。`ownerApprovedTask` 由数据库里不可变的 `accepted` 提议状态和来源凭据前缀算出；事实代码经 `runtimePolicyFacts` 排序去重；新文案是静态 i18n；没有新增时间、随机数或无序集合。需要注意的只是第 1 条：`ownerApprovedTask` 的有无会改变冻结运行输入的 JSON 字节，这是快照兼容性问题，不是同一段提示词文本在不同请求间被遮成不同字节。

3. **有没有自动检查，反向用例是否真的会失败？** 有。`test/integration/task-proposals.test.ts:184-201` 用真实 `proposeTaskRun` 建待定提议并把来源凭据改指向它，若 SQL 去掉 `status = 'accepted'` 条件，这条会失败；正向 `:186-189` 检查真实同意后带标记。`test/integration/tool-action-registry.test.ts:646-700` 覆盖“同意后没读外部内容可写、读后改为问主人、没有标记仍拒绝”，若 `refuseBackgroundAfterExternalContent` 没排除新事实或没加事实，相应用例会失败。`packages/application/test/policy-fact-registry.unit.test.ts:117-135` 会校验每条内置规则的命中/不命中例子；`test/tooling/policy-fact-codes.test.ts` 会校验事实代码已注册。执行失败后状态保持 `accepted` 由通用测试 `owner-proposal-execution.test.ts:249-256` 覆盖。未覆盖的是第 1 条的旧冻结快照兼容性。未运行测试，以上是静态判断。

4. **每个新值的使用端能不能接受？** 逐个核对如下：
   - `ownerApprovedTask`：生产端在 `sqlite-thread-operations.ts:1528-1533,1560-1562`；使用端是 `owner-scope-authorization.ts:179,260-262`、运行输入快照和到期结算。授权端接受；快照端对旧数据不接受（第 1 条）。
   - `run_source_owner_approved_task`：生产端在 `policy-fact-registry.ts:16,76-82` 和 `owner-scope-authorization.ts:179`；使用端是 `action-rules.ts:249`、规则例子、`assertPolicyFactCodes`、治理页。代码已注册、排序后通过校验，治理页能显示任意代码，没有长度/格式问题；提示词目录里没有这个代码。
   - 规则 `revision: 2` 和新增例子：`policy-fact-registry.unit.test.ts` 和规则注册表测试接受；控制中心规则页的例子数由后端给，不写死。
   - 三语 i18n：三个语言文件改的是同一个 key，能通过现有资源结构；语义覆盖问题见第 3 条。
   - ADR 元数据：`amends` 和 0257 的事实代码清单两端没有接上，见第 2 条。

总体结论：上一轮第 1、4、5 条已按增量核对改好；第 2 条只剩 `amends`/清单未闭合。增量行本身没有发现会改变模型请求开头或引入非确定字节的新错误；最需要作者处理的是旧运行快照与新增可选字段的兼容性。
