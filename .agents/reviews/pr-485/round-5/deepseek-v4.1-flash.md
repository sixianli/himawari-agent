## 结论概览

本轮 3 条修复的作者说法基本属实：截断时 `complete=false`、请求体 `questions` 在 `input` 前、先单发第一个请求、编码笔记测试改成先分类后判重，都能在代码里对上。没有发现会改变已有对话请求开头的问题。但截断判断有一个边界错误，且请求顺序改动没有测试、也没有达到预热目的。

## 发现（按严重度）

### 1. 中：截断判断放在敏感过滤之前，会把“没有漏掉可比较记忆”也当成截断

- 文件：`apps/agent-service/src/production-memory-control.ts:1387`
- 问题：循环先在 `existing.length >= limit` 时置 `complete=false`，之后才跳过 sensitive/restricted。于是当主人正好有 `limit` 条可比较记忆、后面还跟着一条敏感的旧记忆时，也会被判成“被截断”，所有模型答 `different` 的条目都被降级为 `skipped`（网页显示“没能核对”，默认不导入）。实际上没有任何可发送的记忆被漏掉。
- 证据（亲自读到）：

```ts
for (const record of active) {
  if (existing.length >= limit) {
    complete = false;
    break;
  }
  if (record.dataClassification === "sensitive" || record.dataClassification === "restricted")
    continue;
  const text = await this.readText(record.contentRef).catch(() => null);
  if (text) existing.push({ memoryId: record.id, text });
  else complete = false;
}
```

- 影响：这是保守方向的错误，不会把不重复错判成重复，但会让“刚好到上限”的主人的整批判重结果全部变成“未核对”。
- 建议：把敏感/受限的 `continue` 移到 limit 判断之前；这样只有真正还可能被发送的记忆才会触发 `complete=false`。或者先扫完剩余记录，确认没有可发送记忆再保持 `complete=true`。

### 2. 低：先单发第一个请求，但 job 顺序使它起不到预热作用

- 文件：`apps/agent-service/src/production-memory-import-duplicates.ts:137`、`:167`
- 问题：job 是 `groups.flatMap(group => chunks.map(...))`，即 group 优先。第一个请求是 `group0 × chunk0`，紧接着并发的是 `group0 × chunk1..chunkN`，它们的 `questions.choices` 来自不同 chunk，开头并不相同。只有同一 chunk、不同 group 的请求才共享相同的 `questions`，而这些 job 在 group 优先顺序里离第一个请求很远。
- 证据：

```ts
const jobs = groups.flatMap((group) => chunks.map((chunk) => ({ group, chunk })));
...
const first = allowed[0];
if (first) await run(first);
const rest = allowed.slice(1);
```

```ts
questions: input.candidates.map((_, index) => ({ ... choices })),
input: [ ... ]
```

- 说明：作者说的“先单独发第一个请求再并发其余”确实实现了；上述“没有预热效果”是按代码顺序做的推测，不是运行结果。
- 建议：如果目的确实是规则 17 的缓存预热，应改成 chunk 优先排序，让第一个请求后面的请求共享同一个 chunk 的 `questions`；否则这次串行只增加首轮延迟。另补一条断言调用顺序的测试。

### 3. 低：编码笔记也会发给外部判重模型

- 文件：`apps/control-center/src/components/memory-page.tsx:2003`
- 问题：`askable` 只排除 `sensitive` 和非 `ready`，没有排除 `coding`。编码笔记最终在 `applyImportDuplicates` 里才因 `!item.coding` 永远不被勾选，但在那之前已经被存成受保护内容并发给外部判重模型，浪费请求，也扩大了不必要的出口。
- 证据：

```ts
const askable = sorted.filter((item) => !item.sensitive && item.status === "ready");
const answers = askable.length
  ? await memory.importDuplicates(askable.map((item) => item.text))
  : [];
```

```ts
checked:
  item.status === "ready" &&
  !duplicate &&
  duplicateCheck === "clear" &&
  !item.sensitive &&
  !item.coding,
```

- 建议：`askable` 加上 `!item.coding`；对应地让 `verdicts` 的消费条件和 `askable` 完全一致。

### 4. 低：单个坏 contentRef 会让整批判重查询失败

- 文件：`apps/agent-service/src/production-memory-control.ts:1373`
- 问题：候选 ref 的 `readText` 没有逐条捕获。若某个 ref 不存在、不是 text/plain 或解不开，整个 `#checkImportDuplicates` 抛错；网页 `memory.ts` 的外层 `catch` 会把这一批最多 500 条全部标成 `skipped`。
- 证据：

```ts
else {
  candidates.push(await this.readText(ref));
  sendable.push(index);
}
```

对比同一文件的 existing 读取则用了 `.catch(() => null)`（第 1394 行）。
- 建议：候选读取也逐条 `try/catch`，失败那条 `candidates` 置空并跳过，不影响其余条目。

### 5. 低：ADR 与代码/默认值不一致

- 文件：`docs/adr/0265-memory-import-duplicates-judged-by-the-model.md:37`、`:51`、`:89`
- 问题：
  - ADR 第 37 行说 `#importCommit` 从第 1548 行起，实际当前是 `apps/agent-service/src/production-memory-control.ts:1555`。本轮的截断修改和 `#checkImportDuplicates` 都加在它前面，行号已经偏移。
  - ADR 第 51、67、89 行写成“最多 1000 条”，但 `packages/application/src/ports/configuration.ts:332` 的 `maximumExistingMemories` 范围是 `[0, 5_000]`，1000 只是默认值。文档应区分“默认 1000”和“允许配置到 5000”。
- 建议：更新行号，并把“最多 1000 条”改成“默认 1000 条，可配置”。

### 6. 低：有 `probabilities` 时忽略 `choice: "none"`，与 ADR 的“选了 none 判 different”不一致

- 文件：`packages/application/src/services/memory-import-duplicates.ts:56`
- 问题：`probabilities` 存在时循环直接跳过 `none`，完全不看 `choice`。如果模型选择 `none`，但某个非 none 选项概率在 31%–50%，结果会变成 `unsure`，而 ADR 第 54 行写的是“选了 none 判 different”。
- 证据：

```ts
const options = value["probabilities"];
if (Array.isArray(options)) {
  ...
  if (option["value"] === IMPORT_DUPLICATE_NONE) continue;
  ...
  if (probability > best.probabilityPermille) best = ...
  return best;
}
const choice = value["choice"];
```

- 影响：保守方向，最多让主人多看一眼，不会把不同内容误判成同一件事。
- 建议：在 `probabilities` 分支里先看 `value["choice"] === "none"` 就直接返回 `{ matchKey: null, probabilityPermille: 0 }`；并补一条反向用例。

## 侧重检查

- **错误路径**：HTTP 429、拒答、超时、声明/流式响应超过 1 MiB、日请求上限、单次请求上限都走 `skipped`；有对应测试。未运行测试，只读代码核对。
- **不可信输入**：`contentRefs` 由契约限制为 1–500，服务端按 owner/agent 作用域读 payload；但坏 ref 会让整批失败（见发现 4）。
- **安全/出口**：existing 与候选里敏感、受限、确定性敏感的记忆不发；请求体过 `redactForExternalText`，并带 `zeroDataRetention: true`；出口检查脚本已登记该文件及必需的遮盖调用。编码笔记仍会外发（见发现 3）。
- **资源耗尽**：候选文本截到 2000 字符，响应有 1 MiB 上限，请求数/日请求数有上限。existing 单条文本没有显式上限；现有记忆正文是否总在更小的上限内，未核实。
- **不可撤销操作**：该查询本身是只读；网页会像分类流程一样为导入文本创建受保护 payload，这沿用了 ADR 0260 的既有通道。
- **规则/文档一致性**：ADR 已同步“先单发第一个请求”和截断时 `skipped`，但行号与“最多 1000 条”仍不一致（见发现 5）。词表门槛的已知盲区按要求未展开。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会改变对话请求的开头。新提示词 `MEMORY_IMPORT_DUPLICATE_QUESTION` 只在 `packages/platform-node/src/memory-import-duplicate-decision.ts` 使用，经 `ProductionImportDuplicateChecker` 走独立的 `/v1/decisions` 后台调用，不进入对话系统提示、工具定义或历史；没有改动对话提示组装代码。对这条后台调用，`existing`/`candidates` 的实际文字在 `input` 里且排在 `questions` 后面，但 `questions` 内的 `candidateId` 和 `choices` 也会随请求变化，所以严格说“会变的值都在最后一条消息里”并未完全满足；它不是多轮对话，不涉及“只在末尾追加”的历史规则。

2. **同一段文字会不会在不同请求里变成不同字节？**
   会有一点，但只在后台判重调用内部：`redactForExternalText` 每个请求新建 `known`/`sequentialPlaceholderTag`，同一候选文本出现在不同 existing 分块请求里时，占位符后缀可能因前面出现的敏感值而不同；`m0/m1` 编号也会随记忆集合变化。请求里没有时间字段；`listActive` 是 `ORDER BY id`，随后按 `updatedAt` 稳定排序，同一数据库状态下顺序确定。这不影响任何对话已发内容的字节。

3. **有没有对应自动检查，反向用例真的会失败吗？**
   - 截断：有 `[A4] never calls an entry different when older memories were left out of the comparison`，把上限设为 1。未运行，但读代码可推演：没有本轮的 `complete=false`，该用例会得到 `different`，与期望的 `skipped` 不符，因此会失败。
   - 请求体顺序和“先单发第一个再做并发”：没有测试；平台单测只按 JSON 键取值，不检查序列化顺序，也没有断言调用顺序。
   - 编码笔记测试改成先分类后判重：属实，但这个测试本身在两种顺序下结果相同；真正约束“先分类后判重”的是已有的 `[MP-8][A4] never asks about entries the server could not sort`。
   - `none` 与 `probabilities` 同时出现、`none` 被选中的反向用例：没有。

4. **改动产生或修改的每个值，使用它的地方都能接受吗？**
   逐项核对，未发现会卡住的值：
   - `contentRefs`：网页每批 500，契约 `1..500`，服务端按同一顺序返回，网页逐条核对 `contentRef`。
   - `verdict`：`same/unsure/different/skipped` 在应用层、网关快照枚举、网页类型三处一致。
   - `candidateId`（`c0…`）和 `matchKey`（`m0…`）：请求里生成，解析时分别校验 `name` 和 `choice` 是否在本次 `existingKeys` 内。
   - `runPolicy.importDuplicates` 的字段：严格配置按 `IMPORT_DUPLICATE_DEFAULTS` 的键逐项解析，`IMPORT_DUPLICATE_RANGES` 类型上要求覆盖全部字段，`model`/`secretRef` 走 `safeReference`，并校验密钥用途必须是 `model-auth`。
   - 新提示词 id：源码、`usedBy` 与 `prompt-manifest.json` 的键一致；manifest 的 SHA 是否重算正确，未核实。
   - 文档里的“1000/150/1500”与配置范围存在默认值/上限的表述差异，见发现 5。
