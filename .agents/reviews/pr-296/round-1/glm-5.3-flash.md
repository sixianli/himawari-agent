# 复核报告：PR 296（合并前本地 gitleaks 门槛）

## 发现（按严重度从高到低）

### 1.（中）「本地比 CI 严或一样严」与代码不符：本地跳过的不止「到期」一项
- 文件:行：`scripts/ci/security-owner-review.mjs:230-240`、`scripts/ci/check-security.mjs:566-594`
- 问题：作者承认本地不核对「店主批准是否到期」，但实际跳过的校验更多。`loadOwnerReview`（CI 路径）会核对：GitHub 评论存在且作者身份（`security-owner-review.mjs:162-173`）、批准记录的 decision/manifestSha256/sourceHead（:183-191）、有效期（:192-203）、headSha 合法且 `manifest.sourceHead` 是 head 的祖先（:204-212）、PR 事件号与 head 匹配（:155-161）。`loadOwnerReviewManifest` 这些**全部不做**，只做 `readOwnerManifest` 的结构检查（:110-131），然后把工作树里的清单例外直接应用到本地扫描。CI 在这些校验失败时的表现是整个 security 作业 `infrastructure_failed`（`check-security.mjs:746-754、766-775`，经 `loadReviewedExceptions` → `loadOwnerReview` 抛错），即「CI 会拦下的情形，本地会通过」——这正是作者声称不会发生的方向。
- 缓解（读代码证实）：CI 仍是安全边界（作者自己也这么说）；且经 `applySecurityExceptions` → `verifySyntheticProvenance`（`check-security.mjs:268-298`），清单例外只能豁免符合 `synthetic-boot-token` 形状（`tokenValue` + 16 位十六进制重复两遍，`check-security.mjs:206-207`）的内容，真密钥形状豁免不了；未消费的例外会以 `SECURITY_EXCEPTION_FINDING_UNKNOWN` 失败（:328-331），不会静默。
- 建议：把作者的说法改成准确清单（本地不核：GitHub 评论身份、批准记录、到期、PR 事件、sourceHead 祖先），或在 `loadOwnerReviewManifest` 里至少核 `expiresAt` 和 sourceHead 祖先（都不需要联网）。

### 2.（低）并发首跑会偶发失败（不是写坏，方向安全，但和「并发跑两次」的说法有出入）
- 文件:行：`scripts/ci/install-tools.mjs:302-308`、`scripts/check-gitleaks.mjs:33-40`
- 证据：`downloadArtifact` 已存在时校验后返回；不存在时下载后 `writeFileSync(path, bytes, { flag: "wx" })`（:308）。两个进程同时首跑：第二个在 `existsSync`（:302）为假后下载，`wx` 遇到对方已写入的文件会 EEXIST 抛错 → 退出 2。另外 `check-gitleaks.mjs:36` 的 `readFileSync(executable)` 与另一进程的 `renameSync` 之间有窗口，可能 ENOENT 抛错退出 2。「不会互相写坏缓存」属实（sha256 在解包前核对：`install-tools.mjs:306-307` `verifyDownload` 在 `tar -xOzf`（`check-gitleaks.mjs:30`）之前；可执行文件按字节与归档成员比对后才原子重命名，:33-40），但「并发跑两次」会有一方失败。
- 建议：捕获 EEXIST 后重读校验，或文档注明并发首跑会偶发失败、重跑即可。

### 3.（低）测试覆盖缺口：门槛的核心价值路径（例外放行）和下载链路无测试
- 文件:行：`test/tooling/check-gitleaks.test.mjs`（全文 64 行）、`test/tooling/security-process.test.mjs:268-313`
- 读代码证实的覆盖：缓存目录默认/环境变量覆盖、平台不支持即拒、发现→`failed` 且不泄原文、报告坏→抛 `GITLEAKS_REPORT_INVALID`、清单结构坏→`SECURITY_REVIEW_SECRET_INVALID`、无清单→null、history range 是 HEAD 全部祖先且不含 `--all`。
- 未覆盖（推测后果）：① 门槛里**例外放行**的正反路径完全没测——`runGitleaksGate` 内 `applySecurityExceptions`（`check-security.mjs:622-626`）一条测试都没有，包括「baseSha 已登记的 synthetic-secret 例外被消费后通过」「例外没被消费时报 `SECURITY_EXCEPTION_FINDING_UNKNOWN`」「advisory/semgrep 类例外被过滤掉不碍事」；② `ensureGitleaks` 的下载→sha256→解包→版本核验成功路径和「sha256 不符」「版本不符」无测试（只测了平台不支持，`check-gitleaks.test.mjs:21-30`）；③ `gateBase`（origin/main 缺失时报错）和 `main()` 的 0/1/2 退出码无测试；④ `loadOwnerReviewManifest`「清单里登记真密钥形状也无法豁免」（靠 `verifySyntheticProvenance`）无测试。
- 建议：至少补 ① 和 ② 的反向用例；这些路径失败时的表现（退出 2）与「误报在合并前被拦」的目标同样相关。

### 4.（低）文档与代码不完全一致
- 文件:行：`.agents/instructions/delivery-mode.md:18`、`docs/incidents-and-gates.md:121`（I-83 行）
- 证据：delivery-mode 写「规则文件和白名单与 CI 的 security 作业是同一份」；I-83 写「同样的已接受例外和店主复核清单」。已接受的例外（`ci/security-exceptions.json` 从 baseSha 读，`check-security.mjs:567-581`）确实与 CI 应用集一致（CI 也应用 baseSha 版本，`security-exceptions.mjs:207-209`）；但店主复核清单在本地**不经验证**地应用（见发现 1），两处文档都没写这个差异。另外「扫描当前文件和当前提交的全部祖先」与本地行为一致（`check-security.mjs:620` 传 `context.testedSha`），CI push 仍是 `--all`（:358-364），这点文档没造成误导。
- 建议：在 delivery-mode.md 或 I-83 补一句已知差异（同发现 1 的清单）。

### 5.（信息）`npm run check` 从此引入网络依赖和 `origin/main` 依赖
- 证据：`check-gitleaks.mjs:30`（首次需下载，120 秒超时、重试 3 次，`install-tools.mjs:273-291`）、`:46`（默认要 `origin/main` 本地引用，缺失时报 `GITLEAKS_BASE_MISSING` 退出 2）、`check-security.mjs:398-400`（浅克隆直接失败）。失败会让整个 `npm run check` 失败。delivery-mode.md 只写了缓存位置，没写「断网/无缓存时 check 失败」。另：`.agents/reviews/pr-296/review-brief.md` 在 diff 里显示为二进制（Bin 0 → 3164 bytes），未核实原因。

## 侧重检查

走了一条最普通的使用流程：开发者在 Hermes 上提交后运行 `npm run check`：
1. `run-all-checks.mjs:32` 读 `package.json` 的 `check:steps` → 含 `check:gitleaks`（`package.json:27、65`），排在 `check:secrets` 后 ✓。
2. `check-gitleaks.mjs` main：`ensureGitleaks`（读锁文件→校验 gitleaks 8.30.0 条目存在 darwin-arm64/linux-x64 两平台，`ci/toolchain-lock.json:165-180` ✓→缓存→下载→**sha256**→解包到内存→字节比对→版本核对）→ `gateBase`（merge-base HEAD origin/main）→ `createContext`（本地 event=workflow_dispatch、testedSha=HEAD、baseSha=merge-base）→ `runGitleaksGate`。
3. `runGitleaksGate`：`verifyContext`（重放 createContext，`runId` 可往返 ✓）→ `verifyRuleFiles`（规则 sha256 对锁文件）→ 例外（baseSha 的 `ci/security-exceptions.json` + 离线清单，只留 synthetic-secret）→ 快照当前文件 → gitleaks dir 扫描 + git 扫描 HEAD 全部祖先 → `applySecurityExceptions`（每条例外必须被消费）→ 阻断则退出 1，错误退出 2 ✓。
- 无测试覆盖的路径（本流程中）：第 2 步的下载/校验/版本失败分支、`gateBase` 失败分支；第 3 步的例外放行与「例外未被消费」分支。有测试覆盖：扫描范围、发现阻断、报告损坏、清单结构、缓存目录。
- CI 不受影响：`.github/workflows/ci.yml:469` 走 `scripts/ci/run.mjs --check security` → `runSecurityChecks`，工作流不跑 `npm run check`；`runSecurityChecks` 的改动仅为等价抽取（`semgrepRuleIds`、`reviewedExceptions`，与原内联代码逐行相同），`gitleaksHistoryScope` 在 `head` 缺省时保持原行为（`check-security.mjs:358-364`）；`loadOwnerReview` 拆分后校验与返回值逐行等价（`security-owner-review.mjs:133-228`，`referenceBytes` 提前读一次，字节相同）。测试超时无改动；本地路径不读 `HIMAWARI_CI_GITHUB_TOKEN` ✓。

## 必答问题

1. **不会改变模型见过的请求开头。** 改动只涉及 `scripts/`（CI/检查脚本）、`docs/`、`package.json`、`.agents/`，没有任何组装模型请求的代码（系统提示、工具定义、历史、遮盖均不在改动集）。追加性规则对本 PR 不适用。
2. **不会产生跨请求的字节漂移。** 不涉及模型请求序列化；门槛自身的输出（`formatGateResult`）是固定格式文本，只进控制台。`new Date()`（`check-security.mjs:596`）和 `Date.now()`（`context.mjs:76`）只用于例外到期校验和 runId，不进入任何被逐字节比较的内容；无依赖遍历顺序的集合进入输出。
3. **有部分自动检查，反向用例部分真实。** 已证实会失败的反向用例：扫描有发现→`status:"failed"`（security-process.test.mjs:278-293）、报告不可读→抛错（:294-298）、清单缺 current 条目→`SECURITY_REVIEW_SECRET_INVALID`（security-review.test.mjs:307-311）。缺口见发现 3：例外放行/未消费、下载校验、退出码等核心路径无测试。新增测试文件属 tooling 项目，不在 `check:steps` 里，由 CI policy 作业和第 2 层运行，符合 ADR 0064 的仓库惯例，不算缺陷。
4. **逐值核对：** `npm run check:gitleaks` 脚本名——定义于 `package.json:65`，被 `check:steps`（:27）引用，`run-all-checks.mjs:32` 按 `check:steps` 执行，delivery-mode.md:18 引用一致 ✓；`HIMAWARI_GITLEAKS_CACHE`/`HIMAWARI_GITLEAKS_BASE` 仅 `check-gitleaks.mjs:14、46` 使用，无冲突 ✓；锁文件 `tools.gitleaks` 8.30.0、两平台 artifact、tar 成员名 `gitleaks` 与 `verifyInstalledTools`（`install-tools.mjs:419`）一致 ✓；`context.testedSha` 作 head 经 40 位 hex 断言（:360）✓；退出码 0/1/2 由 run-all-checks 以非 0 即失败处理 ✓。**唯一不合格的值流：店主复核清单例外**——本地端（产生：`loadOwnerReviewManifest`；消费：`applySecurityExceptions`）缺少 CI 端（`loadOwnerReview`）的批准/到期/祖先校验，两端校验不对称，正是发现 1。
