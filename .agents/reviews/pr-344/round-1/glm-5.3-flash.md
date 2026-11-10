# 复核报告（e1ebd24c，基准 bf2b7234）

## 读代码证实的

- diff 只改了 `ci/security-exceptions.json` 一个文件（`git diff --stat`：1 file changed, +1106 −1），唯一被删除的行是旧的 `proposal.reviewEvidence`，其余全部是新增的 published-synthetic-fixture 条目。与作者“只改例外清单 + 在 proposal.reviewEvidence 末尾追加说明”一致（proposal 就在该 JSON 内，ci/security-exceptions.json:3-8）。
- 清单计数：现文件共 93 条例外 = 33 条 synthetic-secret + **60 条 published-synthetic-fixture**；diff 只增 42 条 published 条目、未删任何条目。基准 51 条（18 条 published + 33 条 synthetic）。与作者“18 已有 + 42 新增 = 60”一致。
- 5 个涉及包的身份与 `package-lock.json` 逐一相符（版本/integrity/resolved）：
  - `@aws-sdk/nested-clients` 3.998.1（package-lock.json:448-451）
  - `@earendil-works/pi-ai` 1.5.0（:946-949）
  - `@earendil-works/pi-coding-agent` 1.5.0（:1019-1022）
  - `@google/genai` 2.21.0（:1587-1590）
  - `openai` 7.19.0（:6780-6783）
- 条目字段能通过 CI 校验（逐项对照代码）：
  - schema（ci/security-exceptions.schema.json:183-292）要求的全部字段都在新条目里；`integrity` 形如 `sha512-…==`（86 位 + 双等号）符合 :246 的模式；`reviewReference` 为 `…/pull/338` 符合 :228 的模式。
  - `validatePublishedEntry`（scripts/ci/security-exceptions.mjs:45-70）：`path === runtime/<packageLockPath>/<archiveMember 去掉 package/>`（:51），抽查各包条目均满足；findings 的 rule 全部在 `publishedRules`（:36-44）；单条内无重复 finding 身份。
  - 依赖存在性（:54-62，对 `enumerateLockDependencies` 的锁路径/包名/版本三元组）——5 个包均通过上面的 lock 核对。
  - 提案范围（:116-133）：所有条目 owner=sixianli=proposal.owner；expiresAt 2026-12-04 − proposedAt 2026-11-04 恰好 30 天，`<= 30*86400000` 边界内。作者“与现有 51 条一致、不超 proposedAt+30 天”属实。
- node-forge README 不重复登记的说法属实：`.github/security-review-manifest.json:225-235` 有该条目，`ownerReviewExceptions`（scripts/ci/security-owner-review.mjs:295-317）会把它转换成 published-synthetic-fixture 并入 `loadReviewedExceptions` 的合并结果（security-exceptions.mjs:243）；若再在例外清单里登记同一 `path`，会在 security-published-fixtures.mjs:37 触发 `PUBLIC_FIXTURE_MEMBER_DUPLICATE`。“重复登记会被拒绝”成立。
- 例外范围不比需要的宽：每条精确到 path + fileSha256 + findings(含次数)；成员里多出任何未登记命中会因 `actual.size !== entry.findings.length` 失败（security-published-fixtures.mjs:61-67），少一个成员或重复出现分别由 :72、:54 失败。方向全是 fail-closed。
- 内容合理性（间接证据）：`chunk-B46VJEHW.js` 的三个 credential-literal digest（083645e1/191a4439/70bc1131）与既有 google-auth-library computeclient/jwtclient/impersonated 条目的 digest 完全相同（ci/security-exceptions.json:704-711 等），与“Pi 打包内联了该库”的解释自洽；aws-key 命中对应 [已遮盖:aws-access-key]（AWS 官方文档公开示例密钥）；"[已遮盖:authorization-bearer]" 说明文字命中 bearer-token 正则（security-source.mjs:12 `\bBearer\s+[A-Za-z0-9._~+/=-]{12,}`，"authentication" 14 个字母即满足）。

## 发现的问题（按严重度）

**1.〔中·流程预期〕本 PR 运行期间，这 42 条例外不生效，PR 自身的运行时制品检查会失败。**
证据：`loadReviewedExceptions`（scripts/ci/security-exceptions.mjs:229-234）——base 上已有该文件时 `bytes = git show baseSha:exceptionPath`，**执行时用的是基准文件的例外**；候选文件只在 :230 被校验，`candidateDiffers` 仅作为证据记录（:272），没有任何代码把候选条目并入执行集。因此在本 PR 的 CI 上，42 个新命中成员不在 expected 表里，会以 `PUBLIC_ARTIFACT_CONTAINS_SECRET` 失败（security-redaction.mjs:226、security-published-fixtures.mjs:50-51）。例外只有在合入 main（成为新 base）后生效。这与既有 18 条当初的引入方式相同，属提案工作流的固有特性，不是本 diff 引入的缺陷；但作者“模拟 security-published-fixtures 逐成员核对通过”用的是候选清单，与 PR 期间 CI 实际取数不同，结论只对“合入后”成立。
建议：在 PR 描述里明确“PR 期间发布门会红、合入后转绿”，避免误判为回归。

**2.〔低·测试缺口〕`PUBLIC_FIXTURE_PACKAGE_SOURCE_CHANGED` 没有反向测试。**
证据：该检查在 security-published-fixtures.mjs:33-36（锁 integrity/resolved 变化后例外未更新即失败），但在 test/tooling 全目录 grep `PUBLIC_FIXTURE_PACKAGE_SOURCE_CHANGED` 无命中；security-published.test.mjs 覆盖了 findings 变化（:302-308）、成员缺失（:326）、重复消费（:328）、含哨兵（:155）等反向用例，唯独漏了这条。
建议：补一条“lock integrity 变了、例外没跟着改 → 抛 PUBLIC_FIXTURE_PACKAGE_SOURCE_CHANGED”的用例。

**3.〔未核实〕42 条的 fileSha256/findings digest/reason 与真实 npm tarball 及构建产物字节的对账，无法离线完成。**
仓库工作树里没有 `runtime/node_modules`（glob 无结果），我也不能联网。能确认的只有内部自洽性（见上）。若某条 fileSha256 或 digest 抄错、或某成员其实不在运行时闭包里，CI 会分别以 `PUBLIC_FIXTURE_MEMBER_CHANGED` / `PUBLIC_FIXTURE_FINDINGS_CHANGED` / `PUBLIC_FIXTURE_MEMBER_MISSING` 明确失败（fail-closed），不会静默放行。作者声称已在 CI 同款路径实测 60/60 全命中且无多余——无法复核，但即使有错也会在 CI 暴露而非造成放行。同理，“61 个命中成员、node-forge README 在闭包内、Pi 分块文件无命中、102 条测试通过”均未核实（不能运行命令）。

**4.〔无发现〕未发现“真实凭据被当成占位”。**
读到的 reason 全部对应知名公开示例值或占位符（AWS 文档示例密钥、your-api-key、GEMINI_API_KEY、$ACME_API_KEY、命令行帮助文本、"[已遮盖:authorization-bearer]" 字样）；同一 digest 跨包复现也与占位值复用相符。此项基于 reason 文本与规则正则的间接核对，最终以第 3 条的未核实字节对账为准。

## 侧重检查

走的流程（普通发布路径）：`npm` 按锁安装 → 构建期 `packageNodeRuntime` 产出运行时归档 → `publish.mjs:122` `assertPublicArtifacts`（classification "build"）→ `security-redaction.mjs:154` `createPublishedFixtureReview` → `inspectBuildArchive` 逐成员 `findBuildSecrets`（security-redaction.mjs:224）→ `review.inspect` 对账（security-published-fixtures.mjs:43-70）→ `finish` 全覆盖断言（:71-72）→ 写 `public-review.json`（publish.mjs:145-152）。并行门：`runSecurityChecks` 的 gitleaks/semgrep/machine 扫描（check-security.mjs），其中 `applySecurityExceptions` 明确把 published 条目排除在遮盖路径外（check-security.mjs:274）。

结论：
- **测试覆盖**：清单数据本身有离线自动检查——test/tooling/security-review.test.mjs:388 用**真实提交的** `ci/security-exceptions.json` + 真实 package-lock 跑 `loadReviewedExceptions`（含 schema、依赖身份、到期、重复校验），本 diff 的任何格式/身份错误都会让它红；security-published.test.mjs、security.test.mjs 覆盖校验逻辑的反向用例。缺口见问题 2；另外“归档成员字节 ↔ tarball ↔ 清单”的对账只有 CI 运行时路径，无离线测试（受环境限制，合理）。
- **无测试覆盖的路径**：上面对账链里的 `review.inspect`→`finish` 在真实构建制品上的执行只在 CI（publish）发生；`PUBLIC_FIXTURE_PACKAGE_SOURCE_CHANGED` 分支完全无测试。
- **文档/规则一致性**：`proposal.reviewEvidence` 的新增段落与 diff 事实一致（42 条、5 个包、PR 338、2026-11-10、node-forge 不重复登记）；未发现规则文件与代码矛盾之处。`docs/incidents-and-gates.md` I-73 原文未读（本次核对以代码为准）。

## 必答问题

1. **不会改变模型已见过的请求开头。** 改动仅 `ci/security-exceptions.json`，不触及系统提示、工具定义、历史消息或遮盖结果；该文件不进入任何发给模型的内容，遮盖路径也明确排除 published 条目（check-security.mjs:274）。发给模型的内容本次完全没有变化，“只追加” trivially 成立。
2. **不会。** 唯一改动是静态提交的 JSON：所有日期是写死的字符串，digest 是确定性 sha256，条目顺序固定，没有任何运行时生成或依赖前后文的值。同一段文字在任何请求里字节相同。
3. **有对应的自动检查，且部分反向用例确实会失败。** 数据层：security-review.test.mjs:388（真实清单过全量校验）、:396（重复登记 → `SECURITY_EXCEPTION_DUPLICATE`）；逻辑层：security-published.test.mjs 的 findings 改变/成员缺失/重复消费/哨兵反向用例。缺口：`PUBLIC_FIXTURE_PACKAGE_SOURCE_CHANGED` 无反向测试（问题 2）；“42 条内容真实性”只有 CI 运行时对账，无离线反向用例。作者声称的 102 条测试通过未核实（不能运行）。
4. **逐值核对通过（除标注未核实的字节对账）。** 本次产生的值只有 42 条 published 记录 + reviewEvidence 文本。产生方：本 PR 手工登记；使用方及两端校验：schema（字段/模式）→ `validatePublishedEntry`（路径公式、规则白名单、依赖三元组）→ `createPublishedFixtureReview`（integrity/resolved 对 lock、fileSha256 对成员字节、findings 对扫描结果、成员全覆盖）→ 遮盖路径明确排除。lock 端 5 个包的身份已逐一核对一致；30 天到期、唯一 id（schema 强制 `const`）、node-forge 不重复登记均核对成立。唯一未核实的是 fileSha256/findings 与真实 tarball 字节的对应（问题 3），且该对账 fail-closed。
