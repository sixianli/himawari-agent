## 读代码证实的

### 1. 中：文件名像密钥时，新增测试只证明 `parseUsage` 能读账本，没证明合并门能过；完整门会报 `record-secret-like`

- 文件：`scripts/model-review/opencode-review.mjs:2674`、`scripts/model-review/opencode-review.mjs:2695`、`test/tooling/plan-claims-gate.test.mjs:412`

证据：

```js
// opencode-review.mjs:2674
export function ledgerLine(record) {
  const masked = maskSecretLikeDeep(record);
  if (record.mode === "plan-claims")
    return `${JSON.stringify({ ...masked, claimsFile: record.claimsFile })}\n`;
  return `${JSON.stringify(masked)}\n`;
}
```

```js
// opencode-review.mjs:2695
export function recordSecretProblems({ repo, ledgerPath, otherFiles = [] }) {
  ...
  return recordFileProblems(repo, [...listed.stdout.split("\0").filter(Boolean), ...others]);
}
// 2681
function recordFileProblems(repo, files) {
  ...
  for (const id of secretLikeRules(shown.stdout))
    problems.push(`record-secret-like ${printable(file)} ${id}`);
```

`RECORD_SECRET_RULES` 里有 `["openai-api-key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g]`（`opencode-review.mjs:2593`）。新增测试构造的路径正好命中这条规则：

```js
// plan-claims-gate.test.mjs:412
it("[claims gate] a file name that looks like a secret is still recorded in a ledger the gate can read", () => {
  const path = `docs/adr/0304-${["sk", "abcdefghijklmnopqrstuv"].join("-")}.md`;
  ...
    const line = ledgerLine(f.claimsRecord({ claimsFile: path, claimsSha256: sha(text) }));
    expect(JSON.parse(line).claimsFile).toBe(path);
    expect(parseUsage(line, "u")[0].claimsFile).toBe(path);
});
```

这个测试没有调用 `f.check()`，也没有把记录写进 topic 的 `usage.jsonl`。如果按真实流程补上：PR 新增了这个 ADR → `claimsProblems` 的 `files` 会包含该 `usage.jsonl`（`plan-claims.mjs:212-224`）→ `assertReviewed` 把它传给 `recordSecretProblems`（`opencode-review.mjs:1438-1445`）→ `secretLikeRules` 命中 `openai-api-key` → 报 `record-secret-like`。而该问题不在 `claims-` 前缀里（`OVERRIDABLE_PROBLEMS` 只加了 `claims-`，`opencode-review.mjs:1303` 附近），不能用 `--accept-unreviewed` 放行。

文档也只说“文件名里含字母、数字、`._/-` 以外的字符…报 `claims-name-unsupported`”（`.agents/instructions/model-review.md:40`），没提密钥规则会另外拦下；第 44 行说“所有 `claims-` 开头的…可以盖过”，但这里产生的是 `record-secret-like`，盖不过。

影响：这类文件名永远无法合并，且账本里会原样写入像密钥的字符串；功能上失败在安全侧，但作者“不是秘密、已处理”的表述和测试名与实际门不一致。

建议：明确一种行为并做端到端测试。若要允许这种名字，应让记录文件扫描能识别“这是 `claimsFile` 字段且等于已提交 ADR 路径”；若要禁止，应在 `claims-name-unsupported` 或专门错误里直接拒绝，并同步文档和测试。不要只用 `ledgerLine` + `parseUsage` 代替合并门测试。

---

### 2. 低：“同一内容的每一次有结果的运行都要过关”比实现更强；同一 `dir`+`round` 里同一模型只检查最后一条

- 文件：`scripts/model-review/plan-claims.mjs:230`、`scripts/model-review/plan-claims.mjs:244`

证据：

```js
// plan-claims.mjs:230
const groups = new Map();
for (const record of matching) {
  const key = `${record.dir}\0${record.round ?? 1}`;
  groups.set(key, [...(groups.get(key) ?? []), record]);
}
...
for (const group of groups.values()) {
  const latest = group[0];
  const lastByModel = new Map();
  for (const record of group) lastByModel.set(record.model, record);
  const done = [...lastByModel.values()].filter((record) => record.outcome === "ok");
```

同一 `dir`+`round` 里同一模型的更早 `ok` 记录会被覆盖，只读 `${roundDir}/${short}.md`（`plan-claims.mjs:246`）。而更早的答案文件其实被 `keepEarlierAttempt` 改名保留为 `.attempt-N.md`（`opencode-review.mjs:1808-1822`），门却不读它。

正常 CLI 下，同一轮同一模型已有 `ok` 时 `--round` 会被 `ROUND_ALREADY_HAS_RESULT` 拒绝（`opencode-review.mjs:1773-1775`），所以实际很难触发；只有手工改账本才可能让两条 `ok` 记录落在同一组。文档 `.agents/instructions/model-review.md:36` 的“每一次有结果的运行”因此偏强，准确说法应是“每个 topic/round 组里每个模型的最后一次有结果运行”。

建议：要么文档改成按“组/模型最后一条”描述；要么遍历所有 `ok` 记录并映射到对应的 `.attempt-N.md` 再检查，确保真的“每一次”。

---

### 3. 低：坏行识别仍会静默跳过一部分像 CLAIM 的行

- 文件：`scripts/model-review/plan-claims.mjs:47-50`

证据：

```js
if (!line.startsWith("CLAIM|")) {
  if (/^(?:\d+[.)]\s+)?[`*"'“#]*CLAIM(?![A-Za-z])/u.test(line))
    problems.push(`line-${number}-malformed`);
  continue;
}
```

新增规则覆盖了 `1. CLAIM|…`、`CLAIM_6|…`、`# CLAIM`，但只认 ASCII 数字和 `.`/`)`。像 `1、CLAIM|…`（中文顿号）、`１. CLAIM|…`（全角数字）、`1）CLAIM|…`（全角括号）既不以 `CLAIM|` 开头，也不命中这条正则，会被 `continue` 静默跳过，不报 `line-N-malformed`，从而绕过 `CLAIMS_PARSE_FAILED`。这正好落在“长得像 CLAIM 的坏行不能静默跳过”的目标边缘。

建议：把前缀放宽到 Unicode 数字和常见中文/全角分隔符（例如 `[\p{N}]+[、.．)）]\s*`），并补一条反向用例；或者明确接受这些写法并从提示里说明。

---

### 4. 低：序号规则在文档和提示里互相矛盾（本次增量之前已存在）

- 文件：`.agents/instructions/model-review.md:30`、`scripts/model-review/opencode-review.mjs:280`

证据：

```md
// .agents/instructions/model-review.md:30
...序号只要求不重复，不要求从 1 起。...
```

```js
// opencode-review.mjs:280（发给模型的提示）
...序号从 1 起，不重复。...
```

代码里 `parseClaims` 只校验 `CLAIM_ID_PATTERN` 和重复（`plan-claims.mjs:57-65`），并不要求从 1 开始。提示比实际检查更严，文档又比提示更松。建议统一成一种说法。

---

## 推测 / 未核实

- 工具受限，没有运行 `vitest`，也没有实际执行 `--assert-reviewed`；以上关于测试失败/门报错的结论来自读代码和测试断言。
- 没有逐条阅读 `.agents/reviews/pr-415/` 下的实际记录内容，只看了本次增量的代码、测试和文档。
- `1、CLAIM`、全角数字等写法是否真的会出现在模型输出中没有实测；但它们在当前正则下被静默跳过是代码可证的。
- 没有实际构造“先 `ok` 标记、再在同一 `dir`+`round` 追加另一条 `ok`”的账本去跑门；第 2 条标为低，因为它主要靠手工改账本才可达。

---

## 侧重检查

- **错误路径**：失败运行只从 `done` 排除、不参与判断；全部组都没有 `ok` 才报 `claims-run-failed`（`plan-claims.mjs:235-242,299`）。答案缺失 `claims-answer-missing`、无可解析行 `claims-none`、格式坏 `claims-answer-invalid`、判断文件坏 `claims-verdicts-invalid`、账本坏 `claims-ledger-invalid` 都有对应分支；CLI 端格式坏或零条时置退出码 4（`opencode-review.mjs:3359-3376`）。这些与文档一致。
- **不可信输入**：`--claims-file` 走 `validClaimsFile`（拒绝 `..`、空段、绝对开头、`.agents/reviews/`）；证据路径 `validEvidencePath` 同样拒绝绝对路径、`..`、空段、前导 `-`；topic 目录名被限制为 `topic-[a-z][a-z0-9-]*`；`round` 在 `parseUsage` 里必须是正整数（`opencode-review.mjs:1673-1674`）。未发现新增路径穿越。
- **安全**：模型请求的遮盖没变；落盘账本唯一的新增例外是 `claimsFile` 原样写入，和密钥扫描的冲突见第 1 条。该冲突最终是“拒绝合并”，不是放行秘密。
- **资源耗尽**：本增量新增的循环按账本记录数和 ADR 数线性增长；每条记录会跑 `git show` / `git ls-tree`，未见新的无界递归。提示词仍有 `PROMPT_TOO_LARGE` 上限（`opencode-review.mjs:3143-3144`），答案文件也会被读入内存，这次没有放宽上限。
- **不可撤销操作**：`plan-claims` 运行本身只读仓库并写记录；合并门只在 `low-fix`/`override` 路径追加账本，这次改动没有新增写操作。
- **规则/文档/代码一致性**：发现第 1、2、4 条不一致；其余 `claims-` 问题前缀能被 `OVERRIDABLE_PROBLEMS` 接受，`skip: claimsOwned` 在 `unreviewed` 过滤和 `lowFixProblems` 两处都被正确使用。

---

## 必答问题

**1. 这个改动会不会改变模型已经见过的请求开头？**
不会。本次增量只改了 `ledgerLine`、`parseClaims` 的坏行识别、合并门的分组逻辑和文档/测试；没有改 `MODE_TEXT`、`buildPrompt`、`reviewConfig`、工具定义或历史拼接。发给模型的仍是“固定头 → 资料 → 最后一条消息”，`plan-claims` 的资料来自同一提交里的 `claimsBlob`，同一提交字节相同。没有新的每轮变化值被放进请求头。

**2. 会不会让同一段文字在不同请求里变成不同字节？**
不会（对模型请求而言）。模型可见内容仍由固定文本和同一提交的 ADR 字节决定；`ledgerLine` 的改动只影响落盘的 `usage.jsonl`，不影响提示词。分组用 `Map` 遍历，输出顺序虽取决于账本顺序，但只影响诊断信息，不进模型请求；JSON 字段顺序由对象字面量固定。

**3. 有没有对应自动检查，反向用例是否真的会失败？**
有。新增/修改的用例包括：
- `plan-claims-gate.test.mjs:394` “重跑到碰巧全一致…”，第一次断言在旧的“只看最后一轮”实现下会得到 `[]`，因此旧实现会失败；
- `plan-claims-gate.test.mjs:412` 的账本文件名测试，旧 `ledgerLine` 会把 `claimsFile` 遮掉，`parseUsage` 会失败；
- `plan-claims-gate.test.mjs:182-202` 的坏行测试，旧正则会漏报第 4、5 行。
工具受限未能实际运行测试，以上是读断言得出的结论。第 412 条的反向覆盖不完整：它没有走 `assertReviewed`，见第 1 条问题。

**4. 改动产生/修改的每个值，两端校验都能接受吗？**
逐个核对：
- `claimsFile`：产生于 `ledgerLine` 原样写入（`opencode-review.mjs:2677`）；使用于 `parseUsage` 的 `validClaimsFile`（`:1709`，接受）、`claimsProblems` 的路径相等比较（`plan-claims.mjs:211`，接受）、`recordSecretProblems`（`:2695-2703`，**可能拒绝**，见第 1 条）。这是唯一不匹配的两端。
- 分组键 `${dir}\0${round}`：只在本函数内部使用，使用方就是生成方，接受。
- `claims-` 开头的问题字符串：产生于 `claimsProblems`；使用于 `OVERRIDABLE_PROBLEMS`（`opencode-review.mjs:1303` 起，前缀匹配接受）和文档第 43 行，接受。
- `skip`/`claimsOwned` 文件清单：产生于 `claimsProblems` 的 `files`；使用于 `unreviewed` 过滤（`:1380-1381`）和 `lowFixProblems` 的 `skip?.has(match[3])`（`:1201`），两端都是精确路径集合，接受。
- `line-N-malformed`：产生于 `parseClaims`；使用于 CLI 的 `CLAIMS_PARSE_FAILED`/退出码 4（`:3363-3376`）和门的 `claims-answer-invalid`（`plan-claims.mjs:252-254`），接受。
- `record.round`：`parseUsage` 要求正整数或未定义（`:1673-1674`），门里用于拼 `round-${record.round ?? 1}`，接受。
- `claimsSha256`：`parseUsage` 要求 64 位小写十六进制（`:1710`），与 `blobSha256` 输出一致，接受。

结论：本次增量最需要修的是第 1 条——`claimsFile` 的一端（`ledgerLine`/`parseUsage`）接受，另一端（`recordSecretProblems`）不接受；其余值基本对齐。
