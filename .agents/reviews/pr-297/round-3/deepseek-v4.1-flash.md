## 侧重检查

- **私钥/密钥类输入**：核对了 `private-key-block` 与 `private-key-header` 两条规则的匹配范围，以及合并门是否复用同一组规则。发现规则只覆盖 RSA/EC/OPENSSH 的完整块，其余格式（ENCRYPTED/DSA/PGP 及小写变体）只遮开头。
- **不可信记录与绕过路径**：核对了 `recordSecretProblems` 只扫本 PR 目录、`changedOutside` 与 `OVERRIDABLE_PROBLEMS` 的交互，发现改别的 PR 记录目录会被归入可放行的 `unreviewed`。
- **错误路径**：核对了 `git ls-tree`/`git show` 失败分支、`record-unreadable` 是否可被 `--accept-unreviewed` 放行、以及补跑比较失败路径。
- **资源耗尽**：合并门每次会对本 PR 目录下所有已提交记录逐个 `git show` 并跑 8 条正则；记录文件很大或很多时有额外开销，但属于受信任的复核记录，未作为独立问题列出。
- **规则、文档、代码一致性**：核对了 I-86、`.agents/instructions/model-review.md` 与代码，发现一处 `maskedRecordText` 表述不符，见下。
- **未核实**：两个被“重新遮盖”的记录 `.md` 的实际内容，以及 round-1/round-2 记录是否已全部干净。复核环境对 `.agents/reviews` 路径的 git 读取返回 `REVIEW_GIT_REFUSED records-path`，且稀疏检出未包含这些文件。

## 读代码证实的问题（按严重度）

### 1. 中高：非 RSA/EC/OPENSSH 的私钥块只遮头、不遮正文，合并门会放行

`scripts/model-review/opencode-review.mjs:2397-2401`

```js
["private-key-block",
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
["private-key-header", /-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----/gi],
```

问题：完整块规则只认 `RSA |EC |OPENSSH ` 且大小写敏感；新的头规则虽然能匹配 `ENCRYPTED PRIVATE KEY`、`PGP PRIVATE KEY BLOCK`、`DSA PRIVATE KEY` 和小写形式，但只替换开头那一行。`maskSecretLike`（`:2413-2417`）因此会留下整段 base64 正文；随后 `recordSecretProblems` 用同一组规则复查（`:2452`）也发现不了正文，合并门通过。gitleaks 的 `private-key` 规则以 BEGIN 标记开头（文档 `.agents/instructions/model-review.md:92` 自己写明），头被替换后它大概率也无法再命中剩余正文；其余 8 条规则没有通用高熵/裸 base64 检测。这个缺口在本轮把规则改成大小写不分后对更多形式可达。

建议：把完整块规则放宽为大小写不分的“任意前缀 + PRIVATE KEY + 可选 BLOCK”并匹配到对应 END，或遮掉从 BEGIN 到对应 END 的整段；补一条“完整 ENCRYPTED/PGP 私钥块”的反向用例，断言正文也被遮且 `secretLikeRules(masked)` 为空。

### 2. 中：改别的 PR 记录目录可用 `--accept-unreviewed` 绕过 `record-secret-like`

`scripts/model-review/opencode-review.mjs:1222-1235`、`:1282-1284`、`:2442-2443`；`.agents/instructions/model-review.md:92`

```js
const OVERRIDABLE_PROBLEMS = ["unreviewed ", "ledger-not-committed", ...];
...
return result.stdout.split("\0").filter((file) => file && !file.startsWith(`${ledgerPath}/`));
...
problems.push(...recordSecretProblems({ repo, ledgerPath }));
```

问题：`recordSecretProblems` 只扫本 PR 的 `ledgerPath`。若在 `.agents/reviews/<别的 PR>/...` 里加入像密钥的文字，只会产生 `unreviewed <文件>`，而 `unreviewed` 在 `OVERRIDABLE_PROBLEMS` 里，`--accept-unreviewed` 会写 override 记录并放行。文档说“别的 PR 目录里的记录由 `unreviewed` 拦”，但没有说明它是可放行的，和 `record-secret-like`/`record-unreadable`“不能用 `--accept-unreviewed` 放行”的保护力度相反。作者把它留给 Andy 决定，风险可审计，但理由不足以让文档保持现在的说法。

建议：对 `REVIEWS_DIR` 下所有被改动的记录文件跑 `recordSecretProblems`，或把“本 PR 之外任何 `.agents/reviews/` 改动”设为不可放行；至少把文档改成“可被 `--accept-unreviewed` 放行，CI 事后还有 gitleaks”。

### 3. 中低：补跑比较依赖当前规则集，摘要与存档不可互验（未采纳的第 6、8 条）

`scripts/model-review/opencode-review.mjs:1606-1617`、`:2966`、`:2992`

```js
(onDisk !== null && onDisk !== maskSecretLike(prompts[model])) ||
recordedDigests.some((recorded) => recorded !== digest)
...
writeFileSync(join(roundDir, promptFileName(model)), maskSecretLike(prompt));
...
promptSha256: createHash("sha256").update(prompt).digest("hex"),
```

问题：补跑时用“当前规则”重新遮盖重建的提示词并与旧存档比较。只要遮罩规则改过（本 PR 自己就改了 `private-key-header`），任何含新命中词的旧存档都会报 `ROUND_PROMPT_MISMATCH`，合法补跑被拒。同时 `promptSha256` 是未遮盖原文的摘要，和遮盖后的存档无法互验；把存档里的一个密钥换成另一个会被同一规则遮成同一标记的值，比较仍然相等，存档不可防替代。作者判为“低”，触发概率确实不高，但修复成本很低。

建议：写入存档时同时记录“遮盖后存档”的摘要（如 `promptMaskedSha256`），补跑时优先比较它，保留 `promptSha256` 供未遮盖语义校验；这样规则变更不再破坏补跑，存档也可验证。

### 4. 低：I-86 文档说提示词走 `maskedRecordText`，代码用的是 `maskSecretLike`

`docs/incidents-and-gates.md:122`；`scripts/model-review/opencode-review.mjs:2426-2427`、`:2966`

```md
（提示词、答案、错误输出走 `maskedRecordText`，账本三种写入先遮盖字段再序列化，走 `ledgerLine`）
```

```js
writeFileSync(join(roundDir, promptFileName(model)), maskSecretLike(prompt));
```

问题：答案和错误输出走 `maskedRecordText`（含 CRLF 归一和行尾空白清理），提示词只走 `maskSecretLike`，两者行为不同。同一句还写 `record-unreadable <文件>`，而 `ls-tree` 失败分支报的是目录（`:2444`）。属于文档与代码的小偏差，但这是安全相关的说明文档。

建议：改文档为“提示词走 `maskSecretLike`，答案/错误输出走 `maskedRecordText`”，并说明 `ls-tree` 失败报目录。

### 5. 低：`ledgerLine` 会改写 low-fix 的 `files`/`findings`，后续一致性校验可能误拒

`scripts/model-review/opencode-review.mjs:2430-2439`、`:1350`、`:1254-1263`

```js
findings: check.errors.map((verdict) => verdict.id),
...
if (check.problems.length === 0 && !sameList(point.files, check.files)) problems.push("files-differ");
```

问题：`ledgerLine` 递归遮盖所有字符串，包括本应精确对应的文件路径和 verdict id。若真实文件名或 id 含像密钥的子串（例如 `password=...`），账本里记录的是遮盖后的值，下一次门检查拿它和真实 diff/verdict 比较就会得到 `files-differ`/`findings-differ`，low-fix 被误拒；`reviewReport` 里 `verdicts.find(...)` 还可能取不到而抛错。概率低，但端到端理由成立。

建议：只遮盖自由文本字段（`quote`、`problems`、`apiError`、`lastReason` 等），`files`/`findings`/`head`/`from`/`model`/`mode` 等标识保持原值；或在比较时两边都按同样规则遮盖。

### 6. 低：新测试有覆盖缺口

`test/tooling/opencode-review.test.mjs:2272-2306`、`:2410-2432`

问题：`[round-2 R2-1]` 只测了孤立的私钥开头，没有测完整非标准私钥块的正文；`[merge gate] refuses a lone private-key header` 用 `[已遮盖:private-key-header]`，旧的正则也能命中，因此它不是针对本轮放宽规则的反向用例；`[merge gate] reports record-unreadable` 只直接调用函数，没有验证在 `assertReviewed({acceptUnreviewed})` 下确实拒绝放行（`overridden === false` / `REVIEW_OVERRIDE_REFUSED`）。`[round-2 R2-3]` 的源码正则对空白敏感，属于脆弱检查。

建议：加完整 ENCRYPTED/PGP 块正文被遮的反向用例；加 `assertReviewed` + `--accept-unreviewed` 下 `record-unreadable`/`record-secret-like` 仍拒绝的用例。

## 推测（未读代码直接证实）

- 第 1 条要真正泄漏，需要模型在被复核的代码里读到并原样引用一个真实私钥；触发频率未知。规则匹配层面可以确定只遮头，是否会实际发生属于推测。
- 第 2 条需要有人刻意对别的 PR 记录目录使用 `--accept-unreviewed` 并拿到 Andy 原话；gitleaks 在推送后可能兜底，但 I-86 明确“合并不等 CI”，所以存在窗口。是否有人会这样做，未核实。
- 第 3 条中“规则变更导致合法补跑失败”只影响包含像密钥文字的提示词，概率不高；“替换同规则密钥后比较仍相等”是逻辑推断，未实际构造验证。
- 两个被重新遮盖的 `.md` 是否已彻底干净、是否破坏已有 verdict 引用，未核实（复核环境拒绝读取 records 路径）。

## 必答问题

1. **不会改变模型已经见过的请求开头。** 发给模型的是未遮盖的 `prompt`（`:2966` 写遮后存档、`:2974` 把 `prompt` 传给 `reviewModel`）；被改的只是仓库存档，补跑比较也改成和 `maskSecretLike(prompts[model])` 比（`:1614`）。会变的值 `head`/`base`/`previous`/`brief` 仍集中在 `buildPrompt` 的 `material` 末尾（`:293-305`），固定内容在前；追问仍只在末尾追加。请求头未变。

2. **不会让发给模型的内容字节变化。** 遮盖不用于出口，答案/提示词/账本都不进模型请求；`maskSecretLike` 是逐字段纯函数，结果不依赖对象顺序，`at` 时间戳只在账本、不进请求。需要注意 `private-key-block` 的匹配依赖后面是否出现 END，若将来把它用到会话出口就会违反“只看自己及前面”的确定性要求；本 PR 只用于存档，暂不影响请求。

3. **有自动检查，但覆盖不全。** 新测试在 tooling 项目运行；R2-1、R2-2、R2-3 和 `record-unreadable` 在旧实现上会失败（反向用例有效）。缺口是：完整非标准私钥块正文没有反向用例；`record-unreadable` 没有在 `assertReviewed` + `--accept-unreviewed` 下验证不可放行；合并门本身仍是手动命令，不在 `check:steps` 里自动执行，自动跑的只是这些单元测试。

4. **两端大体一致，但有上述问题。** `record-secret-like`/`record-unreadable` 确实不在 `OVERRIDABLE_PROBLEMS`，符合文档；`promptSha256` 用未遮原文、和 `roundForRun` 的 digest 校验一致；遮后补跑文件与 `maskSecretLike(prompts)` 一致。问题在于：`ledgerLine` 改写的 `files`/`findings` 与后续 `sameList` 校验可能不一致（第 5 条）；`private-key-header` 的遮盖程度与“不得把私钥写进记录”的目标不一致（第 1 条）；别的 PR 目录的路径根本没经过 `recordSecretProblems`，只有可放行的 `unreviewed`（第 2 条）；I-86 的 `maskedRecordText` 表述与代码不符（第 4 条）。
