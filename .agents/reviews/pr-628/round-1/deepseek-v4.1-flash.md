## 侧重检查

- **错误路径**：网页推送 `#deliver` 在 `contentOf(item)` 抛错时改为 `#retryLater(..., "WEB_PUSH_CONTENT_UNREADABLE")`，不再整条记 failed（`apps/agent-service/src/production-web-push.ts:616-623`）；iPhone 路径在 `input.content(item)` 抛错时同样重试并 `continue`（`apps/agent-service/src/production-apple-push.ts:355-362`）。`settled` 的 `#content` 抛错只跳过当前 id（`production-web-push.ts:687-691`）。三条错误路径都读到了，处理符合题述目标。
- **不合规范 / 不可信输入**：错误对象来自解密/UTF-8 解码（`service-main.ts:2915-2925`，`fatal:true` 会抛）和消息读取；重试只记录 `lastCode`，不把错误文本写进推送。未发现新增信任边界。
- **安全 / 隐私**：`her_words` 的 sensitive/restricted 隐藏分支在 `#content` 里仍先于 `readText`，重试不会绕过隐藏（`production-web-push.ts` 的 `hidden ? privateMessage : text`）。本改动未放松遮盖。
- **资源耗尽**：内容读错走同一 `attempts` 计数器，`attempts > RETRY_DELAYS_MS.length` 即 failed，最多初次 + 3 次重试；`recordAttempt` 限制 0..100、`listDue` 有批上限。未发现无界重试。
- **不可撤销操作**：本改动无删除、外发或不可逆副作用。
- **规则/文档与代码一致性**：新 `rule_set` 文字“写了 `run_result` 的规则同时管 `her_words`”与 `pushQuietClassesOf` 完全一致（`packages/application/src/rules/rule-types.ts` 的 `pushQuietClassesOf`：`!named.includes("run_result") || named.includes("her_words")` 时原样返回，否则补 `her_words`）；规格第 347 行改后的那句也与代码一致。
- 顺带发现一处**与本 diff 无关**的既有不一致：`docs/execution/specs/2026-11-11-apple-device-body-design.md:660`、`:1007` 说“她的话全文显示，不遮盖”，但当前 `#content` 对 sensitive/restricted 仍显示“你有一条私密消息”，测试也断言隐藏。未核实这是否是后续批次，未列为本次意见。

## 已读代码证实

- 网页路径发送失败的原有语义被原样抽到 `#retryLater`：`rate_limited` 仍在 `#send` 中单独处理，其他 retry 用 `RETRY_DELAYS_MS`（`production-web-push.ts:1019-1050`、`:1080-1091`）。
- iPhone 路径 `#retryLater` 保留 `rate_limited` 的 `RATE_LIMIT_DELAY_MS`，其余用 `RETRY_DELAYS_MS`（`production-apple-push.ts:508-536`）。
- `recordAttempt` 的 UPSERT 只在原状态为 `pending` 时更新（`packages/persistence-sqlite/src/sqlite-web-push-operations.ts` 的 `recordAttempt`、`sqlite-apple-push-operations.ts` 的 `recordAttempt`），因此第 1 次插入、后续 pending→pending、最后 pending→failed 都能写入；`listDue` 只在 `pending` 且 `next_attempt_at <= now` 时取出，attempts 会累加。
- `pushQuietClassesOf` 确实实现“显式 `run_result` 同时管 `her_words`”，默认清单含 `her_words`。
- `field-catalog.ts` 的 `push_class` 说明已包含 `her_words`，与本 PR 文字不冲突。

## 推测 / 未核实

- 两个 SHA-256（`packages/prompt-catalog/prompt-manifest.json` 的 `tools.rule-set` 与 `apps/agent-service/test/production-runtime-tools.unit.test.ts` 的两组常量）无法用现有只读/git 工具重算；**未核实具体值**。对应自动检查存在：`prompt-catalog.unit.test.ts` 会报 `PROMPT_MANIFEST_STALE`，`production-runtime-tools.unit.test.ts:2116-2124` 会比对摘要。
- 未实际运行测试；“去掉修复会失败”是按代码路径推断（见必答问题 3）。

---

### 1. 低：提示词文字改动只对新对话生效，已冻结的老对话看不到“run_result 同时管 her_words”
- 文件:行：`.agents/instructions/prompt-prefix.md:42`、`:44`；`packages/application/src/services/thread-prompt-bundle-service.ts:152-157`、`:96-109`；`packages/runtime-pi/src/pi-runtime-adapter.ts:1411-1412`
- 问题：`rule_set` 的说明文字属于工具定义（请求前缀）。按规则，文字改动只对新对话生效；代码也只在工具名/参数结构变化或显式 rebuild 时换新。因此本 PR 想让模型“知道写了 `run_result` 就同时管 `her_words`”这一句，对已在线上冻结的对话不起作用，只有新对话、rollout 首次冻结的对话、或手动 `thread prompt rebuild` 后才生效（`rule-review` 后台调用会用到新文字，因为它不是冻结对话）。
- 证据：`toolSchemaChanged` 只比较 `parsedTools` 出的 `{name, parameters}`（`:96-109`、`:152-157`），工具级 `description` 被忽略；`frozenToolText` 虽把 description 写进 bundle（`pi-runtime-adapter.ts:570-583`），但复用判断不看它。规则原文：“改了提示词文字，只对新对话生效。要让老对话也用上，必须手动换新。”
- 建议：在交付说明里写明老对话不会自动获得这句说明；若这是产品必须，安排一次对话换新（或确认旧对话本就会删除/重建），不要误以为改文字会自动生效。

### 2. 低：`settled` 的“只跳过这一条”没有反向用例覆盖
- 文件:行：`test/integration/production-web-push.test.ts:909-912`；`test/integration/push-channels.test.ts:1809-1821`
- 问题：新的 `settled` 反向用例只传了一个读不出的 `brokenId`，断言返回 `[]`；既有 `[IOS-9]` settled 用例也没有读不出项。它只能证明“读不出会抛异常/被跳过”，不能证明“同一批里另一条仍然结算”。如果有人把整个循环包进一个 `try/catch`，一条读不出就返回 `[]`，这两个用例都会通过，违背“只跳过这一条”。
- 证据：`expect(await push.settled([brokenId])).toEqual([]);`（只有单个 id）；另一条 `expect(await context.push.settled([liveId, doneId, "unknown_id"])).toEqual([doneId]);` 不含读不出项。
- 建议：在同一次 `settled` 调用里传 `[brokenId, doneId]`，断言只返回 `[doneId]`；iPhone 侧也补一条对应用例。

### 3. 低：`settled` 吞掉 `#content` 的所有异常，连程序性错误也降级为“这条不结算”
- 文件:行：`apps/agent-service/src/production-web-push.ts:687-691`
- 问题：需求是“内容读不出只跳过这一条”，但 `catch` 覆盖整个 `#content` 调用，`#content` 里的 `TypeError`、数据形状错误等程序性错误也会被当成单条跳过，接口仍正常返回 200，只剩 `onFailure` 日志。故障范围一大时，调用方看到的是“永远没结算”，而不是明显的 500，排查会更难。
- 证据：
  ```ts
  try {
    if ((await this.#content(item, approvals, now)).expired) settled.push(id);
  } catch (error) {
    this.#options.onFailure(error);
  }
  ```
- 建议：能区分“读取/解密失败”与“代码错误”时只吞前者，或至少在日志/指标里标出 `settled_content_unreadable` 与其它异常，避免系统性 bug 被静默成“未结算”。

### 4. 低：iPhone 的内容读不出重试没有覆盖 1/5/15 分钟节奏和三次后 failed
- 文件:行：`test/integration/push-channels.test.ts:596-606`；`apps/agent-service/src/production-apple-push.ts:524-536`
- 问题：网页测试逐步验证了 61 秒、+301、+901 和最终放弃，但 iPhone 用例只验证了一次“61 秒后重试成功”。“不挡后面的推送”覆盖了，`#retryLater` 在 Apple 是**独立实现**（不共享网页的），固定 60 秒无限重试或漏掉 `attempts > RETRY_DELAYS_MS.length` 的 bug，这个用例抓不到。
- 证据：iPhone 用例最后只做 `context.setClock(at(T0, 61)); await context.push.tick();` 后断言第二条出现，没有读不出到底时的 `failed/attempts` 断言。
- 建议：补一条一直读不出的 iPhone 用例，按 +61、+361、+1261 验证重试，再在之后确认不再尝试且 `web_push_attempts` 为 `failed`、`attempts` 为 4。

---

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
- 会改变工具定义文本本身（`TOOL_RULE_SET.text` 进入 `description`，`production-runtime-tools` 摘要也随之变），但**对已冻结的对话不会改变已经见过的开头**：`promptBundleChange` 只比较工具名、模型、推理强度、回答语言（`thread-prompt-bundle-service.ts:81-94`），`toolSchemaChanged` 只比较参数结构、忽略 description（`:96-157`），所以老对话沿用旧 bundle。新对话、首次 rollout 冻结、或手动 rebuild 的对话会使用新文字。
- 本改动没有改请求组装流程；发出的内容仍是工具定义→系统提示→历史→最后一条用户消息，本轮会变的值没有搬进前缀。
- 代价是：老对话不会自动获得这句新说明（见意见 1）。

**2. 同一段文字会不会在不同请求里变成不同字节？**
- 不会。新增的只有静态工具说明文字和静态 manifest/测试摘要；推送正文来自消息原文与固定 `WEB_PUSH_TEXT`，重试时正文相同。重试之间的 `ttlSeconds`、`app_badge` 可能变化，但那是推送载荷，不是发给模型的内容，也没有引入依赖前后文的遮盖或不排序集合。未发现本改动新增非确定性字节。

**3. 有没有对应的自动检查，反向用例是否真的会失败？**
- 有：`prompt-catalog.unit.test.ts` 抓 manifest 摘要过期；`production-runtime-tools.unit.test.ts:2110-2124` 比对两组工具定义摘要；两个集成测试覆盖网页和 iPhone 的内容读错重试、以及 `settled` 不 500。
- 按代码推断：去掉网页内容读错的重试，`broken`/`flaky` 会立刻永久 failed，`production-web-push.test.ts:915` 的 bodies 断言失败；去掉 `settled` 的 catch，`:912` 的 `await push.settled` 会直接 reject；去掉 iPhone 的 catch，`broken` 抛出会让 `said` 发不出，`push-channels.test.ts:602` 失败。因此作者“去掉修复时失败”的说法在逻辑上成立（**未实际运行**）。
- 不足：`settled` “只跳过一条、其余照常结算”与 iPhone 的完整 1/5/15/放弃节奏没有反向用例（意见 2、4）。

**4. 每个新值的使用端都能接受吗？**
- `pending` / `failed`：两端 `ATTEMPT_STATUSES` 都收（`sqlite-web-push-operations.ts`、`sqlite-apple-push-operations.ts`），`routeOutbox` 也把 `pending` 视为 APNS 已占用。
- `attempts` 1..4：`recordAttempt` 校验 0..100；`listDue` 把 `attemptCount` 读回 `attempt.attempts`，用于下一次累加和 `attempts > RETRY_DELAYS_MS.length` 的放弃判断。两端一致。
- `nextAttemptAt`：由 `Date.parse(now)+delayMs` 生成 ISO 字符串，`recordAttempt` 用 `time()` 校验 ISO；`listDue` 用 `next_attempt_at <= now` 过滤。可接受。
- `WEB_PUSH_CONTENT_UNREADABLE` / `PUSH_CONTENT_UNREADABLE`：只作为 `lastCode` 写入 `web_push_attempts.last_code`；`recordAttempt` 不校验 `lastCode`，全仓 grep 没有其它读取/白名单，使用端都能接受（也意味着没有专门诊断可读性）。
- `prompt-manifest.json` 的 `sha256`：由 `prompt-catalog.unit.test.ts` 的 `digest(entry)` 校验，值不对会失败；**具体值未核实**。
- `production-runtime-tools.unit.test.ts` 的两个摘要常量：由同一测试用 `JSON.stringify(descriptors)` 重算；**具体值未核实**。
- `rule_set` 新文字：`production-owner-rules.ts` 用作工具 description，`rule-review-service.ts` 用作后台提示词，均只消费字符串；参数 schema（`PUSH_QUIET_CLASSES` 的 enum、`maxItems`）未变，使用端无需改动。
