# 复核结论

## 问题列表（按严重度从高到低）

**1.（中）`scripts/ci/check-security.mjs:246-250、326-329` 合并后第一次真正全流水线运行的是一条从未整链验证过的路径；作者的第 4 条验证只覆盖了加载阶段，不能据此得出「合并后其他 PR 就通过」。**
证据（读代码证实）：
- `loadReviewedExceptions`（`scripts/ci/security-exceptions.mjs:204-222`）只做两份数据的解析＋合并去重校验，**不跑扫描、不做来源祖证**。作者在 CI VPS 上跑的正是这个函数（「65 条」与我的独立计数一致：文件内 54 条 + 复核清单 11 条 = 65，见下）。
- 真正把例外与扫描发现对账的是 `applySecurityExceptions`/`verifySyntheticProvenance`（check-security.mjs:224-264、266-331）：历史发现必须落在清单登记的 `provenance.history` 里（246 行 `assert(scope, "SECURITY_EXCEPTION_HISTORY_EXPANDED")`），且**每条**例外都必须至少消费一条发现（326-329 行 `SECURITY_EXCEPTION_FINDING_UNKNOWN`）。
- 删除 10 条后，这 10 个路径的覆盖责任全部转移到 PR 4 复核清单派生的例外，其 current 钉在 `sourceHead e2a792f8…`、history 只含 2007？10 条（01 条 11 行）清单里登记的引入提交。**在任何绿跑中验证过这个组合的时间窗无法从仓库确认**：bd0859a9（PR 248）之后到本 PR 合并前，main 上所有 PR 的 security 检查都在加载阶段就抛 `SECURITY_EXCEPTION_DUPLICATE`，`loadReviewedExceptions` 抛错发生在扫描之前（check-security.mjs:601 的 try 块内），所以 PR 268/271 等提交的 diff 从未被完整对账过。
推测（未核实）：若 bd0859a9 之后的某个提交在这些文件里导致 gitleaks 在未登记提交上产生 history finding，或某条例外在当前 main 上一条发现都消费不到，合并后首跑将报 `SECURITY_EXCEPTION_HISTORY_EXPANDED`/`SECURITY_EXCEPTION_FINDING_UNKNOWN`（infrastructure_failed），而非恢复通过。独立旁证：对这 10 个文件最近一次被改动的提交（3248fd0b、551d12c3、12c8bfb7 等，恰是各被删条目 current 的 sourceCommit），说明的字面量位置与清单一致，大概率不会触发；但这是推测非证明。
建议：合并后立刻在 CI/VPS 上跑一次完整 `check-security.mjs`（含扫描），而不是只跑 `loadReviewedExceptions`；或者本地用真实 base 对 10 个路径做一次 `git -c gitleaks` 全历史扫描与清单对账。

**2.（低）测试缺口：没有任何用例锁住「base 例外与 Owner 复核清单含同一身份 → SECURITY_EXCEPTION_DUPLICATE」及「删除后恢复通过」这两个新状态。**
证据（读代码证实）：`test/tooling/security-review.test.mjs:25-28` 的 fixture 把 `ci/security-exceptions.json` 写成空数组，`loadReviewedExceptions` 的合并分支（security-exceptions.mjs:217-222）从未在该测试里得到非空 base 与重叠身份的用例；`test/tooling/security.test.mjs:476-530` 只测候选≠基准的 `candidateDiffers`。反向用例（再造重复）目前只在真实 CI 里失败过，没有留在测试套件里。
建议：在 security-review.test.mjs 增加两用例：base 含与清单 secret 条目同 identity 的例外 → `toThrow("SECURITY_EXCEPTION_DUPLICATE")`；base 只含一份 → 通过且计数正确。

**3.（低）`ci/security-exceptions.json:7`（proposal.reviewEvidence 叙述与文件现状不一致）。**
证据（读代码证实）：正文说「2026-11-04 …同日新增 13 条 synthetic-boot-token 例外，覆盖 …其余命中」，但本 PR 删掉了这 13 条里的 10 条，它们现在由复核清单覆盖。文本是历史叙述，不影响机器校验（validateSecurityExceptions 只看 proposedAt/owner/expires，security-exceptions.mjs:116-133），但下次续期复核的人读它会误解覆盖来源。
建议：在 reviewEvidence 追加一句 2026-11-11 的说明（该字段的模式允许延续叙述）。

**4.（信息）作者说法第 1 条措辞与代码细节有一处不精确。**
证据（读代码证实）：作者说「路径和次数（current + history）一致」——数量一致成立（10 条全部逐一比对：9 条 2 = 1+1、sqlite 3 = 1+2，id 均为 `generic-api-key`、kind `synthetic-secret`、digest 全部 `3eb1bd43…`，与 `.github/security-review-manifest.json` 中 10 条 current + 11 条 history 一一对应）；但**current 的 sourceCommit 和行号两边并不一致**（如 service-main 条目记 551d12c3@136，清单记 e2a792f8@144；production-sandbox-scope 条目记 5bab4de1@636，清单记 @251）。这不影响这个改动（去重身份只由 kind/id/path/package/version/digest 组成，security-exceptions.mjs:176-183），但说明同一事实被登记成了两个不同的「当前状态」，正是重复登记产生的根源。

## 侧重检查（普通使用流程走查）

入口 `scripts/ci/quality.mjs:7` / `scripts/ci/run.mjs:18` → `runSecurityChecks`（check-security.mjs:551）→ `verifyContext`/工具链核验（570-589）→ `loadReviewedExceptions`（601，读取 base 例外 + 候选 + Owner 评论签名校验，security-exceptions.mjs:190-252）→ `snapshotCurrent` → 三个独立扫描（machine / gitleaks current+history / semgrep，630-660）→ `applySecurityExceptions`（675，逐条 synthetic 来源祖证）→ `applyMachineReview`（680）→ 脱敏断言与报告落盘（739-741）。覆盖情况：机制各段都有 tooling 测试（security.test.mjs、security-review.test.mjs、security-machine-baseline.test.mjs、security-published.test.mjs、gitleaks-config.test.mjs 跑真扫描器）。**没有测试覆盖的路径**：合并去重分支复用真实重叠数据（见问题 2）；manifest 派生例外与真实 gitleaks 全历史发现在真实祖先图上的对账（问题 1，只有集成入口 `security-process.test.mjs` 用合成 fixture）。

## 作者说法逐条核对

1. **属实（已逐条比对）**：10 个路径、id、kind、digest 全在清单里有对应条目，current+history 计数一致；但「current 的来源提交/行号」两边不同（见问题 4）。
2. **结构属实、日期未核实**：清单审批只在评论正文 JSON 里带 `expiresAt`，校验要求 `expires > now`、`expires - created ≤ 30 天`、格式 `…T00:00:00Z`（security-owner-review.mjs:190-201）；到期后整个 security 检查必然失败（清单文件存在就一直要求有效评论）。仓库里无法读评论 6625244385 验证具体是 2026-12-03；文件侧条目到期 2026-12-04，所以 12-03→12-04 之间「删后仍被覆盖」的说法其实不成立——不过按设计那也是整份检查失效的时段。
3. **属实**：`loadEditedExceptions` 读的是 `context.baseSha` 上的例外（security-exceptions.mjs:198-209），本 PR 未合并前 base（bc380a6e 侧）仍含 10 条重复 → 合并校验必抛 `SECURITY_EXCEPTION_DUPLICATE`。
4. **数字属实、VPS 运行未核实**：54 + 11 = 65 与我独立计数一致；27e1d332 的路径历史最近改动正是 bd0859a9（`git log 27e1d332 -- ci/security-exceptions.json`），其 base 必含重复，与报错相符。但「本提交为基准时通过」只验证到加载层，不等于全流水线通过（见问题 1）。
5. **属实**：`af0beef3…` 等冻结摘要只存在于 `test/qualification/evidence/**` 内部，grep 全仓没有任何代码/测试重算当前文件摘要与它比对；唯一引用是 `test/tooling/gitleaks-config.test.mjs:139、156` 的窄 allowlist 反向用例，与本文件无关。它们不是检查，不会因此失败。

## 必答问题

1. **不涉及模型请求**。改动只删 `ci/security-exceptions.json` 的 10 个数组项；系统提示、工具定义、历史消息、遮盖结果一律未触碰（额外确认：`test/tooling/expensive-models.test.mjs:71` 引用该文件只是无关解析用例）。「每轮会变的值都在最后一条消息」对本改动无从谈起，结论：不存在改变模型已见请求开头的风险。
2. **不会引入字节不确定**。删的是静态 JSON 数组项；`expiresAt/proposedAt` 是固定常量，无运行时生成的时间戳、无依赖前后文的遮盖、无无序集合（例外匹配靠 `findIndex` 顺序消费，且合并集唯一身份已由校验保证）。唯一的运行时依赖（评论到期时间、`now`）是既有机制，未被改动。
3. **自动检查有，反向用例真实失败过，但未沉淀为单测**。每个 PR 的 security 检查实际执行 `loadReviewedExceptions` 的合并去重（证明代码路径 security-exceptions.mjs:184 ← 219），问题叙述的 `SECURITY_EXCEPTION_DUPLICATE` 是真实 CI 报错且 bd0859a9 之后每次 PR 都复现——反向用例确实失败。缺口见问题 2：测试套件里没有闭式回归用例，正向「删除后通过」同样只有运行时侧验证。
4. **两端校验已逐处核对，当前组合可接受**。产物端（base 文件）与清单端（Owner 评论字节签名的 manifest）都过同一个 `validateSecurityExceptions`（同 schema、同去重、同路径正则 `^(?:test\/|ci\/rules\/fixtures\/|(?:apps|packages)\/[^/]+\/test\/)`，security-exceptions.mjs:164——10 个路径全部合规）；消费端共三处：check-security 的 secret 例外应用、machine 秘密的 `applyMachineReview`（未触碰）、published 检查（`security-published-fixtures.mjs:27-29` 只取 `published-synthetic-fixture`，与被删条目无关）。合并后的组合集（54+11）经我逐条身份比对无重复、无消费者失配。遗留风险不在「校验两端」而在问题 1 的整链首跑验证。
