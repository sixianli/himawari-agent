## 发现（按严重度）

### 1. 中高｜邮件记录会把“根本没发给模型”的内容记成已拦截

- 文件:行：`packages/application/src/services/proactive-mail-check-service.ts:198`、`:209`、`:346-356`；`packages/application/src/services/proactive-mail-body.ts:10-22`
- 问题：真正发给模型的正文是“先遮盖、再截断”的窗口文本，附件也只取前 10 个；但记录扫描的是完整的原始正文和全部附件。正文中段、第 16000 字符之后、第 11 个及之后的附件名里的敏感值，会被记成 `masked`，可它们从未进入模型请求。
- 证据：
  ```ts
  // proactive-mail-check-service.ts:198
  const windowed = item.body === null ? undefined : windowMailBody(masked(item.body), bodyLimit);
  // :209
  attachments: item.attachments.slice(0, MAX_ATTACHMENTS_SHOWN).map(...)
  // :349-356
  const sightings = batch.flatMap((item) =>
    [
      item.from,
      item.subject,
      item.body ?? item.snippet,
      ...item.attachments.map(({ filename }) => filename),
    ].flatMap((text) => findSensitiveValues(text)),
  );
  ```
  且 `DEFAULT_PROACTIVE_BODY_LIMITS.perMail = 16_000`（`:100-101`），`MAX_ATTACHMENTS_SHOWN = 10`（`:106`）。
- 建议：扫描对象必须与真正进入 prompt 的文本一致：先对原始正文调用 `windowMailBody`（再对窗口文本做 `findSensitiveValues`），附件只扫描前 `MAX_ATTACHMENTS_SHOWN` 个；或让 `proactiveMailView` 在遮盖前把“将要遮盖的文本”交给回调。补一个反向用例：敏感值位于正文中段或第 11 个附件名时，不应产生记录。
- 标注：【读代码证实】。

### 2. 中｜标题生成等“对话派生”的后台调用记录 threadId 为 null，删对话时不会跟着删

- 文件:行：`apps/agent-service/src/production-model-composition.ts:459-467`、`:636-645`；`packages/persistence-sqlite/src/migrations/0078_sensitive_interceptions.sql:25-26`；`apps/agent-service/src/production-thread-titles.ts:74-76`
- 问题：`generateTitle` 拿到的是带 `threadId` 的 `request`，但辅助模型 transport 把所有请求的 `egressContext.threadId` 固定为 `null`，`purpose` 才用 `text.purpose`。标题生成 prompt 里如果有密码/验证码/卡号，经出口遮盖后产生的记录就是 `thread_id = NULL`，而外键级联只在 `thread_id` 非空时生效，因此删对话后记录仍留在“后台”记录里，和“删对话时记录跟着删”不一致。记忆整理、动作复核等辅助调用同理。
- 证据：
  ```ts
  // production-model-composition.ts:461-467
  egressContext: {
    ownerId: options.ownerId,
    agentId: options.agentId,
    threadId: null,
    source: "background",
    purpose: text.purpose,
  },
  ```
  ```ts
  // :636-639
  generateTitle: (request: RuntimeRequest, prompt: string, gate: ModelInvocationPort) =>
    generateText(request, prompt, gate, { purpose: "thread-title", ... })
  ```
  标题路径只做 `assertMachineSecretFree(text)`（`production-thread-titles.ts:74`），它不处理密码/验证码/卡号；这些值会由出口遮盖记录。
- 建议：凡是请求本身带 `threadId` 的辅助调用（标题、记忆整理、动作复核等），把 `request.threadId` 传进 `auxiliaryModelFor`/`egressContext`；只有真正不属于某个对话的后台调用才用 `null`。补一个用例：标题生成时产生记录 → 删除对话 → 记录消失。
- 标注：【读代码证实】。

### 3. 中低｜同一个值、同一个 part 可能因“规则不同”产生两行，违背“每轮只占一行”

- 文件:行：`packages/application/src/services/model-egress.ts:201`；`packages/persistence-sqlite/src/sqlite-sensitive-interception-operations.ts:60-74`；`packages/sensitive-capture/src/redaction.ts:215-219`、`:268-281`
- 问题：记录身份和数据库去重键都包含 `ruleId`。而 `known` 在一次请求内跨消息共享：历史消息里带关键词的密码会以 `password-keyword` 命中，后面当前消息里再次出现同一个值会以 `named-earlier` 命中。两者 `part`、`kind`、`fingerprint` 相同，但 `ruleId` 不同，于是同一值/同一 part 会有两行，界面看起来像重复记录，且各自累加次数。
- 证据：
  ```ts
  // model-egress.ts:201
  const identity = `${part}\u0000${kind}\u0000${ruleId}\u0000${fingerprint}`;
  ```
  ```ts
  // sqlite-sensitive-interception-operations.ts:63-72
  JSON.stringify([
    item.threadId, item.source, item.purpose, item.part,
    item.category, item.ruleId, item.fingerprint, item.outcome,
  ])
  ```
  ```ts
  // redaction.ts:276-279
  text = text.replace(pattern, () => {
    tally(counts, kind);
    see(kind, "named-earlier", value);
    return placeholder;
  });
  ```
- 建议：去重键不包含 `ruleId`，把命中的规则作为附属信息记录（例如另存规则集合，或保留第一次命中的规则并统计其余规则次数）；或者在“同一 fingerprint + part”已经记录过时，不再单独开 `named-earlier` 行。补一个“历史密码 + 当前消息再提一次”的用例，断言只有一行。
- 标注：【读代码证实（场景可达）】。

### 4. 低｜队列溢出时如果诊断日志抛错，后续写入不会被调度

- 文件:行：`packages/application/src/services/sensitive-interception-recorder.ts:124-134`
- 问题：`onDropped` 抛错时直接 `return`，跳过了后面的 `this.#schedule()`。队列里剩下的记录要等到下一次 `observe`、读取、清除或停机才可能写入；如果一直没有新事件，就会延迟到停机。
- 证据：
  ```ts
  if (excess > 0) {
    this.#queue.splice(0, excess);
    this.#dropped += excess;
    try {
      this.#options.onDropped?.(excess);
    } catch {
      return;          // 跳过了 #schedule()
    }
  }
  this.#schedule();
  ```
- 建议：把错误吞掉但继续执行到 `this.#schedule()`，或用 `finally` 保证调度；日志失败不应影响记录落库。
- 标注：【读代码证实】。

### 5. 低｜邮件记录的准备阶段扫描不在 try 内，“记录失败不影响请求”的结构性保证不完整

- 文件:行：`packages/application/src/services/proactive-mail-check-service.ts:346-362`
- 问题：只有 `onMasked(sightings)` 被 `try/catch` 包住；`findSensitiveValues` 和 `item.attachments.map` 在 try 之外。若扫描或数据形状在运行时抛错，`#reportMasked` 会把异常抛回 `run()`，在 `#judge` 之前中断整批邮件判断。普通数据下不太可能触发，所以定为低。
- 证据：
  ```ts
  const sightings = batch.flatMap((item) =>
    [
      item.from,
      item.subject,
      item.body ?? item.snippet,
      ...item.attachments.map(({ filename }) => filename),
    ].flatMap((text) => findSensitiveValues(text)),
  );
  if (sightings.length === 0) return;
  try {
    onMasked(sightings);
  } catch {
    return;
  }
  ```
- 建议：把整个 `#reportMasked` 的函数体放进 `try/catch`，记录失败只写诊断，绝不影响后续模型调用。
- 标注：【读代码证实（异常路径可达）】。

### 6. 低｜页面数字混用“记录条数”和“发送次数”

- 文件:行：`apps/control-center/src/components/sensitive-interceptions.tsx:71-79`、`:117-123`；`apps/control-center/src/sensitive-interceptions.ts:19-21`；`packages/persistence-sqlite/src/sqlite-sensitive-interception-operations.ts:211-224`
- 问题：筛选按钮上的数字来自 `summarize`，是“行数”；条目里的 `maskedOnce/maskedMany` 用的是 `seenCount`，是“这次值被上报/发送的次数”。文案却写成“发给模型前遮住 {count}”“之后 {later} 次发送”，两个“次数”不是同一个定义。加上发现 1 的邮件多报，页面上的数字和实际发给模型的内容可能对不上。
- 证据：
  ```tsx
  // components/sensitive-interceptions.tsx:74-77
  { id: "all", count: total },
  { id: "masked", count: counts.masked },
  ...
  { id: "notSaved", count: counts.notSaved },
  ```
  ```tsx
  // :121-123
  return item.seenCount <= 1
    ? message("sensitive.maskedOnce", { time })
    : message("sensitive.maskedMany", { time, later: item.seenCount - 1 });
  ```
  ```ts
  // sensitive-interceptions.ts:19-21
  return counts.masked + counts.withheld + counts.notSaved;
  ```
- 建议：文案明确区分“N 条记录”和“N 次发送”；筛选计数标注为记录条数，条目里如需展示发送次数就明确写“发送 N 次”。另外先修复发现 1，否则“发送次数”本身不可信。
- 标注：【读代码证实】。

---

## 必须回答的三个问题

### 1. 会不会改变模型已经见过的请求开头？

**不会。** 就本 diff 看，发给模型的内容没有新增字段；新增的 `observe`/`report` 只是旁路回调，不参与生成请求体：

- `redactForEgress` 的 `see()` 只调用 `observe`，并在 `observe` 抛错时吞掉（`packages/sensitive-capture/src/redaction.ts:178-185`）。
- `ModelEgress` 在 `redactForEgress` 返回后才调用 `#report`，且 `#report` 自身捕获所有异常（`packages/application/src/services/model-egress.ts:129-137`、`:220-221`）。
- 新增的 `partOf`/`part` 只影响上报元数据，不参与 `text()` 的返回字符串；`maskTree` 的 `tool_calls` 分支也只影响 `part`，最终 `maskArguments` 对 `arguments` 仍使用 `"tool_call"`。
- 测试已在字节层面比较：`packages/application/test/model-egress.unit.test.ts` 的 `sends the same bytes ... even when recording fails`，以及 `packages/runtime-pi/test/prompt-prefix.compat.test.ts` 的 `[SI-2] ... sends the same bytes as without recording`。邮件侧 `test/integration/proactive-mail-check.test.ts` 的 `[SI-3]` 也断言 `watched.prompts` 与无 `onMasked` 时完全相同。

因此仍然是“只在末尾追加”；本轮会变的值没有进入系统提示/工具定义/历史前缀。`generatedAt`、`firstSeenAt`、`lastSeenAt` 这类时间只进入数据库/API/页面，不进入模型请求。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

**本改动不会。** 遮盖逻辑本身没有被改成依赖后续内容或时间：

- `observe` 不修改 `known`/`table`，也不修改返回文本；`see` 的异常被吞掉。
- 指纹只用于上报，HMAC 使用固定标签 `himera...`（实际为 `himawari.sensitive-interception.fingerprint.v1`）和稳定密钥；不进入请求体。
- 数据库 `dedupe_key` 是对固定顺序数组的 `sha256`（`sqlite-sensitive-interception-operations.ts:60-74`），集合顺序固定。
- 邮件扫描使用 `findSensitiveValues`，不修改 prompt。

需要区分：**记录行的“规则归属”可能因同一请求内消息顺序而变化**（例如密码在前文是 `password-keyword`、后文变成 `named-earlier`），但这只影响数据库行的 `rule_id`，不影响发给模型的字节。遮盖密钥轮换会让占位符变化，这是既有的、文档已说明的缓存失效原因，不是本 PR 引入的。

### 3. 有没有自动检查，反向用例真的会失败？

**有，且部分反向用例是真正能失败的：**

- `packages/sensitive-capture/test/redaction.unit.test.ts`：`observe` 抛错时输出与不传监听器相同；如果 observe 影响了遮盖，这条会失败。
- `packages/application/test/model-egress.unit.test.ts`：`report` 正常/抛错时请求字节都必须等于没有记录时；如果 report 改变字节或异常外泄，这条会失败。
- `packages/application/test/sensitive-interception-recorder.unit.test.ts`：数据库失败、日志监听器抛错、时钟抛错时 `reportEgress` 不抛、`flush` 仍 resolve；如果记录失败影响调用方，这条会失败。
- `test/integration/sensitive-interceptions.test.ts`：去重、分页、按 agent 隔离、清除、对话删除级联、非法字段拒绝。
- `test/integration/sensitive-interceptions-browser.test.ts`：有数据/空状态/清除/手机深色三语；空状态反例是真的。
- `scripts/check-layout-audit.mjs`：`REQUIRED_KINDS` 加入 `CONTENT_PUSHED_SIDEWAYS`，并用故意做坏的页面自检；如果检测器失效，自检会失败。

**仍然缺的反向用例：**

- 没有“敏感值在正文被截断的中段/第 11 个附件名，不应产生记录”的用例（对应发现 1）。
- 没有“标题生成等辅助调用产生的记录随对话删除”的用例（对应发现 2）。
- 字节相等测试只覆盖 chat completions；`/messages`、`/responses`、`/embeddings` 只测了 part，没有逐字节比较。
- 没有覆盖“同一个密码在前文 password-keyword、后文 named-earlier”的去重用例（对应发现 3）。
- 没有直接查询数据库、日志和 API，断言不存在原值/可反推短验证码的哈希；从代码看当前路径是安全的，但没有自动化护栏。

---

## 与作者说法的核对（简要）

- “迁移 0078、复合外键、thread_id 为空不受约束”：**属实**，见 `0078_sensitive_interceptions.sql:24-27`。
- “去重键是出处、规则、指纹、结果等字段的 sha256”：**属实**，实际还包含 `threadId`、`purpose`、`category`。
- “值指纹用遮盖密钥加标签 HMAC、取前 16 字节”：**属实**，`model-egress.ts:198-200`、`:490-495`。
- “记忆指纹改用哪次整理/第几条候选/哪部分/哪条规则”：**属实**，`sensitive-interception-recorder.ts:99-103`；它不包含原值，不能反推短验证码。
- “redactForEgress 不传 observe 行为不变、observe 抛错不影响结果”：**redactForEgress 路径属实**；直接调用导出的 `redactMachineSecrets` 并传入会抛错的 observe 时没有单独保护，但生产路径不会这样用。
- “记录服务 200ms 批量写、上限 2000、丢最旧并写诊断、停机前写完、读取/清除前先 flush”：**基本属实**；`onDropped` 抛错会跳过调度（发现 4）。
- “邮件在交给模型前已被预先遮好，另在 ProactiveMailCheckService 报出”：**部分属实**；报出的范围大于真正发送的窗口（发现 1）。
- “读取接口不含 fingerprint 和规则 id”：**字段层面属实**；但返回的 `id` 是包含 fingerprint+ruleId 的 `dedupe_key` 的 sha256（`sqlite-sensitive-interception-operations.ts:22-24`），不是原指纹，也不能反推，属于可接受但值得明确的设计。
- “删对话时记录跟着删”：**仅对 thread_id 非空的记录成立**；标题/辅助模型记录为 `threadId:null`（发现 2）。
- “顺带修手机设置弹窗并加 CONTENT_PUSHED_SIDEWAYS”：**代码存在**；实际视觉修复未运行/未核实。
- “工具输出整段拦下的 5 处不记录”：**未核实**，不在本次 diff 的主要路径内。

（受工具限制，本次未运行测试和 `check:*`；以上测试存在性来自读代码，未声称执行通过。）
