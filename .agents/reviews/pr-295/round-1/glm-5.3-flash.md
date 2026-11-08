# PA-2 复核报告（a46fe34，基准 8ae40ba）

## 发现（按严重度从高到低）

**1. 中｜`apps/agent-service/src/production-proactive-memory.ts:47,61`｜主动检查召回链路上两处新改动没有任何测试断言**
- 证据：`production-mail-embedding.unit.test.ts`（本次未改）第 140-146 行只断言 `recordUse/minimumSimilarity/excludeCategories/policy`（`toMatchObject`，多出的 `includeTentative: true` 不会让它失败），第 146 行 `expect(result.hits.get("mail-3")).toEqual([{ id: "m1", text: "text of ref-m1", score: 0.7 }])` 用的固定内存是 `found()` 造的无 attributes 对象。`test/integration/proactive-mail-check.test.ts:1310` 的 `[PA-2]` 用例用的是手写 stub `recallOf`（tentative 标志是测试自己塞进去的），绕过了真实的 `DurableMemoryService.search → HybridMemoryProvider → sqlite indexScope` 链。
- 后果：把 `includeTentative: true`（第 47 行）或 tentative 透传（第 61 行）删掉，全部测试仍然通过。
- 建议：在 `production-mail-embedding.unit.test.ts` 的 `seen` 断言中加 `includeTentative: true`，并补一条「search 返回带 `attributes.tentative` 的记录时输出带 `tentative: true`」的用例。

**2. 低｜`test/integration/automatic-memory-golden.test.ts:481-483`｜黄金用例的对账不变式与新行为不再等价（当前靠数据集碰巧不触发）**
- 证据：不变式是 `ledgerCount("kept") === auditCount("auto_committed","explicitly_approved","approval_committed")`，但新代码对 `tentative_kept` 也写 `kept` 账本行（`automatic-memory-service.ts:199-208`、`526`）。数据集 `test/integration/fixtures/memory-golden-dataset.json:265-276` 的 low-confidence 用例候选无 `quote` 字段，仍走丢弃分支，所以现在通过。
- 后果：黄金测试没有覆盖新路径；将来数据集加入一条带 quote 的低分 create 候选时，该不变式会误报失败；且第 467 行 `committedMemoryIds` 断言会掩盖新行为。
- 建议：不变式中加入 `tentative_kept` ↔ `kept_tentative` 对账，并在数据集加一条会存成 tentative 的用例。

**3. 低｜`packages/application/src/services/automatic-memory-service.ts:78-82`｜「quote 非空 ⇒ 原话已核实」只是上游构造不变式，服务层不自查**
- 证据：`canBeKeptTentatively` 只查 `candidate.quote !== undefined && quote.length > 0`；quote 只在核实过才放进候选这一点，靠 `production-memory-capture.ts:399-401`（`evidenceVerified && dataClassification !== "restricted"` 才带 quote）保证。服务自己有 `readSourceText`（第 114 行）却不复核 quote 是否确为原话子串。
- 后果：当前唯一生产接线安全；若将来其他调用方直接调 `AutomaticMemoryService` 传入未核实 quote，会存入带假「原话引用」的待确认记忆，并在主动检查提示里以主人原话的姿态出现。
- 建议：在服务层对 `quote` 做一次与 `sourceText` 的包含性核对，或至少在 ADR/代码注释固化该前置条件。

**4. 低（churn，无风险）｜`packages/prompt-catalog/prompt-manifest.json:155-176,524-548`｜三处既有条目 `phrases` 数组的纯换行重排与本次功能无关**
- 证据：diff 中这三段只改了 JSON 缩进，`sha256` 未变；manifest 语义由 `apps/agent-service/test/prompt-catalog.unit.test.ts:187`（`PROMPT_MANIFEST_STALE`，含反向用例）把守。新条目 `mail.judgment.tentative-note` 的 sha256 数值本身我未计算（工具受限），但其正确性由同一测试强制——错了会红。

**5. 信息｜与代码逐条核对一致的 ADR 说法（读代码证实）**
- 门槛 850 与推测类 700 上限未改：`automatic-memory-service.ts:191`、`production-memory-capture.ts:372`。
- 密钥/受限/暂时性/敏感检查都在低分分支之前：`automatic-memory-service.ts:150-188`。
- tentative 跳过提醒与人物登记：`onCommitted` 承担这两类副作用（`production-memory-capture.ts:531-554`），`kept_tentative` 跳过它（`automatic-memory-service.ts:536`）。
- 档案块、默认检索、提醒仍排除 tentative：`owner-profile-service.ts:100`、`sqlite-memory-operations.ts:242`（参数缺省 0 时等价于原条件）、`sqlite-memory-reminder-operations.ts:12`。
- `unchanged` 转正逻辑未动：`durable-memory-service.ts:112-114,260-280`。
- 账本约束可接受新值：`migrations/0069_decision_ledger.sql:19,48-51`——`reason_code` 是 1-64 位自由文本，`kept_tentative` 合法；`outcome` 仍是 `kept`。

## 侧重检查（测试覆盖 / 文档一致性 / 普通流程走查）

普通流程：聊天轮结束 → `ProductionMemoryCapture` 构造候选（quote 核实，`production-memory-capture.ts:290-401`）→ 低分 create+quote 存 tentative（单测 `tentative-memory-capture.unit.test.ts` + 集成 `production-memory-capture.test.ts:630-710`）→ 投影入索引（该集成测试跑了 `runProjectionBatch`）→ 稍后 Gmail 主动检查 → `createProactiveMemoryRecall.recall`（**无覆盖**，见发现 1）→ 提示拼装与账本（`proactive-mail-check.test.ts` 的 `[PA-2]` 覆盖，但用 stub recall）→ 账本读回（`decision-ledger.test.ts:208-211,822-825` 覆盖，worker/direct 双路）。缺口集中在发现 1 和 2。文档一致性：ADR 0179 的决定 1-6 与代码逐条对上（见上）；「已核对的事实」四条全部属实。未核实：云端测试运行结果、manifest 哈希数值、`proactive-production.test.ts` 全文。

## 读代码证实的 vs 推测的

- 证实：以上所有引用行均为亲自读取；「无 tentative 时提示逐字节相同」由 `proactivePrompt`（`proactive-mail-check-service.ts:267-274`）的数组展开加两条集成断言（1388/1402-1410 行）证实。
- 推测（未运行验证）：各测试套件实际通过；`proactive-production.test.ts` 是否在真实链路上覆盖了 tentative（grep 未见 tentative 痕迹，推测未覆盖）。

## 必答问题

1. **不会改变已见过的请求开头。** 本次改动不触及对话请求的系统提示、工具定义、历史消息和遮盖（diff 无 runtime-pi/context 相关文件）。唯一模型可见的变化是后台邮件判断提示，它是每次检查新起的一次性单条请求（`proactive-mail-check-service.ts:803-814`，直接 `model.invoke`，无对话历史），不存在跨轮前缀；且仅在召回出 tentative 记忆时在记忆段后追加一条固定说明，否则与原来逐字节相同。每轮会变的值（now、邮件内容）本来就在提示尾部，未移动。
2. **不引入前后文依赖的字节变化。** 新增的 `"tentative":true` 字段只取决于该记忆自身的存储属性，与前后文无关；确认过的记忆条目字节不变（键序 mailId,id,text，tentative 永远在末尾且有测试断言精确 JSON）。无新增时间字段；账本里的 `tentativeMemoryIds` 是 Set 的插入序展开，与既有 `usedMemoryIds` 模式一致。同一记忆转正前后条目字节不同，那是属性本身变化所致，与既有「记忆块随检索结果变化」同类，不违反规则。
3. **大部分有，一处关键缺口。** 抽取存储、账本、提示拼装、档案块、默认检索排除均有正向用例，且反向用例真实可失败（quote 为空/update/unchanged/transient 仍丢弃、全确认时不出说明、默认检索不含 tentative、manifest 陈旧报错）。缺口：`production-proactive-memory.ts:47,61` 的开关与透传无任何断言（发现 1）；黄金对账不变式未随新行为更新（发现 2）。
4. **逐值核对通过，一处隐性约定要留意。** `attributes.tentative`（产：`automatic-memory-service.ts:197`；收：sqlite 列 `737/782`、档案块 `owner-profile-service.ts:100`、提醒 `reminder-operations.ts:12`、索引 `indexScope:242`、控制台 `production-memory-control.ts:332`、召回 `production-proactive-memory.ts:61`）两端一致。`ProactiveMemoryHit.tentative`（产 61；收 `proactive-mail-check-service.ts:130,914,792`）一致。`tentativeMemoryIds`（产 `proactive-mail-check-service.ts:1013`；收：写入校验 `sqlite-proactive-operations.ts:539,611`、读回 `sqlite-decision-ledger-operations.ts:162`，worker/direct 双路有集成测试）一致。`tentative_kept` 审计值只进 TS union 和内存回调（`production-memory-capture.ts:523`），无 DB 枚举约束可违反。隐性约定即发现 3：quote 非空 ⇒ 已核实只在生产捕获路径成立。
