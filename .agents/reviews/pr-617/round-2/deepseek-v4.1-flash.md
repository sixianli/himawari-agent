## 复核结论（第 2 轮，增量 d7a63ab..3ebb8a9）

**本轮范围**：重点看了 `production-owner-rules.ts`、`production-quiet-hours-control.ts`、`production-web-push.ts`、`production-http-composition.ts`、`rule-types.ts`、`web-push-gate.ts`、`contracts-v2.ts`、`data-export/rules.ts` 及对应测试；对照了规格 `docs/execution/specs/2026-11-24-main-thread-subthreads-inbox-design.md:339-357` 和 `.agents/instructions/prompt-prefix.md`。未重读整个旧代码库。

### 1. 中高 — 第 1 轮意见 4 没有改好：一条「她的话」读取失败仍会让整个推送 tick 反复失败
- 文件:行：`apps/agent-service/src/production-web-push.ts:616-620`、`:868-876`、`:327-333`；`apps/agent-service/src/service-main.ts:2883-2892`
- 问题：`#deliver` 在逐个处理 due 项时直接 `await contentOf(item)`，`her_words` 分支里 `readMessage(...)` 和 `readText()` 都没有 try/catch。`readPlain` 里的 `unprotect`/解码一旦抛错，整个 `#deliver` 抛出，`tick()` 只把它交给 `onFailure`。这条 outbox 记录没有写 attempt，下一 tick 仍会 due；`listDue` 按 `created_at, source_key` 排序（`sqlite-web-push-operations.ts:363`），它会一直排在前面，阻塞其它推送，直到 24 小时过期。第 1 轮意见 4 仍然成立。
- 证据：
  - `const content = await contentOf(item);`（`:616`，外面无 try）
  - `const text = hidden ? undefined : (await message.readText())?.trim();`（`:875`）
  - `tick(): Promise<void> { this.#running ??= this.#run().catch(this.#options.onFailure)... }`（`:327-333`）
  - `readPlain` 内 `await episodeProtector.unprotect({...})`（`service-main.ts:2886-2892`）可抛
- 建议：把单条内容的构建包在 try/catch 里，失败时 `#record(entry, now, "failed"/"expired", code)` 后 `continue`，不要抛到整个 tick；并补一条“单条解密失败不阻塞其它推送”的反向测试。

### 2. 中高 — 自动给“明写 classes 且含 run_result”的旧规则加上 her_words，与规格和作者自己的说法相反
- 文件:行：`packages/application/src/rules/rule-types.ts:66-73`；规格 `docs/execution/specs/2026-11-24-main-thread-subthreads-inbox-design.md:347`、`:350`
- 问题：`pushQuietClassesOf` 对 `named.includes("run_result") && !named.includes("her_words")` 的规则强行注入 `her_words`。作者材料开头写“已明写 classes 的旧规则不自动加”，规格写“已有的安静时段规则如果明写了 classes，只管它写的那几种，不会自动加上‘她的话’”，并要求测试“一条明写了三种 classes 的旧规则不管‘她的话’”。现在的代码与这两处都相反，等于未经清单确认就改变了主人已有的规则语义。
- 证据：
  ```ts
  const named = parameters.classes;
  if (!named) return PUSH_QUIET_DEFAULT_CLASSES;
  if (!named.includes("run_result") || named.includes("her_words")) return named;
  return PUSH_QUIET_CLASSES.filter((pushClass) =>
    pushClass === "her_words" ? true : named.includes(pushClass),
  );
  ```
  并且第 1 轮的 REVERSE 用例被从 `classes: ["scheduled_reminder", "run_result", "mail_reminder"]` 改成了 `classes: ["scheduled_reminder", "mail_reminder"]`（`test/integration/production-web-push.test.ts:910-921`），正好绕开了规格要求“三种类别也不管她的话”的场景；新加的 `[SAID-2]` 用例（`:892-908`）则把这个行为固化下来。
- 建议：按规格保持“显式写 classes 就只按写的管”，旧规则中由旧生产写库路径写入默认三类的，单独用迁移/一次性清单处理并让 Andy 确认；若坚持现在的语义，就同步修改规格、ADR 和作者交接材料，并把规格要求的 REVERSE 用例恢复。

### 3. 中 — 安静时段的“版本号防并发”不是原子的，两个并发 set 会留下两条生效规则
- 文件:行：`apps/agent-service/src/production-owner-rules.ts:1190-1196`、`:1235-1262`、`:856-939`
- 问题：`setQuietHours` 先读 `quietHours()` 得到 `version`，比较 `expectedVersion` 后，再分别执行 `#activate`（一次 `rules.create` 事务）和逐个 `undo`（各自一次事务）。没有外层事务，也没有把 `expectedVersion` 交给底层做 CAS。两个设备/两个标签页同时提交同一 `expectedVersion` 时会都通过检查，各自创建一条新规则、各自 undo 旧规则，最终两条 active 规则同时存在；`quietHours()` 的 `editable` 要求 `rows.length === 1`（`:1215-1216`），此后通知页再改会一直抛 `RULE_UNAVAILABLE`（`:1238-1239`）。另外若新规则已建、undo 旧规则中途失败，也会留下两条规则且命令报错。
- 证据：
  ```ts
  const current = await this.quietHours();
  if (current.version !== input.expectedVersion)
    throw new OwnerRuleError("RULE_CONFLICT", ...);
  ...
  const receipt = await this.#activate({...}, null);
  for (const { ruleId } of current.rules)
    if (ruleId !== receipt.ruleId) await this.undo(ruleId);
  ```
- 建议：把“校验版本 + 创建新规则 + 退休旧规则”放进同一事务；或为 quiet-hours 设置单独存一行带 `revision` 的记录，写入时做 compare-and-swap；失败时回滚新建的规则。并补并发提交的测试。

### 4. 中低 — 通知页保存会把只静默部分类别的规则扩成四类，并额外静默主人自己定的到点提醒
- 文件:行：`apps/agent-service/src/production-owner-rules.ts:1248-1251`、`:1215-1217`；`packages/application/src/rules/rule-types.ts:54-58`
- 问题：通知页 `setQuietHours` 开启时固定写 `classes: [...PUSH_QUIET_CLASSES]`（四类，含 `scheduled_reminder`），而聊天里“没点名 classes”的默认只有 `mail_reminder`/`run_result`/`her_words`。同时 `editable` 只要求“一条规则、一个每天时段”，不关心它原本写的 classes，所以一条主人只让静默邮件的规则在通知页上仍显示可编辑；只要保存一次就会被替换成四类，连到点提醒也被静默。作者材料说“写的是同一份规则”，但两个入口的默认类别并不相同。
- 证据：
  ```ts
  params: {
    periods: [{ days: [...QUIET_HOURS_DAYS], start: input.start, end: input.end }],
    classes: [...PUSH_QUIET_CLASSES],
  },
  ```
  `PUSH_QUIET_DEFAULT_CLASSES = ["mail_reminder", "run_result", "her_words"]`（`rule-types.ts:54-58`）
- 建议：通知页保存时保留原有 `classes`（或在页面显式让主人选），至少不要把“classes 与通知页默认不一致”的规则标成可编辑；并把这一产品取舍写进规格/说明。

### 5. 低 — 导出的规则文字没有按实际生效类别写，会漏报 her_words
- 文件:行：`packages/persistence-sqlite/src/data-export/rules.ts:177-181`
- 问题：`pushQuietWording` 直接使用存储的 `params.classes`（未写时用 `PUSH_QUIET_DEFAULT_CLASSES`），没有调用 `pushQuietClassesOf`。对于 `classes: ["run_result"]` 的规则，实际执行会管 `her_words`，但导出文字只写“任务完成”。现有导出测试（`test/integration/data-export-rules.test.ts:174-195`）只断言 summary，不检查“推送类别”，因此抓不到。
- 证据：
  ```ts
  const classes = (
    params["classes"] === undefined ? PUSH_QUIET_DEFAULT_CLASSES : strings(params["classes"])
  )
    .map((name) => PUSH_CLASS_LABELS[name] ?? name)
    .join("、");
  ```
- 建议：导出文字改用 `pushQuietClassesOf(params)`；若最终按规格去掉自动注入，这里自然一致，但仍建议统一走同一函数。

### 6. 低 — 规格说“正在看主对话时不弹”，实际是任何控制台标签页可见就压掉
- 文件:行：`apps/control-center/src/web-push.ts:215-233`、`apps/agent-service/src/production-web-push.ts:564`、`:583`
- 问题：心跳只按 `document.visibilityState === "visible"` 上报，不带“当前在主对话”的信息；服务端 `anyVisible()` 因此把“主人开着设置页/记忆页”也当成“正在看主对话”，新加的把 `visible` 提前到安静时段判断之前的逻辑（`:583`）会让这些情况下的「她的话」被直接记为 suppressed、之后也不再补发。规格 `:357` 明确写的是“你正在 App 里看主对话时不响”，并说由 App 自己判断。
- 证据：
  ```ts
  { clientId, visible: input.document.visibilityState === "visible" }
  ```
  ```ts
  const visible = this.#options.presence.anyVisible(now);
  ...
  if (visible) return false;
  ```
- 建议：把“是否正在看主对话”带进心跳（例如 threadId/页面标识），或按规格改为服务端照常发、客户端在主对话前台时抑制展示。

### 7. 低（推测）— 挂起/损坏的安静时段规则会让通知页显示“已开启”但实际不生效
- 文件:行：`apps/agent-service/src/production-owner-rules.ts:1190-1226`、`packages/application/src/rules/rule-book.ts:18-20`
- 问题：`quietHours()` 用 `includeRetired:false` 列出规则，`enabled` 只看是否存在 `push_quiet_hours` 规则；`ruleIsEnforced` 对 `suspended` 返回 false，所以一条 suspended 规则会让页面显示 enabled 但推送闸门不执行。损坏参数时 `quietParams` 返回 undefined，页面仍显示 enabled、`editable:false`，也无法从通知页删除。是否为现实路径（谁能把规则置 suspended/写坏）我未核实。
- 建议：`quietHours()` 只把 `ruleIsEnforced` 的规则算作 enabled/editable，损坏规则给出可修复提示。

---

**侧重检查（错误路径、不可信输入、安全、资源、不可撤销操作、规则/文档一致性）**

- 错误路径：`readMessage`/`readText` 抛错会中断整个 tick（意见 1）；`setQuietHours` 的创建/undo 不是原子操作（意见 3）。
- 不可信输入：`quiet_hours.set` 的 `start`/`end` 由网关 `quietClock`（`contracts-v2.ts:397-403`）和 `setQuietHours` 的 `CLOCK` 双重校验，`start===end` 被拒；`expectedVersion` 只做比较；未发现注入或路径问题。
- 鉴权：`ProductionQuietHoursControl.execute` 检查 `actorType === "owner"` 且 scope 匹配（`production-quiet-hours-control.ts:56-68`），与 `owner.preferences.set` 同构；但没有专门的反向测试验证非 owner/错 scope 被拒。
- 资源耗尽：`herWordsPushKey` 超长走 128 位摘要，长度上限 256，与 outbox/feedback 的 CHECK 一致；`quietHours()` 只列 owner 规则，未见明显放大。重复 set 会创建并归档记忆/规则，但没有请求级限流（与其它设置接口一致）。
- 不可撤销操作：`setQuietHours` 会 retire 旧规则并归档其来源记忆；通知页可重建，但并发/部分失败会留下不可从页面修复的两条规则（意见 3）。
- 规则/文档一致性：意见 2（规格/作者说法 vs 代码）、意见 5（导出文字 vs 实际生效类别）、意见 6（规格“主对话” vs 代码“任意页面可见”）。

**必答问题**

1. **是否改变模型已见过的请求开头？** 本题与推送内容本身无关；但本 PR 改了 `rule_set` 工具定义：`classes` 的 `enum` 增加 `her_words`、`maxItems` 从写死 3 改成 `PUSH_QUIET_CLASSES.length`（`production-owner-rules.ts:335-338`）。这是“去掉说明文字后的参数结构”变化，按 `prompt-prefix.md` 第 6 条，老对话会在下一轮运行开始时换新一次；新对话直接用新定义。仅改说明文字不会触发换新。历史消息、遮盖结果没有被改写；没有把每轮变化的值放进开头。**作者说“老对话会换新一次”结论对，但原因是 enum/maxItems 的结构变化，不是说明文字。**
2. **同一段文字会不会在不同请求里变成不同字节？** 不会。新增的序列化值只有 `said:` 推送编号和 quiet-hours `version`：`herWordsPushKey` 对同一来源固定（SHA-256 确定性），`version` 是对排序后的 `[ruleId, revision, status]` 做 SHA-256（`production-owner-rules.ts:1190-1196`）。`version` 的排序用了 `localeCompare("en")`，在同一部署/ICU 下稳定，跨环境理论上可能不同，但它不进模型请求。推送正文就是原话/固定私密文案，确定性。
3. **有没有对应的自动检查，反向用例真的会失败？** 有：`packages/application/test/her-words-push-key.unit.test.ts`（分隔符碰撞、超长、空段），`rule-type-push-quiet-hours.unit.test.ts`（默认/显式类别、四种、5 类拒绝），`production-web-push.test.ts` 的 SAID-1/2/3（外部事件不推、删除消息不推、sensitive/restricted 不上锁屏、安静时段延后、可见时不补发），`push-channels.test.ts`（APNs + 两张表 kind=reminder），`production-memory-capture.test.ts` 的 SAID-5（读写、版本冲突、多时段只读、非法时间）。**但**：第 1 轮的 tick 失败隔离没有测试；并发 set 没有测试；数据导出文字没有测试；quiet_hours 没有 HTTP 入口/非 owner 鉴权测试；而且规格要求的“明写三种 classes 的旧规则不管她的话”反向用例被改成了不含 run_result 的版本（见意见 2），所以当前反向用例不能证明规格场景会失败。
4. **每个值的使用端都能接受吗？**
   - `said:` 编号：outbox/feedback/decision_ledger/apple push 的 `source_key` 上限均为 1..256，`herWordsPushKey` 保证 ≤256；`kind=reminder` 通过 outbox 与 feedback 的 CHECK；`webPushTopic` 对它做 32 字符哈希作为 tag，无冲突。可用。
   - `her_words` 类别：`PUSH_CLASSES`、`PUSH_QUIET_CLASSES`、工具 schema enum、field-catalog 说明、`PUSH_CLASS_LABELS` 都已接受。但 `data-export` 的文字生成没有用它（意见 5）。
   - `startedBy`/`replyMessageId`：`runs.trigger_id` 为 NOT NULL，`startedBy` 实际不会是 null；SQLite 查询和 `WebPushFinishedRun` 类型一致，`replyMessageId` 为 null 时走旧的“已完成”分支。只有 sqlite 实现和 `production-web-push` 使用，测试覆盖。可用。
   - `quiet_hours.read/snapshot/set`：已加入 `GATEWAY_V2_MESSAGE_TYPES`、`schemasByType`、fixture、`CLIENT_CAPABILITY_TABLE` 和生成的 Swift；snapshot 的 `version ≤64`、`summary ≤200`、时间 `HH:MM` 都能通过契约校验。服务端只在一个 composition 路径注册，未见消费端遗漏（目前也还没有 UI 使用它）。可用。
   - `RULE_CONFLICT`：只在此 control 中产生，映射为 `PORT_CONFLICT`（`production-quiet-hours-control.ts:69-73`），测试期望一致。可用。
