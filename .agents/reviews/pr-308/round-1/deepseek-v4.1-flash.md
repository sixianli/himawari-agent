## 复核结论

改动本身没有修改模型请求的字节、没有新增迁移，也没有留下对已删结果码的代码引用；历史上的账本行和拦截记录行仍能被类型、SQL 约束、网关合同和页面读取。主要问题在文档侧：新 ADR 没有把“密码/密钥进入推送正文”写成已知缺口，另有一份状态为 active 的搜索验收说明仍写着“拒绝机器秘密”，与代码不符。

---

## 发现（按严重度）

### 1. 中｜`docs/adr/0183-...md:69-70`、`apps/agent-service/src/production-web-push.ts:485-498`
**问题：** ADR 0183 的“后果/已知缺口”没有覆盖“密码、密钥会出现在 Web Push 正文（锁屏通知）”这条路径；而代码只对 `sensitive`/`restricted` 隐藏正文，密码/密钥不会把分类提到 sensitive。

**读代码证实：**

`apps/agent-service/src/production-web-push.ts:486-498`：
```ts
const hidden =
  memory.dataClassification === "sensitive" || memory.dataClassification === "restricted";
const text = hidden
  ? undefined
  : (await this.#options.readMemoryText(memory))?.replace(/\s+/gu, " ").trim();
...
body: hidden
  ? WEB_PUSH_TEXT[locale].privateReminder
  : `${text}\n${this.#formatTime(reminder.dueAt, locale)}`,
```

`packages/sensitive-capture/src/identifiers.ts:8-15` 只会把“证件号/卡号”一类的长数字提到 sensitive：
```ts
return (classification === "private" || classification === "public") &&
  containsRestrictedIdentifier(text)
  ? "sensitive"
  : classification;
```

`apps/agent-service/src/production-reminder-writer.ts:199-206`：
```ts
dataClassification: classificationWithIdentifiers(text, "private"),
```

`packages/platform-node/src/web-push-sender.ts:52-70` 直接把 payload 发到订阅 endpoint，没有经过出口遮盖：
```ts
const details = webPush.generateRequestDetails(..., request.payload, ...);
...
const response = await send(details.endpoint, { method: details.method, ... });
```

而 ADR 0183 只写了：
- `:69` “主人的数据库里会有密码、密钥的明文拷贝……推送正文是否显示取决于记忆分类。”
- `:70` 已知缺口只列了密码规则边界、置顶、导入分类、`explicit`，没有列推送正文。

**推测/需确认：** 实际触发需要一条引用了含密码/密钥文本的记忆的提醒（模型提议或主人手动建提醒都可能）；触发后正文会原样进入推送通知。是否为“外部服务”按 ADR 的定义可能有争议，但通知正文会显示在锁屏上，且 Andy 的拍板里专门提到“推送通知不显示正文”，因此应至少明确写成已知缺口。

**建议：** 在 ADR 0183 的“后果/已知缺口”补一条：密码/密钥不会把分类提到 sensitive，含这些内容的提醒/记忆在推送正文中可能原样显示；若要兑现“只在数据发往外部时遮盖”的原则，需要把推送正文也纳入遮盖/抑制，或把密码/密钥检测加到分类提升规则。另把 `:69` 的“记忆分类”改成代码实际检查的“数据分级（`dataClassification`）”。

---

### 2. 低｜`docs/execution/specs/2026-09-10-control-center-local-acceptance-design.md:47`
**问题：** 该文档仍写搜索“拒绝机器秘密”，与现在的代码和本 PR 三语文案“先遮盖再发出”不一致。文档 frontmatter 仍是 `status: active`。

**读代码证实：**

`docs/execution/specs/2026-09-10-control-center-local-acceptance-design.md:47`：
```md
搜索适配实现……查询限制长度与结果数量、拒绝机器秘密；披露审批明确包含 Exa 与本轮模型。
```

实际代码：

`packages/platform-node/src/exa-public-search.ts:216`：
```ts
const query = redactForExternalText(input.query.trim()).text;
```

`packages/platform-node/src/deepseek-web-provider.ts:71`：
```ts
const query = redactForExternalText(input.query.trim()).text;
```

**建议：** 把该句改为“查询先遮盖再发出”，或加注指向 ADR 0183。该文档不在提交信息列出的“Docs deferred”清单里，容易漏掉。

---

### 3. 低（措辞精度）｜`docs/adr/0183-...md:46-48`
**问题：** “内部存储……都存主人或模型实际写出的原文”与紧接着的决定第 3 条“写库前还原占位符”存在措辞张力。记忆候选和对话标题并不是模型逐字写出的文本，而是按提示重建对照表后还原过的文本。

**读代码证实：** 决定第 3 条描述的行为确实存在：
- `apps/agent-service/src/production-memory-capture.ts:833-850` 建 `placeholderTable` 后作为 `restore` 传给解析；
- `apps/agent-service/src/production-thread-titles.ts:89-93` 用 `placeholderTable(prompt, ...)` 还原标题。

**建议：** 把第 1 条的“都存……原文”限定为“不整段丢弃/拒绝”，并明确“记忆候选和标题在写库前按第 3 条还原”。这不是功能缺陷，只是 ADR 容易被读成“原样落库”。

---

## 读代码证实的其余核对

- 全仓已无 `source_secret_excluded`、`candidate_secret_excluded`、`reportMemoryAudit`、`MEMORY_EXCLUSIONS`、`memoryCategory` 的代码引用；只剩 ADR 0143/0166/0183 中的历史说明。
- `AutomaticMemoryResult.status` 只剩 `"completed" | "extraction_failed"`，生产代码没有消费其他取值。
- 审计记录不落库：`onAudit` 最终走 `writeServiceDiagnostic`（`packages/platform-node/src/service-runtime.ts:67-73`），只写 stderr 并做机器密钥遮盖，因此不存在“审计表 outcome CHECK”问题。
- 决策账本的 `outcome` CHECK 只约束 `kept/discarded/pending_approval`（`packages/persistence-sqlite/src/migrations/0069_decision_ledger.sql:50`）；两个被删的值原本是 `reason_code`，该列是 `TEXT NOT NULL CHECK (length(reason_code) BETWEEN 1 AND 64)`（同文件 `:19`），历史行不受影响；读取类型 `DecisionLedgerEntry.reasonCode` 也是 `string`（`packages/application/src/ports/decision-ledger.ts:117`）。
- 拦截记录的历史 `memory_candidate`/`memory_source` 仍完整保留：`packages/application/src/ports/sensitive-interceptions.ts:23-24`、迁移 `0078_sensitive_interceptions.sql:10-14`、网关合同 `packages/gateway-contracts/src/contracts-v2.ts:693-694`；`not_saved` 也仍在 `:35`、SQL `:20`、合同 `:703`。页面 i18n 的三语键都在。
- 历史记忆行仍被自动测试覆盖：`test/integration/sensitive-interceptions-browser.test.ts:184-196` 会找“这条记忆没有保存”的行并检查 `data-tone="warning"`，fixture 里就是 `part: "memory_candidate"`、`outcome: "not_saved"`（`test/e2e/fixtures/control-center-browser-server.mjs:594-601`）。

**未核实：** 没有运行 `npm run check:prompt-prefix`、`npm run check:egress-redaction` 或测试套件；只按代码和测试源码判断。ADR 0183 列出的“Muse 收件、沙箱诊断、对话检查点、反思、执行动态、模型流式输出落库”没有逐条读写库路径，只做了全仓函数调用搜索，未逐项确认。

---

## 侧重检查

- **错误路径：** 删除的是 `onAudit` 里的本地记录调用；两个回调仍保留 `writeServiceDiagnostic`，不会新增异常路径。`SensitiveInterceptionRecorder` 的写入失败/队列上限逻辑未被改动。
- **不合规范或不可信输入：** 搜索词仍先经过 `redactForExternalText` 再限长/发出（`exa-public-search.ts:216-224`、`deepseek-web-provider.ts:70-75`）；本 PR 只改文案。网页手动提醒仍经过 `classificationWithIdentifiers`。没有新增输入解析。
- **安全：** 出口遮盖、搜索遮盖、记忆/标题占位符还原均未改动；发现的问题是 ADR 未披露的推送正文路径，不是本 PR 新写的漏洞。
- **资源耗尽：** 删除 `reportMemoryAudit` 后不再为记忆审计排队，队列压力只会下降；没有新增无界循环或缓存。没有新增迁移或不可撤销操作。
- **规则/文档一致性：** ADR 0183 与代码主体一致；发现的第 1、2、3 条是文档覆盖/措辞问题。ADR 0143、0148、0166、0167 的改动均为追加说明，没有改写原决定内容。

---

## 必答问题

**1. 这个改动会不会改变模型已经见过的请求开头？**

不会。diff 只涉及 ADR/文案、两个 `onAudit` 回调里的本地记录调用、审计类型和测试；没有改任何组装系统提示、工具定义、历史消息或出口遮盖的文件。被删的两处调用在 `apps/agent-service/src/service-main.ts:1943-1951` 和 `:2032-2040` 的 `onAudit` 诊断回调里，只写本地诊断，不参与模型请求。因此“发给模型的内容只在末尾追加、每轮会变的值都在最后一条消息里”的性质未被本 PR 改变。依据：[prompt-prefix.md#rules](.claude/rules/prompt-prefix.md#rules)。未实际运行 `check:prompt-prefix`，以上按 diff 判定。

**2. 同一段文字会不会在不同请求里变成不同的字节？**

不会。本 PR 没有改遮盖/序列化/排序逻辑；`reportMemoryAudit` 里的 `sha256` 摘要只用于拦截记录的本地去重，不进入模型请求。三语 `chat.search.sentLimits` 只用于控制中心界面，不发给模型。ADR 0183 只是文档。没有新增依赖上下文、时间或无序集合的字节生成。

**3. 改动有没有对应的自动检查，反向用例是否真的会失败？**

- 类型层面：删除联合成员、`AutomaticMemoryResult.status` 取值和 `reportMemoryAudit` 方法后，任何残留引用都会让 TypeScript 编译失败（本 PR 已无残留，grep 确认）。
- 存储侧“不再整段拦下”：`check:egress-redaction` 会对未登记的整段拦下调用报错（`scripts/check-egress-redaction.mjs:283-299`），并对 Exa/DeepSeek 等外部出口强制要求 `redactForExternalText`（`:187-195`）。相关行为测试仍在：`packages/application/test/memory-credential-storage.unit.test.ts:70-89` 正向验证密码/密钥照原样存储，`:91-99` 反向验证模型标 restricted 的候选仍被丢弃。
- 历史行显示：`test/integration/sensitive-interceptions-browser.test.ts:184-196` 正向覆盖 `memory_candidate` + `not_saved` 的历史行仍显示、筛选计数仍为 1。
- 搜索遮盖：`packages/platform-node/test/exa-mcp-transport.unit.test.ts:334`、`packages/platform-node/test/deepseek-web-provider.unit.test.ts:79` 覆盖外部服务收到的是遮盖后的查询。
- 缺口：没有自动检查把三语 `chat.search.sentLimits` 文案和搜索代码行为绑定；两个结果码的删除只有编译期检查，没有专门的运行时反向用例。第 1 条发现（推送正文）也没有测试。

**4. 改动产生或修改的每个值，每个使用它的地方都能接受吗？**

逐个核对结果：

- 删除的 `source_secret_excluded`/`candidate_secret_excluded`：全仓无代码引用；`MemoryExtractionAuditRecord` 不落库；账本里它们作为 `reason_code`（自由字符串，长度 1–64）出现，`outcome` CHECK 不受影响，历史行可读。
- 删除的 `AutomaticMemoryResult.status` 取值：无生产者、无消费者，生产调用方忽略返回值。
- 删除的 `reportMemoryAudit`/`MEMORY_EXCLUSIONS`/`memoryCategory`：无残留引用。
- 拦截记录的 `memory_candidate`/`memory_source`：应用类型、SQL CHECK、网关合同枚举、三语 i18n 都仍接受；`not_saved` outcome 也仍被四处接受，历史行可正常读出并显示。
- 三语 `chat.search.sentLimits`：键名未变，`message-ids.ts` 未变，唯一使用点 `apps/control-center/src/components/search-authorization-control.tsx:116` 无需改参数；三种语言均已更新。
- 测试里把 `candidate_secret_excluded` 改成 `restricted_excluded`：账本 `reasonCode` 接受任意 1–64 字符字符串，`daily-review` 只看 `outcome`/`contentRef`，该测试的 `secret-1` 仍是 `contentRef: null`，因此 `textHidden` 期望不变。
- 新增 ADR 0183：引用的 ADR、`docs/prd-v0.2.md`、`docs/product-vision.md`、`test/fixtures/v0.2/coverage-manifest.json` 和四个代码文件均存在；frontmatter 与相邻 ADR 一致。
