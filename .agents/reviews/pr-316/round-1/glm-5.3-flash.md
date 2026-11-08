工具调用因权限受限需要调整（只允许 git diff/log/show/blame/status，且不能接管道）。继续核对：
# 复核结论（PR 316 / 提交 020a31c9）

## 发现（按严重度从高到低）

### 1. 中高 · test/tooling/gitleaks-config.test.mjs — 新白名单块缺少真实 Gitleaks 层的样例，违反 ADR 0177 自己定的规则
- **证据（读代码证实）**：`docs/adr/0177-gitleaks-exact-value-allowlist.md:70`：「新加或改动的块，还要在 `test/tooling/gitleaks-config.test.mjs` 里加样例，用锁定版本的真实 Gitleaks 核对放行的文件不再报、同一个值出现在别的文件里照报。」本次 diff 只改了 `gitleaks-allowlist.test.mjs`（纯 JS 正则检查），`gitleaks-config.test.mjs` 的 `FIXTURES`（第 49-68 行）和 `EXPECTED_WITH_REPOSITORY_CONFIG`（第 70-82 行）里没有任何 deepseek/`abcdef123456` 条目。
- **后果**：「真实 gitleaks 对 `token=abcdef123456` 捕获的 Secret 恰好等于 `abcdef123456`、锚定白名单 `^abcdef123456$` 能放行」这一点没有用真实引擎验证过（推测：main 上 `generic-api-key` 确实报了这处命中，所以规则会触发；但捕获组边界是否恰好等于裸值，只有真实扫描能确认）。同文件里其他 13 块都有对应的真实引擎样例和「放宽就失败」的 it.each 反向用例，唯独新块没有。
- **建议**：在 `gitleaks-config.test.mjs` 加一个 fixture（deepseek 测试文件含 `token=abcdef123456`，外加一个含同值的姊妹文件），进入 `EXPECTED_WITH_REPOSITORY_CONFIG` 与两个扫描范围断言；再在 it.each 加「value 放宽」用例。

### 2. 低 · test/tooling/gitleaks-allowlist.test.mjs:91-112 — 新块没有路径正例/反例
- **证据（读代码证实）**：第 74-81 行的路径反向用例只对 `/tmp/work/src/other.ts`、`docs/test/integration/other.test.ts` 这类通用路径测试；第 132-145 行对 web push、第 115-130 行对 pr-273 有专项路径正例，新块没有「`packages/platform-node/test/deepseek-web-provider.unit.test.ts` 命中、同级变体文件不命中」的专项断言。
- **建议**：仿照第 132 行的写法补一个专项路径用例。

### 3. 信息 · ci/toolchain-lock.json:1202 — 新 sha256 值本身未核实，但有运行时强制校验
- **证据（读代码证实）**：`scripts/ci/install-tools.mjs:314-322` `verifyRuleFiles` 对 `lock.rules.files` 逐个断言 `sha256(readFileSync(path)) === file.sha256`；`scripts/ci/check-security.mjs:598、666` 在 gitleaks 门禁入口调用它。所以摘要没同步不会静默放行，`npm run check:gitleaks` 会直接报「扫描规则摘要不匹配」。
- **限制**：本次复核不能执行哈希命令，`34c0d12a...` 是否等于改动后 `gitleaks.toml` 的真实摘要——**未核实**（但错误值会让门禁失败而非放行，风险方向安全）。

### 4. 信息 · 作者说法核对
- 「白名单只放行这一个值/这一个文件」：**证实**。新块（`ci/rules/gitleaks.toml:126-132`）`paths` 精确锚定该测试文件、`regexes` 精确锚定 `^abcdef123456$`，`targetRules` 限 `generic-api-key`；白名单测试第 64 行计数 13 与实际块数（16 − 前 3 个特殊块）一致，样例数组第 107 行与末位块按位置对齐正确。
- 「命中 1、3 在当前文件和历史提交 e5edb5469 各一处」：**证实**。`git show e5edb5469` 显示该提交给 `packages/platform-node/test/deepseek-web-provider.unit.test.ts` 加了 `url: "https://user:pw@example.org/a?token=abcdef123456"`，且该提交在 HEAD 祖先链上；当前文件同字符串仍在。路径正则对历史 blob 同样生效，两处都被覆盖。
- 「命中 2 是 opencode-review.test.mjs:2299」：**证实**。改动把整行字面量改为 `${["-----BEGIN", "PRIVATE KEY-----"].join(" ")}`，运行时字符串逐字节不变（我逐字符核对过 join 结果），断言语义不变；源码不再含连续字面量，默认 private-key 规则的字符类（`[ A-Z0-9_-]`）跨不过中间的引号逗号（此处为推测，依据是同文件其他行早已用同样拆分写法通过 CI）。
- 「ADR 引用改全」：**证实**。改名后全仓对 `drop-node-floor` 的引用只剩 0189（README 两处、spec 四处，均已是 0189）；`docs/incidents-and-gates.md:124` 指向另一个 0181（persistent-verified-download-cache），正确保留未动；`docs/adr/0189` 文件内无残留 0181 自引用。0187/0188 编号空缺，`check:adr-numbers` 只查重号不查空缺（`docs/lessons.md:733`），不阻塞。
- 「ci/speed-land 分支已使用 0189」「validate_docs.py --strict 11 条 Runbook 错误与 main 相同」：**未核实**（本地 clone 里没有这些分支/无法运行该脚本；`git log --all` 显示本地任何分支都没有其他提交占用 0189 路径，重号风险在本 clone 范围内不存在）。
- 「package.json check:steps 缺缩进」：**证实**（diff 中旧行顶格、新行四空格与其余行一致）；biome 会因此失败为合理推测。

## 侧重检查

**走过的流程**：`npm run check:gitleaks` 入口（`scripts/check-gitleaks.mjs:76-82`）→ `ensureGitleaks` 按 lock 下载/校验 gitleaks 版本（19-43 行）→ `createContext` 取 merge-base 基准（45-58 行）→ `runGitleaksGate`：先 `verifyRuleFiles` 校验规则摘要（check-security.mjs:598），再扫当前文件（:619）和 git 历史（:733），用同一份 `ci/rules/gitleaks.toml` → 有未登记发现即失败（formatGateResult:60-74）。

**结论**：改动后这条链路上，规则摘要校验（lock 同步）和白名单条目本身都被覆盖；**没有测试覆盖的路径**是「真实 gitleaks 引擎 × 新白名单块」这一段（发现 1）——`gitleaks-config.test.mjs` 的两个扫描范围断言和 it.each 放宽反向用例都不含新块。这是本次改动相对既有惯例唯一的覆盖缺口。文档与代码一致性方面：ADR 0177 的要求与实际改动不一致（同发现 1）；其余文档（README、spec、incidents-and-gates、delivery-mode.md 对 check:gitleaks 的描述）与代码相符。

## 必答问题

1. **会不会改变模型已见过的请求开头？** 不会。diff 只涉及 CI 配置、tooling 测试、文档和 package.json，没有任何构建模型请求（系统提示、工具定义、历史消息、遮盖结果）的代码路径被触及；改动后的 deepseek 测试只断言发往外部搜索服务的遮盖（且该断言非本 PR 修改）。发给模型的内容仍只追加，每轮变化值的位置不受影响。
2. **会不会让同一段文字在不同请求里变成不同字节？** 不会。新值（白名单块、sha256、ADR 编号）都是确定性的静态文本；没有时间字段、无序集合或依赖前后文的遮盖。opencode-review 测试的 join 写法运行时结果逐字节等于原字面量。
3. **有没有对应的自动检查、反向用例会不会真失败？** 部分有。JS 层：`gitleaks-allowlist.test.mjs` 新块计入 13 块，反向变异（改尾字符/同类字符）按断言会失败；若有人放宽正则或路径，形状检查和反向用例会失败。真实引擎层：按 ADR 0177 应加的 `gitleaks-config.test.mjs` 样例缺失（发现 1），即「真实 gitleaks 下放行生效/放宽失效」未自动验证。lock 摘要同步由 `verifyRuleFiles` 在门禁运行时强制。
4. **每个新值的两端都核对了吗？** 核对如下：白名单块 → 消费方是 gitleaks 门禁（check-security.mjs:619/733，路径/值精确）和 allowlist 测试的顺序敏感解析（新块加在末尾、样例加在末尾，对齐正确）；lock sha256 → 消费方是 `verifyRuleFiles`（install-tools.mjs:314，运行时断言，值本身未核实但错误会显式失败）；ADR 0189 → 消费方是 README、spec 和 `check:adr-numbers`（查重号，0189 无冲突）；package.json 缩进 → 消费方是 `format:check`（格式与相邻行一致）；opencode-review 拆分字符串 → 消费方是同测试内的 `maskSecretLike` 断言（运行时值不变，语义不变）。未发现两端校验不匹配之处；唯一实质缺口即发现 1。
