# 复核结论（PR 309 第 2 轮，head 87636974）

先给总评：本轮增量**没有改变发给模型的内容**，核心修复（只计有反馈记录的推送、按推送聚合、条件写入、上限、清理）方向基本正确；但新增反向用例里有一条**实际守不住**，聚合后的“点开清零”还出现了一个语义变化，另外两处说明与代码不完全一致。

---

## 一、读代码证实的问题（按严重度）

### 1. 中：无 @ 地址的反向用例即使去掉修复也不会失败
- 位置：`test/integration/proactive-mail-check.test.ts:1035`
- 问题：`does not classify a sender address without an at sign` 只断言 `verdict === "pushed"`。旧实现会把它分到 `due:not-an-address`，但这是新类，被忽略数为 0，本来就照常推送，所以去掉修复该用例仍通过。
- 证据：
  - 用例只查 verdict：
    ```ts
    it("does not classify a sender address without an at sign", async () => {
      const h = await harness();
      await ignoredPushes(h, 3);
      expect(await pushDue(h, "odd", "not-an-address")).toMatchObject({ verdict: "pushed" });
    });
    ```
  - 旧 `senderDomain` 对无 @ 字符串返回整串：
    ```ts
    return address.slice(address.lastIndexOf("@") + 1).toLowerCase();
    ```
    `lastIndexOf("@")` 为 -1，于是 `slice(0)` 得到 `"not-an-address"`；旧 `proactivePushClass` 会返回 `due:not-an-address`。
  - 但该类此前没有推送，`countIgnoredPushes` 为 0，`previewBackoff` 返回 allow，`writes` 又会过滤掉 `stage===0 && !steppedUp`，所以没有任何可观察差异。
- 建议：直接查 `source_insights.push_class` 断言为 NULL；或连续 3 次用同一个无 @ 地址（旧代码会累积到 `due:not-an-address` 并进入台阶），再断言第 4 次仍 `pushed` 且 `listBackoff` 为空。也建议补一个 `fromAddress=""` 的用例，因为生产的 `senderAddress()` 对解析不出的 From 正好返回空串，而旧代码会生成 `due:` 这个类。

### 2. 中：聚合后“点开清零”被 `unneeded` 抢先，混合推送不再触发 break
- 位置：`packages/persistence-sqlite/src/proactive-push-backoff.ts:66`
- 问题：同一个 `pushKey` 内只要有一条 `unneeded`，代码就 `ignored += 1`，且**永远不会检查这条推送的 `opened`**。于是“既被点开、又有一条被评‘不需要’”的推送不会触发“遇到被点开的就停（计数清零）”，更早的忽略会继续被计入，可能过度降频。这和 ADR 的“有一条被点开就算被点开”“遇到一条被点开的就停（计数清零）”不一致。
- 证据：
  ```ts
  for (const push of pushes.values()) {
    if (push.unneeded) ignored += 1;
    else if (push.opened) break;
    else if (Date.parse(push.at) <= cutoff) ignored += 1;
  }
  ```
  ADR 原文（`docs/adr/0184-back-off-ignored-proactive-pushes.md:40`）：“同一条推送里只要有一条被评‘不需要’就算被忽略，有一条被点开就算被点开……遇到一条被点开的就停（计数清零）”。
  另外旧代码是逐行判断：`if (rating === "unneeded") ignored++ else if (openedAt !== null) break`，多条提醒时仍会在 opened 行 break；新聚合把“点开”这个 break 条件彻底旁路了。
- 建议：明确优先级。如果采用“点开优先”，应先判断 `push.opened` 再判断 `push.unneeded`；如果采用“不需要优先”，就要在 ADR 写明“同时被点开时仍算忽略且不重置计数”，并补一条混合推送的反向用例。

### 3. 低：文档写“确实发到设备上”，代码只证明推送服务返回 2xx
- 位置：`docs/adr/0184-back-off-ignored-proactive-pushes.md:40`；`packages/platform-node/src/web-push-sender.ts:32`
- 问题：反馈行只在 `recordAttempt` 状态为 `sent` 时写入，而 `sent` 的定义是 HTTP 2xx，仅代表推送服务受理，不代表设备收到（设备离线、消息过期都可能没到）。因此“没送达的推送不计 / 只数确实发到设备上的推送”是比代码更强的说法。
- 证据：
  ```ts
  if (status >= 200 && status < 300) return { kind: "sent" };
  ```
  ```ts
  if (recorded && input.status === "sent")
    ... INSERT INTO web_push_feedback ...
  ```
- 建议：措辞改为“推送服务已受理（有反馈记录）”，或另记设备回执后再声称“发到设备”。

### 4. 低：断开来源时清理整张表，未按 source 限定
- 位置：`packages/persistence-sqlite/src/sqlite-proactive-operations.ts:463`
- 问题：新增的 `DELETE FROM proactive_push_backoff WHERE owner_id = ? AND agent_id = ?` 不按 source 过滤；`proactive_push_backoff` 本身也没有 source 列。今天 `SOURCES = ["gmail"]`，行为正确；将来加第二个来源时，断开一个来源会误清所有来源的降频状态，而 catalog 和 ADR 写的是“断开该来源时清掉”。
- 证据：
  ```ts
  .prepare("DELETE FROM proactive_push_backoff WHERE owner_id = ? AND agent_id = ?")
  .run(input.ownerId, input.agentId);
  ```
  `const SOURCES = ["gmail"] as const;`（同文件第 28 行）。
- 建议：加注释说明“当前只有 gmail，清理全部等于清 gmail”；或在接入第二个来源前给表加 source 维度。

### 5. 低：catalog 把 `push_class` 说成“发件人域名”，实际是带前缀的类键
- 位置：`packages/persistence-sqlite/src/schema-catalog.ts:886`
- 问题：描述写“push_class holds the sender domain”，实际值形如 `due:service.example.com`（`proactivePushClass` 返回 `due:${domain}`）。
- 证据：`"one row per source thread with a result; ... push_class holds the sender domain of a pushed reminder in plain text"`；`return ... \`due:${domain}\`.slice(0, 128);`
- 建议：改成“holds the push class key (`due:<domain>`)”，避免下一位读者按域名取 `push_class`。

---

## 二、推测 / 未能核实

- **资源规模**：`countIgnoredPushes` 没有 `LIMIT`，且 stage 0 时 `sinceAt` 是 `EPOCH`，因此会取该类的全部历史反馈/提醒并在内存建 Map。小规模没问题；长期大量推送时开销随历史线性增长。是否成为实际问题是推测（未跑基准）。
- **恢复与同一次检查**：条件写入只能保证“恢复后不覆盖状态表”，不能撤销同一次检查里已经基于旧状态压掉的提醒；ADR 的“恢复后下一条立即推送”只对后续检查成立。这是行为说明，不是明确 bug。
- **读连接快照**：条件写入依赖 preview 读到的 `updated_at` 与写事务读到的完全一致；若读上下文拿到过期快照，合法台阶写入会被静默跳过（下次检查再试）。当前架构下单查询读最新提交，正常不会发生，未核实并发读副本场景。

---

## 三、侧重检查（错误路径 / 不可信输入 / 安全 / 资源 / 不可逆 / 文档一致）

- **不可信输入**：`push_class` 来自发件人域名，已 `includes("@")`、空域名判空、`toLowerCase()`、`slice(0,128)`，迁移有 `length BETWEEN 1 AND 128`，SQL 全参数化，未发现注入或超长问题。
- **未送达/失败路径**：失败、无订阅、`expired`、`suppressed` 都不会写 `web_push_feedback`，因此不会计数；这条与代码一致。但“送达”仅到 2xx，见问题 3。
- **恢复/清理不可逆操作**：`removeSource` 与 `clearRecords` 都在事务里；`removeSource` 的清理范围见问题 4。恢复只把 `stage` 置 0、保留 `ignored_count`，overview 又按 `stage>0` 过滤，不会把旧计数显示出来，可接受。
- **并发条件写入**：`applyBackoffWrites` 在 `record` 的同一事务内先读 `stage/since_at/updated_at` 再 upsert；写事务已持写锁，恢复无法在读写之间插入提交，本地原子性成立。
- **文档一致性**：ADR 的 reason 规则（`counts.pushed===0`）、1000 上限、最低可写版本 81 都已和代码/迁移对上；不一致的是“发到设备”和 catalog 的 `push_class` 描述。

---

## 四、必答问题

### 1. 会不会改变模型已经见过的请求开头？
**不会。** 本次改动没有触碰系统提示、工具定义、历史消息或遮盖结果；所有改动发生在模型判断**之后**（`#gateBackoff`、写库、清理）和展示层。`proactivePrompt` 未改，`push_class`/降频状态都不进入提示词。因此不存在“非末尾追加”的问题——根本没有改动发给模型的内容。

### 2. 同一段文字会不会在不同请求里变成不同字节？
**不会。** 新增/修改的值（`push_class`、`backoff` 状态、`base`）都只进数据库和总览/命令，不进模型输入。`now`、`first_sent_at`、`updated_at` 只用于数据库判定和并发比对，不参与提示词。类键由小写域名决定，稳定。

### 3. 改动有没有对应自动检查，反向用例是否真的会失败？
有 [PA-6] 共 13 条，数量与作者说法一致。逐条判断：
- 会失败（有效反向）：`undelivered`（962，旧 LEFT JOIN 会按 `insight.updated_at` 计数）、`one ignored push once`（971，旧代码按行计数会到 3）、`keeps the normal reason`（1003，旧代码会返回 `PUSH_BACKED_OFF`）、`clears on disconnect`（1041，无 DELETE 时仍剩 1 行）、`restore wins + cap`（1050，无条件写入会变 stage 2，无上限会触发 DB CHECK 抛错）。
- **不会失败（无效反向）**：`does not classify a sender address without an at sign`（1035），理由见问题 1。
- 另一个小缺口：`PUSH_SUPPRESSED` 的“同一次检查还有别的推送时保持 URGENT”只有 steppedUp 的用例覆盖，suppressed 分支没有对应用例。

### 4. 新增/修改的每个值，各使用处都能接受吗？
逐个核对：
- `source_insights.push_class`：写入端 `proactivePushClass` 保证非空时 `due:<domain>` 且 ≤128；迁移 CHECK 1–128、可空；读取端只有 `countIgnoredPushes` 的过滤和 overview 的 `classKey.slice(indexOf(":")+1)`，都能接受。**join 两端已对齐**：`record` 写 `push_source_key = proactive:${push.id}`（`sqlite-proactive-operations.ts:869`），生产 outbox 用 `sourceKey: proactive:${push.id}`（`production-web-push.ts:362`），反馈表再用该 `source_key`，所以聚合键确实能对上。
- `ignored_count`：写入端 `Math.min(write.ignoredCount, 1000)`，与迁移 `CHECK (... <= 1000)` 一致。
- `base`（`ProactiveBackoffPreview`/`ProactiveBackoffWrite`）：唯一实现是 sqlite `previewBackoff`，唯一写入消费是 `applyBackoffWrites`；`product-state-repository` 只是委托 durable adapter，没有第二份实现；作为普通对象经 IPC 序列化，没有严格 schema 会丢弃/拒绝它。
- `reason_code`：没有新增码，只是条件切换为已有的 `PUSH_BACKED_OFF`/`PUSH_SUPPRESSED`/`URGENT`/`QUIET_HOURS`，决策表不受影响。
- 清理表：`proactive_push_backoff` 无 source 列，当前只有 gmail 来源所以“清全部”可接受，但扩展性见问题 4。

**总体建议**：合并前至少修掉问题 1（把无 @ 用例改成真正会失败的用例）和问题 2（明确 opened/unneeded 优先级并加用例）；问题 3–5 建议顺手改文档/注释。
