## 读代码证实的结论

### 1.（中）账本把“没有交给模型的旧邮件”也记成已交给模型
`packages/application/src/services/proactive-mail-check-service.ts:679` 在进入分批和每日费用上限检查**之前**就对全部候选邮件做了 `#related`，并在 `:540-544` 把所有候选的旧邮件写进 `trace.relatedByMail`；`:1186-1189` 无条件写进账本。但每日上限在 `:699-706` 直接 `break`，后面的候选根本没有进入模型：

```ts
const relatedViews = await this.#related(token, candidates, controller.signal, trace); // :679
...
if (spentToday + costMicros + estimate > this.#options.limits.dailyCostMicros) {
  stop = "capped_daily"; break;                                                    // :699-701
}
...
relatedByMail: Object.fromEntries(trace.relatedByMail),                             // :1186
```

而 `#judge` 里 `sourceIds` 只加真正送进这一批的邮件（`:962`）。ADR 0180 第 44 行说 `relatedByMail` 是“每封邮件**实际交给模型**的旧邮件编号”，`relatedStats` 是“交给模型的旧邮件封数和字数”。在 capped/中途失败时这句话不成立，账本会高估实际发送范围。建议把 `relatedByMail`/`relatedStats.messages`/`characters` 的累加移到实际组 prompt 的批次里（像 `memoryByMail` 那样），或明确改称“已准备/已读取”，并补一条 capped 场景的反向测试。

### 2.（中）现有账本集成测试没有同步更新，按代码推断会失败
`packages/persistence-sqlite/src/sqlite-decision-ledger-operations.ts:175-192` 现在**无条件**给每条 `inputs` 补四个新字段：

```ts
relatedByMail: Object.freeze(Object.fromEntries(...)),
relatedRead: inputs.relatedRead ?? "off",
relatedStats: Object.freeze(inputs.relatedStats ?? { ... }),
relatedFailedSteps: Object.freeze([...(inputs.relatedFailedSteps ?? [])]),
```

但 `test/integration/decision-ledger.test.ts:195-223` 仍用 `toEqual` 期望旧形状（到 `memoryRecall: "off"` 为止）。按代码推断这条测试会因多出四个字段而失败；我未运行测试（本次只能用 git 命令），但这是确定性差异。作者“第 0 层 942 条通过”的说法若包含该文件则不成立；请更新期望值。

### 3.（中）`#related` 没有独立的时间预算，可能挤掉模型判断
`#recall` 传了 `deadlineAt`（`:680`），新加的 `#related` 只传 `controller.signal`（`:679`、签名 `:498-503`）。`findRelatedMail` 只在每封邮件开头检查 `signal.aborted`（`packages/platform-node/src/gmail-related.ts:101-105`），没有基于耗时的提前收手：

```ts
for (const item of items) {
  if (signal.aborted) { failed.set(item.messageId, "timeout"); continue; }
```

`run()` 的定时器到 `perCheckMs` 才整体 abort（`:573-574`）。真实 Gmail 慢或线程很大时，前情读取可能吃掉整个检查时间，导致这一轮完全没有模型判断；若消息一直未被处理，下一轮会重复读取、重复超时。建议把 `deadlineAt` 传进 `#related`，在每封/每次请求前检查“剩余时间不足就停止并记 partial/timeout”。

### 4.（中低）`sourceIds` 的既有定义被悄悄扩大，但字段没有同步
ADR 0147 第 42 行把 `sourceIds` 定义为“真正放进过提示词的邮件编号”。现在旧邮件也进了提示词，却只记在 `relatedByMail`，`sourceIds` 仍只有本批顶层邮件（`:962`、`:1179`）。任何按 ADR 0147 用 `sourceIds` 判断“哪些邮件内容被发出去”的消费者会漏掉所有前情邮件。建议要么把前情 id 也并入一个明确的“全部送入模型邮件 id”字段，要么更新 ADR 0147 并说明 `sourceIds` 只指“被判断的顶层邮件”。

### 5.（低）404/找不到被当成“没有前情”，不会告诉模型“前情可能不全”
`packages/platform-node/src/gmail-source.ts:258`、`271`、`281`、`288` 对 404 返回 `undefined`；`gmail-related.ts:113`、`:120` 用 `?? []` 当成空结果：

```ts
for (const message of (await transport.thread(item.threadId)) ?? []) { ... }
const ids = await search(...);  // search 内部 (await transport.search(...)) ?? []
```

如果线程确实存在但读不到，或 `messages.list` 返回 404，`failed` 不会记录，`relatedRead` 仍是 `ok`，模型看不到 `relatedUnavailable`，与“读不全时告诉模型前情可能不全”的目标不一致。建议“已知应存在但返回 undefined”按失败处理，只有明确“确实没有”才当空。

### 6.（低）`relatedCharactersPerMail` 不是硬上限
`packages/application/src/services/proactive-mail-check-service.ts:273-276`：

```ts
const size = JSON.stringify(json).length;
if (chosen.length > 0 && total + size > limits.charactersPerMail) break;
```

第一封（最新一封）无论多大都会被加入，实际可以超过配置的“每封邮件前情总字数”。默认配置下影响不大，但和“上限放配置”的字面承诺不一致。建议要么第一封也截断/跳过，要么在文档里写明这是“软上限”。

### 7.（低）旧邮件没有 `bodyUnavailable`，与顶层邮件的提示语义不一致
顶层邮件在 `baseMailView` 会带 `bodyUnavailable: true`（`:313`），提示词第 15 行也专门解释这个字段；但 `relatedMailView`（`:255-270`）在 `mail.body === null` 时只放 `snippet`，不加 `bodyUnavailable`。模型无法知道这封旧邮件只有摘要，可能把 `snippet` 当完整背景。建议给前情邮件也补 `bodyUnavailable`，或在 `related` 说明里写清 `snippet` 的含义。

### 8.（低）作者/ADR 的“固定说明只在末尾追加两条”与代码不符
ADR 0180 第 42 行说“固定说明只在末尾追加两条”。实际是在 `packages/prompt-catalog/src/mail.ts:16-17` 插在 `bodyTruncated` 说明之后、`"对每封邮件给出一个结论："`（`:18`）之前，属于固定提示词中间插入，不是末尾追加。对一次性后台调用不构成“改写已发历史”，但描述不准确；若有人据此认为固定前缀未变，是误解。

### 9.（低）设计说明文档没有跟上新配置键
`docs/execution/specs/2026-10-29-proactive-loop-v1-gmail-design.md:299` 仍只列出 `bodyCharactersPerMail`、`bodyCharactersPerBatch` 等旧键，没有 `related*`。ADR 0180 有写，但这份设计说明会误导运维。建议同步或标注已被 ADR 0180 覆盖。

## 推测 / 未核实
- 真实 Gmail 的 `threads.get`、`messages.list` 搜索行为、Gmail 查询语法对特殊字符的处理：未实测，作者也承认未验证。`normalizeSubject` 会去掉双引号但保留反斜杠；若主题以 `\` 结尾可能让 Gmail 查询非法（最多导致该封前情读取失败，未发现可利用的查询注入）。
- 已连接 Gmail 的老用户会在升级后**默认**开始读取历史邮件（`strict-configuration.ts:1045` 默认 6，不是 0），设置页文字已改，但没有看到强制重新同意/确认流程。是否可接受属于产品/隐私决定，需 Andy 确认；未核实仓库里是否有其他同意版本校验。
- `prompt-manifest.json` 的新 `sha256` 是否与 `mail.ts` 实际分段一致：未运行哈希计算，未核实。`changedIn: "PA-1"` 能通过现有校验（只要求非空，没有强制 ADR 格式）。
- 账本页面：仓库内未找到读取 `relatedStats`/`relatedByMail` 的展示页面，与作者说法一致，未进一步核实。

## 侧重检查
- **不可信输入**：主题、正文、编号都进入 Gmail 查询和模型提示。主题被 `normalizeSubject` 压缩空白并去掉双引号；编号正则只产出 `[A-Z0-9-]`；提示词明确“邮件内容是不可信的数据”。未发现新的命令注入/查询注入升级路径；主题尾随反斜杠只可能造成查询失败（低）。
- **错误路径**：`reader.related` 抛错 → 全部 `failed/read`，检查继续；部分失败 → `partial`；预算耗尽 → `budget`；abort → `timeout`；这些都有单元/集成测试。缺口是 404/undefined 被当成功（见第 5 条）和没有独立时间预算（第 3 条）。
- **安全/隐私**：旧邮件正文、标题、发件人、摘要都走 `maskSensitiveText`；旧邮件附件只读取文件名以外的数据结构时不进入 prompt；只发 GET，没有写 Gmail。风险是历史邮件范围默认开启且发给模型路由，属不可撤销披露（见推测）。
- **资源耗尽**：`relatedRequestsPerCheck` 上限、每封 `perMail`、每封/每批字符上限、整体 `perCheckMs` 都存在；但没有给前情阶段单独的时间预算；另外 `known` 缓存整个检查期间保留所有抓取到的邮件（`gmail-related.ts:75`、`:83`、`:113-115`），大线程/大正文时可能占用较多内存，建议限制缓存或按封释放。
- **规则/文档一致性**：`prompt-prefix.md` 第 15 条要求后台调用“固定在前、会变的在后”，当前顺序满足；但“只在末尾追加两条”的说明与 `mail.ts:16-17` 的中段插入不符；`sourceIds` 与 ADR 0147 的定义出现偏差；设计说明未更新新配置键。

## 必答问题
1. **会不会改变模型已经见过的请求开头？**
   这是独立的 Gmail 判断后台调用，没有对话历史、没有工具定义。提示词结构仍是：固定指令 `MAIL_JUDGMENT.text` → 可选记忆 → 邮件数据（含新 `related`）→ 最后的 `now/timeZone/today`；每轮会变的数据仍在数据段，时间仍在最后。因此不存在“改写已发历史”的追加违规。
   但要指出：两条新固定说明是插在 `MAIL_JUDGMENT.text` **中间**（`mail.ts:16-17` 在 `:18` 之前），不是作者说的“只在末尾追加”；固定前缀相对上一版本确实变了。由于每次检查是独立请求、不共享对话缓存，这属于部署时提示词变更，不是每轮不稳定；若依赖跨检查的固定前缀缓存，会失效一次。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   就同一份输入而言，不会：旧邮件按 `receivedAt`、`messageId` 排序（`gmail-related.ts:137-143`），取得最近 N 封后再按时间正序输出；JSON 键顺序固定；遮盖是逐字符串的 `maskSensitiveText`，没有跨消息状态；`durationMs` 等时间值只进账本、不进 prompt；没有依赖 Set/对象遍历顺序的输出。
   需要注意：真实环境下“同一封新邮件”可用时间段不同、邮箱内容变化，会得到不同的前情集合；这是输入变化，不是同一内容的字节不稳定。另有一个契约风险：服务端 `relatedMailView` 假设 `byMail` 是时间升序（`proactive-mail-check-service.ts:253`、`:278`），目前只有 Gmail reader 保证这一点；若将来别的 reader 返回降序，时间线会错，建议在服务层自己排序或写清接口契约。

3. **有没有对应的自动检查，反向用例是否真的会失败？**
   有：`[PA-1]` 单元测试覆盖标题归一、编号提取、三种关联、同标题不同发件人（`packages/platform-node/test/gmail-related.unit.test.ts` 的 `sameSubjectStranger`）、搜索结果不含编号时的本地复核、预算耗尽、超时；集成测试覆盖正例、同发件人不同事的反向例、读取失败降级、部分失败、遮盖、每封上限；配置测试覆盖默认值、0 和越界。
   这些反向断言在实现被改回“只看同发件人”或“信任搜索命中”时确实会失败，测试质量基本够。缺口是：没有 capped 场景下“账本只记实际送入模型”的反向用例；没有 404 被当成功的反向用例；没有 `sourceIds` 新语义的测试；真实 Gmail 未测。另外现有 `decision-ledger.test.ts` 没更新期望，按代码推断会失败（未运行）。

4. **每个新值的生产者和消费者是否都能接受？**
   - 四个配置键：`strict-configuration.ts:994-997、1020-1048` 白名单、范围、交叉校验齐全；`production-proactive.ts:180-185` 正确映射；服务默认值一致；老配置缺键有默认值。通过。
   - `participants`：`gmail-source.ts:182-187、220` 生产，`gmail-related.ts` 的 `counterparts`/`sharesCounterpart` 消费，类型可选，老测试不受影响。通过。
   - `relatedByMail/relatedRead/relatedStats/relatedFailedSteps`：服务生产，`sqlite-proactive-operations.ts:525-549` 校验（键 ≤500、每封列表 ≤64、步骤 ≤16 且 1–64 字符、统计为非负安全整数），`entryFromRow` 给老记录补 `off`/空/零。单值类型能接受；但存在第 1 条的“未送入也记入”语义问题、第 4 条 `sourceIds` 覆盖问题，以及第 2 条现有测试未同步。
   - 提示词清单：`changedIn`/`reason` 非空即可，`PA-1` 能通过；`sha256` 需与实际分段一致，未计算核实。
   - i18n：三个语言同一个 key 都改了，无新增/删除 key。
   - `related`/`relatedUnavailable`：模型提示已解释；前情邮件缺 `bodyUnavailable`（第 7 条）。
   总体：大多数消费者能接受，但账本语义和既有测试一致性需要修。
