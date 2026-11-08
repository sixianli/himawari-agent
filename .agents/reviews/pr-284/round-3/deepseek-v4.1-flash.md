# PA-1 第 2 轮复核结论

我按“读代码证实”和“推测”分开写。没有发现高严重度问题；下面按严重度排列。

---

## 一、读代码证实的问题

### 中：`relatedFailedSteps` 的写入端没有收口，持久层却会拒绝超过 16 条或空串

- 文件:行：`packages/application/src/services/proactive-mail-check-service.ts:534`、`:1215`；`packages/persistence-sqlite/src/sqlite-proactive-operations.ts:539-544`
- 问题：服务把失败步骤原样塞进 `Set`，`#finish` 时全部传给 `store.record`；持久层要求最多 16 条、每条长度 1–64。生产读取器目前最多只会产生 `thread/subject/reference/budget/timeout/read` 六种，所以现在不会触发；但只要 `reader.related` 返回更多不同步骤（或空串），`store.record` 会抛 `Proactive check inputs are invalid`，整个检查失败、不落账，违背“整个检查不因此失败”的降级目标。这正是 I-73 那类“两端校验不一致”。
- 证据：
  - `trace.relatedFailedSteps.add(failure.toLowerCase().replace(/[^a-z0-9_]+/gu, "_").slice(0, 64));`（service:534-539）
  - `relatedFailedSteps: [...trace.relatedFailedSteps].sort(),`（service:1215）
  - `inputs.relatedFailedSteps.length <= 16 && ... step.length >= 1 && step.length <= 64`（sqlite:539-544）
- 建议：在 `#finish` 前把 Set 截到 16 条、过滤空串（空串回退成 `read`），或让持久层接受更宽范围并统一在一处校验。

### 低：作者“读取失败时这封退回只看自己”与代码不一致

- 文件:行：`packages/platform-node/src/gmail-related.ts:147-159`；`packages/application/src/services/proactive-mail-check-service.ts:541-546`；`packages/prompt-catalog/src/mail.ts:17`
- 问题：某一步失败后，`findRelatedMail` 仍把此前已收集到的部分旧邮件写进 `byMail`；服务端即使 `failure` 存在也照用 `byMail`，于是邮件会同时带“部分旧邮件”和 `relatedUnavailable:true` 发给模型。这与提示词第 17 行“或只取到一部分”一致，但与作者说明“退回只看自己”不一致。测试也只覆盖了“另一封失败、这封成功”，没有覆盖“同一封既带部分旧邮件又失败”。
- 证据：
  - catch 后仍执行 `byMail.set(item.messageId, ordered.slice(-limits.perMail));`（gmail-related:150-159）
  - `const view = relatedMailView(fetched?.byMail.get(item.messageId) ?? [], failure !== undefined, limits);`（service:541-546）
- 建议：要么把作者说明改成“保留已取到的部分并标 `relatedUnavailable`”，要么在失败时丢弃 `pool`；并补一条“部分结果 + 失败”的测试。

### 低：超时发生在取 OAuth token 阶段时被记成 `read`，不是 ADR 写的 `timeout`

- 文件:行：`packages/platform-node/src/gmail-source.ts:250-251`；`packages/application/src/services/proactive-mail-check-service.ts:526-531`；`docs/adr/0180-...md:43`
- 问题：`related` 先调用 `options.oauth.accessToken(token, signal)`，这一步在 `findRelatedMail` 的逐封 try/catch 之外。若半程超时正好落在这里，异常直接冒泡到 `#related` 的 catch，`fetched = undefined`，随后每封记 `read`；只有超时落在 thread/search/message 请求里才会记 `timeout`。ADR 第 43 行说“到点后……`relatedFailedSteps` 记 `timeout`”，并非所有超时路径都成立。
- 证据：
  - `const access = await options.oauth.accessToken(token, signal);`（gmail-source:251）
  - `} catch { fetched = undefined; }` → `const failure = fetched === undefined ? "read" : ...`（service:526-531）
- 建议：在 `#related` 的 catch 里判断 `signal.aborted` 并记 `timeout`，或在 `createGmailReader.related` 里把 token 获取也纳入逐封失败处理。

### 低（文档）：案例库“面试 30 秒版”仍写“只把发件人、标题和一行摘要交给模型”

- 文件:行：`docs/engineering-casebook.md:3065`
- 问题：作者新增了 PA-1 跟进段，但同一案例的 30 秒版仍停留在旧描述；ADR 0159 之后已经读全文，PA-1 之后还读旧邮件，文档与代码不一致。
- 建议：同步改写这段，或明确标注它描述的是 v1 初始形态。

---

## 二、推测（未写测试或未实际触发）

### 低：`mentions` 的边界检查把 `-` 也当成“更长号码”，编号后紧跟连字符会漏

- 文件:行：`packages/platform-node/src/gmail-related.ts:49`
- 说明：`if (!/[A-Z0-9-]/u.test(before) && !/[A-Z0-9-]/u.test(after)) return true;` 中 `-` 属于“非边界”。例如旧邮件写 `ご注文 12345678-の件`，编号后是 `-`，会被判成更长的号码而漏掉。测试只覆盖了“数字被更长数字包住”的反例，没有覆盖“编号后紧跟格式连字符”。建议把 `-` 从“必须独立出现”的边界字符里去掉，或补测试确认取舍。

### 低：标签后若跟 ISO 日期会被当成编号，可能拉进无关邮件

- 文件:行：`packages/platform-node/src/gmail-related.ts:14`、`:24`、`:43-53`
- 说明：正则只要求标签后是 8–40 位含数字的 `[A-Z0-9-]`，因此 `order 2026-11-07` 会抽出 `2026-11-07`，再按这个字符串搜邮箱、只核对字符串出现。若另一封无关邮件也含这个日期，会被当成“同一件事”。这是启发式误报，建议在提取后排除纯日期形状，或要求编号含字母或至少两段数字。

### 低：`related` 阶段为全部候选一次性保留完整正文，内存占用随新邮件数线性放大

- 文件:行：`packages/application/src/services/proactive-mail-check-service.ts:505-556`、`:247-291`、`:675-686`；`packages/platform-node/src/gmail-body.ts:5`、`:197-200`
- 说明：`#related` 先对所有 `candidates` 构建 `RelatedView`，其中 `mails` 持有完整的 `ProactiveSourceItem`（正文上限 20 万字符）。默认每封 6 封旧邮件、单次最多 300 封新邮件时，最坏约 1800 封正文常驻，量级可达数百 MB；配置上限 50 时更大，且即使这些邮件最终因每日上限不会发给模型，也先做了遮盖和截断。请求预算 300 限制了“请求数”，但 `thread` 一次响应可包含很多封。建议按批计算，或在生成 `json` 后只保留遮盖结果/sighting，不保留完整 `mails`。

---

## 三、侧重检查

- **错误路径**：读取器抛错、半程超时、请求预算用完、部分失败、Gmail 404、模型失败都走过。降级总体成立；发现“超时被记成 read”和“部分结果 + 失败”两处小问题。
- **不可信输入**：`subject` 被去掉双引号后拼进 Gmail 搜索；`reference` 被限制在 `[A-Z0-9-]`；搜索结果本地再核对标题/对方/编号；只发只读 GET。未发现注入或不可撤销操作。`subject` 里的反斜杠没有转义，但只影响搜索语义，结果还会本地复核。
- **安全/隐私**：只读 scope；会把已归档和主人发出的旧邮件发给模型，三种语言的设置说明已如实更新；旧邮件逐字段遮盖（`maskSensitiveText` → `redactForEgress`，不带 known/tag），没有新增明文日志。
- **资源**：请求预算、每封旧邮件数、正文长度都有上限；但“全部候选一次性构建 RelatedView”有内存放大风险（见推测第 3 条）。
- **不可撤销操作**：没有；`gmail-related.unit.test.ts:303` 断言所有 URL 不含 modify/send/delete。
- **规则/文档与代码一致**：ADR 0180、设计说明、设置文案基本一致；发现案例库 30 秒版未同步（低）。`prompt-manifest.json` 的 sha256 无法在本次只读、无执行权限下复算，未核实。

---

## 四、必答问题

### 1. 会不会改变模型已经见过的请求开头？

不会改变对话的请求开头。`MAIL_JUDGMENT` 只被 `proactive-mail-check-service.ts` 使用（`grep MAIL_JUDGMENT` 仅命中该服务与目录定义），不进入对话系统提示。这是一次性后台调用，没有对话历史；`proactivePrompt` 的顺序仍是：固定指令 → 记忆（本轮数据）→ 邮件数据（含新增 `related`）→ 最后的 `MAIL_JUDGMENT_NOW`。每轮会变的值（记忆、邮件、旧邮件、当前时间）都在固定指令之后，当前时间仍在最后。唯一一次性的变化是固定指令文字本身新增两行，这会让部署后首次主动检查的前缀缓存失效一次，不属于“每轮变化”，ADR 0180 也已说明不涉及冻结前缀。

### 2. 会不会让同一段文字在不同请求里变成不同字节？

新代码里不会因前后文改变遮盖：旧邮件的 `from`、`subject`、`body`/`snippet` 各自调用 `maskSensitiveText`（内部 `redactForEgress`，不带 `known`/`tag`），只由该字段自身决定；旧邮件按 `receivedAt` + `messageId` 排序，顺序固定；`related` 里没有当前时间字段。需要注意的两点：旧邮件集合本身会随邮箱状态和共享预算在不同检查间变化，但它位于数据区、不是对已发内容的改写；`localeCompare` 理论上依赖 locale，但对 ASCII 的 messageId 和 ISO 时间戳实际稳定，且这是既有写法。结论：不违反“同一段文字每次同样字节”的规则。

### 3. 有没有对应的自动检查，反向用例真的会失败？

有。`gmail-related.unit.test.ts` 覆盖标题归一、编号识别、三种关联、预算/超时、只收更早邮件、编号被更长数字包住、搜索命中但本地不含编号；`proactive-mail-check.test.ts` 的 `[PA-1]` 覆盖完整时间线、账本只记真正发送的批次、读取失败/部分失败、遮盖、数量上限、同发件人不同事的反例、每日费用用完跳过、旧邮件 `bodyUnavailable`；`startup-configuration.unit.test.ts` 覆盖四个新配置键的默认值、`relatedMailsPerMail:0` 和三类非法值；`proactive-production.test.ts` 走真实 `createGmailReader` 的 thread 路径；prompt golden/manifest 也更新了。按代码推演，`isEarlier`、`mentions` 边界、去掉 `ID/No./#` 标签、旧邮件遮盖、账本只记发送批次这些反例在改动前会失败。未覆盖或覆盖不足：半程超时的信号接线、单封邮件“部分旧邮件 + 失败”的组合、`mentions` 对编号后连字符的边界。我无法运行测试，实际是否全绿未核实。

### 4. 每个新值的两端校验

- **配置键** `relatedMailsPerMail/relatedCharactersPerMail/relatedCharactersPerRelatedMail/relatedRequestsPerCheck`：产生于 `strict-configuration.ts:1020-1048`，消费于 `production-proactive.ts:180-185` → 服务 `#relatedLimits`。范围与不变式一致（`perMail` 0–50、`requests` 1–2000、`charactersPerMail ≥ charactersPerRelated`）；`0` 在服务里被当作“不找”，与文档一致。
- **`participants`**：由 `gmailItem` 产生，`gmail-related.ts` 的 `counterparts/sharesCounterpart` 消费；字段可选，其他 reader 不受影响。
- **`relatedByMail`**：键是被判邮件 id（≤300，< 500），值每封 ≤ 配置上限 50，持久层 `ids(list, 64)` 接受，唯一性由 `Map`/pool 保证；两端一致。
- **`relatedRead`**：枚举 `off/ok/partial/failed`，两端一致。
- **`relatedStats`**：服务产生非负整数，持久层校验 safe integer ≥ 0，一致。
- **`relatedFailedSteps`**：唯一不一致点，见“中”那条。
- **`related`/`relatedUnavailable` 提示字段**：产生于 `relatedMailView/proactiveMailView`，消费于提示词与固定说明；不影响模型输出契约。
- **`prompt-manifest.json` 的 `sha256`/`changedIn`**：`changedIn:"PA-1"` 只要求非空，能过；`sha256` 无法在本次权限下复算，未核实。

---

## 五、未核实

- `prompt-manifest.json` 的新 sha256 是否等于 `mail.judgment` 的 segments 摘要（无法运行哈希）。
- 作者所说 `npm run check` 41 步中 3 步在干净 main 同样失败、第 0 层 49 文件 942 条通过（无法运行测试）。
- 真实 Gmail `threads.get`/搜索响应、上线后的费用增幅、真实邮箱正反验收。
- 本次未运行任何测试，以上反向用例“会失败”的判断来自代码推演。
