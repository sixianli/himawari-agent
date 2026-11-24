这一轮实际查过的范围：`git diff aeacaddf..c6c300de` 的完整增量（净改动只有规格 `docs/execution/specs/2026-11-24-main-thread-subthreads-inbox-design.md` 和评审记录；评审记录在工作区读不到，`git` 对 `.agents/reviews` 路径返回 `REVIEW_GIT_REFUSED`，未核实）；对照 base `891955719` 读了 ADR 0285、7 份被取代 ADR、0230/0244/0257 的 frontmatter；按规格引用读了推送、规则、收件箱、外部内容标记、迁移、权限相关代码。没有改任何文件。

### 1. 中高：新“她的话”推送没有接入推送内容构造器，按规格字面实现会被当成普通提醒丢弃

文件: `docs/execution/specs/2026-11-24-main-thread-subthreads-inbox-design.md:344-345,353`；`apps/agent-service/src/production-web-push.ts:855-886`；`packages/application/src/ports/web-push.ts:82-89`；`packages/persistence-sqlite/src/sqlite-web-push-operations.ts:710-743`

问题: 规格选择“推送表 `kind` 仍写 `reminder`，用新的编号前缀区分”，但“要改的是”只列了 `PUSH_CLASSES`、`pushClassOf`、安静时段类别和 `rule_set`。`kind=reminder` 的内容构造是按 `sourceKey` 前缀分支的；新前缀没有分支时会落到最后的普通提醒分支，把 `sourceRef` 当提醒编号读，读不到就返回 `expired`，推送永远发不出去。运行完成推送还缺“谁叫起这次运行”和“她回你的原话”这两个值。

证据（读代码证实）:
```ts
855: if (item.kind === "reminder") {
856:   const reminder = await this.#options.reminders.read(item.sourceRef);
857:   if (
858:     !reminder ||
859:     reminder.status !== "scheduled" ||
860:     !item.sourceKey.endsWith(`:${reminder.remindAt}`)
861:   )
862:     return { expired: true };
```
`WebPushFinishedRun` 只有 `runId/threadId/status/resultUnconfirmed/finishedAt/cursor`（`ports/web-push.ts:82-89`），没有触发来源和消息编号；`listFinishedRuns` 只排除 `origin='think'` 的旧线程（`sqlite-web-push-operations.ts:727-728`），新子线程 origin 需要另加过滤。

建议: 在“要改的是”里补：`#content` 的新前缀分支、读取原话的端口/选项、`WebPushFinishedRun` 增加触发来源/消息编号、`listFinishedRuns` 排除新子线程 origin。更稳的做法是把原话的消息编号放进 `sourceRef`，给 `production-web-push.ts` 加一个消息读取入口，而不是靠 `sourceRef` 复用提醒读取。

### 2. 中：新增安静时段类别漏了 prompt catalog 文本、manifest 校验、字段目录和一条现有测试（会直接失败）

文件: `docs/execution/specs/2026-11-24-main-thread-subthreads-inbox-design.md:345`；`packages/prompt-catalog/src/tools.ts:243`；`packages/prompt-catalog/prompt-manifest.json:1313-1316`；`packages/application/src/rules/field-catalog.ts:89-92`；`packages/application/test/rule-type-push-quiet-hours.unit.test.ts:115-125`

问题: 规格只列了 `PUSH_QUIET_CLASSES`、`PUSH_QUIET_DEFAULT_CLASSES` 和 `rule_set` 的 `maxItems: 3`。同一个值的其他使用端没列：`rule_set` 的说明文字把三种类别和默认两种写死了；提示词清单有这条文字的 `sha256`；字段目录的 `push_class` 说明也列了三种；现有测试用“4 个类别”验证超长会被拒，加第四种后不再抛错。

证据（读代码证实）:
- `tools.ts:243`：“classes 可选 run_result（任务完成或失败）、mail_reminder（邮件提醒）、scheduled_reminder（主人自己定的到点提醒），主人没点名就不写 classes（默认只管任务完成和邮件提醒）”
- `prompt-manifest.json:1313-1316` 记录 `tools.rule-set` 的 `sha256`；`prompt-catalog.unit.test.ts:300-318` 要求清单 digest 与当前文字一致，`check:prompt-catalog` 会失败。
- `field-catalog.ts:89-92`：“scheduled_reminder 是主人自己定的到点提醒，run_result 是任务完成或失败，mail_reminder 是邮件主动提醒……”
- 测试 `115-125`：`classes: ["run_result", "mail_reminder", "scheduled_reminder", "run_result"]`，`expect(() => record(...)).toThrow`；`rule-types.ts:276` 是 `rawClasses.length > PUSH_QUIET_CLASSES.length`，加第四种后 `4 > 4` 为假，测试失败。

建议: 把 `tools.ts` 文字、manifest 的 `sha256/changedIn/reason`、`field-catalog` 说明、测试改成 5 个类别；补一条“默认类别包含她的话”的测试；在规格的“要改的是”和自动检查里写明 `npm run check:prompt-catalog` 和 `check:rule-registry`。更好的做法是加一条检查：`rule_set` 说明必须提到 `PUSH_QUIET_CLASSES` 里的每一项，防止文字和枚举再漂移。

### 3. 中：`web_push_outbox`/`web_push_feedback` 要不要重建，规格前后矛盾

文件: `docs/execution/specs/2026-11-24-main-thread-subthreads-inbox-design.md:344` 与 `:602-603`

问题: 同一段先说“下面这些都不用动：……两张表的 CHECK”，紧接着说“新种类不在它的 CHECK 里……两张表都得重建”；“还没核实的事”又说“推送加‘她的话’一种要改 `web_push_outbox`”，并把“推送种类 `web_push_outbox.kind`”列为新值。按已选方案 `kind` 仍写 `reminder`，两张表的 CHECK 都接受 `reminder`，不需要重建。这段会误导编码线程去改冻结表。

证据（读代码证实）:
- `web_push_outbox.kind` CHECK：`kind IN ('reminder','approval','run')`（`0058_web_push.sql:26`）。
- `web_push_feedback.kind` CHECK：`kind IN ('reminder','approval','run')`（`20261114154943_apple_push.sql:93`）。
- `recordAttempt` 写 feedback 时从 outbox 抄 `kind`（`sqlite-web-push-operations.ts:612-617`），`kind=reminder` 能通过。
- 规格 `602` 行说 `web_push_feedback` 在冻结名单里。

建议: 如果坚持 `kind=reminder`，删掉“两张表都得重建”和 `602/603` 的 `web_push_outbox` 改动项，明确写“两张表都不改、无需迁移”；如果要单独的开关，再把新 kind 和重建写清楚。不要把两种方案混在一段里。

### 4. 中：20 件上限没有按“一类来源”分组，可能把主人消息和外来事件塞进同一次运行

文件: `docs/execution/specs/2026-11-24-main-thread-subthreads-inbox-design.md:262-264`

问题: “一次运行最多带 20 件事，按到达先后取”没有说先按来源类别过滤；下一条又说“一次运行只处理一类来源”。同一个对话里如果同时有 25 件主人消息和外来事件，按到达先后取 20 件可能混类，违反权限边界。测试“攒了 25 件”也没写类别。

证据（读代码证实）: 规格 `264` 行自己写了原因：“规则按‘这次运行是谁叫起来的’判断能不能写（`action-rules.ts:41-51` 的 `run_source`，只有一个值）……混在一起，要么邮件里的话借你的来源拿到写权限，要么你的话被当成外来的拿不到权限。”

建议: 把上限写成“先按对话和来源类别分组，每组按到达先后取最多 20 件”，测试也按同一类别写 25 件。

### 5. 中：去掉排队/每天上限和过期后，收件箱积压没有上界

文件: `docs/execution/specs/2026-11-24-main-thread-subthreads-inbox-design.md:98,257,262`

问题: 只加了“一次运行最多 20 件”，这只限制一次运行的上下文，不限制收件箱积压。规格同时去掉了排队上限、每天上限和过期，且这次增量删掉了上一轮“还没核实的事”里“花费上限只停花钱，不停积压”的提醒。外部事件持续进来时，表和磁盘可以无界增长，工人也可能永远追不上。

证据（读代码证实）: 规格 `257` 行“收件箱现有的排队上限、每天上限、排久了自动作废（`expired`）都去掉”；`262` 行只写了每次运行 20 件；`98` 行“收件箱不设排队和每天上限”。上一轮那条 unchecked 在本次 diff 中被删。

建议: 明确积压的上界或背压（例如总量/磁盘水位告警、超过阈值停止接收并告诉 Andy、或按来源丢弃策略），至少把删掉的“积压没有上界”风险写回 unchecked。

### 6. 中：ADR 0285 说“推不推她定”，规格新增“她回你的话自动推”，ADR 没同步

文件: `docs/adr/0285-one-main-thread-subthreads-and-one-inbox.md:40`；`docs/execution/specs/2026-11-24-main-thread-subthreads-inbox-design.md:337,339,353`

问题: ADR 决定 6 写“她说的话是聊天消息，推不推她定”；规格 `337/339` 也写“推不推到手机，由她定”“要不要推由她决定”。但增量第 `353` 行改成“主对话里你的消息叫起的运行……推她回你的那句话……你正在 App 里看主对话时不响”，这是程序按前台状态决定推不推，不是她决定。ADR 没有 amend。

证据（读代码证实）: ADR 0285:40、规格 339 行、规格 353 行的原文如上。

建议: 在 ADR 0285 决定 6 和规格 339 行区分两条路：用“告诉主人”说的话由她决定推不推；主人消息的回复按 Andy 22:35 的决定自动推、受安静时段管、App 前台不弹。或者明确这条新决定覆盖“推不推她定”。

### 7. 中低：新前缀与去重键的拼法没对齐，按字面实现会让 `pushClassOf` 返回 `unknown`（绕过安静时段）

文件: `docs/execution/specs/2026-11-24-main-thread-subthreads-inbox-design.md:344,349`；`packages/application/src/services/web-push-gate.ts:18-23,34-40`

问题: 分类靠 `sourceKey` 前缀；去重键却写成“来源种类 + 来源编号 + 版本”。如果一封邮件引起的“她的话”推送用来源种类 `mail` 拼键，键以 `mail:` 开头，`pushClassOf` 认不出，返回 `unknown`；`unknown` 在 `PUSH_RULE_PROTECTED_CLASSES` 里，会直接推出、绕过安静时段。规格没写“拼出来的键必须以新前缀开头”，也没写分隔符转义/冲突处理。

证据（读代码证实）:
```ts
18: export const PUSH_RULE_PROTECTED_CLASSES = Object.freeze([
19:   "approval",
20:   "muse_outage",
21:   "proposal",
22:   "unknown",
23: ]);
...
34: if (input.kind === "reminder") {
35:   if (input.sourceKey.startsWith("muse-channel:")) return "muse_outage";
36:   if (input.sourceKey.startsWith("proactive:")) return "mail_reminder";
37:   if (input.sourceKey.startsWith("proposal:")) return "proposal";
38:   if (input.sourceKey.startsWith("reminder:")) return "scheduled_reminder";
39: }
40: return "unknown";
```

建议: 明确 `sourceKey` 的格式，保证它以一个固定的新前缀开头（例如 `himawari:<来源种类>:<来源编号>:<版本>`，或新前缀本身就是来源种类）；规定分隔符的转义或使用长度前缀；加反向测试：邮件引起的“她的话”推送在安静时段被延后。更好的做法是给不在冻结名单里的 `web_push_outbox` 加一个显式的 `push_class` 列，分类不再靠前缀解析，去重键就可以自由拼。

### 8. 低：迁移/改名清单漏了 `think_settings` 和 `enqueue` 里的 `day/queueLimit/dailyLimit`

文件: `docs/execution/specs/2026-11-24-main-thread-subthreads-inbox-design.md:241-245`；`packages/persistence-sqlite/src/migrations/20261115033014_think_settings.sql:1-8`；`packages/application/src/ports/think-inbox.ts:48-60`；`packages/persistence-sqlite/src/schema-catalog.ts:806-819`；`packages/application/src/ports/configuration.ts:420-421`

问题: 设计去掉 `day` 列、排队上限和每天上限，但迁移/改名表只写了 `think_inbox`、`think_inbox_declined` 和“代码里的 ThinkInbox 名字”。`think_settings` 表、`enqueue` 的 `day/queueLimit/dailyLimit` 入参、配置键 `queueLimit/dailyLimit` 及其测试仍是这些值的直接使用端。

证据（读代码证实）: `think_settings` 表存在（`20261115033014_think_settings.sql:1-8`）；`schema-catalog.ts:806-819` 描述它存“queue limit … confidence”；`ports/think-inbox.ts:48-60` 的 `enqueue` 入参有 `day`、`queueLimit`、`dailyLimit`；`configuration.ts:420-421` 定义这两个键。

建议: 在迁移/改名清单里加上 `think_settings`（改名或删）、`enqueue` 入参、配置键和对应测试；在“编码时要逐个核对的新值”里列出“删掉的键还有哪些读它的地方”。

### 9. 低：外部内容标记“第一封邮件后主对话一直带着”依赖至少一次授权，纯回复运行不会打标记

文件: `docs/execution/specs/2026-11-24-main-thread-subthreads-inbox-design.md:416-420`；`apps/agent-service/src/owner-scope-authorization.ts:177,255-265`；`apps/agent-service/src/context-external-content.ts:193-196`

问题: 规格说“第一封邮件叫起主对话的运行之后，主对话就一直带着标记”。但现有代码只在授权时 `#externalSources` 里 `marks.mark(...)`；如果那封邮件叫起的运行只回复、没有调用需要授权的工具，标记不会写，后面同一主对话的运行也不会带标记。规格自己也说“在授权时自动打上”，两句不完全一致。

证据（读代码证实）: `authorize` 第 `177` 行调用 `#externalSources`；`#externalSources` 第 `262` 行 `if (eventIsExternal) await marks.mark(invocation.runId, "external_event")`；`mark` 第 `194` 行写第一项（对话）scope。

建议: 要么在外部事件运行开始时无条件打标记，要么把后果句改成“只要那次运行调用过需要授权的工具，主对话之后就一直带着标记”，并加一条纯回复邮件的测试。

### 10. 低：`context-external-content.ts:100-104` 行号偏一行

文件: `docs/execution/specs/2026-11-24-main-thread-subthreads-inbox-design.md:416`；`apps/agent-service/src/context-external-content.ts:101-105`

问题: 规格引用 `:100-104`，实际的 `externalContentKey` 是 `101-105`。不影响结论，但编码线程按行号找会差一行。

证据（读代码证实）: `101: export function externalContentKey(scope: ExternalContentScope): string {` 到 `105: }`。

建议: 改成 `:101-105`。

---

**上一轮意见核对（只按增量核对）**

- 1（中高，标记按一次运行记）: 已改好。新文字说按对话记，`externalContentKey` 用 `thread:`、`mark` 写第一项 scope，与代码一致；只有行号 `:100-104` 偏一行（见第 10 条）。
- 2（中高，rule_set 工具定义 + maxItems: 3）: 部分改好。`maxItems: 3` 和工具定义换新已写；但仍漏了 `tools.ts` 说明文字、prompt-manifest sha256、field-catalog 说明和会直接失败的现有测试（见第 2 条）。
- 4（中高，新推送种类漏类型联合/控制台/账号开关）: 部分改好。改用 `kind=reminder` 后，`WebPushKind`、`pushKindSchema`、控制台 `WEB_PUSH_KINDS`、写入校验、账号开关、两张表 CHECK 确实都不用动（读代码证实）；但新前缀的内容构造、运行完成推送的端口/SQL、去重键拼法没补齐（见第 1、7 条），且留下了“两张表都得重建”的矛盾文字（见第 3 条）。
- 5（低，删 `day` 前先删 `think_inbox_day`）: 已改好。新文字明确先删 `think_inbox_queue` 和 `think_inbox_day`，再删 `day`、改表名；`20261115004401_think_inbox.sql:19-20` 与描述一致。
- 6（低，作者说明漏 ADR 0257 被 amend）: 仓库内已一致。ADR 0285 的 `amends` 列了 0257，`0257` 的 frontmatter 有 `amended_by`；作者说明是否同步修改无法从仓库核实。
- 7（低，冻结规则改成不再命中没提例子和 check）: 已改好。规格现在写了 `action-rules.ts:255` 起的例子和 `npm run check:rule-registry`，`rule-book.ts:16` 的 `retired` 也存在。
- 8（低，失败重试没有反向测试）: 已改好。规格 `273` 行写了 `runs.trigger_id` 唯一（`0001_initial_product_schema.sql:147`）和失败后换新 `triggers`/运行，`494` 行加了反向用例。
- 9（低，推测，已有规则显式写 `classes` 不会管“她的话”）: 已确认并写进规格。`rule-types.ts:270-282` 只有没写 `classes` 才用默认清单；规格也要求上线前检查现有规则。

---

**侧重检查**

- 错误路径: 推送内容构造器对新前缀落到普通提醒分支返回 `expired`（第 1 条）；`pushClassOf` 对未知前缀返回 `unknown`，而 `unknown` 是受保护类别（第 7 条）；安静时段类别长度校验 `rawClasses.length > PUSH_QUIET_CLASSES.length` 会让现有测试在加第四类后失败（第 2 条）；失败重试的 `runs.trigger_id` 唯一约束与 `triggers` 的幂等键已核对，规格的修法可行（`0001_initial_product_schema.sql:138,147`）。
- 不合规范或不可信输入: `source_key` 允许 1–256、来源编号和版本各可到 256，拼键超长要截断加摘要，规格已提；但分隔符转义、前缀归属、同一到达时间的 tie-break 没定死（第 7 条）。`decision_ledger.scenario` 只允许小写 `[a-z0-9_]`（`20261114172143_proactive_source_registry.sql:24-26`），规格用中文描述来源，编码时必须落成小写名字。
- 安全: 外部内容标记按对话记，主对话会长期带着标记，这是更保守的方向；但纯回复运行可能不打标记（第 9 条）。20 件上限可能混类，直接触碰“一次运行只处理一类来源”的权限边界（第 4 条）。未知推送类别会绕过安静时段（第 7 条）。
- 资源耗尽: 去掉排队/每天上限和过期后，只有每次运行 20 件的上下文上限，没有积压/磁盘上限（第 5 条）。推送内容改成她回你的原话后，长回复的推送载荷长度、APNs/Web Push 上限和截断策略规格没写，属于未核实风险。
- 不可撤销操作: 迁移要删 `day` 列、两个索引和 `think_inbox_declined` 表，并改表名；规格已写清顺序，但迁移不可逆，回退要靠快照。`web_push_feedback` 在冻结名单里，按现方案不应改；第 3 条的矛盾文字有让编码线程去重建冻结表的危险。ADR 0285 取代 7 份 ADR、修改 3 份，frontmatter 双向关系已核对一致；被取代 ADR 的选择本轮没有重读正文，只核对了元数据。
- 规则、说明文档和代码一致: 发现 ADR 0285 决定 6 与规格 353 行的自动推送不一致（第 6 条）；规格 344 行内部对两张表是否重建自相矛盾，且与 602/603 行不一致（第 3 条）；`rule_set` 说明文字、manifest、field-catalog 会与新类别不一致（第 2 条）；行号 `:100-104` 偏一行（第 10 条）。

---

**必答问题**

1. **会不会改变模型已经见过的请求开头？** 本 PR 只有文档，不改代码。设计本身要求只在末尾追加：状态板只放本次最后一条消息，收件箱事件作为新消息追加，选项是之后的工具调用/消息，感知内容只作为 `perception_read` 的工具结果；会变的时间、进度、事件编号都放最后一条。外部内容标记、推送、App 前台判断都不进请求。唯一会让开头变的是工具定义：`rule_set` 的 `maxItems: 3→4` 属于“去掉说明文字后的参数结构”变化，新增“给选项”“开子线程”等工具也改变工具集合。规格已按 `prompt-prefix.md` 第 6 条要求换新一次，并说第 1 步旧对话全删；如果实现时旧对话没删，就必须换新一次，否则违反“按对话冻结”。压缩和清理是规则第 12/14 条留出的例外。结论：设计不违反“只追加”，前提是工具定义变更按第 6 条处理。

2. **会不会让同一段文字在不同请求里变成不同的字节？** 设计已固定状态板排序、事件编号、时间格式、来源排序；新推送去重键也写了固定顺序和分隔符。仍有三处没定死：同一到达时间的批次排序（`created_at` 相同怎么 tie-break）、去重键分隔符在来源编号/版本里出现时怎么转义、以及新前缀与“来源种类+编号+版本”的拼法（第 7 条）。这三处定死前，不能保证同样内容每次字节相同。

3. **有没有对应的自动检查，反向用例是否真的会失败？** 本 PR 没有代码，所以没有针对设计断言的自动检查；规格里的反向用例（包括新增的失败重试）都还是文字，不是可运行的测试。现有 `check:rule-registry`、`check:prompt-catalog`、`check:prompt-prefix` 会在实现时抓到一部分回归，但规格的“要改的是”漏了 `check:prompt-catalog` 和会直接失败的 `rule-type-push-quiet-hours.unit.test.ts:115`。文档类检查（`docs-links`、`adr-numbers`、`markdown-tables` 等）不验证代码说法。

4. **每个值的使用端都能接受吗？**
   - 新安静时段类别: `PUSH_CLASSES`/`pushClassOf`/`PUSH_QUIET_CLASSES`/`PUSH_QUIET_DEFAULT_CLASSES`/`rule_set maxItems` 已列；漏了 `tools.ts` 文字、`prompt-manifest` sha256、`field-catalog` 说明、现有测试（第 2 条）。
   - 新推送前缀 + `kind=reminder`: `WebPushKind`、gateway `pushKindSchema`、控制台 `WEB_PUSH_KINDS`、写入校验、账号开关、两张表 CHECK 都接受（读代码证实）；但 `#content`、`#collect`、`WebPushFinishedRun`、`listFinishedRuns` 没列（第 1 条），去重键前缀没对齐（第 7 条）。
   - 新收件箱列/结局: `status` 列只限长度，`finish` 只收 `proposed/skipped/failed`（`sqlite-think-inbox-operations.ts:261`），规格的 unchecked 已提；`think_settings`、`enqueue` 的 `day/queueLimit/dailyLimit` 没提（第 8 条）。
   - `decision_ledger` 的 `verdict` `pushed/silent/deferred/failed`: 读代码证实 CHECK 已允许（`20261114172143_proactive_source_registry.sql:32`），`proactive` 的 `outcome` 必须为空（`:63`），`scenario` 允许小写（`:24-26`）；这部分安全。
   - `threads.origin` 的“子线程”: 该列没有 CHECK（`20261115045512_thread_origin.sql:1`），数据库接受；消费端（起标题、到期删除、列表、导出）规格已列在 unchecked。
   - 新“20 件”配置键: 规格只说“可以改”，没写键名、默认值、严格配置解析器和测试的使用端。
