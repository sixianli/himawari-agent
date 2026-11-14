## 侧重检查

本轮增量只改网页文案、i18n、测试和 ADR，没有新增输入解析、网络入口、文件写入或不可逆操作。我按错误路径逐一看过：

- **来源记忆缺失 / 编号为空**：`rechecking` 为假，待重审规则会显示 `review.notChecking`，符合预期。
- **核对连续失败到上限**：`reviewAttempts >= 3` 时 `rechecking` 为假，待重审规则显示 `review.notChecking`，符合预期。
- **已暂停后重新排队、核对又失败到上限**：代码没有显示“系统没法自动核对”，与 ADR 决定 4 的字面不一致（见问题 3）。
- **没有配置邮件检查 / 没有 proactive 的部署**：`rechecking` 仍可能为真，文案仍承诺“下次查邮件前系统自动核对”，永远不会兑现（见问题 2）。
- **失败重试间隔**：失败后 `review_after` 被设为 1 小时后，期间 `rechecking` 仍为真，文案仍承诺“下次查邮件前核对”，与 `listDue` 的 `review_after <= now` 条件冲突（见问题 1）。
- **安全与资源**：本轮没有新增秘密、外部输入或循环；规则核对服务仍是每批 3 条、输出上限 65,536 字节、60 秒超时。未发现本轮引入安全或资源耗尽问题。
- **不可撤销操作**：本轮没有。

## 读代码证实的

### 1. 中：`review.checking` / `review.rechecking` 承诺“下次查邮件前核对”，但在失败重试和批量上限下不成立

- 文件：`apps/control-center/src/components/correction-review.tsx:57-58`、`apps/control-center/src/i18n/resources/zh-CN.ts:887,893`、`packages/persistence-sqlite/src/sqlite-correction-review-operations.ts:346-349` 和同文件 `:191`
- 问题：`rechecking` 只表示“已排队、来源存在、未到 3 次失败”，并不表示“下次查邮件前一定核对”。`recordFailure` 把下次核对时间设为 1 小时后，但默认邮件检查间隔是 15 分钟；这期间 `rechecking` 仍为真，界面却写“下次查邮件前系统自动核对”。另外每次最多核对 3 条，排队超过 3 条时后面的规则也不会在下次查邮件前被核对。
- 证据：

```ts
// sqlite-correction-review-operations.ts:346-349
rechecking:
  row.reviewAfter !== null &&
  row.sourceMemoryId !== null &&
  row.reviewAttempts < RULE_REVIEW_MAX_ATTEMPTS,
```

```ts
// sqlite-correction-review-operations.ts:191
AND review_after IS NOT NULL AND review_after <= ? AND review_attempts < ?
```

```ts
// packages/application/src/ports/rule-review.ts:4-6
export const RULE_REVIEW_MAX_ATTEMPTS = 3;
export const RULE_REVIEW_RETRY_MS = 3_600_000;
export const RULE_REVIEW_BATCH = 3;
```

```ts
// packages/application/src/services/rule-review-service.ts:223
retryAfter: new Date(Date.parse(now) + RULE_REVIEW_RETRY_MS).toISOString(),
```

```ts
// packages/platform-node/src/strict-configuration.ts:1160（默认检查间隔 15 分钟）
intervalMs: optional("intervalMs", 900_000, 60_000, 86_400_000),
```

- 建议：文案不要绑定到“下次查邮件”，例如改回“系统会再核对”；或者让 `listOpen` 返回“下次可核对时间 / 是否已排队”，前端据此显示；也可把“失败后 1 小时重试、每次最多 3 条”写进文案。

### 2. 中：没有配置邮件检查的部署会永久显示“下次查邮件前系统自动核对”

- 文件：`apps/control-center/src/components/correction-review.tsx:57`、`docs/adr/0232-memory-corrections-flag-derived-memories-and-recheck-rules.md:93`、`apps/agent-service/src/service-main.ts:1796-1802`、`apps/agent-service/src/production-proactive.ts:342-347`、`apps/agent-service/src/production-http-composition.ts:683`、`apps/agent-service/src/production-memory-control.ts:74`
- 问题：`memory.review.read` 只要记忆功能可用就会装，和是否配置 proactive 无关；而 `RuleReviewService` 只在构造 `ProductionProactive` 时存在。因此没有配置邮件检查的部署仍会看到待重审规则，`rechecking` 由数据库字段算为真，界面显示“下次查邮件前系统自动核对”，但没有任何 tick 会执行核对。ADR 后果一节自己也承认“这句在这种部署上不会兑现”。这不是文档与代码不一致，而是把已知的错误文案留在产品里。
- 证据：

```ts
// production-proactive.ts:342-347
tick(): Promise<void> {
  this.#running ??= this.#checkable()
    .then(async (checkable) => {
      if (!checkable) return undefined;
      await this.reviewRules();
      return this.#service.run();
```

```ts
// service-main.ts:1796-1802：只有配置了 proactive 才创建服务
if (
  proactiveConfiguration &&
  (proactiveSecret || proactiveConfiguration.demoInbox) &&
  proactiveDescriptor &&
  proactiveStore &&
  proactiveSeal
) {
```

```md
// ADR 0232:93
没有配置邮件检查的部署不会自动核对，规则停在待重审并照常执行（已暂停的保持暂停），清单上“下次查邮件前系统自动核对”这句在这种部署上不会兑现。
```

- 建议：在服务端把“这台部署有没有规则核对能力”作为字段返回，前端据此显示 `review.notChecking`；或至少让文案不承诺会自动核对。若决定接受这个限制，应在 ADR 里写成明确的产品取舍并加一条界面测试，而不是只在后果里承认。

### 3. 低-中：ADR 决定 4 说“已暂停后重新排队的规则核对失败后也显示没法自动核对”，代码只对待重审规则显示

- 文件：`docs/adr/0232-memory-corrections-flag-derived-memories-and-recheck-rules.md:53`、`apps/control-center/src/components/correction-review.tsx:55-58`
- 问题：组件先判断 `suspendReason`，有暂停原因时只显示暂停原因；只有 `suspendReason && rechecking` 才追加“再次核对”。已暂停并重新排队的规则在 3 次失败后 `rechecking` 为假，界面只剩“已暂停：……”，不会显示“系统没法自动核对，请你看一下”，与 ADR 决定 4 的字面不一致。
- 证据：

```tsx
// correction-review.tsx:55-58
{rule.suspendReason
  ? message("review.suspendReason", { r: rule.suspendReason })
  : message(rule.rechecking ? "review.checking" : "review.notChecking")}
{rule.suspendReason && rule.rechecking ? ` ${message("review.rechecking")}` : null}
```

```md
// ADR 0232:53
3 次都失败写一条 `recheck_failed`，规则保持原样：待重审的照常执行（前提 2 的理由），已经暂停后重新排队的保持暂停；清单上不再写“系统自动核对”，改写“系统没法自动核对，请你看一下”
```

- 建议：在 `suspendReason` 分支也追加 `!rechecking` 的 `review.notChecking`；或者把 ADR 改成“只有待重审规则这样显示”，并补一条暂停规则的测试。

### 4. 低：ADR 决定 2 引用的文案已过时

- 文件：`docs/adr/0232-memory-corrections-flag-derived-memories-and-recheck-rules.md:51`、`apps/control-center/src/i18n/resources/zh-CN.ts:893`
- 问题：ADR 仍写“来源记忆又变了，系统会再核对一次”，代码和三种语言文案已改成“来源记忆又变了，下次查邮件前系统会再核对一次”。
- 证据：

```md
// ADR 0232:51
清单上在原来的暂停原因后面写明“来源记忆又变了，系统会再核对一次”
```

```ts
// zh-CN.ts:893
"review.rechecking": "来源记忆又变了，下次查邮件前系统会再核对一次（核对完之前保持暂停）",
```

- 建议：更新 ADR 引用，或改成引用 message id，避免以后文案再改时再次失配。

### 5. 低：`review.notChecking` 把“来源记忆编号为空”概括成“来源记忆不在了”

- 文件：`apps/control-center/src/i18n/resources/zh-CN.ts:888-889`、`docs/adr/0232-memory-corrections-flag-derived-memories-and-recheck-rules.md:53`
- 问题：ADR 明确提到“导入时来源记忆没带过来”也会走这个分支，但界面说“来源记忆不在了”，容易被理解为被删除了。属于文案细节，不影响行为。
- 建议：可改为“找不到来源记忆，或核对连续失败”。

## 推测

- 问题 2 的实际影响取决于生产里是否存在“记忆功能开启、proactive 未配置”的部署。仓库代码允许这种组合；具体部署是否有这种实例，无法从仓库确认。

## 未核实

- `.agents/reviews/pr-434/round-3/*`（包括 `judgments.md` 和 DeepSeek 第 3 轮原文）在本次检出中不可读，`read` 返回文件不存在，git 访问被策略拒绝。因此无法逐条核对第 3 轮 4 条意见的原文，只能按作者说明和当前代码核对。
- 出口遮盖的底层实现没有逐行读；我只核对了规则核对提示词的组装和参数排序。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   本轮增量不会：它只改网页文案、i18n、测试和 ADR，没有碰模型输入。整个 PR 新增的 `rule.review` 是独立的单次后台调用，不是往已有对话追加；`ruleReviewPrompt` 的顺序是固定说明 → 固定标题 → 固定“立规则说明” → 本次 `{memory,currentRule}` JSON，变化内容在最后一段，符合“固定的在前、会变的在后”。已有系统提示、工具定义、历史、遮盖路径在 diff 中没有变化。

2. **会不会让同一段文字在不同请求里变成不同的字节？**
   规则核对提示词未发现这种问题：不含时间字段；`entries()` 会去重并排序，`parseOwnerRuleParameters` 生成固定键序。`packages/application/test/rule-review-service.unit.test.ts:233-246` 还专门断言同一输入在不同数组顺序/大小写下产生逐字节相同的 prompt。出口遮盖实现未逐行核实。

3. **有没有对应的自动检查，反向用例真的会失败？**
   有部分覆盖：
   - `apps/control-center/test/correction-review.unit.test.ts:202-215` 覆盖 `rechecking:false` 的待重审规则；把第 57 行改回总是显示 `review.checking`，这条会失败。
   - `packages/persistence-sqlite/test/correction-propagation-migration.contract.test.ts:301-310,437-443` 断言核对出结论后、失败到上限后 `listOpen` 的 `rechecking` 为 false；`rechecking` 计算写错会失败。
   - i18n 完整性测试 `i18n-runtime.unit.test.ts:63-68` 保证三种语言键集一致、格式可渲染。
   - 没覆盖：问题 1 的重试间隔/批量上限文案、问题 2 的无 proactive 部署、问题 3 的暂停规则失败后文案。这些不是本轮失败的自动检查。

4. **每个改动值的使用方都能接受吗？**
   - `review.notChecking`：生产在 `apps/control-center/src/i18n/message-ids.ts:829`，使用在 `correction-review.tsx:57`，三种语言资源都有；客户端类型 `MessageId` 和 i18n 完整性测试会强制三语齐全。它不经过后端校验，未发现两端不接受的问题。
   - `rechecking`：生产在 `sqlite-correction-review-operations.ts:346-349`，经 `gateway-contracts/src/contracts-v2.ts:1727` 校验为布尔值，`production-memory-control.ts:630` 原样透传，前端由 `MemoryReview` 类型接收并在 `correction-review.tsx:57-58` 使用；契约 fixture 也给出了 `rechecking:false`。类型和契约两端都接受。
   - 全 PR 新增的用途标识 `rule-review`：在 `MODEL_USAGE_PURPOSES`（`ports/model-usage.ts:3-14`）、迁移 `0095_correction_propagation.sql:432-436` 的 CHECK、`sensitive-interceptions.tsx:252-257` 的用途映射以及三种语言资源里都存在，消费端能接受。未发现 I-73 那种“清单里的 id 过不了后端校验”的问题。
