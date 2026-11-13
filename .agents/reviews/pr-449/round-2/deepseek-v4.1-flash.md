说明：本轮已达到工具调用上限，未运行测试；以下是基于已读代码的完整复核。未核实项：测试实际执行结果、`prompt-manifest.json` 中 `home.urgency` 的哈希是否匹配、前端如何渲染按钮文字、规则摘要的实际分级来源。

# 侧重检查

我优先查了这些路径：

- **错误路径**：模型失败/超时/返回非 JSON/漏编号/编造编号/超上限；存储失败；封存失败；删除失败。
- **不可信输入**：模型 JSON、模型写的一句话和按钮文字、对话标题、规则摘要、审批事实、配置里的语言与上限。
- **安全/分级**：`restricted` 不发不存；模型不许看的分级只发种类和到期时间；审批标题按分级发送；一句话密封存放；按钮文字明文存放。
- **资源耗尽/上限**：每日调用和费用、`perCall`、`referenceLimit`、单次读取 2000 件、模型输出 16KB、关闭时后台任务。
- **不可逆操作**：审批同意按钮、治理删除线程/运行时的分数与密封内容、外键级联和删除触发器。
- **规则/文档/代码一致**：`prompt-prefix.md` 第 15 条、ADR 0255、作者 9 条说法与代码。

结论：**未发现高严重度问题**。标题分级修复和读分数分批修复本身是正确的；下面 4 条是低严重度或未核实的硬化/测试问题。

# 问题（按严重度从高到低）

## 1. 低—中：模型写的同意按钮文字接受双向文字控制符（Cf），可被用来视觉伪装不可逆动作的按钮

- 文件:行
  - `packages/application/src/services/home-urgency.ts:196-201`
  - `packages/application/src/services/home-urgency.ts:127-142`
  - `apps/agent-service/src/production-home.ts:121`
  - `apps/agent-service/src/production-home.ts:562`
  - `packages/gateway-contracts/src/validation.ts:96-99`

- 问题：模型生成的 `affirm` 会直接成为审批的肯定按钮 `label`。解析和读取校验只拒绝 `\p{Cc}\p{Zl}\p{Zp}`、限制长度、和否定文字比较；没有拒绝双向文字控制符（如 U+202E、U+2066–U+2069）等格式字符。`boundedString` 也只拒绝 C0 和 DEL。模型可能被条目里的不可信内容影响，写出视觉上重排的按钮文字，例如让“发出去”看起来像别的动作。

- 证据（亲自读到）：
  - `home-urgency.ts:199`：
    ```ts
    if (text.length === 0 || text.length > max || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(text)) return null;
    ```
  - `home-urgency.ts:135-141` 只检查 trim、grapheme 上限、是否等于否定文字。
  - `production-home.ts:121`：
    ```ts
    label: options.modelLabel ?? options.label ?? HOME_TEXT[locale].actions[name],
    ```
  - `production-home.ts:562` 附近把 `copy?.affirmLabel` 作为 `modelLabel` 传入。
  - `validation.ts:96-99` 只拒绝 `< 0x20` 和 `0x7f`。

- 严重度说明：读代码可证实“控制符会被接受”；“前端会因此视觉重排”属于推测，取决于未来客户端渲染。这个标签服务于不可逆审批，建议按安全输入处理。

- 建议：在 `line()` 或 `acceptsHomeAffirmLabel` 里拒绝双向控制符（U+202A–U+202E、U+2066–U+2069、U+200E/U+200F、U+061C），但保留 emoji 需要的 ZWJ（U+200D，现有单元测试依赖它）。补一条反向用例，断言带 U+202E 的 `affirm` 退回目录文字。

## 2. 低：`HOME_URGENCY_ITEMS_PER_READ` 与持久层的 `ITEM_LIMIT` 是两个独立的 2000，生产代码没有把两端绑在一起

- 文件:行
  - `packages/application/src/ports/home-urgency.ts:6`
  - `packages/persistence-sqlite/src/sqlite-home-urgency-operations.ts:17`
  - `packages/application/src/services/home-urgency.ts:144-152`

- 问题：应用层按 `HOME_URGENCY_ITEMS_PER_READ = 2000` 分批，SQLite 适配器另有 `ITEM_LIMIT = 2_000`。当前相等，所以工作正常；但如果以后只改其中一边，应用层可能每批都被存储拒绝，或者分批不再真正避开上限。这是 I-73 类“两端校验各自独立”的耦合风险。

- 证据：
  - `ports/home-urgency.ts:6`：`export const HOME_URGENCY_ITEMS_PER_READ = 2_000;`
  - `sqlite-home-urgency-operations.ts:17`：`const ITEM_LIMIT = 2_000;`
  - `sqlite-home-urgency-operations.ts:69-82` 在 `items.length > ITEM_LIMIT` 时失败。
  - `home-urgency.ts:149-150` 用应用层常量切批。

- 严重度：低。现有集成测试用 2001 件把两边“钉”在 2000，能发现大多数不一致，但生产代码没有编译期或运行期共享来源。

- 建议：让持久层直接使用 port 导出的常量，或让 `HomeUrgencyStorePort` 暴露一个“单次最大读取件数”，服务按它分批；至少加一个测试断言两处常量相等。

## 3. 低：分批读取的正向路径没有被测试，只测了“超过上限会抛”和“空表不抛”

- 文件:行
  - `test/integration/home-urgency.test.ts:1270-1298`
  - `packages/application/src/services/home-urgency.ts:144-152`

- 问题：新用例用 2001 个候选、但数据库里没有任何分数，因此 `service.scores(many)` 期望空 Map。这个用例能证明“不会因为 2001 件整体抛错”，但不能证明 `inBatches` 真的把两批结果都合并回来。如果实现错误地只读第一批、跳过最后一批，或者把批次结果丢掉，这个正向断言仍然通过。

- 证据：
  - 测试构造 `Array.from({ length: HOME_URGENCY_ITEMS_PER_READ + 1 })`，但 `candidates` 的分数行没有插入。
  - `await expect(service.scores(many)).resolves.toEqual(new Map());`
  - 直接 `listScores` 2001 件期望 `rejects.toThrow()`，这只验证了存储上限。

- 严重度：低，但这是一个真实的测试覆盖缺口。

- 建议：插入第一条和最后一条（跨批边界）的成功分数行，再断言 `scores()` 同时返回两条；再加一条 `listRecentFailures` 跨批的失败行用例，因为 `#run` 也用它。

## 4. 低：关闭服务时只清定时器，不等待正在进行的打分调用（推测影响：可能留下密封句子的孤儿 payload）

- 文件:行
  - `apps/agent-service/src/production-home.ts:765-778`
  - `apps/agent-service/src/production-http-composition.ts:1365-1368`
  - `apps/agent-service/src/production-service-lifecycle.ts:38-52`

- 问题：`startScoring()` 会立即 `void this.score()`，`stopScoring()` 只 `clearInterval`，没有等待 `HomeUrgencyService.run()` 的 `#running`。生命周期按注册逆序关闭，`http.close()` 先执行，随后关闭 model/authority/repository；正在进行的 `#invoke` 或 `recordCall` 可能在依赖关闭后继续。

- 证据（亲自读到）：
  - `production-home.ts:771-778`：
    ```ts
    this.#timer.unref?.();
    void this.score();
    ...
    stopScoring(): void {
      if (this.#timer) clearInterval(this.#timer);
      this.#timer = undefined;
    }
    ```
  - `production-http-composition.ts:1365-1368`：`close` 中调用 `home.stopScoring(); await app.close();`
  - `production-service-lifecycle.ts:40`：`const resources = [...this.#resources].reverse();`，http 注册在最后，故先关闭。

- 严重度：低。读代码可证实“没有 drain/await”；“会留下孤儿 payload”是推测：若关闭期间 `recordCall` 失败，`#run` 会尝试 `seal.release`，但 payload store 已关闭时 release 可能失败并被 `.catch(() => undefined)` 吞掉。

- 建议：把 `stopScoring` 改成 `async stopScoring()`，让 `HomeUrgencyService` 暴露 `drain()`/`waitForIdle()`，在 http 关闭阶段等待正在进行的 run；或者把计时器纳入现有的 `runs`/`memory-worker` 那样的 drain 生命周期。

## 5. 未核实/推测：规则条目的分级写死为 `private`，而其摘要会作为 `facts.label` 发给模型

- 文件:行
  - `apps/agent-service/src/production-home.ts:428-451`
  - `apps/agent-service/src/production-owner-rules.ts:396-405`
  - `apps/agent-service/src/production-owner-rules.ts:430-438`

- 问题：规则条目在首页来源里写死 `dataClassification: "private"`，同时把 `rule.summary` 放到 `label`，第 2 步开始会把 `label` 发给模型。规则来源记忆的分级由 `classificationWithIdentifiers(text, "private")` 决定，可能升到 `sensitive`；而首页规则项没有读取来源记忆分级。

- 证据：
  - `production-home.ts:428-451` 的 `rules` 来源里 `label: line(rule.summary, 500)`，`dataClassification: "private"`。
  - `production-owner-rules.ts:396-405` 对规则来源文本使用 `classificationWithIdentifiers(text, "private")`。
  - `production-owner-rules.ts:430-438` 把该分级写进来源记忆。

- 说明：我没有核实规则摘要本身是否可能携带敏感内容；测试里敏感的是 `quote`，而首页只发 `summary`，且 `maskSensitiveText` 会遮标识符。因此这条是“需要确认”的推测，不应按已证实漏洞处理。

- 建议：若规则摘要可能来自敏感来源，首页规则项应从 `sourceMemoryId` 读取来源记忆分级，或只发目录句子、不发摘要；若确认摘要按设计只能是 private，则在 ADR/注释里写明。

# 读代码证实的与推测的分开汇总

## 读代码证实的

- `home_item_scores` 唯一索引只约束 `status = 'done'` 的 `(owner_id, agent_id, item_key, text_digest)`；`recordCall` 在单个 `database.transaction` 内插入全部 records 和 failures，异常会整批回滚。
- 失败条目通过 `listRecentFailures` + 时间下限过滤；存储失败时 `#storeFailedAt` 记录内存退避，并 `seal.release` 已密封的句子。
- 每日次数/费用 `countSince` 按 `invocation_id` 分组，`max(cost_micros)`；一次调用只算一次。
- 审批分数行通过 `approval_request_id ... ON DELETE CASCADE` 随审批删除；线程/运行删除时 `#runPayloadRefs` 收集 `sentence_ref`，随后删除 payload。
- 首页读取审批文字和 `ProductionHomeControl.approvalCopy` 走同一个 `HomeUrgencyService.approvalCopy`；`ProductionWebPush` 没有调用 `approvalCopy`。
- 新模型调用通过 `proactiveModel` + `begin: fresh`，写独立 input payload，不触碰对话线程。
- 标题分级门禁在 `approvalSource`；自动标题的 payload 分类来自第一条 owner 消息。
- `inBatches` 在 `scores()` 和 `#run()` 的 `listScores`/`listRecentFailures` 上都使用 2000 分批。

## 推测/未核实

- 双向控制符导致按钮视觉伪装，实际取决于未来前端渲染。
- 关闭时正在进行的打分会留下孤儿密封 payload，取决于关闭顺序和 payload store 的关闭行为。
- 规则摘要的实际敏感内容可能性。
- 所有测试是否实际通过、`prompt-manifest.json` 哈希是否匹配，未运行。
- 迁移 0095 合并时改号的影响按题目要求不展开。

# 作者说法逐条核对

1. **同一件事同一份文字摘要只有一行成功记录；并发后写整批失败，不留半批。**
   - **基本证实（读代码）**：唯一索引 `0095_home_item_scores.sql:34-36`；整批事务 `sqlite-home-urgency-operations.ts:256-275`。
   - 并发场景没有实际运行；“后写整批失败”由唯一索引+事务推断成立。
   - 测试 `test/integration/home-urgency.test.ts:1139-1184` 覆盖了“一批中第二条冲突时第一条也回滚”。

2. **失败条目 `retryAfterHours` 内不重发；存储写不进时内存退避并释放已密封的一句话。**
   - **证实**：`home-urgency.ts:355-360` 过滤 `failedRecently`；`home-urgency.ts:338-339` 清理过期内存退避；`home-urgency.ts:473-481` 释放 `sealed` 并写入 `#storeFailedAt`。
   - 测试 `home-urgency.test.ts:1083-1113` 覆盖。

3. **每天次数和费用都从表里数，一次调用无论打几件事只算一次。**
   - **证实**：`sqlite-home-urgency-operations.ts:127-139` 按 `invocation_id` 分组，`max(cost_micros)`，`count(*)` 为调用次数。
   - 测试 `home-urgency.test.ts:709-724` 覆盖。

4. **删除数据时审批一句话引用的密封内容一并清掉；审批行随审批记录级联删除。**
   - **证实（读代码）**：`0095_home_item_scores.sql:7` 的 `ON DELETE CASCADE`；`sqlite-governed-deletion.ts:1043-1052` 收集 `sentence_ref`；`#deleteUnreferencedPayloadRows` 真正删除。
   - 测试 `home-urgency.test.ts:1240-1268` 断言线程删除后分数行和 payload 行消失。
   - 注意：直接 `DELETE FROM approval_requests` 时审批分数行级联删除，但句子 payload 不会单独被删；这是设计（句子随 Run 删除），不是本次改动引入的路径问题。

5. **`approvalCopy` 和首页读取返回同一份经过同样核对的文字；推送还没接上。**
   - **证实**：`production-home.ts:528-550` 的首页审批来源通过 `readCopy` 读取；`production-home.ts:705-712` 把 `this.approvalCopy` 传入；`production-home.ts:739-750` 调同一个服务方法。`production-web-push.ts` 没有 `approvalCopy` 调用。
   - 测试 `home-urgency.test.ts:772-856` 对比了首页与 `approvalCopy` 的结果。

6. **独立后台请求，不改任何对话已发出的请求开头。**
   - **证实**：`production-model-composition.ts:500-540` 的 `proactiveModel` 用 fresh admission 和独立 `inputRef`，没有复用对话线程；`home-urgency.ts:167-194` 的提示词固定文字在最前，时间/时区/语言/上限在最后一行。

7. **主要测试在 `test/integration/home-urgency.test.ts` 和 `packages/application/test/home-urgency.unit.test.ts`。**
   - **证实**：两个文件都存在，且包含打分、排序、字节确定、失败、上限、审批文字、分级、删除、分批等用例。未运行。

8. **审批材料里的对话标题只在标题分级不高于审批分级时发送。**
   - **证实**：`production-home.ts:528-536` 比较 `classificationRank(thread.dataClassification) <= classificationRank(approval.intentSnapshot.dataClassification)`，不满足则 `conversation = null`。
   - 标题 payload 的分类来源：`production-thread-titles.ts:113-120` 使用第一条 owner 消息的 `dataClassification`。
   - 测试 `home-urgency.test.ts:1220-1238` 覆盖 sensitive/restricted/private/public 四种标题。

9. **打分和读取分数按 `HOME_URGENCY_ITEMS_PER_READ`（2000）分批，不会因条目超过单次上限整体失败。**
   - **证实**：`home-urgency.ts:144-152` 的 `inBatches`；`home-urgency.ts:283-285` 和 `350-360` 使用。
   - `sqlite-home-urgency-operations.ts:17` 的存储上限也是 2000。
   - 测试 `home-urgency.test.ts:1270-1298` 覆盖“2001 件不整体抛错、直接超限会抛”。
   - 唯一保留意见是第 2 条问题：两个常量各自独立。

# 必答问题

## 1. 会不会改变模型已经见过的请求开头？

**不会。** 这次新增的是独立后台调用，不走对话线程；`proactiveModel` 使用 fresh admission 和新的 input payload，不改系统提示、工具定义、历史消息或已发出的遮盖结果。

新调用自身的排列也符合规则：
- 固定的 `HOME_URGENCY.text` 在最前；
- 随后是本次的“参照”和“新条目”；
- 最后一行才是 `now`、`timeZone`、`language`、`affirmMax` 这些每轮可能变的值。

标题分级门禁只影响本次调用里的条目事实，不会回写任何已经发给模型的对话请求。依据 `.claude/rules/prompt-prefix.md:27-29`、`:67`，以及 `packages/application/src/services/home-urgency.ts:175-193`。

## 2. 会不会让同一段文字在不同请求里变成不同的字节？

**对“同样的输入”没有新增不确定性。**
- 标题是否出现取决于标题 payload 的稳定分级，不依赖前后消息的遮盖上下文。
- `maskFact` 对对象键排序后序列化；`reference` 和 `fresh` 都按条目编号排序。
- 每轮变化的时间、语言、按钮字数上限都在最后一行。
- 模型写的一句话和按钮文字是打分时一次性生成并存下的，读取时不会重新生成。

需要注意但不是本次 bug：同一段标题文字可能因为分级不同在一个请求里出现、在另一个请求里不出现；这是按条目元数据裁剪，不是“同样输入产生不同字节”。另外，如果规则摘要或 `from`/`label` 等事实在两次请求之间变化，参照区内容会变，这是第 2 步“参照即本次数据”的既有设计。

## 3. 有没有对应的自动检查？反向用例真的会失败吗？

**有自动检查，读代码看反向用例是有效的，但我没有运行测试。**
- 标题分级：`home-urgency.test.ts:1220-1238`，去掉门禁后 sensitive/restricted 标题会出现在 `facts.conversation`，测试会失败。
- 分批：`home-urgency.test.ts:1270-1298`，去掉 `inBatches` 后 `service.scores(2001)` 会被存储拒绝，测试会失败。
- 删除密封句子：`home-urgency.test.ts:1240-1268`，去掉 `sentence_ref` 收集后 payload 行仍存在，测试会失败。
- 整批回滚：`home-urgency.test.ts:1139-1184`，去掉事务后第一条新记录会留下，`rows` 长度断言会失败。
- 提示词排列/解析/按钮文字：`packages/application/test/home-urgency.unit.test.ts` 覆盖。

**缺口**：分批测试只验证空表不抛，没有验证跨批分数真正合并；见问题 3。

## 4. 改动产生或修改的每个值，使用它的地方都能接受吗？

逐个核对如下：

- **`threadTitle` 新增的 `dataClassification`**
  - 产生：`production-http-composition.ts:1173-1178` 返回 `payload.dataClassification`。
  - 使用：`production-home.ts:533-535` 的 `classificationRank`。
  - 接收方：`classificationRank` 接受 `DataClassification`；该值不会直接写入 `home_item_scores` 的 `data_classification`，所以不会被存储的“只允许 public/private/sensitive”约束拒绝。
  - 注意：类型是可选的（`production-home.ts:147-150`）。未提供时标题被保守地省略，安全，但未来调用方漏传会静默丢标题。生产代码目前只有 `production-http-composition.ts` 提供。

- **`HOME_URGENCY_ITEMS_PER_READ = 2000`**
  - 使用：`home-urgency.ts:149-150` 分批。
  - 接收方：SQLite `items()` 在 `> 2000` 时失败，当前两端相等。
  - 问题：两端常量独立，见问题 2。

- **模型用量用途 `home-urgency`**
  - 产生：`service-main.ts` 的 `purpose: "home-urgency"`；`MODEL_USAGE_PURPOSES` 包含该值；迁移 0095 的 `model_usage_observations` CHECK 包含该值。
  - 检查：`home-urgency.test.ts:1300-1316` 验证所有 purpose 可插入、未知 purpose 被 CHECK 拒绝。

- **提示词 id `home.urgency` / parser `parseHomeUrgency`**
  - 产生：`packages/prompt-catalog/src/review.ts` 的 `HOME_URGENCY.id`；manifest 增加 `home.urgency`；`prompt-output-contracts.unit.test.ts` 注册了 `parseHomeUrgency` 并把 `home.urgency` 列入结构化提示词清单。
  - 未核实：manifest 的 sha256 是否正确，需要 `check:prompt-catalog`。

- **合约里的 `model` 值**
  - `HOME_RANKS`、`HOME_SENTENCE_BASES`、`HOME_LABEL_BASES` 都加了 `"model"`；`production-home.ts`/`home-feed.ts` 产生这些值；`homeSnapshotSchema` 用枚举接收。
  - `label` 合约上限 64，存储上限 64；各语言显示上限 6/8/16，均不超过 64。

- **`copy_locale`**
  - 产生：打分时的 `locale()`，生产上是 `OwnerPreferenceLocale`（`zh-CN`/`en`/`ja`）或回退 `"en"`。
  - 存储校验长度 2–16，读取要求等于读的人的语言；这些值都能通过。

- **`home_item_scores` 的 id / text_digest / created_at**
  - id 为 `home-urgency:<16 hex>:<timestamp>:<index>`，长度小于 128；`text_digest` 为 sha256 的 64 位小写十六进制；`created_at` 来自 `clock.now()` 的规范 ISO。
  - 这些都能通过 `sqlite-home-urgency-operations.ts` 的 `bounded`/`DIGEST`/`valid` 校验。

- **模型写的按钮文字**
  - 产生：模型输出 `affirm`；存储校验长度 ≤64；读取校验各语言 grapheme 上限、是否等于否定文字。
  - **问题**：格式控制符（Cf）没有被校验，见问题 1。

- **`homeUrgency.modelRef` 配置**
  - 解析：`strict-configuration.ts` 的 `parseHomeUrgency` 校验是已配置的 generation 模型且接受 `private`；`parseProductConfiguration` 再次检查。
  - 使用：`service-main.ts` 用该 ref 构造 `proactiveModel`，`prepare` 再检查实际调用分级。

总体上，标题分级、分批读取、删除密封内容、`approvalCopy` 共用读取口这几处与作者说法一致；没有发现会改变已发对话请求开头或让同一输入产生不同字节的问题。需要处理的主要是模型按钮文字的格式控制符、两个 2000 常量的耦合、分批正向测试缺口，以及关闭时未 drain 后台打分。
