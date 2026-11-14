## 结论摘要

本轮 749d2becb 的六条修复大体按作者说法实现：服务端候选按载荷级别跳过、已有记忆读到上限即停、读失败/全被确定性词表挡掉时返回 `skipped`、删除 `inputMicrosPerMillionTokens` 并新增 `dailyMaximumRequests`、`importDuplicateVerdict(undefined)` 返回 `skipped`、响应体边读边限 1 MiB。
但发现几处新问题，最值得先处理的是：**“全部已有记忆都是 sensitive/restricted”时仍被判成 `different`（默认勾选可导入），与作者第 (3) 条说法不一致**；以及**服务端判重没有利用已有的敏感判定缓存，敏感不外发只靠网页过滤和载荷级别**。

---

## 读代码证实的问题

### 中：全部已有记忆被敏感级别挡掉时，仍然判 `different` 而不是 `skipped`

- 文件:行：`apps/agent-service/src/production-memory-control.ts:1379-1385`、`apps/agent-service/src/production-memory-import-duplicates.ts:126-129`
- 问题：`#checkImportDuplicates` 在读取已有记忆时，直接跳过 `sensitive` / `restricted` 记录，但没有把 `complete` 置为 `false`：

```ts
for (const record of active) {
  if (existing.length >= limit) break;
  if (record.dataClassification === "sensitive" || record.dataClassification === "restricted")
    continue;
  const text = await this.readText(record.contentRef).catch(() => null);
  if (text) existing.push({ memoryId: record.id, text });
  else complete = false;
}
```

于是当主人所有已有记忆都是 sensitive/restricted 时，传进 checker 的 `existing` 是空数组、`complete` 仍是 `true`。checker 里：

```ts
if (known.length === 0) {
  if (existing.length === 0 && scan.complete)
    for (const index of asked) results[index] = { verdict: "different", memoryId: null };
  return results;
}
```

候选会被判成 `different`。前端 `different` 会进入“默认勾选可导入”：

```ts
checked:
  item.status === "ready" &&
  !duplicate &&
  duplicateCheck === "clear" &&
  !item.sensitive &&
  !item.coding,
```

因此这**不满足作者第 (3) 条“被全部挡掉判 skipped，只有确实一条都没有才判 different”**。相反，如果被挡掉的是 checker 内部的 `deterministicallySensitive` 文本（`existing.length > 0`），结果才会是 `skipped`，两种“被挡掉”行为不一致。

- 影响：主人如果只有敏感记忆，导入相同内容时不会提示“没能核对”，而是静默默认勾选导入，可能产生重复记忆；也容易让复核者误以为“敏感记忆不参与比较”已经有安全默认。
- 建议：在 control 层因 `sensitive` / `restricted` 跳过记录时同时设置 `complete = false`（或单独传一个 `hiddenExisting` 标记），让这类候选返回 `skipped`；并补一个“已有记忆全部敏感时结果为 `skipped`、不默认勾选”的反向测试。
- 说明：ADR 0265 第 88 行确实写了“已有敏感记忆不参与比较”，但“不参与比较”不等于“应当按 `different` 默认勾选导入”；这里的行为与第 (3) 条修复说明不一致。

### 中：服务端判重没有使用 `#sensitiveJudgments`，敏感不外发依赖网页单侧过滤

- 文件:行：`apps/agent-service/src/production-memory-control.ts:1310-1316`、`1364-1371`
- 问题：分类查询已经把模型判为 sensitive 的 `contentRef` 记进 `#sensitiveJudgments`：

```ts
if (result.classification !== "sensitive") continue;
this.#sensitiveJudgments.delete(ref);
this.#sensitiveJudgments.set(ref, result);
```

但 `#checkImportDuplicates` 只检查载荷级别：

```ts
const payload = await this.options.payloads.get(ref);
if (payload && classificationRank(payload.dataClassification) > classificationRank("private"))
  candidates.push("");
else {
  candidates.push(await this.readText(ref));
  sendable.push(index);
}
```

没有查 `#sensitiveJudgments.get(ref)`。网页路径确实在 `memory-page.tsx:2003` 用 `!item.sensitive` 排除了模型判敏感条目，所以正常网页流程读代码看是受保护的；但服务端接口本身没有这层防线：任何不经过网页过滤的调用者，或网页分类/过滤逻辑以后出现回归，只要 `contentRef` 的载荷级别仍是 `private`，模型判敏感的文字（例如“我得了抑郁症”，没有证件号/密码这类确定性特征）仍会被送进外部 `/decisions` 模型。

- 建议：在 `#checkImportDuplicates` 里同时检查 `this.#sensitiveJudgments.has(ref)`（或把确定性敏感判断前移），命中就按 `skipped` 处理、不加入 `sendable`；补一个“先 classify 判 sensitive、载荷仍是 private，再调用 duplicates，断言请求里没有这段文字”的反向测试。
- 说明：正常网页路径是否已发生泄露：读代码未发现，属于“服务端防线不完整 + 可构造的非网页调用”；不是已证实的正常 UI 泄露。

### 中：网页“敏感/未分类不问”缺少真正会失败的反向测试

- 文件:行：`apps/control-center/test/memory-interactions.unit.test.ts:1617-1635`
- 问题：主测试给 4 个条目配了 4 个 `duplicateAnswers`，但仔细看断言：

```ts
classifyAnswers = [
  classified("other"),
  classified("rule"),
  classified("other", "sensitive", "other"),
  classified("health", "sensitive", "health"),
];
duplicateAnswers = ["same", "different", "skipped", "different"];
...
expect(preview).toContain("找到 4 条，已勾 1 条");
```

如果实现有 bug，把 sensitive 的两个条目也发给 `memory.import.duplicates.read`，mock 会依次返回 `same`、`different`、`skipped`、`different`；sensitive 条目即使拿到 `different` 也会因为 `!item.sensitive` 不勾选，最终“已勾 1 条”仍然成立。测试**没有断言发给判重查询的 `contentRefs` 数量或文字**，因此不能证明网页真的没问敏感/未分类条目。这是本轮声明的核心安全行为，但当前用例不能反向失败。

- 建议：在 query mock 里记录 `memory.import.duplicates.read` 的 `contentRefs`，断言长度等于非敏感 ready 条目数、且不包含敏感条目对应的引用；再加一个“分类失败/全部敏感时根本不发判重查询”的用例。
- 另：`applyImportDuplicates` 新增的 `!item.coding`（`apps/control-center/src/memory-import.ts:160`）也没有有效测试。现有 Codex 解析用例里第 5 条 verdict 是 `skipped`（`apps/control-center/test/memory-interactions.unit.test.ts:1935-1941`），即使删掉 `!item.coding`，该条仍然不会被勾选。建议补一个 coding 条目拿到 `different` 的用例。

### 低：1 MiB 响应体限制没有对应反向测试

- 文件:行：`packages/platform-node/src/memory-import-duplicate-decision.ts:93-110`、`packages/platform-node/test/memory-import-duplicate-decision.unit.test.ts:93-112`
- 问题：新代码同时检查 `content-length` 和流式读取累计字节：

```ts
const declared = Number(response.headers.get("content-length") ?? 0);
if (declared > MAX_RESPONSE_BYTES)
  throw new ImportDuplicateDecisionFailure("IMPORT_DUPLICATE_RESPONSE_TOO_LARGE");
...
received += value.byteLength;
if (received > MAX_RESPONSE_BYTES) {
  await reader.cancel();
  throw new ImportDuplicateDecisionFailure("IMPORT_DUPLICATE_RESPONSE_TOO_LARGE");
}
```

但现有反向测试只覆盖 HTTP 错误、非 JSON、模型名不匹配，没有覆盖“声明的 `content-length` 超限”和“无 `content-length`、分块流超限”。作者第 (6) 条修复目前没有自动用例能证明撤掉限制会失败。
- 建议：加两个本地回环桩用例：一个返回超限 `content-length`，一个不返回 `content-length` 但持续写超过 1 MiB，断言抛 `IMPORT_DUPLICATE_RESPONSE_TOO_LARGE` 且不会把整段读完。

### 低：文档仍说配置里有“每百万输入 token 的价格”，代码已拒绝该键

- 文件:行：`docs/adr/0265-memory-import-duplicates-judged-by-the-model.md:56`、`packages/platform-node/src/strict-configuration.ts:1306`
- 问题：ADR 仍写：

```text
`runPolicy.importDuplicates` 写模型名、密钥引用和每百万输入 token 的价格
```

但 `inputMicrosPerMillionTokens` 已删除，`rejectUnknown(input, [...keys, "model", "secretRef"], field)` 会把它当未知字段拒绝。照 ADR 配置会让服务启动失败。
另外 ADR 第 54 行只写“一次查询最多发 150 个请求”，没有写新增的 `dailyMaximumRequests`（默认 1500）；第 87 行的费用估算也仍按 token 单价描述。
- 建议：更新 ADR 第 56 行，删掉价格配置；在第 54 行补日请求上限及其默认值；如仍保留费用估算，明确价格来自哪里而不是配置项。
- 备注：仓库里没有生产配置样例，无法核实是否已有部署配置包含旧键；这是“文档与代码不一致”的已证实问题，实际是否会导致现网启动失败未核实。

### 低：日请求上限按 UTC 日切、不持久化、命中上限无诊断

- 文件:行：`apps/agent-service/src/production-memory-import-duplicates.ts:77-89`
- 问题：

```ts
const today = this.#now().slice(0, 10);
if (today !== this.#day) {
  this.#day = today;
  this.#requestsToday = 0;
}
```

`new Date().toISOString()` 是 UTC 日切，而记忆分类器的日额度用的是配置的 `timeZone`；同一产品里两个“日上限”的日界线可能不同。计数器只在进程内，重启或多副本会重新计数。另外超过日上限时只是静默返回 `skipped`，没有 `onFailure`/诊断日志，网页只会显示“没能核对”，运维不容易知道是额度用完了。
- 建议：使用与分类器一致的配置时区/时钟；命中上限时写一条带 `dailyMaximumRequests` 的诊断；如上限需要跨副本，考虑持久化或集中计数。

### 低：已有记忆没有单条长度上限，`existingCharactersPerRequest` 只控制分批

- 文件:行：`apps/agent-service/src/production-memory-import-duplicates.ts:91-111`、`136-145`
- 问题：本轮给候选加了 `MAXIMUM_CANDIDATE_CHARACTERS = 2000` 截断：

```ts
text: [...(candidates[index] ?? "")].slice(0, MAXIMUM_CANDIDATE_CHARACTERS).join(""),
```

但已有记忆仍然整段发送：

```ts
current.push(item);
size += length;
```

`existingCharactersPerRequest` 只在 `size + length > limit` 时换批；单条超过上限的记忆仍会单独成批并完整发给外部模型。`#importCommit` 只检查非空、不限制长度（`production-memory-control.ts:1548-1552`），所以来自其它客户端的超长导入记忆可能让判重请求体异常大、费用异常高。
- 建议：对 `existing` 单条也做与候选相同的字符截断（至少对外发版本截断），或在导入提交处强制记忆文本长度上限；同时用一个超长已有记忆的测试验证发送内容被截断。
- 另：响应头 `content-length > 1 MiB` 时直接 throw 而没有 `response.body?.cancel()`，可能留下未消费的响应体；建议在抛出前取消。

---

## 推测/未完全核实

- **非网页调用者会绕过网页敏感过滤**：服务端接口没有 actor/分类上下文校验的进一步证据在本轮范围外；我只证实了 `#checkImportDuplicates` 不查 `#sensitiveJudgments`，没有核实所有调用路径的鉴权和实际是否会这样调用。
- **`/decisions` 是否做前缀缓存**：ADR 说它是后台独立调用，代码也按独立 POST 构建；如果该端点未来做请求前缀缓存，`importDuplicateRequestBody` 把可变的 `input` 放在固定的 `questions` 前面并不符合“固定的在前、会变的在后”的优化顺序。当前没有证据表明存在缓存命中要求，按不构成会话前缀问题处理。
- **prompt manifest 的 SHA-256 是否与模板一致**：没有运行脚本，未核实；但 `memory.import-duplicate-question` 已加入 manifest、`memory.ts` 导出、`PARSERS` 和 prompt-output-contracts 用例。
- **生产配置是否已包含 `inputMicrosPerMillionTokens`**：仓库里没找到配置样例，未核实。

---

## 侧重检查

- **敏感内容外发**：
  - 网页路径：`memory-page.tsx:2003` 只把 `!item.sensitive && item.status === "ready"` 发给判重；读代码看正常路径成立。
  - 服务端候选：`production-memory-control.ts:1366` 对载荷级别高于 private 的直接返回 `skipped`，不调用 `readText`，成立。
  - 缺口：服务端没有使用 `#sensitiveJudgments`；网页测试没有断言实际发出去的 `contentRefs`。
  - 导出导入路径：`parseMemoryExport` 的 `sensitive` 只来自导出文件字段，不会重新跑模型分类；如果导出文件字段不可信，模型敏感内容可能进入判重。读代码确认了这一点，是否是设计取舍未核实。
- **错误路径**：
  - 已有记忆 `readText` 失败：`.catch(() => null)` + `complete = false`，全部候选的 `different` 会被降级为 `skipped`，成立。
  - 候选 `readText` 失败：没有 try/catch，整个 query 会 reject；网页 `memory.ts` 的 `importDuplicates` 按 500 条一批 catch 后整批标 `skipped`。安全但会丢掉同批其它有效结果。建议逐条 catch。
  - 判重模型 HTTP/格式/超时错误：`check` 的 `run` 捕获后标记 `incomplete`，对应条目 `skipped`，成立。
- **不可信输入**：
  - 契约限制 `contentRefs` 为 1 到 500 个 `machineString`；前端 `CLASSIFY_BATCH = 500` 与之对齐。
  - 候选长度在进入外部模型前截断到 2000 字符；已有记忆没有单条长度限制（见上）。
  - 非 text/plain 的候选载荷会让整个 query 失败，而不是单条 `skipped`。
- **资源耗尽**：
  - 单次查询请求数受 `maximumRequests`（默认 150）和 `dailyMaximumRequests`（默认 1500）双重限制；响应体受 1 MiB 限制。
  - `#checkImportDuplicates` 在候选全部敏感时仍会读取最多 1000 条已有记忆，不消耗日请求额度，属于可重复触发的解密开销；仅在 owner 权限下，风险较低。
  - 极端配置（`existingPerRequest = 10`、`candidatesPerRequest = 1`、5000 条已有记忆、500 个候选）会先构造约 25 万个 job 对象，再被 `maximumRequests` 截断；这是既有实现，建议先用 `maximumRequests` 限制 groups/chunks 再展开。
- **不可撤销操作**：判重查询是只读；导入仍可整批 undo，本轮没有引入新的不可撤销动作。
- **规则/文档一致性**：词表登记表覆盖 `SENSITIVE_MENTION` 等确定性检测；新代码没有新增“猜用户意思”的词表。发现 ADR 0265 第 56 行价格配置过期、日请求上限未写入文档。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

**不会改变对话请求的系统提示、工具定义、历史消息或遮盖结果。**
本轮新增的是后台判重调用：`service-main.ts` 把 `memoryImportDuplicates` 传给 `ProductionMemoryControl`，判重请求由 `memory-import-duplicate-decision.ts` 单独 POST 到 `/decisions`；`MEMORY_IMPORT_DUPLICATE_QUESTION` 只被这个后台调用使用，不在对话系统提示或工具定义里。ADR 0265 第 42、91 行也明确说“这是后台单独调用，不改任何对话请求的开头”。
后台判重请求本身每次重新构建，不参与对话的 append-only 序列；会变的 `existing` / `candidates` 都在该请求的数据部分，不在对话最后一条用户消息里。这里没有“只在末尾追加”的要求。
唯一可提的观察：该后台请求把可变 `input` 放在固定 `questions` 之前，若 `/decisions` 以后做前缀缓存，顺序不是最优；但当前不是会话前缀问题。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

- **对话请求：不会。** 本轮没有改系统提示、工具、历史或会话遮盖。
- **判重后台请求：可能，且按设计不要求跨请求字节稳定。** `importDuplicateRequestBody` 用 `sequentialPlaceholderTag()` 和共享 `known` 做遮盖，占位符编号取决于本次请求里前面出现过的文本顺序；`existing` 集合和顺序也随记忆更新时间变化，`updatedAt` 相同的情况下还依赖 `listActive` 的返回顺序。因此同一段文字在不同判重请求中可能被遮成不同占位符或处在不同位置。
  单次请求内部，遮盖只依赖它自己和前面的内容，符合“不依赖后面的内容”的确定性要求；候选截断也是逐条确定。若希望判重结果可复现，建议给 `existing` 排序增加稳定次级键（如 `memoryId`），并让占位符编号不依赖集合顺序。

### 3. 有没有对应的自动检查，反向用例真的会失败？

已覆盖且反向会失败：
- 配置：`startup-configuration.unit.test.ts` 断言 `inputMicrosPerMillionTokens` 和 `dailyMaximumRequests: 0` 都会被拒绝。
- `importDuplicateVerdict(undefined) === "skipped"`：`memory-import-duplicates.unit.test.ts`。
- 已有记忆读失败 / 全部被确定性词表挡掉：checker 单测的 `complete: false` 和“密码是 hunter2”用例。
- 日请求上限：checker 单测“stops asking once the daily request limit is used up”。
- 服务端按载荷级别跳过敏感候选：`production-memory-capture.test.ts` 的 d3/d4 用例；如果服务端不跳，`duplicateRequests` 的候选数会变化、断言会失败。
- 判重请求出口遮盖/不发送银行卡号：`memory-import-duplicate-decision.unit.test.ts` 第一条。

覆盖不足、反向不会失败：
- **网页是否真的不问敏感/未分类条目**：主用例即使把 sensitive 条目也发出去仍会通过（见上文）。
- **1 MiB 响应体限制**：没有任何超限用例。
- **`maximumExistingMemories` 早停**：没有用例验证“超过上限后不再读/不再解密已有记忆”。
- **`applyImportDuplicates` 的 `!item.coding`**：现有 coding 条目 verdict 是 `skipped`，删掉 `!item.coding` 也不会失败。
- **全部已有记忆都是 sensitive/restricted**：没有用例；而当前代码会返回 `different` 而不是 `skipped`。

### 4. 每个新值/改动值，产生处和使用处两端都能接受吗？

- `dailyMaximumRequests`
  - 产生：`IMPORT_DUPLICATE_DEFAULTS` / `IMPORT_DUPLICATE_RANGES` / `strict-configuration.ts` 的通用 `keys.map`。
  - 使用：`ProductionImportDuplicateChecker.#reserve` 做整数减法和 `Math.min`。
  - 两端都是整数；范围 `[1, 100000]` 校验存在。**可接受。**
  - 文档未同步（ADR 第 56 行仍写价格配置，第 54 行未写日上限）。
- `existingLimit`
  - 产生：checker getter，返回 `maximumExistingMemories`。
  - 使用：`#checkImportDuplicates` 的 `if (existing.length >= limit) break;`。
  - 类型和语义一致。**可接受。**
- `ImportDuplicateExistingScan.complete`
  - 产生：control 在已有记忆 `readText` 失败时置 `false`。
  - 使用：checker 用它阻止把无答案条目判成 `different`。
  - 两端类型一致；但 control 在因 `sensitive` / `restricted` 跳过记录时没有置 `false`，语义不完整（见问题 1）。
- `memory.import.duplicates.read` / `.snapshot`
  - 产生：契约 `contracts-v2.ts`、`PRODUCTION_MEMORY_OPERATIONS`、网关 fixture。
  - 使用：网页 `memory.ts` 按 500 条分批，后端按 `refs.map` 返回；`contentRef` 对不上时网页按 `skipped` 处理。
  - 数量上限 500 与前端批次 500 一致；`verdict` 枚举包含 `skipped`。**可接受。**
- `MAXIMUM_CANDIDATE_CHARACTERS`
  - 产生/使用都在 `production-memory-import-duplicates.ts`，只影响发给外部模型的候选文本。**可接受**（但没有对已有记忆做同等限制）。
- `memory.import-duplicate-question` 提示词 id
  - 产生：`packages/prompt-catalog/src/memory.ts`、`prompt-manifest.json`。
  - 使用：`memory-import-duplicate-decision.ts` 的 `renderPrompt`、`parseImportDuplicateAnswers`、`prompt-output-contracts` 的 PARSERS 清单。
  - 名称和 parser 两端一致。**哈希是否匹配未核实**（没有运行校验脚本）。
- `verdict: "skipped"`（`importDuplicateVerdict(undefined)`）
  - 产生：application 服务。
  - 使用：checker 的 `check`、网页 `ImportDuplicateVerdict` 类型和 `applyImportDuplicates` 的 `skipped -> unchecked` 映射。
  - 两端都接受 `skipped`。**可接受。**
- `memoryId: string | null`
  - 产生：checker 从已有记忆真实 id 映射。
  - 使用：snapshot 契约 `nullable(machineString)`；网页不消费该字段。
  - 两端校验一致。**可接受。**
