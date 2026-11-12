## 结论

这次增量（`bf503ebc..fa4271f8`）主要是加固第 5 轮：ADR 文件名像密钥时拒绝、坏行前缀放宽、文档与提示对齐。**没有发现会改变 Himawari 请求内容的问题**；改动只落在开发用的复核脚本、其测试和说明文档里。但有一个“产出的值”和“消费它的校验”不一致的错误路径：`ledgerLine` 对所有字段遮盖后，`claimsFile` 可能被遮成 `parseUsage` 不接受的形状，把整个 topic 账本弄坏。另有坏行前缀仍会静默漏网、以及 `ledgerLine` 改动缺少直接测试两处低严重度问题。

---

## 问题（按严重度）

### 1. 中：`ledgerLine` 把 `claimsFile` 遮掉后，`parseUsage` 会拒绝整条记录，topic 账本变不可读

- 文件:行：`scripts/model-review/opencode-review.mjs:2675`、`:2665`、`:3118`、`:3306`、`:1708`、`:1736`、`:1104`
- 类型：读代码证实（触发条件为推测，见下）

证据：

```
2675 export function ledgerLine(record) {
2676   return `${JSON.stringify(maskSecretLikeDeep(record))}\n`;
```
```
2665 function maskSecretLikeDeep(value) {
2666   if (typeof value === "string") return maskSecretLike(value);
```
`maskSecretLike` 默认 `registeredValues = true`（`:2637`），会把登记值也换成 `[已遮盖:registered-test-value]`。

写账本前登记值已经加载：

```
3118   registerTestValuesFromRefs(options.repo, [commits.base ?? commits.head, "origin/main"]);
...
3306       appendFileSync(join(options.out, "usage.jsonl"), ledgerLine(record));
```

而 `parseUsage` 要求 `claimsFile` 仍是合法路径：

```
1708       const claimsValid =
1709         record?.mode !== "plan-claims" ||
1710         (validClaimsFile(record.claimsFile) &&
...
1736         throw new Error(`USAGE_LEDGER_INVALID ${path}:${number}`);
```

`parseArgs` 和合并门的检查都在登记值加载之前：

```
3095   const options = parseArgs(process.argv.slice(2), {
...
3102   if (options.assertReviewed) {
3103     const result = assertReviewed(options);
...
3108     return;
3118   registerTestValuesFromRefs(...)
```

所以：**如果 ADR 路径里含某个已登记的测试假值**（`ci/rules/gitleaks.toml` 里 `^[已遮盖:registered-test-value]$`、`^[已遮盖:registered-test-value]$`、UUID 等，长度 ≥12、字符集允许 `/` 和 `.`），`parseArgs` 和合并门都会放行，但运行结束写账本时 `claimsFile` 被遮掉。下一次 `readUsage`（`:1101-1104`）直接抛 `USAGE_LEDGER_INVALID`，整个 topic 账本报废；`claimsProblems` 里则变成 `claims-ledger-invalid`。这正好是问题 4 要核的“产生方的值，消费方是否接受”。

触发条件：需要 ADR 文件名恰好包含登记值；当前 `docs/adr/` 未见这种名字，所以实际可达性低。登记值清单也不只是真密钥，`[已遮盖:registered-test-value]`、`[已遮盖:registered-test-value]` 这类值出现在 slug 里并非不可能。`claimsSha256` 理论上也可能被无锚定的登记值正则命中（概率极低）。

建议：
- 在 `main()` 的 `registerTestValuesFromRefs(...)` 之后、花钱和写记录之前，用同一套 `maskSecretLike` 再检查一次 `options.claimsFile`，不一致就提前失败（例如新增 `CLAIMS_FILE_SECRET_LIKE`），不要写出坏账本；
- 或者让 `parseArgs` / 合并门 / `ledgerLine` 对 `claimsFile` 使用同一档规则（例如都传 `{ registeredValues: false }`），并明确是否允许登记值出现在文件名里；
- 补一条测试：用 `ledgerLine` 写一条带 `claimsFile` 的 `plan-claims` 记录，其路径含登记值，断言要么运行提前拒绝、要么 `parseUsage` 仍能读。

### 2. 低：坏行前缀仍有静默漏网，和“坏行不再静默跳过”的目标不完全一致

- 文件:行：`scripts/model-review/plan-claims.mjs:47`
- 类型：读代码证实（具体漏网样例为按正则推断，未运行）

证据：

```
47     if (!line.startsWith("CLAIM|")) {
48       if (/^(?:\p{N}+[.．)）、]\s*)?[`*"'“#]*CLAIM(?![A-Za-z])/u.test(line))
49         problems.push(`line-${number}-malformed`);
```

新正则覆盖了 `1、`、`１. `、`1）` 这类前缀，但没有覆盖常见的：
`（1）CLAIM|…`、`(1) CLAIM|…`、`1。CLAIM|…`、`1：CLAIM|…`、`① CLAIM|…`、`- [ ] CLAIM|…`。
这些行既不以 `CLAIM|` 开头，也不匹配上面的前缀，会被 `continue` 静默跳过。混用格式时，部分 CLAIM 会被无声丢弃，正是第 2 轮 `cf91df59` 想消除的失败模式（全都被跳时至少还会报 `claims-none`）。

建议：把括号、圈号、全角 `。：` 纳入前缀，或者更保守地：任何包含 `CLAIM` 且不像正常文字、又不在 `CLAIM|` 行首的行都报 malformed；给上述几种写法补测试。

### 3. 低：`ledgerLine` 恢复成“所有字段遮盖”这件事没有自动检查

- 文件:行：`test/tooling/plan-claims-gate.test.mjs:116`、`test/tooling/opencode-review-merge-gate.test.mjs:522`
- 类型：读代码证实（diff 与测试源码）

证据：本增量删掉了唯一直接测 `ledgerLine` + `claimsFile` 的用例，并把 `ledgerLine` 的 import 也删了：

```
-  ledgerLine,
...
-  it("[claims gate] a file name that looks like a secret is still recorded in a ledger the gate can read", () => {
```

新测试只验证 `parseArgs` 拒绝和门报 `claims-name-unsupported`，没有验证 `ledgerLine` 实际写出的内容。现有测试要么直接 `JSON.stringify(record)` 写账本（`plan-claims-gate.test.mjs:116`），绕开 `ledgerLine`；要么只测 `override` 字段（`opencode-review-merge-gate.test.mjs:522-539`）。把 `ledgerLine` 改回旧的特殊分支，现有测试不会红。

建议：如前所述补一条 `ledgerLine` + `plan-claims` + `claimsFile` 的往返测试，覆盖普通名字和像密钥的名字两种，明确“被遮后是否可接受”。

### 4. 低（潜在）：`looksSecret` 是可选项，且 `maskSecretLike` 默认包含登记值，和 ADR 0190 的约定有漂移风险

- 文件:行：`scripts/model-review/plan-claims.mjs:206`、`scripts/model-review/opencode-review.mjs:1378`
- 类型：读代码证实 + 推测（当前 CLI 不触发）

证据：

```
206     if (!validClaimsFile(adr) || looksSecret?.(adr)) {
```
```
1378     looksSecret: (text) => maskSecretLike(text) !== text,
```

`looksSecret` 不传时会静默跳过这条安全检查（测试里的直接调用就没传）。另外 `maskSecretLike` 默认 `registeredValues = true`；ADR 0190 明确写“合并门（`--assert-reviewed`）不检查登记值，只认内置的密钥形状”（`docs/adr/0190-...md:81`）。当前 `assertReviewed` 在 `main()` 里于 `registerTestValuesFromRefs` 之前返回，所以行为恰好符合 ADR；但只要以后有人在门之前加载了登记值，门的结果就会随 `origin/main` 的白名单变化，违背 ADR 0190 的意图。

建议：让合并门显式使用 `maskSecretLike(text, { registeredValues: false })`，并把 `looksSecret` 变成必填（或在 `plan-claims.mjs` 内提供默认实现），避免选项顺序变化导致同一 ADR 名字时而过、时而被拒。

---

## 未核实

- `.agents/reviews/pr-415/round-4/` 下新增的答案与提示词存档内容未读到：环境里的 git 替身对 `agents/reviews` 路径直接返回 `REVIEW_GIT_REFUSED`，glob 也看不到这些文件。因此无法确认它们是否含有会被 `recordSecretProblems` / gitleaks 当成密钥的文字。脚本落盘时会走 `maskedRecordText` / `maskSecretLike`，按理应已遮盖，但这是未核实项。
- 全程未运行测试（本次只允许读文件和只读 git 命令），下面的“反向用例会失败”是读测试代码后的推断。

---

## 侧重检查

我重点查了这些错误路径、不可信输入和文档一致性：

- **ADR 文件名（不可信输入）**：`validClaimsFile`、`parseArgs` 的 `maskSecretLike` 拒绝、门里的 `looksSecret`。静态密钥形状（`sk-…`、`gh…`、`AKIA…`、JWT、私钥等）在三个入口一致；**登记值这条路径不一致**，见问题 1。
- **模型答案（不可信输入）**：`parseClaims` 的坏行、重复 ID、字段数、verdict 白名单；坏行检测仍有静默漏网，见问题 2。
- **账本/记录串行化**：`ledgerLine` 对所有字段遮盖，JSON 仍合法；但 `plan-claims` 的 `claimsFile` 是结构性字段，被遮后无法被 `parseUsage` 和 `claimsProblems` 消费，见问题 1、3。
- **安全与遮盖**：模型收到的提示词仍是原文、遮盖只在落盘（ADR 0190），没有新的模型侧泄漏；`parseArgs` 失败信息不回显敏感内容；门的 `claims-name-unsupported` 会把含密钥形状的路径打到 stdout，但该路径本来就已提交在仓库里，不算新增泄漏。
- **资源耗尽**：新增的正则和循环都在线性量级，没有新增无界递归或大内存路径；未发现新问题。
- **不可撤销操作**：改动只写 `.agents/reviews/` 记录；问题 1 会让账本变成 `USAGE_LEDGER_INVALID`，修复需要手工改已提交文件（实际上要重写历史或追加修正），属于需要避免的后果。
- **规则/文档/代码一致性**：
  - `.agents/instructions/model-review.md:30` 的“序号用 1、2、3……，脚本不检查连续性”与提示和代码一致；
  - `:36` 的“每个轮次里每个模型最后一次有结果的运行”与 `lastByModel` + `outcome === "ok"` 基本一致；仅在“同一轮先 ok、后又被追加一条非 ok 记录”的手工/历史账本下，代码取最后一条而非最后一条 `ok`，工具本身用 `ROUND_ALREADY_HAS_RESULT` 不允许这种顺序，故实际等价（推测，未构造用例）；
  - `:40` 的“长得像密钥的文字……没法传给 `--claims-file`”对内置规则成立，对登记值不成立（问题 1）；
  - 作者说的“不改变发给 Himawari 的任何内容”成立：改动文件均不在生产请求路径，`.ts` 生产代码没有引用 `scripts/model-review/*`。

---

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**

- 对 **Himawari**：不会。改动只在 `.agents/`、`scripts/model-review/`、`test/tooling/`，生产代码没有引用；系统提示、工具定义、历史、遮盖都不受影响。
- 对 **复核模型**：唯一模型可见的变化是 `opencode-review.mjs:280` 里 plan-claims 的固定输出说明文字。它属于每次复核新会话的提示文本，不是往已有会话中间插入；同一会话内的 wrap-up 仍只用 `--session` 续接并在末尾追加（`opencode-review.mjs:792`、`:1052-1058`）。会变的值（`head`/`base`/`previous`/材料）仍由 `buildPrompt` 放在末尾的 material（`:300-329`），没有进系统提示或工具定义。
- 附带影响：提示文字变了，用旧提示生成的 `--round` 再跑会因 `promptSha256` 不同被 `roundForRun` 以 `ROUND_PROMPT_MISMATCH` 拒绝（`:1791-1801`）；这不是改写已发出的开头，但旧轮次不能原地重跑。
- 结论：**发给模型的内容仍然只在末尾追加；每轮会变的值仍在最后一条消息（material）里。**

**2. 会不会让同一段文字在不同请求里变成不同字节？**

- 请求侧：不会。plan-claims 的附加文字是固定字符串；`at` 时间只进账本；集合/Map 的遍历顺序由账本行序决定；没有新增依赖前后文的模型遮盖（模型拿到的仍是未遮原文）。
- 记录侧：有。`ledgerLine` 对 `claimsFile` 的遮盖依赖登记值集合，而登记值来自 `base/HEAD` 和 `origin/main`，会随时间变化；同一个 `claimsFile` 在不同时间可能被遮成不同字节。这正是问题 1 的根因，也说明“结构化字段不应经过会变的遮盖”。

**3. 有没有对应的自动检查，反向用例真的会失败吗？**

- `parseArgs` 拒绝像密钥的 `--claims-file`：有新用例；去掉该检查，`toThrow("ARG_INVALID --claims-file")` 会失败。
- 合并门报 `claims-name-unsupported`：有新用例；去掉 `looksSecret`，`claimsOnly(...)` 不会再得到该问题，会失败。
- 坏行前缀：有新用例；把正则退回旧版，三条 `1、/１./1）` 都不会产生 problem，`toHaveLength(3)` 会失败。
- **`ledgerLine` 恢复对所有字段遮盖：没有直接反向用例**（旧用例被删，新用例不经过 `ledgerLine`），见问题 3；登记值导致坏账本这条也没有测试。
- 测试只断言了坏行问题数量，没有断言具体 `line-N-malformed`，属于弱断言（不影响本次结论）。

**4. 每个产生/修改的值，消费方都能接受吗？**

- `ARG_INVALID --claims-file`：只用于 CLI 报错，消费方一致。
- `claims-name-unsupported`：文档、测试使用；`assertReviewed` 通过 `looksSecret` 传入；它在 `OVERRIDABLE_PROBLEMS` 的 `claims-` 前缀内，可按文档被 Andy 原话覆盖；一致。
- 提示里的序号说法：无程序消费方；与文档一致。
- `line-N-malformed`：经 `claims-answer-invalid` 进入门，消费方接受。
- **`ledgerLine` 产出的 `claimsFile`（以及极端情况下的 `claimsSha256`）：`parseUsage` 的 `claimsValid` 和 `claimsProblems` 的 `record.claimsFile === adr` 都要求原样路径，被遮盖后不接受** —— 这是本次唯一确认的不一致，见问题 1。其余字段（`at`、`model`、`cost`、`head` 等）遮盖后仍满足各自校验。

**作者说法的核对结果**

- “像密钥的 ADR 文件名不再放行原样写账本；`parseArgs` 拒绝；合并门报 `claims-name-unsupported`”：对内置规则成立；对登记值不成立（`parseArgs` 放行、门放行，写账本时才遮，反而弄坏账本）。
- “`ledgerLine` 恢复成对所有字段遮盖”：属实（`:2675-2676`）。
- “坏行前缀放宽到 Unicode 数字和全角分隔符”：属实，但仍有括号、圈号、全角句号/冒号等常见前缀漏网。
- “提示里序号说法与文档对齐”：属实（`opencode-review.mjs:280` 与 `model-review.md:30`）。
- “文档把‘每一次运行’改成‘每个轮次里每个模型最后一次有结果的运行’”：与代码基本一致，仅手工/历史账本下“最后一次运行”和“最后一次有结果的运行”有细微差别。
- “这个改动不改变发给 Himawari 模型的任何内容”：属实。
