## 复核：PR 275（gitleaks 白名单 5 处误报）

### 侧重检查（普通使用流程）

我走的主流程：开发者推送 → CI `scripts/ci/check-security.mjs` 的 `runSecurityChecks`（scripts/ci/check-security.mjs:551）→ `loadToolchainLock` + `verifyRuleFiles`（scripts/ci/install-tools.mjs:332，逐文件断言 sha256）→ `scanGitleaks` 用 `ci/rules/gitleaks.toml`（check-security.mjs:648）扫 current（`snapshotCurrent` 拷贝 tracked+untracked 文件后 `gitleaks dir`）与 history（`--full-history`）→ `applySecurityExceptions` 应用 `ci/security-exceptions.json` → 写 security-report.json。

结论：本 PR 改的就是这段链路里的第一环（toml 配置）和它的形态测试 `test/tooling/gitleaks-allowlist.test.mjs`（test:tooling 必跑）。走查发现的一条覆盖缺口和几处与主线一致的核实结果，列在下面。

### 读代码证实的（作者说法逐条核对）

- ✅ 3 个新块全部满足 `condition="AND"`、`targetRules=["generic-api-key"]`、单一路径正则、`regexTarget="secret"`、`^精确值$`，且**排在文件最后**（ci/rules/gitleaks.toml:78-100，前 9 块未被增删改动）。测试断言 `scoped` 共 9 块（此前 6 块），下标 0-5 与原有块逐一对应（test/tooling/gitleaks-allowlist.test.mjs:64、86-98 与 toml 的 30-76 块核对一致）。「新加 3 块排最后、不影响已有下标」**成立**。
- ✅ 令牌块路径正则 `(?:^|/)\.agents/reviews/pr-273/round-[14]/deepseek-v4\.1-flash\.md$`（toml:82）只匹配 round-1/round-4 的 DeepSeek 记录；新测试正向验 round-1/round-4、反向验 round-2、pr-274、glm 文件（gitleaks-allowlist.test.mjs:105-120）。我手工推演正则：round-2 不匹配（`[14]` 吃不到 `2`）、`round-14` 也不匹配（无 `/` 紧随）、glm 文件名不匹配。**作者说法成立**。
- ✅ 三个值都有「改一个字符就不再放行」的反向样例（gitleaks-allowlist.test.mjs:93-98，changeLast/changeFirst 定义在 84-85，互为补集，不会漏改）。
- ✅ token 同值在 ~15 个测试/夹具文件里出现（grep `0123456789abcdef0123456789abcdef`），它们由 `ci/security-exceptions.json` 既有的 `synthetic-boot-token` 例外（reviewEvidence 段与 143-1526 行的条目）覆盖，作者未动它们，PR 只白名单 md 复核记录——口径一致。
- ✅ 不走 security-exceptions.json 的理由核对：synthetic-secret 的路径必须落在 `^test\/|^ci\/rules\/fixtures\/|^(?:apps|packages)\/[^/]+\/test\/`（scripts/ci/security-exceptions.mjs:164，`.agents/reviews` 会被 `REAL_SECRET_CANNOT_BE_EXCEPTED` 拒绝）；例外有 30 天上限（security-exceptions.mjs:129）。幂等键那处 line 1055 是 `"idempotency-key": "..."` 头部行，`classifiedLiteral` 的 `idempotency-fixture` 要求 `\bidempotencyKey\b`（check-security.mjs:201-202），同文件另有 line 1055/1060 两行，例外登记的行数证明难凑齐——作者的取舍论证与代码相符。
- ✅ toolchain-lock 的消费端存在且会失败：`verifyRuleFiles` 逐条断言 `sha256(readFileSync(path)) === file.sha256`（install-tools.mjs:339），`check-security.mjs:570-571` 每次运行调用。diff 里锁定文件只改了 gitleaks.toml 那一行。
- ✅ 测试文件里新拆分的 token/摘要字面量（join 两半）在同一行内不会形成连续的 32/64 位十六进制，本 PR 不会给 `test/tooling/gitleaks-allowlist.test.mjs` 制造**额外**的 generic-api-key 新命中（只把 line 43 既有的那一行列入白名单——这正是作者说的第 3 处）。
- ✅ 合并时不破坏既有资格证据：多个 qualification 证据里记录的 gitleaks.toml 摘要 `01f433eb…` 早已比当前值旧（test/qualification/evidence/.../frozen-inputs*.json 213-216 行），证明这些冻结摘要是历史记录而非运行时复验对象，改 toml 不会引发资格测试连锁失败。
- ⚠️ 作者说 check-security 在「scripts 里」，实际是 `scripts/ci/check-security.mjs`（措辞小误，不影响结论）。

### 发现的问题（按严重度）

**1（中）· test/tooling/gitleaks-config.test.mjs · 三个新白名单块没有“真实 gitleaks”层面的自动验证**
- 问题：gitleaks-config.test.mjs 只对 ADR 0157 的证据目录块做真实 gitleaks 正/反验证；`gitleaks-allowlist.test.mjs` 只用自己的 JS RegExp 检查形状，不能证明 gitleaks 8.30.0 对这些行提取的 Secret 恰好是 `^精确值$` 所要求的裸值（`regexTarget="secret"` 是硬前提；同文件里同摘要的旧块用的是 `regexTarget="match"` 整行锚，toml:26-28）。
- 证据：gitleaks-config.test.mjs:23-36（FIXTURES 只覆盖证据目录/token/api/digest-map 四类，无新块 fixture）、131-148（用 `repositoryConfig` 真扫，但只有证据块会被该配置抑制）；docs/execution/specs/2026-09-03-github-ci-quality-gates-design.md:240 白纸黑字说白名单效果「由 test/tooling/gitleaks-config.test.mjs 用锁定版本的真实 Gitleaks 正反验证」。
- 后果方向是 fail-closed（白名单没生效 CI 仍会红，不会静默放漏），但「64→54、正好少这 10 条」的效果今天就悬空，值得一次报红来回。
- 建议：在 gitleaks-config.test.mjs 加三个 fixture（md 里的 tokenValue 引用处、幂等键两行形状、test.mjs line 43 形状），断言 `scan(repositoryConfig)` 下新块文件不再出现、改一个值后重新出现。

**2（低中）· 本检出树与「当前文件命中」的说法不符（未核实项）**
- 问题：作者说「CI 在 main 上报 10 条：5 处，当前文件和历史各一条」。但本检出（a954eebd）工作树 `.agents/` 下没有 `reviews/` 子目录（read .agents 只有 handoffs/、instructions/、tasks/ 等 6 项），对 `.agents/reviews/...` 的 `git log/show` 一律被 `REVIEW_GIT_REFUSED` 拒绝——两个 md 复核记录在当前树里不存在。若它们不是 tracked 文件，`snapshotCurrent`（check-security.mjs:333-354）的 current 扫描不会为其产生命中，「当前+历史各一」的计数就不成立。
- 证据见上；作者/local 复跑的 64→54 数值我无法在本复核环境复算（不允许运行 gitleaks），标**未核实**。
- 建议：作者贴出复跑输出按 scope（current/history）拆分的条数作证据，或确认这两个 md 记录的 tracked 状态。

**3（低）· 文档与代码不一致：quality-gates design 第 240 行的白名单规格**
- 该行要求白名单「同时限定目录和整行形状（`regexTarget = "line"`）」，而 PR 248 先例以来的精确值块（包括本 PR 三个新块）都是「精确路径 + `regexTarget="secret"` + `^值$`」。代码有人走的路，文档没改，后继者会无所适从。
- 建议：在 240 行补一句认可 PR 248 式的“规则+精确路径+精确值”块。

### 必答问题

1. **不改变发给模型的内容。** 本 PR 只触碰 ci/rules/gitleaks.toml、ci/toolchain-lock.json、test/tooling 测试；不是系统提示、工具定义、历史消息或遮盖输出的一部分，没有任何请求前缀或 wrapper 的形态变化，故「只追加」性质维持不变。
2. **不会。** 新增/修改的值全是静态字面量（正则串、精确值、sha256）；无时间戳字段、无序列化顺序敏感的数据。既有的 `githubToken()`（randomBytes）在 gitleaks-config.test.mjs 是旧代码，本 PR 未触碰。
3. **部分覆盖。** 有：gitleaks-allowlist.test.mjs 的数量断言、mutate 反向样例、路径正反用例（作者关于顺序与正则的说法逐条核对成立）；它进 `test:tooling`。缺：真实 gitleaks 对三个新块的反向用例（问题 1），即“该块在 gitleaks 层面真的只是收窄这 10 条”这一点没有自动化证明。
4. **两端核对通过（除下述一项）。** gitleaks.toml → 消费方 gitleaks（check-security.mjs:648）与允许清单测试（:13）；toolchain-lock 新 sha256 → 消费方 verifyRuleFiles（install-tools.mjs:339）与锁链校验（aggregate.mjs:292、check-coverage.mjs:134）；新路径正则和样本值 → 只被 gitleaks 与本测试消费。唯一未闭环点：locker-file 里写入的 sha256 是否等于文件现值本环境无法计算（未核实），依赖 CI 首跑的 verifyRuleFiles 兜底——它确实会失败报错，属 fail-closed。
