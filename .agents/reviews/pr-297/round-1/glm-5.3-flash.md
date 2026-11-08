# 复核结论（PR 297，分叉点 8ae40ba → 9315c79）

## 发现（按严重度从高到低）

**1. 中 | scripts/model-review/opencode-review.mjs:2950 与 1605-1617 | `--round` 补跑在提示词含密钥样例时必然报 `ROUND_PROMPT_MISMATCH`**
- 证据（读代码证实）：第 2950 行 `writeFileSync(join(roundDir, promptFileName(model)), maskedRecordText(prompt))` 把**遮盖后**的提示词写盘；而 `roundForRun` 第 1610 行对**未遮盖**的 `prompts[model]` 算摘要、第 1614 行 `onDisk !== prompts[model]` 拿磁盘上的（遮盖版）文件和内存里重建的（未遮盖版）提示词逐字节比较。只要提示词里有任何一条规则命中的文字，磁盘版和重建版就不同，补跑直接抛错。改前写盘用的是 `recordText(prompt)`，提示词已归一化时两者相等，补跑正常。
- 影响：恰好在「提示词含密钥样例」这一新遮盖机制针对的场景下，作者说明里写的补跑流程（`--round <序号>`）会失效。失败是显式报错，不会静默出错结果。
- 建议：`promptOnDisk` 读盘后过一遍 `maskSecretLike` 再比较，或比较两边都先归一化遮盖；并补一个「提示词含密钥样例 + 磁盘为遮盖版」的 `roundForRun` 用例。现有测试（opencode-review.test.mjs:3448-3482）只测了「文件被删回退到摘要」和「内容不同」，没有任何用例覆盖「磁盘是遮盖版」。

**2. 中低 | scripts/model-review/opencode-review.mjs:2396-2401、ci/rules/gitleaks.toml:103-116 | 遮盖规则不覆盖 gitleaks 的 `private-key` 规则，I-83 的「私钥开头标记」类误报并未根治**
- 证据（读代码证实）：`RECORD_SECRET_RULES` 的 `private-key-block` 要求 BEGIN…END 成对（`-----BEGIN … PRIVATE KEY-----[\s\S]*?-----END … PRIVATE KEY-----`）；而这次加白名单的两处 PR 274 记录恰恰是**只有 BEGIN 标记、后面跟说明文字**（gitleaks.toml:108、116 的放行值就是证明）。今后复核记录再引用一个孤立的 `[已遮盖:private-key-header]`：写盘不遮（规则不命中）、合并门不拦（同一规则集）、`check:secrets` 也不命中，但 gitleaks 照报——I-83 场景复发，还得再手补白名单。
- 建议：要么在 `RECORD_SECRET_RULES` 加一条只认孤立 BEGIN 标记的规则（写盘遮掉、门也拦），要么在 ADR/I-83 里写明这个已知盲区。
- 附带（推测）：`[\s\S]*?` 跨行惰性匹配意味着记录里先出现 BEGIN、很远的地方出现 END 时，中间**无关的整段文字**会被并进一个遮盖块；若这段恰好横跨 low-fix 的 verdict 行，`lowFixProblems`（第 1106 行）读到的就是被压成一行的遮盖文本，verdict 解析可能失败。

**3. 低 | scripts/model-review/opencode-review.mjs:2430、1276-1284 | 合并门只查本 PR 的 reviews 目录，`--accept-unreviewed` 叠加时存在绕过路径**
- 证据（读代码证实）：`recordSecretProblems` 用 `git ls-tree -r HEAD -- <ledgerPath>` 只列 `${REVIEWS_DIR}/pr-<本 PR>` 下的文件（第 2430 行，ledgerPath 定义见 1238 行）；第 1284 行的检查虽是无条件的（好），但它是唯一查记录内容的门。若把带密钥样例的记录提交到**另一个 PR** 的目录，断言本 PR 时：`recordSecretProblems` 查不到它，而它的路径会落在 `changedOutside` 之外吗——不会，它以别的 `pr-*/` 开头，会报 `unreviewed`；`unreviewed` 在 `OVERRIDABLE_PROBLEMS`（1222-1229 行）里，`--accept-unreviewed` 即可放行。
- 建议：把 `recordSecretProblems` 的范围扩到整个 `REVIEWS_DIR`（成本是每次多 show 几个文件），或至少在文档写明这个限制。

**4. 低 | scripts/model-review/opencode-review.mjs:2968-2984 与 2429-2438 | usage.jsonl 被门扫描但写侧从不遮盖，可能造成「自己写的账本自己过不了门」**
- 证据（读代码证实）：`ls-tree -r` 覆盖 ledgerPath 下所有文件，包括 `usage.jsonl`；写侧只遮 prompt、答案、stderr 三处（2950、2965、3008 行），`apiError` 字段（2984 行）只做去控制字符和截断。若服务方报错文本里带密钥样例（如 URL 回显 token），账本里就有未遮盖的命中：`check:secrets` 会红、合并门也会报 `record-secret-like`，且没有自动出路。
- 附带：`recordSecretProblems` 里 `git show` 失败时静默 `continue`（2436-2438 行），检查范围可无声缩小。
- 两条均为推测性边界，建议至少在 `recordSecretProblems` 里把 show 失败报成 problem。

**5. 信息 | scripts/model-review/opencode-review.mjs:2976 | 记录的 `promptSha256` 是未遮盖摘要，磁盘文件是遮盖版**
- 有意设计也能讲通（摘要用于核对补跑时重建的原文），但和发现 1 是同一处不对称的另一面，文档（model-review.md 新增行）未提。

**未核实**（本环境限制：`git show` 读取 `.agents/reviews/` 下的路径被 `REVIEW_GIT_REFUSED records-path` 拦截，工作树里也没有该目录；且除 git 命令外不能执行 node/sha256sum）：
- PR 274 第 7 轮记录第 37、117 行的真实文字是否与两个白名单前缀精确匹配；PR 280 基线条目的 `digest` 是否等于扫描算出的值；`ci/toolchain-lock.json` 里 gitleaks.toml 的新 sha256 是否正确；作者报的 gitleaks 29→26、31→28。
- 可证实的间接证据：`install-tools.mjs:339` 会在 security 检查里对 `ci/rules/gitleaks.toml` 逐文件断言 `sha256(readFileSync(path)) === file.sha256`，摘要错了 security 会直接红，所以 lock 那行改动有运行时核对兜底；作者报的「当前文件少 3、历史少 3」与本次放行的 3 处数量自洽（两处 private-key + 一处 generic-api-key）。

## 侧重检查（流程走查与覆盖核对）

走的流程：复核运行入口 `main()` → `runOne(model, prompt)` → ①写 `prompt.md`（2950，遮盖）→ ②`reviewModel` 发 prompt（2958，**未遮**）→ ③写 `<model>.md`（2965，遮盖）→ ④失败时写 stderr（3008，遮盖）→ ⑤写 usage.jsonl（不遮）→ 合并时 `assertReviewed` → `recordSecretProblems` 查 HEAD 已提交记录。
- 有测试：遮盖纯函数逐规则正反例、与 `scan-machine-secrets.mjs` 规则文本同步的防漂移测试、合并门拒绝未遮盖记录并接受遮盖版（opencode-review.test.mjs 新增三块 + 门用例）；gitleaks 白名单的形状/变异反向用例（gitleaks-allowlist.test.mjs:104-110，我逐个核过：新样本 `changeLast` 后确实不再匹配前缀正则——样本 9 的尾部反引号、样本 10 的尾部空格被改掉后前缀即失配）；用锁定的真实 gitleaks 对夹具仓库跑正反例与「放宽必失败」（gitleaks-config.test.mjs，真实二进制）。
- 无测试：①写盘遮盖→补跑比较的交互（发现 1 的路径）；②`reviewModel` 收到未遮盖 prompt 这件事没有断言（代码已读证实，但无回归保护）；③`--accept-unreviewed` + 跨 PR 目录绕过（发现 3）。
- 文档一致性（读代码证实）：model-review.md 新增行、I-83、ADR 0177 新增第 5 条与代码一致（同组规则、`[已遮盖:<规则>]`、门报 `record-secret-like`、发给模型的不遮、锚定固定开头不用字符类、每块限一个文件一条正则）。

## 必答问题

1. **不会。** 本改动不碰任何发给模型的内容：`buildPrompt`、工具定义、产品代码（apps/、packages/）零改动；遮盖只作用于写进仓库的记录（2950/2965/3008），发给模型的 `prompt`（2958）原样传递；追问的「只在末尾追加」逻辑未动。所有每轮会变的值仍在最后一条消息里。唯一的行为变化是磁盘上的记录文件与实际发送内容不再逐字相同（有意为之，文档已写明）。
2. **不会。** `maskSecretLike` 是纯文本的确定性替换，替换串是常量 `[已遮盖:<规则>]`，无时间戳、无依赖前后文的遮盖、无无序集合；同一段文字在任何请求/记录里都产生相同字节。白名单和基线条目也都是固定值。注意「遮盖」是按**本次写入文本本身**匹配，与请求序号、历史无关。
3. **有，且反向用例真的会失败（读代码证实），但有一处该测未测。** gitleaks-allowlist 的「改一个字符就不放行」对新三块成立（我核对了前缀正则与变异点）；gitleaks-config 用锁定版本真实 gitleaks 跑了放行正例、同目录别轮次/别文字照报、放宽路径或值的正则必使扫描结果偏离期望；opencode-review 的门用例先报 `record-secret-like` 再接受遮盖版。缺口：发现 1 的 `--round` 补跑交互没有任何用例；这些测试都在 tooling 项目（`npm test`/`test:tooling` 覆盖），`check:secrets` 本身跑的是扫描脚本，两者互补。
4. **逐值核对：基本通过，两处例外。** ①三个 gitleaks 白名单：规则单一、路径锚定单文件、值锚定（两个前缀 + 一个精确值）、`condition=AND`、`regexTarget="secret"`，测试还堵了字符类放宽——够窄，接受；lock 的 sha256 由 `install-tools.mjs:339` 运行时断言兜底（值本身未核实）。②基线条目：消费端 `scan-machine-secrets.mjs` 按 `file\0ruleId\0digest` 精确键匹配、`count=1`，digest 未核实但机制吻合。③`RECORD_SECRET_RULES` 的 id 与正则：有防漂移测试锁死两边同步，接受。④`[已遮盖:<id>]` 标记：不会被任何规则再命中（我核过），verdict 解析按行结构不受影响（除发现 2 的跨行特例）。**例外**：遮盖后的 prompt 文件作为 `promptOnDisk` 的消费端不接受（发现 1）；门对 usage.jsonl 的扫描没有对应的写侧遮盖（发现 4）。
