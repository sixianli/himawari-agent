## 读代码证实的问题（按严重度）

### 1. 高：审批所在对话的标题没有做分级检查，可能把 sensitive/restricted 内容发给模型

- 文件:行：`apps/agent-service/src/production-http-composition.ts:1166-1180`；`apps/agent-service/src/production-home.ts:194`；`packages/application/src/services/home-urgency.ts:148-153`
- 问题：审批条目打分时会把 `approvalDetail` 的 `conversation`（对话标题）作为 `facts` 发出去。这个标题来自 `thread.titleRef` 对应的 payload，而该 payload 的分级可以是 `sensitive`/`restricted`（自动标题的分级取第一条用户消息的分级，见 `production-thread-titles.ts`）。但 home 的 `threadTitle` 完全不看 `payload.dataClassification`，而整个模型调用的分级只由候选条目自己的分级决定。于是“审批是 private、标题是 sensitive/restricted”时，标题会以 private 的分级发给模型，违反“`restricted` 不发；不许看的分级只发种类和到期时间”的约束。
- 证据：
  - `production-home.ts:194`：
    ```ts
    conversation,
    ```
  - `production-http-composition.ts:1166-1180`：
    ```ts
    threadTitle: async (threadId) => {
      ...
      const payload = thread.titleRef ? await memoryPayloads.get(thread.titleRef) : undefined;
      if (!payload || payload.contentType !== "text/plain") return { title: null };
      return {
        title: new TextDecoder("utf-8", { fatal: true })
          .decode(await payloadProtector.unprotect({ ownerId, agentId, payload }))
          .trim() || null,
      };
    },
    ```
  - 同一个仓库里另一处专门给审批读标题的实现是带分级检查的，说明这是应当守住的约束（`service-main.ts:1600-1607`）：
    ```ts
    if (
      !payload ||
      payload.contentType !== "text/plain" ||
      !["public", "private"].includes(payload.dataClassification)
    )
      return null;
    ```
  - `home-urgency.ts:148-153` 只对字符串做出口遮盖，不做分级过滤：
    ```ts
    ...(item.disclosed ? { facts: maskFact(item.candidate.facts) } : {}),
    ```
    `maskSensitiveText` 只遮密码/验证码/卡号等，不会把普通 sensitive 业务内容去掉。
- 建议：在 `production-http-composition.ts` 的 `threadTitle` 里加同样的 `["public","private"].includes(...)` 检查（或把标题分级并入本次调用的最高分级，再交给 `modelAllows` 判定）；增加一条反向用例：审批 private、标题 sensitive/restricted 时，prompt 里不能出现标题原文。另注意模型把标题内容写进 `sentence` 后会以审批的分级密封，分级也会失真。

### 2. 中：推送没有接 `approvalCopy`，作者说法 5 和 ADR 决定 9 与代码不一致

- 文件:行：`apps/agent-service/src/production-web-push.ts:516-533`；`apps/agent-service/src/service-main.ts:2487`；`apps/agent-service/src/production-home.ts:731-742`；`docs/adr/0255-model-scores-urgency-of-home-items.md:65`
- 问题：`ProductionHomeControl.approvalCopy` 只被首页读取路径使用；推送侧只拿到 `awaitingCount`，审批通知正文仍是对话标题，没有读模型写的一句话或同意按钮文字。因此“首页和推送返回同一份经过同样核对的文字”目前不成立。
- 证据：
  - `production-web-push.ts:516-533`：
    ```ts
    if (item.kind === "approval") {
      const approval = approvals.find(({ id }) => id === item.sourceRef);
      ...
      const title = await this.#title(item.threadId);
      ...
      body: title ?? WEB_PUSH_TEXT[locale].untitled,
    ```
  - `service-main.ts:2487` 只把 `awaitingCount` 交给推送：
    ```ts
    awaitingCount: async () => http?.home.awaitingCount(),
    ```
  - ADR `0255:65` 写的是“`ProductionHomeControl.approvalCopy`……推送用它就不会和首页不一致”。
  - 集成测试名字声称“gives push the same pair”（`test/integration/home-urgency.test.ts:757`），但实际只调了 `home.approvalCopy`（`:821`），从没调用推送。
- 建议：要么在本 PR 把推送的审批正文接到 `approvalCopy`（带 locale、失败退回目录文字），并加真正的推送用例；要么修正 ADR 和测试名，明确“推送在后续批次接入”。

### 3. 中：候选超过 2000 条时，打分会在查询前整体失败；首页读取也会持续丢分数

- 文件:行：`packages/persistence-sqlite/src/sqlite-home-urgency-operations.ts:17,69-82`；`packages/application/src/services/home-urgency.ts:335-347`；`packages/application/src/services/home-feed.ts:287-290`
- 问题：存储层对 `listScores` 一次传入的 items 设了 `ITEM_LIMIT = 2000`，超过直接 `PORT_INVALID_OPERATION`。但 `HomeUrgencyService.#run` 是先对所有 `open` 条目做 `listScores`/`listRecentFailures`，之后才 `slice(0, perCall)`；首页读取的 `#scores` 也会把全部 awaiting 条目传进去。审批和规则来源没有条数上限，长期账户可能超过 2000 条，结果是：打分整轮失败，首页每次读取都会走 `onScoreFailure` 并全部标 `unscored`。
- 证据：
  - `sqlite-home-urgency-operations.ts:17`：`const ITEM_LIMIT = 2_000;`
  - 同文件 `69-82`：超限直接 fail。
  - `home-urgency.ts:335-347`：
    ```ts
    const refs = open.map(({ ref }) => ref);
    const scored = new Map(
      (await store.listScores({ ...scope, items: refs })).map(...),
    );
    const failedRecently = new Set(
      (await store.listRecentFailures({ ...scope, items: refs, ... })).map(refKey),
    );
    ```
  - `home-feed.ts:287-290` 的 `awaitingCandidates()` 返回全部 awaiting 条目。
- 建议：先按 `perCall`/`referenceLimit` 截断再查询，或对 `listScores`/`listRecentFailures` 分块；对审批/规则来源也加读取上限；补一条超过上限的用例。

### 4. 低：未获准披露的参照条目仍然向外发了分数，和“只发种类和到期时间”不一致

- 文件:行：`packages/application/src/services/home-urgency.ts:164-175`
- 问题：`reference` 的每个元素无条件带 `score`，即使 `disclosed === false`。ADR/约束写的是“模型不许看的分级只发种类和到期时间”。
- 证据：
  ```ts
  JSON.stringify(input.reference.map((item) => ({ score: item.score, ...shown(item) }))),
  ```
  `shown()` 在未披露时只返回 `kind`/`deadline`，但外层仍然加了 `score`。
- 建议：未披露条目不要带 `score`，或在 ADR/测试里明确允许发分数并写清理由；补反向用例。

### 5. 低：删除路径和并发整批失败缺少自动检查

- 文件:行：`packages/persistence-sqlite/src/sqlite-governed-deletion.ts:1043-1052`；`test/integration/home-urgency.test.ts:1105-1120`；`packages/persistence-sqlite/src/sqlite-home-urgency-operations.ts:256-275`；`packages/persistence-sqlite/src/migrations/0095_home_item_scores.sql:30-32`
- 问题：
  - 声称 4 的“按规定流程删除数据时密封内容一并清掉”在代码里确实加了查询，但没有测试真正走 `SqliteGovernedDeletionAdapter` 删除 run/thread；现有用例只是直接 `DELETE FROM approval_requests`，不会覆盖新加的那条 `sentence_ref` 查询。
  - 声称 1 的“两次并发写入后写的整批失败”依赖唯一索引 + 事务，代码看起来成立，但没有并发用例。
- 证据：
  - `sqlite-governed-deletion.ts:1043-1052` 的 `SELECT sentence_ref FROM home_item_scores ...` 没有被任何测试引用（全仓库测试里没有 `home_item_scores` 的 governed deletion 用例）。
  - 现有级联用例只做：
    ```ts
    handle.prepare("DELETE FROM approval_requests WHERE id = 'send'").run();
    ```
  - 插入在 `recordCall` 的 `database.transaction(...)` 内，唯一索引是部分索引 `WHERE status = 'done'`。
- 建议：补两条真实 SQLite 用例：1）删除 run/thread 后审批行、分数行、密封 payload 都没了；2）两个连接并发写同一 item+digest，断言一个批次成功、另一个整批回滚且没有半批。

### 6. 低：`home_item_scores` 对临时条目和已处理审批没有清理策略，会长期增长

- 文件:行：`packages/persistence-sqlite/src/migrations/0095_home_item_scores.sql:1-58`；`docs/adr/0255-model-scores-urgency-of-home-items.md:73`
- 问题：非审批来源的行没有外键，只能随 owner/agent 删除；审批行只在审批记录（或 run/thread）被删时级联。审批已同意/拒绝/过期、邮件提醒已处理后，分数行、`affirm_label`（明文）和密封的一句话仍会长期保留，表会持续增长。
- 证据：迁移里只有 owner/agent/approval 级联和不可删触发器；ADR 偏离说明也承认“其他种类的行……留着”。这是有意设计，但缺少容量/保留期说明或清理任务。
- 建议：明确保留期和清理方式（例如删除已处理的审批分数行并同步释放 `sentence_ref`，或定期清理旧的非审批行），至少加监控。

---

## 推测／未核实

- 标题分级泄漏的实际发生率取决于“审批 intent 的分级低于所在对话第一条消息分级”的账户数据；代码路径成立，但生产数据量未核实。
- 超过 2000 条候选是否会在真实账户出现，取决于待审批/待复核规则数量；代码上限是确定的。
- `packages/prompt-catalog/prompt-manifest.json` 里 `home.urgency` 的 sha256 是否与 `HOME_URGENCY.text` 一致，我没有运行 `check:prompt-catalog`，未核实。
- 新增的 `sentenceBasis: "model"`、`rank: "model"`、`labelBasis: "model"` 目前只被网关合约和测试消费；仓库内没有首页客户端代码读取 `home.snapshot`，网页/苹果端是否能识别这些新值未核实。
- `HomeUrgencyService.#invoke` 在 `readOutput` 之后才检查 16KB 上限（`home-urgency.ts:519-525`），单个超大 output payload 会先被整体读入内存；这是和 `review-prereview.ts` 相同的既有模式，是否可被模型端放大为内存压力未核实。

---

## 侧重检查

- **错误路径**：模型失败/超时/空输出/非 JSON/漏编号/编造编号/重复编号/每日次数/每日费用/关闭都看过了；条目不会被删除，失败行有回退；`recordCall` 在事务里，存储失败会释放刚密封的句子并做内存退避。结论：主路径成立。一个残留：`listScores`/`listRecentFailures`/`countSince` 在读阶段抛错时没有内存退避，会每 60 秒重试。
- **不合规范/不可信输入**：模型输出由 `parseHomeUrgency` 按 `n`/`score`/`sentence`/`affirm` 校验；控制字符、换行、超长会被拒；存储层对分数、摘要、分类、语言、长度都有校验；不执行任何模型文本。结论：基本可靠。
- **安全**：`restricted` 在打分入口被过滤；未披露条目只发 kind/deadline（但 reference 多发了 score，见问题 4）；`maskSensitiveText` 会遮机器秘密；发现对话标题未按分级过滤（问题 1）。审批句子密封存放，`affirm_label` 明文存表。
- **资源耗尽**：见问题 3、6；另有每次 60 秒为构建候选而对审批调用 `approvalCopy` 的开销（`locale` 为 `en` 时可能反复解密句子），属于性能浪费，不是正确性问题。
- **不可撤销操作**：本次只做插入；存储失败时会 `seal.release` 删除刚创建的新 payload；没有删除用户已有数据。删除路径只有 `governed deletion` 新增查询，未见被测试覆盖。
- **规则/文档与代码一致性**：`prompt-prefix.md` 的“固定在前、会变在后”在这条后台调用里成立；新提示词加入 `TRUSTED_PROMPT_TEXTS` 不改变已有聊天请求的字节（只有该文本真的出现在输入里才会影响遮盖）；ADR 决定 9 与推送实现不一致（问题 2）；声称 4 有实现但缺测试。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？发给模型的内容是不是仍然只在末尾追加，每轮会变的值是不是都在最后一条消息里？

**不会改变已有对话请求的开头。** 这次是独立的 `proactiveModel` 调用，不修改系统提示、工具定义、历史消息或已发出的遮盖结果。

新调用内部是“固定的在前、会变的在后”：

- `packages/application/src/services/home-urgency.ts:164-182` 先放固定的 `HOME_URGENCY.text`，再放“参照”/“新条目”，最后一行才放 `now`、`timeZone`、`language`、`affirmMax`。
- 每轮会变的值：`now` 和 `affirmMax`/`language` 在最后一行；`reference` 和 `fresh` 在固定文字之后的变量段。严格说 `reference`/`fresh` 不是“最后一行”，但它们位于固定前缀之后，符合后台调用的规则（`prompt-prefix.md` 第六节第 15 条）。
- `reference` 列表本身会随已打分条目变化，但那是本次请求的输入变化，不是对已发送对话内容的改写。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

**没有发现无意的字节漂移。** 依据：

- `maskFact` 会递归排序对象的键（`home-urgency.ts:102-112`），数组保序；`homeUrgencyPrompt` 的顶层键顺序也是写死的（`:164-182`）。
- `reference` 和 `fresh` 都由按 `candidate.key` 排序的 `open` 生成（`:334,366-370`），不依赖数据库返回顺序。
- 遮盖使用 `maskSensitiveText`，没有传跨消息的 `known` 表，因此一段文字遮成什么只取决于它自己；同一输入是确定的。
- 唯一会变的是最后一行显式传入的 `now`/`timeZone`/`language`/`affirmMax`，以及本次数据本身（参照分数、fresh 集合）。

需要说明：同一件事的文字会先在 `fresh` 出现、以后进入 `reference`，周围的字段和分数不同，所以字节不同；这是输入不同，不是序列化不稳定。

### 3. 有没有对应的自动检查，反向用例是否真的会失败？

**有，而且大多数反向用例的断言是有效的；但有三处缺口。**

- 有效覆盖：`test/integration/home-urgency.test.ts` 覆盖空回答、非 JSON、模型失败、漏编号/编造编号、24 小时退避、每日次数/费用、关闭、文字变化重打、审批指纹/语言/字数/否定词校验、不许看的分级只发种类和到期时间、`restricted` 不发、存储失败释放密封内容、表不可改和审批级联；`packages/application/test/home-urgency.unit.test.ts` 覆盖提示词排列/字节、解析、按钮文字核对；`startup-configuration.unit.test.ts` 覆盖配置默认值和越界；`prompt-output-contracts.unit.test.ts` 覆盖提示词登记与解析函数。
- 反向用例确实有“去掉就失败”的断言，例如未披露条目的 `call.fresh` 精确等于 `{n,kind,deadline}`、存储失败后 payload 数量不变、不可 UPDATE/DELETE、24 小时边界、费用上限。
- 缺口：并发写整批失败没有测试；`governed deletion` 清密封内容没有测试；推送使用 `approvalCopy` 没有测试（测试名声称覆盖推送，实际只测了首页的 `approvalCopy`）。
- 我受工具限制没有运行测试，因此“会失败”是根据测试断言推断的，不是执行结果；`prompt-manifest` 的哈希也未核实。

### 4. 每个产生/使用的值，两端都能接受吗？

**大部分能对上，发现三处不一致。**

已核对且一致：

- 用途 `home-urgency`：`packages/application/src/ports/model-usage.ts:12`、迁移 `0095` 的 `purpose` CHECK、`sqlite-model-usage-operations.ts:22` 三处一致。
- `HOME_RANKS`/`HOME_SENTENCE_BASES`/`HOME_LABEL_BASES` 新增的 `"model"`：合约枚举、`home-feed.ts` 的 `RANK_ORDER`/`rankOf`、`production-home.ts:121,543` 产生的地方一致。
- `home_item_scores` 的 DB CHECK 与 `sqlite-home-urgency-operations.ts` 的校验：分数 0..1000、`affirm_label` 1..64、`text_digest` 64 位小写十六进制、`copy_locale` 与文字存在性、`sentence_ref` 必须带审批、分类三值、`created_at` ISO、费用/耗时上下界，基本逐项对应。
- `HomeUrgencyConfiguration`/`HomeFeedConfiguration` 的键、默认值和范围校验与 `DEFAULT_HOME_URGENCY`/`DEFAULT_HOME_FEED` 一致。
- 提示词 `home.urgency` 已登记到 manifest，解析函数 `parseHomeUrgency` 已登记到输出合约测试。
- `approvalCopy` 返回的句子和按钮文字在首页侧会被 `line(...,2000)`、`acceptsHomeAffirmLabel` 和合约的 64/2000 长度限制接收。

不一致或需要补：

- 未披露的 `reference` 条目仍带 `score`，和“只发种类和到期时间”不一致（问题 4）。
- 对话标题的分级没有进入本次调用的分级，导致模型端可能收到不该看的内容（问题 1）。
- 推送没有消费 `approvalCopy`，所以“首页和推送同一份”不成立（问题 2）。
- 小问题：`affirmLabelMax` 配置允许任意语言标签（如 `fr`），但消费端只用 `HomeLocale` 的 `zh-CN/en/ja`，配置存在但永远不会被用到；不会导致错误，只是无效配置。
