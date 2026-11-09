## 复核结论（PR 322：写记录时遮掉已登记的测试假值）

### 侧重检查（我走的流程与结论）

普通复核流程从入口走到结束：

1. `parseArgs`（opencode-review.mjs:2917）→ `resolveCommits`（:2942）→ **新增** `setRegisteredTestValues(loadRegisteredTestValues(repo, commits.base ?? commits.head))`（:2943）。
2. `buildPrompt`（:277-305）用未遮盖的 `brief`、`questions` 组装提示词发给模型——本次改动没有触及任何发给模型的内容。
3. `roundForRun`（:2971）补跑校验，其中 ：1646 用当前清单**重新遮盖**重建的提示词与磁盘存档逐字节比较（新增耦合）。
4. 落盘遮盖：提示词存档 ：3061、答案 ：3076、报错 ：3121、账本 `ledgerLine`→`maskSecretLikeDeep`（:2510）。
5. 合并门：`--assert-reviewed`（:2924-2932）先从 `--main-ref` 加载清单（:2925），再 `assertReviewed`→`recordSecretProblems`（:1316→:2513-2536）→ `secretLikeRules`（:2486）。
6. **旁路**：`--report` 路径（:2920-2922）→ `reviewReport`（:1426）内部也调用 `assertReviewed`（:1435），但该路径**没有加载清单**。

结论：第 1、2、4 步与说法一致且无前置变化；第 3、6 步有本文下面列出的问题。测试覆盖：新增 6 个单元测试覆盖解析、遮盖/上报、顺序无关、加载与拒绝、真实 HEAD 清单；但合并门和 review 主流程的端到端测试里清单是空文件（见问题 5）。

---

### 问题清单（按严重度从高到低）

**1.（中）`--report` 路径不加载已登记值，同一份记录在两个命令下判定不一致**
- 文件：scripts/model-review/opencode-review.mjs:1435（对照 ：2925、:2924）
- 证据：`main()` 只在 `options.assertReviewed` 分支（:2924-2927）和 review 分支（:2943）调用 `setRegisteredTestValues`；`options.report` 分支（:2920-2922）直接进入 `reviewReport`，而 `reviewReport` 内部 `const gate = assertReviewed({ repo, pr, mainRef })`（:1435）跑在模块级 `registeredTestValues = []`（:2453）上。于是 `report` 模式的 `gate.problems` 永远不会含 `record-secret-like … registered-test-value`，而 `--assert-reviewed` 会报；`reviewReport` 的 `no-error` 一致性判断（:1439）可能给出「无问题」而合并门拒绝。另外 ：1646 补跑对比和 ：1284/:1290 low-fix 对比若经 report 路径触发，重遮结果也和写记录时不一致。
- 建议：把 `loadRegisteredTestValues` 提到 `main()` 的 report 分支同样执行，或在 `assertReviewed` 内部自行加载（参数化注入，避免模块级可变状态）。

**2.（中）过渡期合并门自锁：已提交的未遮盖记录会被新规则拦死且不可豁免；ADR 未写处置办法**
- 文件：scripts/model-review/opencode-review.mjs:2528、:2521-2522、:1252-1259、:1330-1337
- 证据：`recordSecretProblems` 用 `git ls-tree -r … HEAD -- ledgerPath`（:2528）扫 PR 目录下**全部已提交记录**，`record-secret-like` 不在 `OVERRIDABLE_PROBLEMS`（:1252-1259）里，所以 `--accept-unreviewed` 直接拒绝（:1330-1337）。登记动作（往 `gitleaks.toml` 加一块）发生在 main 上；一个开启中的 PR 若在其目录里已有引用该值的原始记录（写记录时值还没登记），本 PR 合并后它一合并就报 `record-secret-like`，只能整轮重跑复核。已合并进 main 的老记录（如 pr-312/316/319 里那个假令牌原文）平时不被扫，但任何 PR 改动到它们（`changedOutside`→`otherFiles`，:1313/:2530-2535）同样拦死。ADR 0190 第 4 条只说「老记录不改、靠现有白名单放行」，没有写「开启中的 PR / 被触碰的老记录怎么办」。
- 建议：在 ADR 0190 后果里写明处置（重跑对应轮次、或明确老记录被触碰时的豁免流程）；或给「值为登记前写入的老记录」一条可审计的放行通道。

**3.（中低）补跑（`--round`）可能因清单变化触发 `ROUND_PROMPT_MISMATCH`**
- 文件：scripts/model-review/opencode-review.mjs:1646
- 证据：`(onDisk !== null && onDisk !== maskSecretLike(prompts[model]))` ——磁盘存档是**当年**清单遮出来的字节，重跑时用**现在** `--base` 的清单重遮。若两次清单不同且提示词含新登记的值（提示词含 PR diff，模型引用的假值常来自 diff 里的测试夹具），比较失败，该轮无法补跑。
- 建议：补跑对比只用 `promptSha256`（未遮盖摘要，:1642-1647 已有），存档对比改为「按存档当年规则」或只比对遮盖后是否等价于「存档经新规则再遮」。

**4.（低）TOML 解析器形状过窄，可能静默漏遮；且不校验 `regexTarget`/`targetRules`**
- 文件：scripts/model-review/opencode-review.mjs:2463
- 证据：正则要求整行是 `regexes = ['''^…$''']`（单值、三引号、行尾即结束）。行尾带注释、双引号字符串、多值数组（`['^a$', '^b$']`）都匹配不到，值被静默跳过。当前 `ci/rules/gitleaks.toml` 全部是单值三引号（我逐块读过），且 `test/tooling/gitleaks-allowlist.test.mjs` 对 scoped 块强制 `regexes` 长度为 1，风险有限；但 ADR 0177 第 3、5 条的块（`regexTarget = "match"`、固定开头）靠「无 `$` 锚」和字符过滤被排除，属巧合式安全——解析器本身不检查 `regexTarget`。
- 建议：解析时校验块形状（`regexTarget = "secret"`），或对解析不到的 `regexes` 行报错而非静默跳过。

**5.（低）端到端反向用例缺失：合并门对「已登记值出现在已提交记录」没有测试**
- 文件：test/tooling/opencode-review.test.mjs:2652
- 证据：合并门夹具 `const main = commit({ "code.txt": "base\n", "ci/rules/gitleaks.toml": "" }, "base")` ——清单为空，所以所有走 `--assert-reviewed` 的端到端测试（:3370、:3539、:3627、:3807、:3952、:4026）里新代码等于空转。新增 6 个测试全是纯函数级；没有用例证明「已提交记录含已登记值 → `record-secret-like … registered-test-value`」「review 模式 `--base` 缺文件 → 整体中止」「`--report` 路径的判定」。
- 建议：给合并门夹具放一个非空 `gitleaks.toml`，加一条「已提交记录含该值被拒、遮盖后放行」的端到端用例（与 ：2674 现有 openai-api-key 用例对称）。

**6.（低，理论）登记值若为替换文本的子串，二次遮盖会损坏输出**
- 文件：scripts/model-review/opencode-review.mjs:2479-2480
- 证据：先遮的值替换成 `[已遮盖:registered-test-value]`，后续 `replaceAll` 扫同一文本；若登记清单里出现该替换串的子串（如 `registered-te`，13 字符、全在允许字符集内），第一次的替换结果会被再遮成畸形字节。确定性不破坏（仍是同一输入同一字节），但输出不可读。当前真实清单无此值。
- 建议：替换前把已产出文本排除（逐段处理），或给规则 ID 换成不含允许字符集子串的形式。

---

### 读代码证实的 / 推测

**读代码证实的**：作者说法中「已有遮盖层覆盖提示词、答案、报错、账本」（:3061/:3076/:3121/:2510）、「从 `--base` / `--main-ref` 读清单」（:2943/:2926）、「长度 ≥12、字符集过滤」（:2452/:2465）、「`REGISTERED_VALUES_UNREADABLE` 停下」（:2473）、「在其他规则之前执行、同输入同字节」（:2479-2482 + 顺序无关测试）、「ADR 0190 修正 ADR 0177 后果并加 `amended_by`」（两份 ADR diff）——均与代码一致。当前 `ci/rules/gitleaks.toml` 里所有第 2 条形状的值都能被解析器收进来（我逐块核对过，含 12 字符的下限刚好命中那个假令牌）；`gh[p]_…`、两块私钥开头标记、两块 `match` 形状块按设计跳过，其中假 GitHub 令牌本身已被既有 `github-token` 规则遮盖。

**推测**：问题 2 中「开启中的 PR 会被自锁」取决于是否存在这样的在途 PR 及其记录内容，本仓库内无法核实；问题 3 的触发需要「补跑 + 两次清单不同 + 提示词含该值」同时成立。作者说「另一线程的 PR 321 与本 PR 不重叠」——未核实（无该 PR 材料）。

---

### 必答问题

**1. 是否改变模型已见过的请求开头？** 否。遮盖只发生在落盘（:3061/:3076/:3121/:2510）和本地校验（:1284/:1290/:1646）；发给模型的提示词由未遮盖的 brief/questions 构建（:2944-2949，`buildPrompt` :277-305 无任何遮盖调用）。清单在一次运行开始时一次性加载（:2943），追问/收尾仍只在末尾追加，本轮内字节稳定。注意：提示词**存档**（:3061/:3088）的字节会随清单版本变化，但不影响发送内容，`promptSha256` 仍是未遮盖原文摘要。

**2. 同一段文字是否会在不同请求里变成不同字节？** 发给模型的请求不受影响。写进仓库的记录：同一次运行内确定——`setRegisteredTestValues` 去重并按「长度降序、字典序」排序（:2455-2459），长值先遮避免前缀遮蔽，且有顺序无关测试；无时间、无无序集合依赖。跨运行字节随 `--base`/`--main-ref` 的清单变化，这是设计意图；真正的判定不一致在问题 1（`--report` 路径未加载清单），需修复。

**3. 有无自动检查，反向用例会不会失败？** 有 6 个单元测试，反向用例（近似值不遮、未登记不报、坏 ref 抛 `REGISTERED_VALUES_UNREADABLE`、超短/字符类/非锚定值跳过）都会失败。缺口见问题 5：合并门与 review 主流程的端到端路径清单为空，新规则在这层等于没有反向验证。

**4. 每个新值的两端校验都过关吗？** 逐一核对：`registered-test-value` 规则 ID 产生于 ：2480/:2491，消费于合并门 `record-secret-like` 输出（:2522）——账本校验 `record.problems`（:1474）只是字符串透传，可接受；`[已遮盖:registered-test-value]` 替换文本进入答案/报错/账本/提示词存档，账本先遮后序列化（:2509-2510）不会破坏 JSON；`ci/rules/gitleaks.toml` 从「纯扫描清单」变成 review 运行的**硬依赖**（缺文件整体中止），对当前仓库成立，但对早于该文件存在的历史提交补跑会炸（该文件 2026-11-05 前后引入，未核实确切提交）。不过关的一处：`assertReviewed` 的第三个调用方（`--report`，:1435）没有加载清单，见问题 1。
