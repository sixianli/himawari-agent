## 结论

本轮 `463a450..20ea9a6` 的增量只改了 `scripts/ci/security-exceptions.mjs`、`test/tooling/security-published.test.mjs` 和设计文档，其余是复核记录（二进制，未读）。**未发现高/中严重度安全漏洞**；校验顺序改动本身正确，新增用例能覆盖对应修复。发现的主要是低严重度的残余风险、错误路径缺口和测试覆盖缺口。

## 发现（按严重度）

### 1. 低（安全残余风险，利用方式为推测）：`$` 开头、全大写的真实字面量会被当成环境变量引用放行
- 文件: `scripts/ci/security-source.mjs:7`、`scripts/ci/security-source.mjs:73-78`
- 问题: 放行规则只看“整个值”的形状，无法区分环境变量引用和碰巧长成 `$UPPER_CASE` 的真实字面量；再配合删除对应台账条目，原本有例外记录的命中就变成“无命中、无例外”。
- 证据（亲自读到）:
  - `const environmentReference = /^\$(?:[A-Z_]+|\{[A-Z_]+\})$/;`（第 7 行）
  - `if (value.length >= 12 && !environmentReference.test(value)) add("credential-literal", value, line);`（第 76-77 行）
- 具体反例（语法上成立，未证明是现实凭据）: `const apiKey = "$" + "REALCREDENTIALVALUE";` 经 `literalParts` 拼成 `$REALCREDENTIALVALUE`，全大写，当前扫描器不会再报 `credential-literal`。同类：`apiKey: "$ABCDEFGHIJKL"`。
- 对作者第 3 轮第 1 条意见: 我不能读 `judgments.md`，但从代码看，**“放宽规则 + 删条目”确实存在这种纯语法反例**。不过我没有找到现实凭据会采用“全部大写字母/下划线且以 `$` 开头”的格式，所以仍同意“实际风险低”，不建议据此否决 PR；建议把它作为已接受的残余风险写进文档，或对删除的条目录入扫描为空的人工证据。

### 2. 低（错误路径）：base 台账是坏 JSON 时仍抛原生 `SyntaxError`，不是受控错误码
- 文件: `scripts/ci/security-exceptions.mjs:236-238`；用例: `test/tooling/security-published.test.mjs:207-215`
- 问题: 本轮只覆盖了“JSON 能解析但 schema 不合法”的情况。`JSON.parse(bytes)` 没有 try/catch，坏 JSON 仍会得到 `SyntaxError`，不符合“base 台账结构错误时报 `SECURITY_EXCEPTION_SCHEMA_INVALID`”这一较宽的说法。
- 证据（亲自读到）:
  - `const bytes = available ? git(root, ["show", `${context.baseSha}:${exceptionPath}`]) : candidate;`
  - `const document = withoutRemovedDependencies(JSON.parse(bytes), dependencies);`
  - 下一行才 `validateSecurityExceptions(document, ...)`（第 237-238 行）
- 建议: 把 base（和 candidate）的 `JSON.parse` 包成受控错误码并补一条非法 JSON 的反向用例；或者把文档/说明收窄为“schema 错误”。

### 3. 低（功能/文档边界，需确认设计意图）：候选无法用“撤掉”来清理已过期的 base 条目
- 文件: `scripts/ci/security-exceptions.mjs:136-142`、`:238`、`:246`；文档: `docs/execution/specs/2026-09-03-github-ci-quality-gates-design.md:246`
- 问题: 代码先整体校验 base（含过期检查），再计算 `removedPublishedPaths`。因此候选即使删掉一个已过期的 base `published-synthetic-fixture`，也会先在 base 校验处报 `SECURITY_EXCEPTION_EXPIRED_OR_INVALID`，删除不生效。文档“删除多余例外的 PR 和它的合并提交不会因为目标分支的旧记录变红”在“旧记录已过期”这一边界下不成立。
- 证据（亲自读到）:
  - `expires.getTime() > instant` 的断言（第 136-142 行）
  - `const exceptions = validateSecurityExceptions(document, ...)`（第 238 行）
  - `const removedPublishedPaths = [...publishedPaths(exceptions)]...`（第 246 行，在整体校验之后）
- 说明: 这是 fail-closed，不是安全漏洞；是否要支持“清理过期条目”取决于设计。
- 建议: 若允许删除失效条目，应先算 removal，再只校验未被撤销的 base 条目；若不允许，在文档写明“被撤掉之前，base 条目本身仍须有效、未过期”，并补一条过期条目的用例。

### 4. 低（测试缺口）：被删的 5 条真实台账条目没有被自动检查覆盖
- 文件: `test/tooling/security-published.test.mjs:434-472`；`ci/security-exceptions.json`
- 问题: “真实台账和当前扫描规则一致”只遍历**剩下的** published 条目，不验证本次删掉的 5 个文件在当前扫描规则下确实为 0 命中。若作者“改后扫描结果为空”的判断有误，真实 public scan 会失败（fail-closed，不会泄密），但现有测试抓不到这个错误。
- 证据（亲自读到）:
  - `const entries = ledger.exceptions.filter((entry) => entry.kind === "published-synthetic-fixture");`（第 439-441 行）
  - 之后只对 `entries` 逐个 `readFileSync` 和比对 `findBuildSecrets`（第 454-470 行）
- 未核实: 当前是 sparse checkout，`node_modules` 不存在，我无法亲自确认这 5 个文件现在是否真的无命中。
- 建议: 增加“对本次删除路径用当前 scanner 断言无命中”的检查，或在复核记录里保留删除前的扫描证据。

### 5. 信息（措辞）：文档说“不能新增或修改”，代码实际是“忽略而不是拒绝”
- 文件: 文档 `:246`；代码 `scripts/ci/security-exceptions.mjs:238,245`、`scripts/ci/security-published-fixtures.mjs:27-29`
- 问题: 候选新增条目会被校验但不会生效；修改 path 会被当作“撤掉原路径”，修改其他字段仍使用 base 条目。安全效果与“不能新增或修改”一致，但代码不会报错，读者可能误以为会拒绝。
- 建议: 若只是表达效果，建议写成“新增或修改不会生效”。

## 侧重检查

- 错误路径: 检查了 candidate/base 的 JSON 解析、schema 校验、初始化分支、owner review 分支、base 依赖被移除分支。除上面第 2、3 条外，错误顺序一致。
- 不可信输入/路径: `validatePublishedEntry` + `exactPath`/`safeRelativePath`（`scripts/ci/contracts.mjs:65-74`）拒绝绝对路径、`..`、`.`、空段、反斜杠和通配符；`removedPublishedPaths` 只按完整路径删除，不能借前缀/通配符删除别的条目。
- 安全: 删除例外只会让成员“按无例外处理”，`security-published-fixtures.mjs:44-51` 仍先检查 sentinel，再有命中即失败；gitleaks 路径在 `check-security.mjs:274` 把 published 条目过滤掉，所以删除只影响公开输出扫描，不会放松源码/历史密钥门禁。
- 资源耗尽/不可撤销操作: 新增逻辑只是对台账做 set/filter/sort，O(条目数)，没有新增子进程、网络或写操作；删除例外会导致保守失败，不会删除文件。未见资源耗尽或不可撤销副作用。
- 规则/文档一致性: 文档新句子与代码效果基本一致；第 3 条的“过期边界”和第 5 条的“拒绝/忽略”措辞需要收窄。
- 未能核实: 当前工作区不在任何分支且是 sparse checkout，`node_modules` 缺失；`.agents/reviews/pr-431/round-3/judgments.md` 不在工作区，`git show` 读取 records 路径被工具拒绝，因此第 3 轮判断原文未核实；也未实际运行测试。

## 必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会。增量只涉及 CI 公开输出扫描、测试和设计文档，没有改系统提示、工具定义、历史消息、模型出口遮盖或请求组装；`security-source.mjs` 是 CI 归档扫描器，不是模型请求的遮盖实现。发给模型的内容仍然只在末尾追加，与本次改动无关。

**2. 会不会让同一段文字在不同请求里变成不同字节？**
不会。新增的序列化值是 `removedPublishedPaths`，它由 `sort()` 排序（`security-exceptions.mjs:246-248`），没有时间字段、没有无序集合直接写出；`now` 只参与校验，不写入输出。同一输入得到相同字节。

**3. 有没有对应的自动检查，反向用例会失败吗？**
有。新用例在 tooling 项目里会被执行（`ci/policy.json:193-194` 包含 `test/tooling/**/*.test.mjs`）。
- “base台账结构错误”用例: 去掉本轮“先校验 base”的修复后，旧代码执行 `({}).filter` 会抛 `TypeError`，断言 `SECURITY_EXCEPTION_SCHEMA_INVALID` 会失败。
- “候选把例外改到别的路径”用例: 若没有按路径撤销，移动后的条目会被当成新例外生效，`inspect` 不会抛错，用例失败。
- “初始化时没有可撤掉的例外”用例: 若 `removedPublishedPaths` 缺失或非空，`toMatchObject([])` 失败。
- 删例外仍有命中/已无命中两条用例也能反向覆盖去撤销逻辑。
缺口: 坏 JSON、过期 base 条目的撤销、被删的 5 条真实条目没有测试覆盖（见发现 2、3、4）。

**4. 每个新值的使用方能接受吗？**
逐项核对:
- `removedPublishedPaths` 产生于 `security-exceptions.mjs:246-248`，两个返回分支都带上（`:275`、`:288`）；使用方 `security-published-fixtures.mjs:26` 用 `new Set(...)`，`:79` 原样放进 `finish()`；再由 `publish.mjs:152-158` 序列化进 `public-review.json`。该文件没有严格 schema 校验，只作为公开产物再做一次敏感扫描，数组字段可接受。
- `candidateExceptions` 只在本函数内用于 `candidatePublishedPaths`，来源是已校验数组。
- `publishedPaths` 的入参从 document 改为 entries，两个调用点都已同步。
- 删除的 5 条台账条目: 仍会经过 `validateSecurityExceptions`、公开扫描和真实台账测试；gitleaks 不消费 published 条目，因此删除不影响 gitleaks；公开扫描在文件仍有命中时会失败（fail-closed）。
- `environmentReference` 只在 `security-source.mjs:76` 使用，影响扫描和测试；残余风险见发现 1。
- 设计文档 `:246` 与代码效果一致，但“不能新增或修改”应理解为“不会生效”，且未覆盖“base 条目本身仍需有效/未过期”的边界。
