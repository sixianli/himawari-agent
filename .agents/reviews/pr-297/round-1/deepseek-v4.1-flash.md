## 发现（按严重度从高到低）

### 高：`--round` 重跑被新写入的 prompt 文件破坏，且 prompt 存档不再是“实际收到的提示词”

**文件:行**：`scripts/model-review/opencode-review.mjs:2950`、`:2392-2393`、`:2425-2427`、`:1610-1614`、`:2976`

**问题**：改动用 `maskedRecordText(prompt)` 写 `<模型>.prompt.md`，但 `maskedRecordText` 先调用 `recordText`，而 `recordText` 总会再补一个换行：

```js
// 2392-2393
export function recordText(text) {
  return `${text.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "")}\n`;
}
// 2425-2427
export function maskedRecordText(text) {
  return maskSecretLike(recordText(text));
}
// 2950
writeFileSync(join(roundDir, promptFileName(model)), maskedRecordText(prompt));
```

`buildPrompt` 的返回值本身已经以 `\n` 结尾（`:305`），因此即使提示词里没有任何“像密钥”的文字，落盘文件也会多一个换行。而重跑校验拿落盘文件和**未经处理**的 `prompts[model]` 逐字比较：

```js
// 1613-1617
if (
  (onDisk !== null && onDisk !== prompts[model]) ||
  recordedDigests.some((recorded) => recorded !== digest)
)
  throw new Error(`ROUND_PROMPT_MISMATCH ${requested} ${model}`);
```

结论：只要该轮的 `<模型>.prompt.md` 存在，`--round` 重跑就会稳定报 `ROUND_PROMPT_MISMATCH`，与提示词里有没有密钥无关。这直接破坏文档写明的补跑路径（`.agents/instructions/model-review.md:91`、`:104`），也违反“每个模型实际收到的提示词”这一存档语义。若提示词里真含密钥，落盘的是遮盖后的文本，而比较对象仍是原提示词，同样必失败。

**建议**：
- 要么让落盘文件保持和实际发送的 prompt 逐字一致；
- 要么把重跑校验改成和落盘时相同的变换比较，例如 `onDisk === maskedRecordText(prompts[model])`，并同步 `promptSha256` 的语义；
- 增加一个真实写盘后再 `--round` 的用例（含提示词里带假密钥的用例），现在所有 `roundForRun` 测试都是手工传 `promptsOnDisk`，没有覆盖写盘路径。

---

### 高/中：遮盖只覆盖 `scan-machine-secrets` 的 7 条规则，盖不住本 PR 自己处理的那类 gitleaks 误报

**文件:行**：`scripts/model-review/opencode-review.mjs:2396-2410`、`ci/rules/gitleaks.toml:118-124`、`test/tooling/opencode-review.test.mjs:2275-2286`

**问题**：I-83 的事故同时包含 `npm run check:secrets` 和 gitleaks，但新的遮盖规则只是 `scripts/scan-machine-secrets.mjs` 的复制，没有 `generic-api-key` 等 gitleaks 默认规则。最直接的证据就是本 PR 新增的白名单值 `MIIEvR2T14TAILBODY`：

```toml
# ci/rules/gitleaks.toml:118-124
targetRules = ["generic-api-key"]
paths = ['''(?:^|/)apps/agent-service/test/pi-coding-program\.unit\.test\.ts$''']
regexTarget = "secret"
regexes = ['''^MIIEvR2T14TAILBODY$''']
```

这个值不匹配 `RECORD_SECRET_RULES` 里的任何一条：不是 `sk-`、不是 Bearer/JWT/GitHub/AWS，也没有 `key: value` 形式，所以它不会被 `maskSecretLike` 遮盖，也不会被合并门 `secretLikeRules` 报出。可是 gitleaks 会把它当成 `generic-api-key`。也就是说，将来某轮复核记录再原样引用这个值，gitleaks 仍会失败，事故会重演；新加的 `test/tooling/opencode-review.test.mjs:2275` 反而把这个缺口固定成“必须和 scan-machine-secrets 完全一致”。

这是“已核实的规则缺口 + 可推断的后果”：同一值在测试文件里确实触发 `generic-api-key`（`gitleaks-config.test.mjs` 的默认规则期望里有它），而它确实不匹配遮盖规则。

**建议**：把合并门/遮盖改为同时覆盖 gitleaks 实际使用的规则集，最稳妥的是在写记录/合并门时用同一份 `ci/rules/gitleaks.toml` 跑一次真实 gitleaks，有命中就遮盖或拒绝；至少为 `MIIEvR2T14TAILBODY` 这类已登记的假值补一条显式规则和用例。不要用“和 scan-machine-secrets 完全一致”的测试把范围锁死。

---

### 中：新合并门会追溯拒绝已经被 baseline/gitleaks 白名单接受的旧记录，且不可 override

**文件:行**：`scripts/model-review/opencode-review.mjs:2429-2440`、`:1222-1229`、`scripts/machine-secret-scan-baseline.json:136-142`、`ci/rules/gitleaks.toml:102-116`

**问题**：`recordSecretProblems` 对当前 PR 账本目录下 HEAD 的所有文件直接跑 7 条规则，不查 baseline，也不看 gitleaks 白名单：

```js
// 2429-2437
const listed = gitStatus(["ls-tree", "-r", "-z", "--name-only", "HEAD", "--", ledgerPath], repo);
...
const shown = gitStatus(["show", `HEAD:${file}`], repo);
...
for (const id of secretLikeRules(shown.stdout))
  problems.push(`record-secret-like ${printable(file)} ${id}`);
```

而已有的 PR 280 记录明确被 baseline 接受：

```json
// scripts/machine-secret-scan-baseline.json:136-142
{
  "file": ".agents/reviews/pr-280/round-1/deepseek-v4.1-flash.md",
  "ruleId": "openai-api-key",
  ...
  "count": 1
}
```

`RECORD_SECRET_RULES` 的 `openai-api-key` 和 baseline 的 `ruleId` 是同一个规则，因此只要对 PR 280 的账本再跑一次 `assertReviewed`，新门就会报 `record-secret-like ... openai-api-key`。PR 274 的私钥开头标记同样可能匹配 `private-key-block`。而 `record-secret-like` 不在 `OVERRIDABLE_PROBLEMS` 里：

```js
// 1222-1229
export const OVERRIDABLE_PROBLEMS = [
  "unreviewed ",
  "ledger-not-committed",
  "no-complete-round",
  ...
];
```

所以 `--accept-unreviewed` 也救不了。风险场景是：任何在本改动合入前就写了若干轮的开放 PR，只要模型引用过假密钥，合并时就会被自己的记录卡住，只能回头改写旧记录。这个门没有把“已经核实并登记的误报”当成可接受值。

**建议**：合并门应复用 `machine-secret-scan-baseline.json` 的 `(file, ruleId, digest, count)` 和/或 gitleaks 白名单，对已登记误报放行；或者只对某个时间点/提交之后新增的记录强制。另加一个“已被 baseline 接受的记录不报”的用例。

---

### 中/低：合并门的扫描范围与遮盖范围不一致，可能误拒合法账本字段

**文件:行**：`scripts/model-review/opencode-review.mjs:2950`、`:2965`、`:3006`、`:2430-2437`、`:2984`、`:1369`

**问题**：写记录时只遮盖三类文件（prompt、答案、stderr）：

```js
writeFileSync(join(roundDir, promptFileName(model)), maskedRecordText(prompt));
writeFileSync(join(roundDir, `${name}.md`), maskedRecordText(summary.text));
writeFileSync(join(roundDir, `${name}.stderr.txt`), maskedRecordText(review.stderr));
```

但门会扫描账本目录下的**所有**文件，包括 `usage.jsonl`。`usage.jsonl` 里的 `apiError`（`:2984`）和 override 的 `quote`（`:1369`）没有经过遮盖。如果服务端错误信息或 Andy 的原话里出现 `Bearer ...`、`password: ...` 之类文字，门会报 `record-secret-like`，而这类问题同样不可 override。触发概率不高，但这是“产生值的路径”和“校验值的路径”不一致。

**建议**：要么把门限定在确实由遮盖函数写出的文件类型，要么在写 ledger 前对文本字段也做校验/遮盖；并补一个 ledger 字段带假密钥的用例。

---

### 低：文档与代码不一致——prompt 文件不再等于“实际收到的提示词”

**文件:行**：`.agents/instructions/model-review.md:91`、`:104`、`:92`

**问题**：文档仍写“每个模型实际收到的提示词（`<模型>.prompt.md`）”，并要求 `--round` 用它比较；代码现在写的是遮盖并规范化的版本。新增的 `:92` 又承认“写进仓库的记录（提示词、答案、错误输出）……遮盖”。同一段说明里前后矛盾。`lowFixProblems` 也依赖答案 `.md` 与 verdict 的 `quote` 逐字匹配（`:1106-1109`），答案被遮盖后，若 low-fix 的引用片段里含假密钥，会出现 `quote-not-found`。

**建议**：明确 `<模型>.prompt.md` 是“遮盖后的存档”还是“实际发送内容”，并相应修改 `--round` 的校验和文档；若必须保留审计，另存实际发送内容的摘要或只读副本。

---

## 侧重检查

我按额外侧重逐项查过：

- **错误路径**：`recordSecretProblems` 对 `git show` 失败直接 `continue`（`:2434-2435`），文件无法用 `HEAD:path` 读出时会被静默跳过；正常记录文件不触发，但这是一条可绕过的错误路径。`maskedRecordText` 没有异常处理，写盘失败会直接抛出；不影响主流程但会中断复核。
- **不可信输入**：模型答案/错误输出是外部内容，正则本身是线性的，没有明显灾难性回溯；但 `credentials-assignment` 会误伤代码表达式（如 `[已遮盖:credential-assignment]` 这类 12 字符以上的值），测试只覆盖了短文本。
- **安全/白名单**：三条新白名单的路径都精确到单个文件；前两条私钥开头没有 `$` 结尾，理论上同一文件里“以该固定开头开始的任何 private-key 命中”都会被放行，但该文件是历史记录且前缀很具体，风险低。第三条精确值风险很低。
- **资源耗尽**：合并门对账本目录每个文件执行一次 `git show`，`maxBuffer` 为 256MB（`:1218-1219`），没有文件大小上限；异常大的记录文件可造成较大内存占用，但需要提交巨大文件，实际风险低。
- **不可撤销操作**：遮盖在写盘时完成，写进仓库后不可逆；原始答案只可能在临时目录的 `.jsonl` 里，prompt 的原始内容没有仓库内副本。若误伤，审计内容无法完整恢复。
- **规则/文档/代码一致性**：ADR 0177 的第 2/5 条和白名单三块基本一致；I-83 的说明与代码一致；但上面的 prompt 文件“实际收到”说明与新行为冲突。另外，`npm run check` 的 `check:steps` 不包含 `test/tooling/opencode-review.test.mjs`、`gitleaks-config.test.mjs`、`gitleaks-allowlist.test.mjs`，也不包含 `check:security`（`package.json:27`、`:71`；这些测试在 `tooling` vitest 项目里，由 `npm test`/CI test 作业运行），所以作者“`npm run check` 通过”并不能证明这些新测试或 `ci/toolchain-lock.json` 的摘要校验通过。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。改动没有修改 `buildPrompt`、系统提示、工具定义或历史组装；`reviewModel` 收到的仍是未遮盖的 `prompt`（`:2950-2958`），遮盖只作用于 `writeFileSync` 的仓库存档。每轮会变的 `head`/`base`/`previous`/`brief` 都仍在 `material` 里、固定在提示词末尾（`:293-305`），符合“只追加、会变值放最后”。**但存档文件不再等于实际发送内容**，这会影响 `--round` 校验和审计，属于上面的高严重度问题。

2. **同一段文字会不会在不同请求里变成不同字节？**
   不会。遮盖规则是固定的七条正则，只依赖被匹配文字本身，不依赖前后文、时间、随机数或集合顺序；`recordText` 的换行/尾随空白处理也是确定的。白名单和 baseline 都是静态数据。需要区分的是：存档字节与实际发送字节现在不同，但这不是“同一内容在不同请求里不同字节”。

3. **有没有对应的自动检查，反向用例真的会失败？**
   有测试，但不完整。已核实：
   - 遮盖逐规则、普通文字不遮、两边规则同步（`opencode-review.test.mjs:2244-2287`）；
   - 合并门拒绝未遮盖记录、接受遮盖后记录（`:2345-2362`）；
   - 新 gitleaks 白名单的形状、路径正反例（`gitleaks-allowlist.test.mjs:63-112`）；
   - 用真实 gitleaks 检查放行与“同一值换文件照报”，以及放宽白名单必须改变结果（`gitleaks-config.test.mjs:196-263`）。我读了反向用例，路径或值放宽后确实会改变 findings，断言不是空转。

   缺口：没有测试真实写盘后的 `--round` 重跑，所以上面的高严重度回归不会被发现；没有测试“gitleaks 会报但遮盖规则不认”的值（`MIIEvR2T14TAILBODY` 正是例子）；没有测试“baseline 已接受的旧记录不应被新门拒绝”。

4. **改动产生或修改的每个值，使用它的地方都能接受吗？**
   - `<模型>.prompt.md` 的内容：`roundForRun` 不能接受（多换行 + 遮盖导致 `ROUND_PROMPT_MISMATCH`）；`lowFixProblems` 依赖的答案 `.md` 逐字匹配也可能不接受遮盖后的 quote。
   - `record-secret-like` 问题字符串：`OVERRIDABLE_PROBLEMS` 不接受它，因此不可 override；这是设计意图，但和旧记录兼容性冲突。
   - `RECORD_SECRET_RULES` 的规则 id：遮盖输出和测试都接受，但覆盖不了 `generic-api-key`。
   - baseline 的 `ruleId`/`digest`/`count`：`scan-machine-secrets.mjs` 按 `file\0ruleId\0digest` 和 count 使用，`ruleId` 与扫描规则一致；`digest` 无法在本次复核中计算（`.agents/reviews` 被 git guard 拒绝读取），**未核实**。
   - gitleaks 白名单的 `targetRules`/`paths`/`regexes`：测试与配置一致；第三条精确值是否就是 gitleaks 实际抽取的 secret 值，测试夹具是模拟的，真实记录内容**未核实**。
   - `ci/toolchain-lock.json` 的新 sha256：会被 `install-tools.mjs:332-340` 的 `verifyRuleFiles` 与真实文件比较；本次无法计算 sha256，**未核实**，且作者声称的 `npm run check` 不包含这一步，建议跑 `check:security` 或等价校验。
   - 文档引用：I-83、ADR 0177 的锚点和编号可用；但 `.agents/instructions/model-review.md:91` 与新的遮盖行为冲突（见上）。

## 未核实项

- PR 274 第 7 轮记录的真实文本和 PR 280 第 1 轮记录的真实文本（仓库的 git guard 拒绝读取 `agents/reviews` 路径），因此 baseline 摘要、白名单是否精确命中真实记录，只依据作者说明和合成夹具判断。
- `ci/toolchain-lock.json` 中新 sha256 是否等于当前 `ci/rules/gitleaks.toml` 的 sha256（无法执行哈希计算）。
- 作者声称的 gitleaks 计数（29→26、31→28）和 `npm run check` 结果（无法运行）。
