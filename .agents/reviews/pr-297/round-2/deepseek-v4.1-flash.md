# PR 297 第 2 轮复核（ab5b10a，增量 6c9e2bc..ab5b10a）

先给结论：第 1 轮点名的多数问题确有对应改动，但**新增的 `private-key-header` 遮盖规则与合并门都没有处理本 PR 已经提交的 round-1 记录**，这是最需要核实的一处；另外 `usage.jsonl` 的遮盖是在 `JSON.stringify` 之后做的，可能把账本 JSON 弄坏；`low-fix` 账本行漏了遮盖。下面分开写「读代码证实」与「推测/未核实」。

---

## 高

### 1. 高（需核实）：新加的 `private-key-header` 门规则会回头扫描本 PR 已提交的 round-1 记录，但没有同步重遮或加白名单
`scripts/model-review/opencode-review.mjs:2403`、`:2432-2446`

- 证据（读代码证实）：
  - 新规则：`["private-key-header", /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/g]`（2403）。
  - 门扫描的是 **HEAD 上本 PR 目录下的全部文件**，包括 round-1 的 prompt/answer/usage：
    `git ls-tree ... "HEAD" -- ledgerPath`（2433），然后逐个 `git show HEAD:${file}` 后跑 `secretLikeRules`（2437-2443）。
  - 合并门在 `assertReviewed` 里无条件加入这些 problem（1284），且 `record-unreadable`/`record-secret-like` 都不在 `OVERRIDABLE_PROBLEMS`（1222-1229），不能用 `--accept-unreviewed` 放行。
  - round-1 记录是在 `95b0bf1` 用**旧规则**（不含 `private-key-header`）写下的；`6c9e2bc` 只改了脚本、测试和文档，`git log --oneline --name-status` 显示没有改动任何 `.agents/reviews/pr-297/round-1/*` 文件。
- 推测（未核实实际文件内容）：round-1 复核正是在讨论「遮盖比 gitleaks 窄、只遮完整私钥块」，回答里很可能原样引用了 `[已遮盖:private-key-header]`（尤其 `ci/rules/gitleaks.toml:108/116` 这两处只有开头标记、没有 END，旧 `private-key-block` 规则不会命中）。若如此，新门会在 `--assert-reviewed` 时报 `record-secret-like .agents/reviews/pr-297/round-1/... private-key-header`，gitleaks 的 security 作业也可能把它当 `private-key` 报红——这正好复现 I-86 的形态。
- 未核实说明：我尝试读取这些记录，被沙箱以 `REVIEW_GIT_REFUSED records-path ...` 拒绝，工作区也没有稀疏检出这些文件，因此无法确认它们是否真的含有孤立标记。
- 建议：在 HEAD 上实际跑一次合并门和 gitleaks；若命中，把 round-1 记录用当前 `maskSecretLike` 重遮（记录目录在 `changedOutside` 之外，允许事后补遮），或按 ADR 0177 为 pr-297 的具体值加窄白名单。只加规则不迁移旧记录，这个自阻塞风险一直存在。

---

## 中

### 2. 中（读代码证实）：对序列化后的 JSON 做遮盖可能吃掉落引号，写出无效的 `usage.jsonl`
`scripts/model-review/opencode-review.mjs:2411`、`:3006-3009`、`:1367-1371`

- 证据：`credential-assignment` 正则以可选的引号结尾：
  `...\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{12,}["']?`（2411）。
  账本却是先 `JSON.stringify` 再遮盖：
  ```
  maskSecretLike(`${JSON.stringify(record)}\n`)   // 3008
  ```
- 后果：若某个自由文本字段以「`[已遮盖:credential-assignment]`」这种形状结尾（如 `apiError`、`retriedAfter`、override 的 `quote`），`JSON.stringify` 后是 `"[已遮盖:credential-assignment]`，正则会把**结尾的 JSON 引号**也吃进匹配并整体替换，得到 `"[...masked...]}` 这类未闭合字符串，`parseUsage` 下次会以 `USAGE_LEDGER_INVALID` 拒绝，而已写入/提交的行需要手工修复（`--accept-unreviewed` 的 override 行也走同一条 1369-1371）。旧代码写的是合法 JSON，这是本次改动引入的回归。
- 建议：先对对象的字符串字段递归 `maskSecretLike` 再 `JSON.stringify`；或在遮盖后强制 `JSON.parse` 校验，失败则退回按字段遮盖，别把序列化后的结构文本当纯文本替换。

### 3. 中（读代码证实）：`low-fix` 账本行没有遮盖，和文档「账本都遮」不一致
`scripts/model-review/opencode-review.mjs:1340-1352`；文档 `.agents/instructions/model-review.md:92`

- 证据：normal 账本行有 `maskSecretLike`（3008），override 行有（1369），但 low-fix 行是：
  ```
  appendFileSync(ledgerFile, `${...}${JSON.stringify({
    mode: "low-fix", ...
    files: check.files,
    findings: check.errors.map((verdict) => verdict.id),
  })}\n`);
  ```
  完全没有遮盖。而文档写的是「提示词、答案、错误输出和账本（`usage.jsonl`）都遮」。
- 影响：`files` 是仓库路径、`findings` 是 verdict id，都属于外部/模型可影响的可变字符串。`findings` 通常也会出现在 `verdicts.jsonl`（会被门扫到，从而多半会先被拒），但 `files` 里的路径不一定出现在别的记录文件里；一旦带 secret-like 文本，会先落进账本，下一次门才报，属于「已提交后才发现」。
- 建议：low-fix 的 append 也走 `maskSecretLike`，并补一条用例证明三处账本写入都被遮。

---

## 低

### 4. 低（推测，依据 gitleaks 默认规则的一般行为）：新 `private-key-header` 比 gitleaks 的 `private-key` 窄
`scripts/model-review/opencode-review.mjs:2403`

- 证据：新规则大小写敏感，前缀字符类只有 `[A-Z0-9 ]`。gitleaks 用 `[extend] useDefault = true`（`ci/rules/gitleaks.toml:3-4`），其默认 `private-key` 规则通常大小写不敏感且前缀允许更宽的字符。这样像 `[已遮盖:private-key-header]` 或含 `_`/`-` 的前缀，gitleaks 会报、这里不会遮（`private-key-block` 同样大小写敏感）。round-1 的诉求是「遮盖比 gitleaks 窄」，新规则又留下了另一类窄口。
- 建议：至少加 `i` 并让前缀类对齐 gitleaks（或直接复用其正则），再用反向用例证明大小写/字符类变体也会遮。

### 5. 低：`record-unreadable` 没有自动检查，且 `ls-tree` 失败仍然是静默跳过
`scripts/model-review/opencode-review.mjs:2433-2434`；测试 `test/tooling/opencode-review.test.mjs`

- 证据：`const listed = ...; if (listed.status !== 0) return [];`（2433-2434）——列举失败时整段检查静默通过。`git grep record-unreadable` 在测试文件里没有任何命中，只有 `record-secret-like` 的用例（2353-2370）。
- 建议：`ls-tree` 失败也要报 `record-unreadable`；补一个 `git show` 失败报 `record-unreadable`、且 `--accept-unreviewed` 不能放行的反向用例。

### 6. 低：补跑比较依赖「当前规则集」，旧存档不会自动兼容
`scripts/model-review/opencode-review.mjs:1615-1619`、`:2956`

- 证据：比较是 `onDisk !== maskSecretLike(prompts[model])`（1616），写入是 `maskSecretLike(prompt)`（2956）。上一版 9315c79 写的是 `maskedRecordText(prompt)`（`git show 9315c79:...` 确认），会多一个换行、并去掉行尾空白；所以本 PR round-1 的 prompt 存档和现在的比较形式不同。测试也明确把「多一个换行」判为 mismatch（`opencode-review.test.mjs:3496`）。
- 影响：对 6c9e2bc 之后新写的轮次没问题；但对 9315c79 写下的旧轮次（本 PR round-1），一旦需要补跑会因为旧存档格式失败。本次 round-1 两模型都有结果，`ROUND_ALREADY_HAS_RESULT` 先拦住，实际触发概率低；但「改了遮盖规则就再也补跑不了旧轮次」是设计上的遗留。
- 建议：比较时优先用 ledger 的 `promptSha256`（未遮盖原文）判定一致性，只有在没有摘要时才要求存档精确等于当前遮盖结果；或为旧存档格式保留兼容分支。

### 7. 低：文档与代码仍有几处不一致
- `.agents/instructions/model-review.md:91`：`再比））` 多一个右括号；同一句仍把 `.prompt.md` 称作「每个模型收到的提示词」，实际存档是遮盖后的版本，和 commit message 里「改为遮盖后的存档」的目标不完全一致。
- `.agents/instructions/model-review.md:92`：说账本都遮，但 low-fix 行没遮（见第 3 条）。
- `docs/incidents-and-gates.md:121`（I-86）：仍写「按 `scan-machine-secrets.mjs` 的同一组规则」「`maskedRecordText`」，而代码现在多一条 `private-key-header`、账本走 `maskSecretLike`；该行没有跟随 6c9e2bc 更新。
- 建议：统一用「遮盖后的存档」措辞、补 low-fix、把 I-86 的门描述同步到新增规则。

### 8. 低：`promptSha256` 与存档不再可互验
`scripts/model-review/opencode-review.mjs:2956`、`:2982`

- 证据：存档写 `maskSecretLike(prompt)`，但 `promptSha256` 算的是未遮盖 `prompt`（2982）。这是有意的设计（补跑要拿原文摘要），但外部审计若用存档文件重算 sha256 会得到不匹配，文档没有说明。建议在文档或字段名上标明「摘要对应未遮盖原文」，避免误判存档被篡改。

---

## 对「未采纳项」的独立判断

**作者理由基本成立，但有一个小缺口。** `recordSecretProblems` 只查 `ledgerPath`（1238、2433），确实和「门只负责本 PR」的定位一致；PR 280 已合并，不会再跑它的门，这个理由合理。

缺口在于：如果后续 PR 去改**另一个 PR 的**记录目录（例如顺手修旧记录），这些文件对 `changedOutside` 来说只是 `unreviewed`（1223、1282），而 `unreviewed` 是可用 `--accept-unreviewed` 放行的（1222-1229）；同时 `recordSecretProblems` 不会扫描它们。也就是说，secret-like 文本仍可能通过「改别的 PR 的记录 + override」进入仓库。建议对 `.agents/reviews/` 下任何被本 PR 改动、但不在 `ledgerPath` 的文件也做 `record-secret-like` 检查，或让这类 problem 不可 override。这比让每个 PR 全量追溯所有旧记录便宜，也覆盖了真正的绕过路径。

---

## 侧重检查（错误路径、不可信输入、安全、资源、不可逆、文档一致性）

- 错误路径：`record-unreadable` 实现了，但没有反向用例；`ls-tree` 失败仍静默返回 `[]`（第 5 条）。
- 不可信输入：`--accept-unreviewed` 的 `quote` 和 `apiError` 等自由文本经「序列化后遮盖」可能破坏 JSON（第 2 条）；`low-fix` 的 `files`/`findings` 未遮（第 3 条）。
- 安全：新私钥头规则比 gitleaks 默认规则窄（第 4 条）；旧 round-1 记录有被新门/gitleaks 同时击中的可能（第 1 条）。
- 资源耗尽：`private-key-block` 的 `[\s\S]*?`、`private-key-header` 的前缀类都有界，未见明显 ReDoS；`recordSecretProblems` 逐文件 `git show`，记录目录规模有限，未见资源问题。
- 不可逆操作：问题 2 会写出坏账本行，且 override 行当场追加，属于提交后需要手工修复的不可逆写入；问题 1 的自阻塞也需要事后改记录。
- 规则/文档/代码一致性：第 3、7 条；ADR 0177 新增决定 5、旧决定顺延为 6，仓库内没有其他文档引用「0177 决定第 5 条」，重编号未见断链。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？
**不会。** 本改动只影响「写进仓库的记录」和「合并门」，没有改 `buildPrompt`（277-305）。证据：提示词写入是 `writeFileSync(..., maskSecretLike(prompt))`（2956），但真正传给模型的是下一行的 `prompt`（2964），是未遮盖原文；`roundForRun` 只做比较（1615-1619），不参与请求组装。每轮变化的 `head/base/previous/brief` 本来就在 `material` 里、拼在整段提示词最后（293-305），本改动没有新增或前移任何每轮变化的值。符合「只追加」规则。需要说明的是：存档的 `.prompt.md` 现在不等于实际发出的字节，但它不是回灌给模型的历史，属于记录保真问题（见第 8 条），不违反 `prompt-prefix.md` 第 4 条。

### 2. 会不会让同一段文字在不同请求里变成不同字节？
**请求本身不会**：遮盖只作用于存档和账本，规则是固定的正则顺序（2398-2419），不依赖前后文。
但有两个需要知道的相关点：一是同一段文字「发给模型的字节」和「存进仓库的字节」现在可能不同（这正是遮盖的目的）；二是**将来改遮盖规则时**，同一段旧文字按新规则会遮出不同字节，`roundForRun` 的 `onDisk !== maskSecretLike(prompt)` 会因此拒绝补跑旧轮次（第 6 条）。`usage.jsonl` 里的 `at` 时间戳是原有字段，不属于模型输入。

### 3. 有没有对应的自动检查，反向用例真的会失败？
- 有：逐规则遮盖含 `private-key-header` 的样例（`opencode-review.test.mjs:2244-2268`）；规则同步改为「只多 `private-key-header`」（2276-2294）；补跑接受遮盖存档、拒绝未遮盖和多一个换行的存档（3476-3497）；合并门拒绝 secret-like 记录、接受遮盖后的记录（2353-2370）。这些反向用例如果撤掉对应实现会失败，读代码成立。
- **不够/缺失**：`record-unreadable` 没有任何用例（第 5 条）；normal/override/low-fix 三处账本写入没有直接用例（第 2、3 条）；gitleaks 的两个新白名单用例用的是合成 fixture（`REVIEW_274_PROSE`、`keyTailLine`），不是真实记录文件内容，因此不能证明真实的 pr-274 记录已经不再报（第 1 条相关的「未核实」部分）。

### 4. 改动产生/修改的每个值，使用它的地方都能接受吗？
- 新规则 id `private-key-header`：只被 `maskSecretLike`/`secretLikeRules`/测试消费；测试已放宽为「比 scan 多这一条」，没有别的固定集合校验。可接受。
- 新错误前缀 `record-unreadable`：被 `problems` 和 `OVERRIDABLE_PROBLEMS` 消费，按前缀判定为不可 override，符合文档；但没有测试，且 `ls-tree` 失败仍不走它。不完全覆盖。
- 账本行遮盖后格式：被 `parseUsage`/`readUsage` 的 `JSON.parse` 校验消费；**第 2 条的引号吞噬会使这个消费者拒绝**，这是两端不匹配。
- `.prompt.md` 新格式：被 `roundForRun`（1616）消费；新写轮次匹配，旧 round-1 存档不匹配（第 6 条）。
- `ci/rules/gitleaks.toml` 的 3 个新白名单 + `ci/toolchain-lock.json` 的 sha256：被 gitleaks 配置/安装脚本消费；测试形状和数量对得上（12 块），但真实文件内容和 sha 值我无法在本环境运行验证。
- `scripts/machine-secret-scan-baseline.json` 的新条目：scan 只按 `observed > allowed` 判失败，多一条 allowed 是无害的；可接受。
- `I-86` 编号：仓库内只有 `model-review.md` 和事故表引用，`check-incident-gates.mjs` 只校验唯一性和格式，不要求连续，重编号未见冲突；但事故行描述已落后于代码（第 7 条）。
