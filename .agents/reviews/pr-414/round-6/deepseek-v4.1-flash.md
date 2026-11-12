## 总体判断

第 6 轮增量（`85239d09..cdde9c43`）确实只是三件事：`deferItem` 的规则状态校验从 `active` 放宽到 `active`/`needs_review`、长期规则词表补月/年/季度词、ADR 改名 0242→0244。**状态放宽这部分与代码其他处一致，没有发现会让审批被延后或让该发推送发不出去的改动**。主要问题集中在“一次性词表”这条线上：新增测试只覆盖了同一子句内的情形，跨子句的一次性限定仍会被误判为长期规则。

---

## 问题（按严重度）

### 1. 中：跨子句的一次性限定不起作用，一次性请求仍会被立成长期规则

- 文件:行：`apps/agent-service/src/production-owner-rules.ts:450-462`（配合 `:49`、`:146-164`）
- 问题：`isStandingQuote` 先按 `CLAUSE_BREAK` 把整句话切成子句，再逐个子句判断。一次性词只检查当前子句，因此“这个月，晚上别提醒我”里，“这个月”在第一个子句，“晚上别提醒我”在第二个子句，第二个子句没有一次性词，整句仍返回 `true`。这正好是第 6 轮新增词想防住的情况，但新增测试只用了没有逗号的 `"这个月晚上别提醒我"`。
- 证据（亲自读到）：
  ```ts
  // production-owner-rules.ts:49
  const CLAUSE_BREAK = /[\n\r。！？!?；;，,、…：:]+/u;
  // production-owner-rules.ts:451-461
  foldText(quote)
    .split(CLAUSE_BREAK)
    ...
    .some((clause) => {
      ...
      const standing =
        STANDING_MARKERS.some(...) ||
        (QUIET_REQUEST_MARKERS.some(...) &&
          RECURRING_TIME_MARKERS.some(...));
      return standing && !ONE_OFF_MARKERS.some((marker) => containsMarker(rest, marker));
    });
  ```
  “下个月起，晚上别提醒我”“今年先这样，以后夜里别提醒我”同理都会返回 `true`。
- 建议：把一次性判断的范围从“当前子句”扩大到“整句/整段”，但先剥掉 `STANDING_STARTS`（例如“从今天开始”“从现在起”），避免把 `从今天开始，以后每次……必须提醒我` 这类合法长期规则误杀；或者至少在出现“一次性时间词 + 逗号/分号”时要求同一句内再出现 `STANDING_STARTS` 才放行。补上 `"这个月，晚上别提醒我"`、`"下个月起，晚上别提醒我"` 这类反向用例。

### 2. 低：ADR 对“长期有效判断”的描述与代码不一致

- 文件:行：`docs/adr/0244-hard-rules-step4-unified-push-gate.md:53` 对 `apps/agent-service/src/production-owner-rules.ts:80-95`、`:457-460`
- 问题：ADR 说“`STANDING_MARKERS` 加了‘别提醒我、不要提醒我、别打扰我’等说法”，读起来像是单独出现“别提醒我”就算长期有效。代码实际把它放在独立的 `QUIET_REQUEST_MARKERS`，并且必须同时命中 `RECURRING_TIME_MARKERS`（夜里、晚上、周末、每天等）。测试也明确 `isStandingQuote("别提醒我") === false`。
- 证据：
  ```ts
  // ADR:53
  // `rule_set` 里“这是长期有效的话”的判断词表（`production-owner-rules.ts` 的 `STANDING_MARKERS`）加了“别提醒我、不要提醒我、别打扰我”等说法
  // production-owner-rules.ts:457-460
  const standing =
    STANDING_MARKERS.some(...) ||
    (QUIET_REQUEST_MARKERS.some(...) &&
      RECURRING_TIME_MARKERS.some(...));
  ```
- 建议：ADR 改成“新增 `QUIET_REQUEST_MARKERS`，必须与 `RECURRING_TIME_MARKERS` 同时出现；`STANDING_MARKERS` 本身不变”。

### 3. 低：新增月/年/季度词对邮件类规则同样生效，会误杀合法的长期规则；词表也有缺口

- 文件:行：`apps/agent-service/src/production-owner-rules.ts:146-164`、`:794-796`
- 问题：`isStandingQuote` 不区分规则类型，第 6 轮新增的“今年、明年、这个月、本季……”也会作用于 `mail_must_notify`、`mail_read_whole_thread`。例如“今年起每次收到入管局的邮件都必须提醒我”会因为含“今年”被判为一次性，不再直接立规则。这是相对上一轮的行为收紧；测试只覆盖了推送静默类句子。另外词表有缺口：`下月`、`上月`、`前年`、`月底`、`年底` 等未列，而 `本季度` 只是碰巧被已有的 `本季` 子串覆盖。
- 证据：
  ```ts
  // production-owner-rules.ts:794-796（不区分 type）
  const explicit =
    !input.inferred && isStandingQuote(quote) && (await this.#ownerSaid(input.threadId, quote));
  ```
- 建议：明确一次性词表是给“静默请求”用的还是全类型共用。若是全类型共用，补邮件类反向用例；若是只给静默用，把判断拆开。顺带补 `下月/上月/月底/年底` 等常用说法，或写注释说明只按现有词表匹配。

### 4. 低：ADR 验证清单没有列出本轮新增的 `needs_review` 用例

- 文件:行：`docs/adr/0244-hard-rules-step4-unified-push-gate.md:97-100`
- 问题：ADR 的“验证”只写了延后、撤销、读取失败等用例，没有提 `production-web-push.test.ts:777-794` 新增的“needs_review 也延后”。ADR 第 90 行已经写了 `active` 或 `needs_review`，验证一节却未同步。
- 建议：在验证清单补一条“待重审规则与生效规则一样延后并延长有效期”。

---

## 读代码证实的与推测分开

**读代码证实**

- `deferItem` 现在接受 `active`/`needs_review`：`sqlite-web-push-operations.ts:417-419`。这与 `ownerRules().list` 的过滤（`sqlite-owner-rule-operations.ts:88`）、`ruleIsEnforced`（`rule-book.ts:14-16`）一致；`retired` 仍被拒绝。
- 触发“待重审”的数据库触发器会同时 `revision + 1`（`migrations/0087_rule_book_memory_link.sql:357`、`:398`），所以放宽 `needs_review` 不会绕过“同一修订”的竞态检查。
- 新增测试是有效的反向用例：去掉 `needs_review` 后，`deferItem` 走 `stale` 分支（返回 `true` 但不写 `defer_until`、不写决策记录），测试中的 `held?.deferUntil === MORNING` 和 `ledger().length === 1` 会失败（`production-web-push.test.ts:777-794`）。
- “撤销规则后立即放出”和“读取后、写入前规则变成 retired”两个反向用例分别覆盖了“不要把 retired 当成有效”的边界（`production-web-push.test.ts:679-722`）。
- 第 6 轮新增的 `"这个月晚上别提醒我"`、`"明年夜里别提醒我"`、`"本季度夜里别提醒我"`、`"don't remind me at night this month"` 在去掉新增词后确实会从 `false` 变为 `true`（`production-memory-capture.test.ts:2123-2126`）。
- ADR 0244 改名完整：在 `*.md`、`*.ts`、`*.json`、`*.sql` 中已无 `0242-hard-rules`、`ADR 0242`、`adr/0242` 的残留；`prompt-manifest.json` 的 `changedIn` 与两份 spec 的链接也已更新。

**推测/未核实**

- `deferItem` 收到格式坏的 `ruleRef`（例如 `foo@abc`）时会得到 `NaN`，按 better-sqlite3 的通常行为绑定会抛错，然后由 `#deferred` 的 catch 转成“照发并告警”；这一点没有实际运行验证。
- 本轮没有重新核实迁移 0093 重建八张表的数据/触发器/外键细节，只确认了规则状态约束和 `decision_ledger` 的 `idList` 限制（≤200 项、每项 1–256 字符、去重）与 `deferItem` 的 16 条上限、256 字符上限兼容。
- 没有运行测试，只按代码路径推导“反向用例会失败”。

---

## 侧重检查

- **错误路径**：`readPushRules` 抛错、`PushGate.decide` 抛错、`deferItem` 抛错、`deferItem` 返回 `false`、规则在读取后被撤销，这五条路径都读到并核对了：前三条“照发并告警”，第四条“本轮照发”，第五条“本轮扣住、下一轮按新规则重判”。没有发现审批被延后的路径：`approval`、`muse_outage`、`unknown` 在 `#deferred` 进入规则前就被放行（`production-web-push.ts:454`，`web-push-gate.ts:29-34`、`:75`）。
- **不可信输入**：`parsePushQuiet` 对 `periods`、`days`、`start`、`end`、`classes` 都有类型、范围、数量上限校验并排序去重（`rule-types.ts` 新增段）；`isStandingQuote` 只接收模型给的 `quote`，但随后有 `#ownerSaid` 核对原话确实出现在主人的消息里，模型不能凭空造一句长期规则。
- **资源耗尽**：闸门按分钟向后找静默结束，最多 24 小时（1440 次判断），且同一轮按推送类别缓存判断结果（`production-web-push.ts:458-467`）；`ruleRefs` 上限 16、每项 256 字符，`defer_rule_refs` 有 JSON 数组约束。没有发现无界循环或无界 JSON。
- **不可撤销操作**：本轮增量没有删除、覆盖或迁移数据；只改了状态校验、词表和文档。
- **规则/文档/代码一致性**：发现 ADR 决策 5 与代码词表结构不一致（问题 2）、ADR 验证清单漏写新用例（问题 4）；ADR 第 90 行的 `active 或 needs_review` 与代码一致。
- **安全**：闸门失败一律放行（fail-open），且审批/Muse/未知来源不交给规则，没有发现“规则出错导致重要推送被吞”的新路径。残余风险是 `needs_review` 的规则会继续执行；这是 `ruleIsEnforced` 的既有设计，不是本轮引入。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

**会变一次，但不是每轮变。** 这个功能本身改了 `rule_set` 工具定义（新增 `push_quiet_hours` 类型和 `periods`/`classes` 参数），工具定义在请求最前面且按对话冻结（`prompt-prefix.md` 第 6 条），所以上线后所有老对话按 `ADR 0165` 重建一次，开头变一次；ADR 0244 第 83 行已记录这一点，作者说法也承认主人已同意。第 6 轮增量本身只把 `prompt-manifest.json` 的 `changedIn` 从 0242 改成 0244，没有改工具文字或哈希。重建之后，闸门和延后只读写数据库与出站表，不改系统提示、工具定义、历史消息或遮盖结果；每轮会变的 `now`、时区只参与运行时判断，没有写进请求开头。

结论：**严格说不是“只在末尾追加”，而是一次性的工具定义换新；这是已有 ADR 允许的例外。除这次换新外，后续每轮仍然只追加，会变的值不在开头。** 整条发送链我只核对了与本次 diff 相关的部分，未逐行重读全部组装代码（未核实）。

### 2. 同一段文字会不会在不同请求里变成不同的字节？

**没有发现。** 本轮新增的规则示例由 `parsePushQuiet` 先对 `periods` 排序、对 `classes` 按常量顺序过滤，`quietHoursExamples` 按固定类别列表和排序后的时段遍历；闸门里 `ruleRefs` 收进 `Set` 后再 `sort()`；决策记录编号是稳定字段的 SHA-256。没有把 `Map`/`Set` 的遍历顺序或时间字段写进模型请求。`now`、`deferUntil`、`decidedAt` 只进数据库，不进提示词。未发现遮盖依赖后文或无序集合泄漏到请求字节的路径。

### 3. 有没有对应的自动检查，反向用例真的会失败吗？

**有，而且新加的 `needs_review` 反向用例是有效的**：去掉状态放宽后，测试会因为 `deferUntil` 为空、决策记录条数为 0 而失败（`production-web-push.test.ts:777-794`）。`retired` 边界由 `production-web-push.test.ts:697-722` 覆盖：如果 `deferItem` 把 `retired` 也当有效，测试会看到不该存在的延后记录而失败。新增的一次性词测试（`production-memory-capture.test.ts:2123-2126`）去掉对应词也会从 `false` 变 `true`，所以也会失败。

**缺口**：没有“一次性词在另一个子句”的用例（如 `"这个月，晚上别提醒我"`），也没有新增词对邮件类长期规则影响的用例。因此问题 1 和问题 3 不会被现有自动检查抓到。

### 4. 每个新值/修改值的生产者和使用者都能接受吗？

- **`needs_review`（本轮修改的状态值）**：生产者是 `0087` 的触发器（`status = 'needs_review'`, `revision + 1`）；使用者有三处：`rule_book_rules` 的 CHECK（含 `needs_review`）、`ownerRules().list({includeRetired:false})` 的 `status IN ('active','needs_review')`、`ruleIsEnforced`，以及本轮新加的 `deferItem` SQL。三处一致，边界有测试。**通过。**
- **`defer_rule_refs` / 决策记录 `ruleIds`**：写入端排序、去重、1–16 条、每条 1–256 字符；迁移 CHECK 要求 JSON 数组；决策记录 `idList` 允许 ≤200 条、1–256 字符、去重。两端兼容。**通过。**
- **ADR 编号 0244**：`prompt-manifest.json`、两份 spec、`data-export-rules.test.ts` 的 `source` 都已改；全仓 md/ts/json/sql 已无 0242 引用。**通过。**
- **新增一次性词**：没有外部 schema，只被 `isStandingQuote` 使用；但它同时影响推送规则和邮件规则（见问题 3），这是本轮没有区分清楚的边界。
- **`prompt-manifest.json` 的 `changedIn`**：只是自由文本，未发现校验 ADR 是否存在的脚本（未核实）。
