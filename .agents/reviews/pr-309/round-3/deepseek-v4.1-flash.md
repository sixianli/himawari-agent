## 结论

本轮增量只有一处行为改动：`countIgnoredPushes` 里把“点开”判在“不需要”之前；其余是 ADR 措辞、schema catalog 说明和测试。该改动与 ADR 第 3 条、以及总览里已有的“点开优先”口径一致，未发现会阻塞合并的新问题。新增的混合推送用例确实是该修复的反向用例。下面列出的是读代码时发现的问题，其中主要几条是本 PR 早先提交就存在、本轮未触碰的遗留项。

## 发现的问题（按严重度）

### 1. 低 — 长发件人域名被截断后可能与他类合并（遗留，非本轮新增）
文件：`packages/application/src/services/proactive-mail-check-service.ts:111-115`

问题：分类键由 `due:${domain}` 生成后直接 `.slice(0, 128)`。域名最长可达 253 字符，两个前 124 字符相同的长域名会落到同一个 `push_class`，导致不同发件人共享降频计数；界面上显示的 `domain` 也会是被截断的片段。没有对应测试。

证据：
```ts
export function proactivePushClass(fromAddress: string): string | null {
  if (!fromAddress.includes("@")) return null;
  const domain = senderDomain(fromAddress);
  return domain.length === 0 ? null : `due:${domain}`.slice(0, 128);
}
```

建议：对超长域名改为“可读前缀 + 哈希后缀”，或明确拒绝过长域名；补一条 125 字符以上域名的用例。【读代码证实】

### 2. 低 — 被忽略计数会扫描该类别全部历史，无上限（遗留）
文件：`packages/persistence-sqlite/src/proactive-push-backoff.ts:43-56`、`66-70`、`10`、`89`

问题：台阶 0 时 `sinceAt` 取常量 `EPOCH`，查询条件只有 `first_sent_at > ?`，没有 `LIMIT`；每次检查对该类别的所有历史推送做 JOIN 并全部载入内存。历史越久，开销越大。攻击面有限（需要真实推送记录），但属于随数据增长的无界扫描。

证据：
```ts
const EPOCH = "1970-01-01T00:00:00.000Z";
...
const sinceAt = row?.sinceAt ?? EPOCH;
...
const ignored =
  stage >= 2
    ? 0
    : countIgnoredPushes(database, scope, classKey, sinceAt, now, settings.ignoreAfterMs);
```

建议：按 `first_sent_at DESC` 设 `LIMIT threshold + 1` 或读到点开后立即停止，避免取回全部历史。【读代码证实】

### 3. 低 — 断开任一来源会删除这个 Agent 所有类别的降频状态，且不可恢复
文件：`packages/persistence-sqlite/src/sqlite-proactive-operations.ts:463-465`；`packages/persistence-sqlite/src/schema-catalog.ts:895`

问题：`removeSource` 按 `owner_id + agent_id` 删除整张 `proactive_push_backoff`，不区分来源，属于不可撤销的删除。catalog 写的是“when the source is disconnected”，有歧义。当前主动检查只有 Gmail 一个来源，所以暂无实际越界；将来增加来源后，断开一个来源会清掉另一个来源的降频状态。

证据：
```ts
this.database
  .prepare("DELETE FROM proactive_push_backoff WHERE owner_id = ? AND agent_id = ?")
  .run(input.ownerId, input.agentId);
```

建议：让降频表带来源维度，或把 catalog/ADR 明确写成“断开任一来源会清空该 Agent 的全部降频状态”。【读代码证实 + 对未来来源的推测】

### 4. 低（推测）— 同一时间戳的多条推送排序可能不稳定
文件：`packages/persistence-sqlite/src/proactive-push-backoff.ts:54`、`66`

问题：查询按 `feedback.first_sent_at DESC, insight.id DESC` 排序，Map 以首次出现的 `pushKey` 决定遍历顺序。若两条不同推送恰好有相同的 `first_sent_at`，推送级没有稳定的次序键，理论上可能把“遇到点开就停”应用在错误的先后顺序上。正常时钟推进下不会发生。

建议：排序增加 `feedback.source_key` 作为最终 tie-breaker。【推测，未构造实例】

## 侧重检查

- **非法/不可信输入**：`fromAddress` 无 `@` 或域名为空时返回 `null`，不会建类；已核对 `senderDomain` 取最后一个 `@` 之后并转小写。未校验域名语法，且存在上面的长域名截断问题。SQL 全部参数化，未发现注入。
- **错误路径与发送失败**：`web_push_feedback` 只在 `recordAttempt` 状态为 `sent` 时写入（`sqlite-web-push-operations.ts:434-446`），而生产发送端把 HTTP 2xx 映射为 `sent`（`packages/platform-node/src/web-push-sender.ts:33`）。因此“失败/无订阅不计入”与 ADR 新措辞一致。
- **安全**：`push_class` 明文存域名，ADR 已接受；该值只在 React 文本和 SQL 参数中使用，未发现 XSS 或拼接 SQL。分类键写库前被截到 128，满足迁移 0081 的 `length BETWEEN 1 AND 128` 和网关 `boundedString(128)`。
- **资源耗尽**：见问题 2 的无界历史扫描；单次检查的类别数受一批邮件数约束，未发现其他放大点。
- **不可撤销操作**：`removeSource` 的整表删除见问题 3；`restoreBackoff` 只把台阶清零并从恢复时刻重新计数，不删除状态行，符合 ADR。
- **规则/文档一致**：已通过 `git show HEAD:.claude/rules/prompt-prefix.md` 读取规则。ADR 第 3 条、catalog 的 `due:<sender domain>` 与代码的 `due:${domain}` 一致。ADR 第 62 行的概括仍写“评‘不需要’算忽略”，没有提混合推送例外，但该条描述的是纯“不需要”用例，不构成矛盾，可不动。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。本轮唯一的生产代码行为改动是 `proactive-push-backoff.ts:67-68` 的分支顺序；另外两处是字符串文档和 ADR。改动没有触及系统提示、工具定义、历史消息、遮盖逻辑或提示词目录，也没有把 `push_class`/降频状态送进模型输入。按 `.claude/rules/prompt-prefix.md` 第 4 条（已发出的内容只能追加），这个 PR 仍然不改任何已发内容；按第 15 条，后台调用若涉及时间等变化值也仍在末尾，本 PR 未改这部分。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   不会因本轮改动产生。分类键只由发件人地址确定（`senderDomain` + 小写 + 固定前缀），不依赖数据库返回顺序；服务在调用 `previewBackoff` 前还对 `classKeys` 做了 `.sort()`（`proactive-mail-check-service.ts:974-978`）。该值也不进入模型请求。

3. **有没有对应的自动检查，反向用例是否真的会失败？**
   有。新增 `proactive-mail-check.test.ts:1049-1083` 的混合推送用例：两条同域名提醒在同一次推送里，一条标记点开、一条评“不需要”，随后断言下一条仍 `pushed` 且没有降频状态。按代码推演，如果把分支改回“先判不需要”（旧代码），这条推送会被计 1，加上此前的 2 次忽略正好达到阈值 3，下一条会被压成 `PUSH_BACKED_OFF`，断言 `verdict: "pushed"` 会失败。无 `@` 用例 `1035-1047` 则是 D9 守卫的反向用例：若去掉 `fromAddress.includes("@")` 守卫，会写出 `due:not-an-address`，`push_class IS NOT NULL` 的断言失败。以上为代码推演，受工具限制未实际运行测试。

4. **改动涉及的值，产生处和使用处是否都能接受？**
   能，逐个核对如下：
   - 产生：`proactivePushClass` 生成 `due:<domain>`，并用 `.slice(0, 128)` 保证长度；
   - 写库：`sqlite-proactive-operations.ts:863-868` 写入 `push_class`，迁移 0081 的 CHECK 接受 1–128；
   - 计数：`countIgnoredPushes` 用同一个函数产生的 `classKey` 比较 `push_class`，两端格式一致；
   - 总览/恢复：`proactive-overview.ts:286` 从 `classKey` 去掉 `due:` 前缀得到显示域名，前端把原样的 `classKey` 传给 `proactive.backoff.restore`；网关契约是 `boundedString(128)`，数据库查找也用同值；
   - 测试夹具：`CLASS_KEY = "due:service.example.com"` 与产生格式一致。
   唯一例外是问题 1：超长域名被截断后，存储的“域名”不再是完整域名，且可能碰撞；除此之外两端校验均能接受。
