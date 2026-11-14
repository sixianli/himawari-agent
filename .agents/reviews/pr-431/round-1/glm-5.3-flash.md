# PR 431 第 1 轮复核

## 侧重检查（先写，因为最高严重度正是从这里走出来的）

我选的普通流程：一次带构建产物的 CI 发布——`scripts/ci/publish.mjs:131` 调 `assertPublicArtifacts` → 构建归档（kind=artifact, classification=build）走 `scripts/ci/security-redaction.mjs:166` 的 `inspectBuildArchive` → 每个成员在 `security-redaction.mjs:224` 过 `findBuildSecrets` → 带审核时交给 `scripts/ci/security-published-fixtures.mjs:43` 的 `review.inspect`，与 `ci/security-exceptions.json` 里的 published-synthetic-fixture 台账**逐条精确比对**（rule+digest+count 全等，`security-published-fixtures.mjs:61-67`）。这条链上，单元测试（`test/tooling/security-published.test.mjs`）只用合成 fixture，**没有任何自动检查把真实台账和当前扫描器对账**——本次改动恰好踩在这条没有覆盖的实数据路径上。

## 按严重度排列的问题

**1.【高】`scripts/ci/security-source.mjs:7` + `ci/security-exceptions.json`（未随 PR 更新）：放宽 credential-literal 会让公开产物门禁以 `PUBLIC_FIXTURE_FINDINGS_CHANGED` 失败。**
证据（读代码证实）：
- 台账里有至少 5 个条目登记的 `credential-literal` 摘要，其 reason 明说是纯环境变量引用：`ci/security-exceptions.json:1224`（docs/custom-provider.md，2 条）、`:1254`（docs/extensions.md，2 条）、`:1284`（"${TOOLS_KEY}、${EXAMPLE_SECRET}"，docs/mcp.md，2 条）、`:1334`、`:1359`（两个 examples/extensions/\*/index.ts 各 1 条），reviewReference 全指向 PR 338，到期 2026-12-04（未过期）。
- 这些值（`$ACME_API_KEY`、`$GITLAB_TOKEN`、`${TOOLS_KEY}`、`${EXAMPLE_SECRET}`）逐字符核对都满足新正则 `/^\$(?:[A-Z][A-Z0-9_]*|\{[A-Z][A-Z0-9_]*\})$/`（长度均 ≥12），修复后扫描器对这 5 个成员产出 0 条 credential-literal。
- 合同要求全等：`security-published-fixtures.mjs:62` `actual.size === entry.findings.length`，actual=0 ≠ 2 → 抛 `PUBLIC_FIXTURE_FINDINGS_CHANGED`；反向用例就在测试里：`security-published.test.mjs:304`「减少命中」断言抛这个码。
- 结论：改动改了扫描器，却没同步刷新台账，发布门禁（凡是保留 artifact 的 publish 流程，含 PR 流程）会红。这正是 I-73 那类「只看改动本身、没问下游校验」的问题。
建议：同一 PR 内同步重derive这 5 个条目的 findings（删掉已不再命中的 digest，或按流程重新提案）；并加一条对账检查（哪怕只是把台账 rule/digest 与一次真实扫描输出比对），否则每次放宽规则都会重演。

**2.【低】`scripts/ci/security-source.mjs:7`：`$` 开头、全大写/下划线/数字形状的真实密钥现在漏过 credential-literal。**
证据：作者自己也点名了 `$ABCDEFGHIJKL1234` 这类——它满足新正则，在全部五条路径（md quoted、dotenv、JSON、TS 字面量、sourcesContent）都被豁免；拼接同理（`literalParts` 把 `"$" + "SECRETNAME123"` 合成一个整体后豁免，security-source.mjs:30-34），而修复前拼接结果是会被检出的。结构化模式（sk-、gh*、AKIA、Bearer、JWT、私钥）不受影响，仍是兜底；但形如 `$UPPERCASE_PW` 的口令型密钥、或 `.env` 里 `API_KEY=$UPPERCASE_VALUE` 都会漏。属已声明的取舍，建议至少在 ADR/规则文档里记下这个放宽的边界（名字全大写 + `$` 前缀 + 长度 ≥12 的值不再按字面量密钥处理）。

**3.【低】`test/tooling/security.test.mjs:212-227`：新用例未覆盖全部路径。**
证据：反例只测了 .md（quoted）、.json、.ts 三条路径；dotenv 路径（`:136-140`）和 sourcesContent 路径（`:122-129`）的环境变量引用行为没有用例（行为推断一致，但无测试钉住）；拼接合成 `$NAME` 的用例也没有。建议补齐。

**4.【信息】`docs/pi-development-guide.md:229` 确认存在 `apiKey: "$ACME_API_KEY",`，根因描述与 diff 相符（修复前 `credential` 确实只看键名 + 长度 ≥12，diff 原行可证）。但「CI 用 findBuildSecrets 扫这份 doc 并报 PUBLIC_ARTIFACT_CONTAINS_SECRET」的调用入口我没找到：全仓只有 `security-redaction.mjs:224` 一个生产调用点，扫的是构建归档成员。这份 doc 如何进入被扫的产物，未核实，不影响上述结论。**

**5.【信息】新增的 `.agents/reviews/pr-431/briefs/brief-round1.md` 在 git diff 里显示为二进制（可能含非常规字节），内容未能核对；与本 PR 代码无关。**

另：`test/qualification/evidence/.../frozen-inputs.json` 等 27 份证据文件里冻结了 `scripts/ci/security-source.mjs` 的旧哈希（`5dc8abac…`），本次改动后与 HEAD 不再一致；我在代码里没找到任何把这些哈希和当前 HEAD 对比的门禁（只发现 gitleaks-config.test.mjs 自构造假证据），推断它们只是历史运行记录——此点未完全核实。

## 必答问题逐条回答

1. **不会改变模型已见过的请求开头。** diff 只改了 `scripts/ci/security-source.mjs`、`test/tooling/security.test.mjs` 和一份审阅 brief；`findBuildSecrets` 的导入方只有 `security-redaction.mjs`（CI 发布路径）和测试，grep 证实没有任何运行时/组装模型请求的代码引用它。追加-only 规则（prompt-prefix.md 第 4 条）不适用。
2. **不会让同一段文字在不同请求里变成不同字节**——本改动不涉及模型请求；且新判定只取决于值本身（正则无前后文、无状态），同一段输入在所有五条路径上判定一致。真正的「放宽」问题是上面第 2 条的漏检方向，不是不确定性方向。
3. **正则锚定正确。** `^`/`$` 均在、无 `m` 标志（JS 中 `$` 只匹配真正的串尾，尾部带换行的值会被照常检出，是安全方向）；无 `i`/`u` 标志，非 ASCII 大写不算引用（也是安全方向）；值里多一个字符、混入小写、`$$` 开头都照报。唯一的绕过方向就是第 2 条：值本身长得像 `$ALL_CAPS` 的真实密钥，以及拼接合并后恰好呈该形状。
4. **产生方/使用方核对发现一处不合格：** 产生方是新豁免判定，使用方共查到四处——（a）`review.inspect` 的台账精确比对：**不合格，高严重度问题 1**；（b）`applySecurityExceptions`/synthetic-secret 路径走 gitleaks 的 digest，不受影响；（c）`assertClean`/`redactText` 哨兵路径不经过 credential 规则，不受影响；（d）gitleaks/machine baseline 是另一套工具，不受影响。自动检查方面：新单测正反两面齐、去掉修复会失败（逻辑上成立，未能实际运行验证）；但**没有**对真实台账的自动对账，这正是问题 1 能溜过去的原因。
