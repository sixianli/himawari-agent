## 侧重检查

我按“错误路径、不可信输入、安全、资源、不可撤销操作、文档与代码一致性”先查了这些地方：

- **错误路径**：`parseClaims` 的坏行分支、`parseUsage` 的 `USAGE_LEDGER_INVALID`、`claims-claimsProblems` 的 ledger/answer/verdict 缺失分支、`validateTask` 对 plan-claims 的拒绝。结论：多数是 fail-closed 的，但坏行识别有漏（见问题 3）。
- **不可信输入**：`--claims-file` 的 `..`、绝对路径、空段、`.agents/reviews/`、首字符；ADR 文件名里的空格/制表符/换行/emoji；CLAIM 的 `location`、verdict 的 `evidenceFile`。结论：`validClaimsFile`、`validEvidencePath` 管住了目录穿越和大部分控制字符；路径都作为 argv 数组传给 git，没有 shell 注入。`validEvidencePath` 不限制字符集，但只用于 `git show` 且失败即报错，不泄露内容。
- **安全**：`safe()` 对 `\p{Cc}`、U+2028/2029 的替换有效，能避免终端多行注入；但它没有覆盖所有坏行形态。
- **资源耗尽**：`parseClaims` 不限制 CLAIM 行数；`claimsProblems` 对每条 claim 调一次 `blobAt`（`maxBuffer` 256MB）并 `collapse` 整个文件，重复引用同一大文件会反复读取。没有上限，但这是合并门在可信线程上跑，风险低（属于既有设计，不是本轮增量）。
- **不可撤销操作**：`assertReviewed` 会向 `usage.jsonl` 追加 override 行（既有行为）；plan-claims 重跑会把同轮旧答案改名成 `.attempt-N` 再写新答案，可恢复。没有新的删除/覆盖仓库内容的操作。
- **规则与文档一致性**：`plan-claims` 不放必答问题和第 16 条、`mode 只能是四种复核模式`、`claims-name-unsupported` 的触发面、delegate 拒绝 plan-claims，这几处与代码一致；发现两处不一致（问题 1、问题 5）。

---

## 问题（按严重度）

### 中：文档说“不能靠重跑到碰巧全一致来蒙混”，代码实际只看最新一轮，重跑可以绕过

- 文件：`.agents/instructions/model-review.md:36`、`scripts/model-review/plan-claims.mjs:229-237`
- 证据（我读到的原文）：

```md
- 以最晚的那一轮为准（同一内容多次重跑，只看最后一轮，所以不能靠重跑到碰巧全一致来蒙混；每次重跑的花费都在账本里）。
```

```js
const latest = matching.reduce((best, record) =>
  Date.parse(record.at) > Date.parse(best.at) ||
  (Date.parse(record.at) === Date.parse(best.at) && record.order > best.order)
    ? record
    : best,
);
const round = matching.filter(
  (record) => record.dir === latest.dir && (record.round ?? 1) === (latest.round ?? 1),
);
```

- 问题：`matching` 只按内容摘要筛选，`latest` 取时间最晚的一条，然后只检查最新那一轮。若某轮把真实的不一致标成“不一致”，线程不处理，而是重跑；新的一轮只要碰巧全写“一致”，旧轮次完全不再检查，门禁就通过。文档的“所以不能靠重跑到碰巧全一致来蒙混”与代码相反。
- 建议：要么让门禁检查同一 SHA 的**所有**轮次（至少要求每个轮次里被标“不一致/找不到”的条目都有 `model-wrong` 判断），要么删掉这句结论，如实写明“只看最新一轮，重跑可能换出一个全一致的结果”。同时可考虑按 `round` 而不是仅按 `at` 选“最晚”，避免 `--round` 重跑旧轮次后把权威轮次改回旧轮。

### 中：合法的 ADR 文件名若含“像密钥”的子串，写进账本时被遮盖，读回时整行账本判为无效

- 文件：`scripts/model-review/opencode-review.mjs:2664-2676`、`scripts/model-review/opencode-review.mjs:1707-1713`、`scripts/model-review/plan-claims.mjs:16-23`
- 证据：

```js
function maskSecretLikeDeep(value) {
  if (typeof value === "string") return maskSecretLike(value);
  ...
export function ledgerLine(record) {
  return `${JSON.stringify(maskSecretLikeDeep(record))}\n`;
}
```

```js
const claimsValid =
  record?.mode !== "plan-claims" ||
  (validClaimsFile(record.claimsFile) && ...
```

- 问题：`claimsFile` 在 `parseArgs` 里先按原始文件名过 `validClaimsFile`，写入账本前又被 `maskSecretLikeDeep` 遮盖。若 ADR 路径里含有 `sk-` 加 16 位字母数字（`RECORD_SECRET_RULES` 的 `openai-api-key`）、`ghp_...`、`AKIA...` 或已登记的测试值，`claimsFile` 会变成 `docs/adr/0300-[已遮盖:openai-api-key].md`。之后 `parseUsage` 再用同一个 `validClaimsFile` 校验这个被遮盖的值，必然失败，整份 `usage.jsonl` 被报 `claims-ledger-invalid`，合法的 ADR 反而过不了门。这正是 I-73 说的“产生端校验通过、消费端校验不接受”。
- 建议：`claimsFile`、`claimsSha256` 不是秘密，写入账本时不要参与 `maskSecretLikeDeep`（或对这两个字段单独跳过遮盖）；若坚持遮盖，消费端要在遮盖前的值上比较，并补一条“文件名含 `sk-`/登记值”的测试。

### 低：坏行识别仍会静默跳过一部分“像 CLAIM 的行”

- 文件：`scripts/model-review/plan-claims.mjs:47-49`
- 证据：

```js
if (!line.startsWith("CLAIM|")) {
  if (/^[`*"'“]*CLAIM\b/.test(line)) problems.push(`line-${number}-malformed`);
  continue;
}
```

- 问题：`\b` 要求 `CLAIM` 后面是词边界，因此 `CLAIM1|...`、`CLAIM_1|...` 这类行不会命中；另外 `1. CLAIM|...`、`# CLAIM ...` 也不会被 `^\s*(?:[-*>]\s+)?` 剥掉前缀，整行被静默跳过。若答案里同时有合法 CLAIM 行，这些坏行不会触发 `CLAIMS_PARSE_FAILED`，该条说法就被漏掉，和作者“不再静默跳过”的说法不完全一致。
- 建议：改成类似 `/^[`*"'“]*CLAIM(?![A-Za-z])/u`（能命中 `CLAIM1`、`CLAIM_1`，但放过 `CLAIMS`/`CLAIMED`），并考虑先剥掉 `\d+[.)]\s+` 这种有序列表前缀；补上对应反向用例。

### 低：`CLAIMS_FLAGGED` 的 `safe()` 改动没有直接测试；新加的文件名测试不是它的反向用例

- 文件：`test/tooling/plan-claims-gate.test.mjs:516-521`、`scripts/model-review/opencode-review.mjs:3365-3368`
- 证据：

```js
console.log(
  `CLAIMS_FLAGGED ${name} ${claim.id} ${claim.verdict} ${safe(claim.location)}`,
);
```

```js
it("[claims gate] a file name with a tab or a newline is reported on one clean line", () =>
  withFixture({ withAdr: false }, (f) => {
    f.commit({ "docs/adr/0303-a\tb\nc.md": "# 方案\n" }, "adr with control characters");
    const [problem] = claimsOnly(f.check());
    expect(problem).toBe("claims-name-unsupported docs/adr/0303-a?b?c.md");
  }));
```

- 问题：`safe()` 在 b12771b3 就已用于 `claims-name-unsupported` 的 `label`，所以这个新测试在 b12771b3 上也会通过，不能证明本轮把 `CLAIMS_FLAGGED` 的 `printable` 改成 `safe` 的行为。仓库里没有任何测试覆盖 `CLAIMS_FLAGGED` 行，也没有直接测 `safe()`。
- 建议：直接给 `safe()` 加单元测试（制表符、换行、U+2028/2029、ESC），或测 `main` 在该模式下的 stdout 只有一行且不含控制字符。这样才能在回退本轮改动时失败。

### 低：网络说明只列了 code-review 和两个 plan 模式，漏了同为离线的 plan-claims

- 文件：`.agents/instructions/model-review.md:102`、`scripts/model-review/opencode-review.mjs:58,203-204`
- 证据：

```md
- 代码复核（`--mode code-review`）不联网；方案讨论的两个模式（`--mode plan`、`--mode plan-review`）可以用 opencode 自带的搜索和读网页工具……
```

```js
export const OFFLINE_MODES = ["code-review", "plan-claims"];
...
webfetch: OFFLINE_MODES.includes(mode) ? "deny" : "allow",
websearch: OFFLINE_MODES.includes(mode) ? "deny" : "allow",
```

- 问题：plan-claims 也是离线模式，但这句话没有提到它。读文档的人按这一节判断网络权限时会以为只有 code-review 离线。
- 建议：改成“代码复核和 plan-claims 不联网；plan 和 plan-review 可以用……”，或列出 `OFFLINE_MODES`。

---

## 推测 / 未核实

- **未核实**：`.agents/reviews/**` 下的真实 `usage.jsonl` 和答案文件我读不到（`git show` 对 records 路径被拒，工作区也没有这些文件），所以无法确认已有 plan-claims 记录的 `at` 是否全部带 `Z`、已有答案里是否含有会被新坏行规则命中的行。代码里的写入端用的是 `new Date().toISOString()`（`opencode-review.mjs:3268`），所以脚本自己产出的记录应能通过新正则。
- **推测**：新增 ADR 只按 `^docs\/adr\/\d{4}-[^/]+\.md$` 识别（`plan-claims.mjs:8`）。若 PR 新增 `docs/adr/plan.md`、`docs/adr/sub/0300-x.md` 或大写 `.MD`，不会进入 claims 门禁。文档只承诺 `NNNN-*.md` 形式，属于已知范围，但“新增 ADR 都要核”这句话在字面上覆盖不到这些命名。
- **推测**：严格 `at` 正则没有做日历合法性检查，像 `2026-02-30T00:00:00Z` 这种串在某些 JS 引擎会被 `Date.parse` 规范化成合法时间；若确实如此，“严格 ISO-8601”只是格式严格，不是日期值严格。未在本环境运行 Node 验证。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

**对 Himawari 产品：不会。** 本次 diff 没有改 `packages/`、`apps/` 或产品运行时，只改了 `scripts/model-review/`、测试和说明文档。发给 Himawari 模型的系统提示、工具定义、历史、遮盖结果都不受影响。

**对复核模型本身：**
- 既有三种模式的固定说明没有变：`OFFLINE_MODES.includes(mode)` 对 plan/plan-review 仍为 false，和原来 `mode === "code-review"` 等价；`RULE_16_SENTENCE` 对非 plan-claims 仍保留；`questions` 非空时输出与原来相同。`test/tooling/review-gateway.test.mjs:597-614` 的逐字节哈希仍在守 code-review/plan/plan-review 的直接配置。
- plan-claims 是一个**新**的固定开头：角色、任务、输出格式都是常量，没有必答问题、没有第 16 条；`head` 和方案内容在 `buildPrompt` 的 `material` 里、位于固定部分之后（`opencode-review.mjs:317-329`）。每轮会变的 `head` 在末尾，不在固定开头。
- 追问仍只追加一句话，工具定义不变（既有逻辑）。
- 唯一需要留意的：本轮把 `必答问题：` 头改成 `questions.length > 0` 才输出（`opencode-review.mjs:311-313`）。正常流程问题列表不为空，所以既有模式字节不变；但如果某次提交的必答问题文件为空，既有模式的固定开头会比以前少一行。这不是 append-only 违规（是新的请求），但属于既有模式提示词的一处条件变化。

### 2. 会不会让同一段文字在不同请求里变成不同字节？

**没有发现新增的这种问题。**
- `safe()` 是纯函数；`at` 时间戳只写进 `usage.jsonl`，不发给模型；`CLAIMS_SUMMARY`/`CLAIMS_FLAGGED` 只打印到控制台。
- plan-claims 的提示词由“固定说明 + 本次材料”组成，材料里是同一提交的 ADR 内容和 `head`，同一提交重跑字节一致；`recordText` 对换行的规范化是固定的。
- 顺序方面：`addedAdrs` 有 `.sort()`，`topicLedgers` 来自 `git ls-tree` 的稳定顺序，`latest` 在 `at` 相同时用 `order` 兜底，输出确定。
- 既有遮盖逻辑没有改动；不过它依赖 `origin/main`/base 里的登记测试值，跨不同 base 运行时同一段文本可能遮成不同字节——这是既有行为，不是本轮引入的，也不进入本次改动的模型输入。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

**有，但覆盖不完整。**
- `test/tooling/plan-claims-gate.test.mjs` 在 CI 的 `tooling` 项目里（`ci/policy.json` 的 `tooling.include` 包含 `test/tooling/**/*.test.mjs`），会随 `npm test`/`npm run check` 跑。
- 坏行新分支：`[claims] a line that looks like a claim but is not in the format is reported, not skipped` 期望 `line-1..3-malformed`。在旧代码上这三行会被跳过、`problems` 为空，所以这个测试**确实会失败**，是真反向用例。
- 严格 `at`：新测试期望 `"2026-11-12 00:00"` 抛 `USAGE_LEDGER_INVALID`；旧代码只做 `typeof + Date.parse`，会接受它，所以这个测试**也会在旧代码上失败**，是真反向用例。
- 制表符/换行文件名测试：断言 `claims-name-unsupported docs/adr/0303-a?b?c.md`。它测的是 b12771b3 已有的 `safe(label)` 路径，在 b12771b3 上就会通过，**不是本轮 `safe` 导出的反向用例**。
- `CLAIMS_FLAGGED` 改用 `safe()` 这件事没有测试覆盖；回退 `printable` → `safe` 不会让任何测试失败。
- 另外，“重跑到碰巧全一致即可通过”没有反向测试；测试只验证了“最新一轮有 `model-wrong` 时通过”。

### 4. 每个新值/改动值，两端是否都能接受？

逐个核对结果：

| 值 | 产生端 | 使用/校验端 | 结论 |
|---|---|---|---|
| `mode: "plan-claims"` | `parseArgs`、`runOne` 写入 | `MODES`、`MODE_TEXT`、`OFFLINE_MODES`、`ASK_FIRST_LINE_USD`、`parseUsage` 的 `modeValid`、`delegate.validateTask` | 一致；delegate 明确拒绝是有意设计 |
| `claimsFile` | `--claims-file` 经 `validClaimsFile` | `blobAt`/`blobSha256`；写入账本；`parseUsage` 的 `validClaimsFile`；`claimsProblems` 与 `adr` 相等比较 | **有问题**：写入账本前被 `maskSecretLikeDeep` 遮盖，消费端仍按原规则校验，见问题 2 |
| `claimsSha256` | `blobSha256`（64 位小写 hex） | `parseUsage` 的 `/^[0-9a-f]{64}$/`；`claimsProblems` 的 `blobSha256` 相等比较 | 一致 |
| `at` | `new Date().toISOString()` | `parseUsage` 的新正则 + `Date.parse`；`claimsProblems` 的 `Date.parse` | 脚本产出的值一致；真实历史记录未核实 |
| 坏行 code（`line-N-malformed`） | `parseClaims` | `main` 的 `CLAIMS_PARSE_FAILED`；`claimsProblems` 的 `claims-answer-invalid` | 都是字符串拼接，能接受 |
| `safe()` 输出 | `plan-claims.mjs` | 控制台 `CLAIMS_FLAGGED` | 无机器消费者，能接受 |
| `--claims-file` 参数 | `parseArgs` | `SUBCOMMAND_ONLY` 检查、`ARG_CLAIMS_FILE_ONLY_FOR_PLAN_CLAIMS`、`ARG_REQUIRED --claims-file` | 一致，非 plan-claims 传会报错 |

总体：除了 `claimsFile` 的“先校验原始值、后遮盖再校验”这一处两端不一致，其余新增字段和标识在产生端和消费端的校验是匹配的。
