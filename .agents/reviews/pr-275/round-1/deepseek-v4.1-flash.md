已达到本次复核能使用的最大工具调用步数，下面是基于已读代码和 git 元数据写出的完整结论；未实际运行测试、也未读取到的地方均标「未核实」。

# 复核结论

## 发现的问题（按严重度）

### 1. 高：新增的“精确值白名单”违反 ADR 0157 与安全检查规范，且没有同步改规则或取得新的 Owner 批准

- 文件:行：`ci/rules/gitleaks.toml:78-100`（三块新增），`docs/adr/0157-gitleaks-allowlist-for-evidence-digests.md:54`，`docs/execution/specs/2026-09-03-github-ci-quality-gates-design.md:240`
- 问题：新块对“合成 token”“幂等键”这种个别具体值使用白名单放行，而现行已批准的规则明确要求这类值走逐条例外；摘要块也使用了 `regexTarget = "secret"`，与 ADR 的“整行形状、`regexTarget = "line"`”四限定不一致。PR 只改了配置和测试，没有改 ADR/Spec，也没有记录新的 Owner 批准。
- 证据（亲自读到）：
  - ADR 0157 第 54 行：`文件摘要这类……用 ci/rules/gitleaks.toml 里的白名单处理；个别具体的值（合成 token、示例密码等）仍按规范走逐条例外。`
  - Spec 第 240 行：`白名单必须只针对一条规则（targetRules）、同时限定目录和整行形状（condition = "AND"、regexTarget = "line"），不得按整个目录或整条规则放行……个别具体的值仍按逐条例外处理。`
  - 新块本身：
    - `ci/rules/gitleaks.toml:82-84`：`paths = ['''...round-[14]/deepseek-v4\.1-flash\.md$''']` + `regexTarget = "secret"` + `regexes = ['''^0123456789abcdef0123456789abcdef$''']`
    - `ci/rules/gitleaks.toml:90-92`：幂等键精确值
    - `ci/rules/gitleaks.toml:98-100`：摘要精确值，同样 `regexTarget = "secret"`，不是 `line`
- 补充：作者“为什么不用例外清单”的事实依据是对的，我核对过代码：
  - `scripts/ci/security-exceptions.mjs:163-166` 要求 synthetic-secret 的路径必须是 `test/`、`ci/rules/fixtures/` 或 `apps|packages/*/test/`，`.agents/reviews/...` 会被 `REAL_SECRET_CANNOT_BE_EXCEPTED` 挡住。
  - `scripts/ci/check-security.mjs:194-221` 的 `classifiedLiteral` 没有能覆盖幂等键行（`"idempotency-key"` 是连字符，`idempotency-fixture` 要求 `idempotencyKey`）和裸摘要行的分类。
  - 但这说明的是“现行例外机制有缺口”，正确做法应是扩展分类/路径规则并登记 Owner 审阅的例外，或先修改 ADR/Spec 明确允许这几类精确值白名单；不能以“已有块也这么写”为由绕过已批准的政策。
- 建议：二选一后再合并：
  1. 扩展 `classifiedLiteral` 与例外路径规则，把两处复核记录、两行幂等键、测试文件里的摘要登记为可到期、可追溯的例外；或
  2. 新增 ADR/Spec 修订并取得 Owner 明确批准，说明“合成 token、测试幂等键、测试文件摘要”这类误报允许用精确值白名单，同时改掉“仍按逐条例外处理”的文字，并补上对应的真实 gitleaks 测试。

### 2. 中：新白名单没有用锁定版本的真实 Gitleaks 做自动验证；反向用例只到 JS 正则层

- 文件:行：`test/tooling/gitleaks-allowlist.test.mjs:6-21, 63-120`，`test/tooling/gitleaks-config.test.mjs:132-171`
- 问题：新加的自动检查只是把 TOML 用正则解析出来，再用 JS `RegExp` 模拟 gitleaks 的 `paths`/`regexes` 语义。它不能证明 gitleaks 8.30.0 真的会按预期放行，也不能覆盖 `condition = "AND"`、`regexTarget = "secret"`、绝对路径/相对路径匹配这些 gitleaks 特有行为。现有真实 gitleaks 测试 `gitleaks-config.test.mjs` 的夹具只覆盖 `test/qualification/...`、`test/fixtures/...`，新路径不会进入它的夹具，因此新块不在真工具验证范围内。
- 证据（亲自读到）：
  - `test/tooling/gitleaks-allowlist.test.mjs:6-19` 用 `text.split("[[allowlists]]")` 和字符串正则解析配置。
  - `test/tooling/gitleaks-allowlist.test.mjs:21`：`const matches = (patterns, value) => patterns.some((pattern) => pattern.test(value));`
  - `test/tooling/gitleaks-allowlist.test.mjs:105-120` 只断言路径正则匹配/不匹配。
  - `test/tooling/gitleaks-config.test.mjs:14, 23-36` 的夹具只有 evidence、token、api、mixed、digest-map；`144-148` 用仓库配置扫描这些夹具，新路径不在其中。
  - ADR 0157 第 60、61 行要求“白名单的效果由 `test/tooling/gitleaks-config.test.mjs` 用锁定版本的真实 Gitleaks 检查”，并“以后……在测试里加对应用例”。
- 反向用例本身：`gitleaks-allowlist.test.mjs:83-103` 的“改一个字符”用例确实会失败（如果正则被放宽），`105-120` 的轮次/PR/模型路径用例也做了否定断言；但这些都是正则层，不是 gitleaks 端到端。
- 建议：在 `gitleaks-config.test.mjs`（或新测试）里加三组真实夹具：
  - 三个目标路径 + 精确值 → 当前扫描和历史扫描都零命中；
  - 同一值放到别的路径、同一路径放别的值、同一值换别的规则 → 仍必须命中；
  - 这样才真正守住“只放行这 10 条”的承诺。

### 3. 中：`ci/toolchain-lock.json` 的新 sha256 未核实，且作者本地的 `npm run check` 不覆盖它

- 文件:行：`ci/toolchain-lock.json:1222`，`scripts/ci/install-tools.mjs:332-340`，`scripts/ci/check-security.mjs:571`，`package.json:27`
- 问题：新哈希 `9b47795fac3d616dd579278a7c46860600b3a32728b531184c537e171a9f912f` 是否等于改后 `ci/rules/gitleaks.toml` 的实际 SHA-256，本次复核无法计算（工具限制只允许 git/read/grep/glob）。如果不对，`verifyRuleFiles` 会在扫描前直接抛 `扫描规则摘要不匹配: ci/rules/gitleaks.toml`，security job 失败。
- 证据（亲自读到）：
  - `scripts/ci/install-tools.mjs:339`：`assert(sha256(readFileSync(path)) === file.sha256, \`扫描规则摘要不匹配: ${file.path}\`);`
  - `scripts/ci/check-security.mjs:571`：`verifyRuleFiles(root, lock);`，在 gitleaks 扫描前执行。
  - `package.json:27` 的 `check:steps` 里没有 security 扫描；`package.json:42` 的 `check:security-review` 也不核对规则摘要。作者说的 `npm run check`（41 步）不覆盖这个哈希。
- 结论：哈希正确与否「未核实」；不能把它当作已验证的事实。
- 建议：至少运行一次 `scripts/ci/check-security.mjs` 或直接调用 `verifyRuleFiles` 验证；更好的做法是把“规则文件摘要与 lock 一致”做成一个便宜的自动检查放进 `check:steps`，避免下次改规则又靠人工同步。

### 4. 低：新路径测试覆盖仍不完整，但风险有限

- 文件:行：`test/tooling/gitleaks-allowlist.test.mjs:105-120`
- 问题：新增用例覆盖了 round-2、pr-274、glm，但没有覆盖 round-3/round-5、`deepseek-v4.1-flash.prompt.md`、`attempt-1.md` 等变体。由于正则锚定了精确文件名，这些变体实际上不会匹配，风险低；但如果以后有人把文件名改宽，现有用例不一定能发现。
- 建议：可补 `round-3`、`prompt.md`、`attempt-1.md` 的否定用例；不是合并阻塞项。

## 读代码证实的事实

1. 三个新块的路径与值：
   - `ci/rules/gitleaks.toml:82` 的路径正则只匹配 `pr-273/round-1` 和 `pr-273/round-4` 的 `deepseek-v4.1-flash.md`；
   - `ci/rules/gitleaks.toml:84`、`92`、`100` 的 regex 都是 `^...$` 精确值。
2. 合成 token 的实际出现位置：
   - 用 `git log -S` + 路径 glob 验证：token `0123456789abcdef0123456789abcdef` 在 commit `1c3a10b5` 中被加入 `round-1/deepseek-v4.1-flash.md` 和 `round-4/deepseek-v4.1-flash.md`；
   - 在 `round-2`、`round-3`、`*deepseek-v4.1-flash.prompt.md`、`round-[14]/glm-5.3-flash.md`、`judgments.md`、`verdicts.jsonl` 中均无该 token。
   - 这支持作者“路径只匹配这两个 DeepSeek 记录、不匹配别的轮次/PR/GLM”的说法。
3. 幂等键 `sensitive-interceptions-clear-01` 在 `apps/agent-service/test/production-http-composition.unit.test.ts:1055` 和 `:1060` 各出现一次；两处都属于同一个文件、同一个值，新块可以同时覆盖。
4. 摘要 `0803...416a` 在 `test/qualification/evidence/workspace-authorization-lifecycle/p4-completion-01/archive-readback.json:68` 和 `test/tooling/gitleaks-allowlist.test.mjs:43` 出现；前者已有第 2 块白名单，后者由新块覆盖。
5. 测试结构：
   - 总块数从 9 变 12，`const [, gitObjects, readback, ...scoped] = blocks;` 后 `scoped` 从 6 变 9，符合 `toHaveLength(9)`；
   - `scoped[6]` 确实是 PR 273 块，`scoped[7]` 是幂等键，`scoped[8]` 是摘要；样例数组 `86-102` 的下标与之一致；
   - 三块确实追加在文件末尾，已有块下标不变；
   - 三个新值都加进了“改一个字符”样例（`93-98`）。
6. 作者“不用例外清单”的理由与代码一致：路径限制与 `classifiedLiteral` 分类限制确实存在（见上）。
7. 改动只涉及 3 个文件：`ci/rules/gitleaks.toml`、`ci/toolchain-lock.json`、`test/tooling/gitleaks-allowlist.test.mjs`；`git diff base..head -- .agents` 无输出，说明本 PR 没有修改复核记录。

## 推测与未核实

- 「未核实」实际 gitleaks 复跑结果 64 → 54。本次不能运行 gitleaks，也不能运行测试；作者的手工结果没有对应的自动测试固定下来。
- 「未核实」`ci/toolchain-lock.json:1222` 的 SHA-256 是否与改后的 `ci/rules/gitleaks.toml` 字节一致。这是最可能让 CI 直接失败的地方。
- 「未核实」复核记录文件的实际内容。本环境读取 `.agents/reviews/...` 时被拒绝（`REVIEW_GIT_REFUSED records-path ...`），无法直接引用原文；但通过 `git log -S` 已确认 token 由 `1c3a10b5` 加入上述两个文件，而不是 prompt/其他轮次。
- 推测（低置信）：如果 gitleaks 的 secret 提取把引号或周围字符算进 secret，精确值白名单可能不生效；作者的手工结果显示生效，但未核实。

## 侧重检查

- 错误路径：新正则都是固定长度、无嵌套量词，不存在 ReDoS 风险；gitleaks/JS 对 `(?:...)`、`[14]`、`^...$` 都支持。真正的高风险错误路径是 `verifyRuleFiles` 的哈希校验失败，未核实。
- 不可信输入：`.agents/reviews/pr-273/...md` 是模型生成内容，属于不可信文本；新白名单把它限制在两个精确路径 + 一个精确合成值，没有扩大到目录或规则。通过 `git log -S` 验证 token 只在这两个文件、没有扩散到 prompt/其他轮次。
- 安全：三个值都不是真实凭据；精确值匹配不会放过同路径下的其他真实密钥。但白名单没有到期日，且绕过了 Owner 审阅的例外机制，这一点是实质性的安全治理问题（见发现 1）。
- 资源耗尽 / 不可撤销操作：无新增扫描范围、无循环、无销毁性操作；改动可通过 revert 撤销。
- 规则、文档与代码一致性：发现 1 是明确的不一致。另外，作者说“与已有‘规则+路径+精确值’块写法一致”在结构上成立（确实存在 Web Push、tmpfs、UUID 等块），但这不能证明符合 ADR 0157/Spec 的现行文字；两者需要一起看。
- I-73 式两端核对：
  - 新值的产生端：`ci/rules/gitleaks.toml`、`ci/toolchain-lock.json`；
  - 使用端：gitleaks 8.30.0、`test/tooling/gitleaks-allowlist.test.mjs`、`verifyRuleFiles`；
  - 块数/下标、路径名、幂等键两行、摘要两处都能对上；唯一没对上的是 `toolchain-lock` 的 SHA-256（未核实）。

# 必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？

不会。改动文件是 CI 安全规则、工具链锁和 tooling 测试，不涉及系统提示、工具定义、历史消息、遮盖结果或任何请求组装代码；diff 中没有对模型请求路径的修改，因此“只追加”的性质没有被触碰。未能读取 `.claude/rules/prompt-prefix.md`（工作区外且访问被拒），但仅凭本次 diff 已足以判断与模型请求无关。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

不会。新值都是静态常量：精确 token、精确幂等键、精确 SHA-256、固定正则和固定路径；没有时间字段、随机值、依赖前后文的遮盖或无序集合。`toolchain-lock` 的 SHA-256 是内容哈希，同一文件内容得到同一字节值。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

有形状级自动检查，但没有行为级自动检查：
- 有：`test/tooling/gitleaks-allowlist.test.mjs` 会检查块数（9）、`condition`、`regexTarget`、单路径/单正则，并用 `changeLast`/`changeFirst` 做“改一个字符必须不放行”的反向用例；如果正则被放宽成非精确匹配，这些用例会失败（逻辑上成立，未实际运行）。
- 缺：没有用锁定版本真实 gitleaks 验证新块；`gitleaks-config.test.mjs` 的夹具不包含这三个新路径。因此“gitleaks 真的会少这 10 条、不会误放行”没有被自动测试守住。作者的手工 64→54 不是可重复的门槛。

### 4. 改动产生或修改的每个值，每一个使用它的地方都能接受吗？

逐个核对：
- `gitleaks.toml` 新块：gitleaks 8.30.0 接受 `targetRules`/`condition`/`paths`/`regexTarget`/`regexes` 这些键，语法与已有块一致；测试文件用 JS `RegExp` 解析也接受。已读代码确认无语法冲突。
- 块数/下标：产生端是 12 块，测试端 `scoped` 期望 9，`scoped[6]` 对应 PR 273 块，`86-102` 的样例顺序也对得上；两端一致。
- 路径：`round-1`、`round-4` 的 `deepseek-v4.1-flash.md` 实际存在（git log 确认）；`production-http-composition.unit.test.ts`、`gitleaks-allowlist.test.mjs` 路径存在且值出现在其中。
- 幂等键：两行（1055、1060）同值同文件，白名单可同时覆盖。
- 摘要：测试文件与 archive-readback 各一处；旧白名单覆盖 archive-readback，新白名单覆盖测试文件，没有互相冲突。
- `toolchain-lock.json` 的新 SHA-256：使用端 `verifyRuleFiles` 要求它等于 `gitleaks.toml` 的实际摘要；这一端「未核实」。如果作者没有跑过 `check-security.mjs`，仅跑 gitleaks 命令本身不会触发这项校验。
- `.agents/reviews` 记录内容：使用端白名单要求值精确等于 `0123456789abcdef0123456789abcdef`；通过 `git log -S` 确认 token 在这两个文件中，但无法确认每处 gitleaks secret 是否正好是这个 32 位串（未核实）。

# 总体判断

技术上，这三块白名单范围很窄，路径和值都核到了，作者关于排序、下标、路径范围和三个反向样例的说法基本成立。合并前最需要处理的是：

1. 现行 ADR/Spec 明确要求“个别具体值走例外、白名单限整行形状”，本改动与之冲突；需要 Owner 批准并改文档，或改用/扩展例外机制。
2. 补真实 gitleaks 8.30.0 的端到端正反测试，而不是只靠 JS 正则复刻。
3. 验证并最好自动化 `ci/toolchain-lock.json` 与 `ci/rules/gitleaks.toml` 的 SHA-256 一致性。
