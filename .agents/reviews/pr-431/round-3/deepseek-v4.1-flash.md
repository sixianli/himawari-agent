## 结论

核心改动本身（用 `removedPublishedPaths` 把候选删掉的公开产物例外从 `expected` 中剔除）在**只删不加**的方向上是成立的；但“只会让检查更严”这个说法不完整：删除动作移除了 base 台账原有的“扫描结果必须与 base 一致”这一道防线，与候选同时修改扫描器时可以把原本会红的检查变绿。另外发现一处文档/代码不一致、一处错误路径退化、以及若干测试缺口。

---

## 发现（按严重度）

### 1. 中：删除例外会让“扫描器被放宽 + 台账删条目”的组合通过，破坏了 base 台账对已登记成员的锚定

- 文件:行：`scripts/ci/security-exceptions.mjs:240-243`、`scripts/ci/security-published-fixtures.mjs:26-29,48-51`；相关测试 `test/tooling/security-published.test.mjs:405-442`
- 问题：`entries` 完全由 **base** 台账生成，`removedPublishedPaths` 把候选里已不存在的路径从 `expected` 中剔除；对于被剔除的成员，`inspect` 只要求“本次扫描发现为空”（`findings.length === 0`）。而本次扫描调用的是**候选分支自己的** `findBuildSecrets`。因此候选可以同时改弱扫描规则并删除因此“对不上”的台账条目，原本应报 `PUBLIC_FIXTURE_FINDINGS_CHANGED` 的检查会变成通过。改动前 base 台账的 `entry.findings` 是唯一把已登记成员的真实扫描结果钉住的东西，删除功能把这个钉子也交给了候选。
- 证据（亲自读到）：
  - `scripts/ci/security-exceptions.mjs:240-243`
    ```js
    const candidatePublishedPaths = publishedPaths(JSON.parse(candidate));
    const removedPublishedPaths = [...publishedPaths(document)]
      .filter((path) => !candidatePublishedPaths.has(path))
      .sort();
    ```
  - `scripts/ci/security-published-fixtures.mjs:26-29`
    ```js
    const removed = new Set(reviewed.removedPublishedPaths);
    const entries = reviewed.exceptions.filter(
      (entry) => entry.kind === "published-synthetic-fixture" && !removed.has(entry.path),
    );
    ```
  - `scripts/ci/security-published-fixtures.mjs:48-51`
    ```js
    const entry = expected.get(name);
    if (!entry) {
      assert(findings.length === 0, "PUBLIC_ARTIFACT_CONTAINS_SECRET");
      return;
    }
    ```
  - 真实台账测试也是用候选台账 + 候选扫描器（`test/tooling/security-published.test.mjs:433-436`）：
    ```js
    findings: tally(findBuildSecrets({ name: entry.path, bytes })),
    ```
    所以扫描器与台账一起改时，这个测试不会反向失败。
- 建议：把“删除例外”当作需要审阅的基线变更处理。可选做法：
  1. 删除路径必须出现在 Owner 复核清单（或新增的 reviewed-removals 清单）里，而不是候选单方面声明；
  2. 或用 **base 版本**的扫描器/规则重新扫描被删路径，只有 base 扫描器也不再命中时才允许删除（这会挡住“放宽扫描器 + 删条目”的组合，但也会挡住本次环境变量引用的清理，所以需要配合一次明确的策略变更审阅）；
  3. 至少增加一条反向用例：候选删除条目、但 base 扫描器对当前文件仍报出该条目的 `findings` 时必须失败（除非有审阅记录）。

### 2. 低：删除功能与设计文档“任意命中集合变化均须重新审阅”不一致

- 文件:行：`docs/execution/specs/2026-09-03-github-ci-quality-gates-design.md:242,246`；代码 `scripts/ci/security-exceptions.mjs:241-243`
- 问题：文档明确写“候选分支不能自行替换它们”“公开输出检查读取目标分支已接受的例外”“任意成员内容、依赖身份或命中集合变化均须重新审阅”。新代码允许候选自行从目标分支的已接受例外集合中删除条目并立即生效，没有对应的审阅入口或清单更新。
- 证据（亲自读到）：
  - `docs/execution/specs/2026-09-03-github-ci-quality-gates-design.md:242`：`常规例外仍从目标分支读取，候选分支不能自行替换它们。`
  - 同文件 `:246`：`任意成员内容、依赖身份或命中集合变化均须重新审阅，不允许按包或目录放行。公开输出检查读取目标分支已接受的例外……`
- 建议：要么在 Spec/ADR 里明确“删除多余例外属于允许的收紧操作、无需 Owner 审阅”并写清边界；要么把删除纳入审阅清单（见发现 1）。当前代码和文档至少有一边需要改。

### 3. 低：base 台账结构异常时，新代码会先抛 `TypeError`，而不是原来的受控错误码

- 文件:行：`scripts/ci/security-exceptions.mjs:234-244`
- 问题：`publishedPaths` 在 `validateSecurityExceptions(document)` 之前执行，直接调用 `(value.exceptions ?? []).filter(...)`。如果 base 台账的 `exceptions` 不是数组（或 `document` 不是对象），这里抛 `TypeError`；改动前会由 `validateSecurityExceptions` 报 `SECURITY_EXCEPTION_SCHEMA_INVALID`。`check-security` 会把非 `^[A-Z_]+$` 的消息当作 `SECURITY_EXECUTION_FAILED`，诊断码退化。
- 证据（亲自读到）：
  - `scripts/ci/security-exceptions.mjs:235-238`
    ```js
    (value.exceptions ?? [])
      .filter((entry) => entry.kind === "published-synthetic-fixture")
      .map((entry) => entry.path),
    ```
  - `scripts/ci/security-exceptions.mjs:244`
    ```js
    const exceptions = validateSecurityExceptions(document, { now, ruleIds, dependencies });
    ```
- 建议：先调用 `validateSecurityExceptions(document, ...)`，再计算 `removedPublishedPaths`；或在 `publishedPaths` 里显式要求 `Array.isArray(value?.exceptions)`，否则直接抛出原有错误码。

### 4. 低：测试覆盖了正反核心路径，但没有锁定作者列出的几个边界

- 文件:行：`test/tooling/security-published.test.mjs:175-195`
- 问题：新增用例只覆盖“删掉条目且成员干净 → 通过”和“删掉条目且成员仍有命中 → 失败”。作者关心的“把例外改到别的路径”“owner 审阅清单同路径”“初始化分支”“候选解析失败”都没有直接用例。
- 证据（亲自读到）：
  - `test/tooling/security-published.test.mjs:175-195` 只有上述两条新用例。
  - 现有“候选自加例外无效”在 `:148-161`，“候选扩大摘要/次数无效”在 `:162-174`。
- 建议：补以下用例（不一定要全部，但至少补前两条）：
  1. 候选把 base 条目从路径 P 改到 Q，实际成员 P 仍有命中必须失败、Q 不得被当成例外；
  2. base 与 owner 清单同路径时，当前会在 `security-exceptions.mjs:253-257` 先报 `SECURITY_EXCEPTION_DUPLICATE`，用测试锁住这个顺序；
  3. 初始化分支 `removedPublishedPaths` 必须为空；
  4. 候选台账 JSON 解析失败时必须在计算删除列表之前失败；
  5. 多个路径被删时 `removedPublishedPaths` 的排序稳定。

### 5. 提示：环境变量引用规则的残留误放行（不是本轮增量，但属于作者说明覆盖的范围）

- 文件:行：`scripts/ci/security-source.mjs:7,73-77`；测试 `test/tooling/security.test.mjs:213-235`
- 问题：`environmentReference = /^\$(?:[A-Z_]+|\{[A-Z_]+\})$/` 会把“`$` + 全大写字母/下划线”的值整体放行。作者说“像密钥的值照样检测”，但全大写、无数字的密钥值（例如 `"$ABCDEFGHIJKLMNOP"`）不会被检出；现有反向用例只覆盖了带数字/小写/连字符的形状。这是一个窄口径的残留误放行，不是本轮新增。
- 证据（亲自读到）：
  - `scripts/ci/security-source.mjs:7`
    ```js
    const environmentReference = /^\$(?:[A-Z_]+|\{[A-Z_]+\})$/;
    ```
  - `test/tooling/security.test.mjs:224-235` 的反向值包括 `$acme_api_key_value`、`$ACME_API_KEY-extra1`、`$ABCDEFGHIJKL1234`，没有纯大写字母亲钥形状。
- 建议：如果接受这个口径，在测试注释或文档里写明残留风险；否则把放行收紧到更接近真实环境变量名（例如要求至少含一个下划线/长度上限/与已知 `process.env` 名风格一致），并加一条纯大写值的反向用例。

---

## 推测（未经运行验证）

- 发现 1 的利用链是读代码推导：候选同时修改 `findBuildSecrets` 和删除对应台账条目时，`expected` 不再包含该路径，`inspect` 只看到“0 命中”，`finish()` 的 `consumed.size === expected.size` 也能通过。我没有运行测试来复现完整链路，但代码路径是确定的。
- 作者关于“`[A-Z_]+` 与 gitleaks 默认全局放行规则一致”的说法，我**未核实**：仓库的 `ci/rules/gitleaks.toml` 只写了 `useDefault = true`，默认规则由锁定的 gitleaks 二进制提供，不在仓库里。
- 作者关于“5 条归零从 616f77439 起就是这样，不是第 2 轮收紧正则造成的”，我核对了提交：`616f77439` 的规则允许数字，`c44f4c7ba` 才收紧到只允许大写字母/下划线；而被删的 5 条值都是 `$NAME`/`${NAME}` 形式、不含数字，所以第 1 个提交时它们已经归零。**这条说法成立**（读 `git show` 证实）。
- `npm run check` 是否通过，我**未核实**（本环境不能运行测试，只能读代码和 git）。

---

## 侧重检查

- **错误路径**
  - 候选台账 JSON 解析失败：`security-exceptions.mjs:229-230` 在 `:240` 之前先 `JSON.parse` 并校验，解析失败会先抛，删除列表不会被计算。结论：安全。
  - base 台账结构异常：见发现 3，错误码退化（低）。
  - base 条目过期/无效：`:244` 仍会先校验 base，候选无法用“删除”救活一个已过期/无效的 base 条目。这是删除功能的限制，不是新漏洞。
  - `withoutRemovedDependencies` 之后的 base：`removed` 基于过滤后的 `document` 计算（`:233,241`），已随依赖移除的条目不会出现在删除列表；候选也不能保留无效依赖条目（`:230` 会校验候选）。结论：安全。
  - 初始化分支（base 无台账）：`bytes = candidate`，`publishedPaths(document) === candidatePublishedPaths`，`removedPublishedPaths` 必为空。结论：安全，但无用例锁定。
- **不合规范/不可信输入**
  - 候选路径、kind、package/version/integrity、归档成员路径：`validateSecurityExceptions(JSON.parse(candidate))` 在 `:230` 先校验；`validatePublishedEntry` 的 `exactPath`、路径等式和依赖匹配仍生效。候选新增条目不会成为例外，因为 `entries` 来自 base（`:27`）。
  - 归档成员名：由 `security-redaction.mjs` 的 `safeRelativePath` 检查，`expected.get(name)` 是精确匹配，删除路径不会让新成员名被豁免。结论：安全。
- **安全**
  - 删除方向不能直接放过仍有命中的成员：`inspect` 在 `:49-51` 对未知路径要求 `findings.length === 0`，且测试 `:189-195` 覆盖。结论：直接路径安全。
  - “放宽扫描器 + 删除台账条目”的组合：见发现 1，是本次改动真正削弱的一道防线（中）。
  - owner 审阅清单同路径：base 与 owner 清单同路径时，`security-exceptions.mjs:253-257` 的 combined 校验会先报 `SECURITY_EXCEPTION_DUPLICATE`；owner-only 路径不在 `document` 里，不会进入 `removed`。结论：删除不会让 owner 条目被悄悄拿掉或放宽。
  - 敏感哨兵：`inspect` 第一条断言仍无条件拦截 `sentinel`（`:44-47`），删除功能不触及。结论：安全。
- **资源耗尽/不可撤销**
  - `/tmp` 下新增逻辑只是对台账数组做 Set/数组操作，`JSON.parse(candidate)` 多解析一次（`:240`），规模受台账文件本身限制，没有新增无界循环或大对象放大。结论：无明显新增风险。
  - 删除在合并后会写入新的 base 台账，属于持久、不可撤销的收紧操作；`removedPublishedPaths` 只写进 `public-review.json` 供审计，不影响后续运行。结论：可审计，但没有独立的“删除审阅”记录（与发现 1、2 相关）。
- **规则/文档一致性**
  - `docs/execution/specs/2026-09-03-github-ci-quality-gates-design.md:242,246` 与代码的候选侧删除不一致（发现 2）。
  - `ci/security-exceptions.schema.json` 只管台账文件本身，不涉及 `removedPublishedPaths`，两者无冲突。

---

## 必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？

不会。改动的文件是 `scripts/ci/security-exceptions.mjs`、`scripts/ci/security-published-fixtures.mjs`、`scripts/ci/security-source.mjs` 和测试；`findBuildSecrets` 只被 `scripts/ci/security-redaction.mjs:224` 用于公开构建产物的扫描，不参与发给模型的系统提示、工具定义、历史消息或出口遮盖。发给模型的内容仍然只在末尾追加，每轮变化的值也没有被搬到请求中间。依据：[prompt-prefix.md 第 4、10、11 条](.claude/rules/prompt-prefix.md#append-only)（已逐条对照）。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

不会。增量中没有时间字段、随机数、依赖遍历顺序或依赖前后文的遮盖。`removedPublishedPaths` 来自 Set，但最后 `.sort()`（`security-exceptions.mjs:243`），相同 base/candidate 输入得到相同字节；`finish()` 只增加这个排序数组。`security-source.mjs` 环境变量规则（本轮之前已存在）同样是确定性的正则，不依赖前后消息。

### 3. 有没有对应的自动检查，反向用例是否真的会失败？

有，且核心反向用例按代码逻辑会失败（未实际运行）：
- 正向：`test/tooling/security-published.test.mjs:175-188`，删掉条目且成员干净时通过，并断言 `removedPublishedPaths: [f.name]`、`memberCount: 0`。
- 反向：`:189-195`，删掉条目但成员仍有命中时 `inspect` 抛 `PUBLIC_ARTIFACT_CONTAINS_SECRET`。
- 去掉过滤逻辑后，正向用例会因 base 条目仍要求成员摘要/命中匹配而失败；反向用例会因成员命中仍被 base 条目接受而不抛错，所以两条都能真正反向失败（读代码推断）。
- 缺口：移动路径、owner 同路径、初始化、候选解析失败、多路径排序没有直接用例（见发现 4）。

### 4. 改动产生或修改的每个值，使用它的地方都能接受吗？

`removedPublishedPaths` 的链路我逐处核对了：
- 产生：`scripts/ci/security-exceptions.mjs:241-243`，两个返回分支都带（`:271`、`:284`）。
- 使用：`scripts/ci/security-published-fixtures.mjs:26-29` 过滤 `entries`，`:79` 写入 `finish()`。
- 下游：`scripts/ci/publish.mjs:152-161` 把 `finish()` 结果写进 `public-review.json`，这里**没有**固定字段 schema；`validateRecord("CheckResult", published)` 校验的是 `result.json` 的另一个对象（`publish.mjs:121,162`）。
- `check-security.mjs:821` 把 `reviewed` 展开进 `security-report.json` 的 `exceptions` 元数据，这个文件也没有 schema；`export-evidence.mjs:143-160` 只读 `status`、`scannedAt`、`context` 等字段，多一个字段无影响。
- `applySecurityExceptions` 在 `check-security.mjs:274` 明确过滤掉 `published-synthetic-fixture`，所以删除列表不会影响 gitleaks 例外消费。
结论：多一个字段不会触发下游固定字段校验报错；但注意它**没有计入 `reviewed.sha256`/`policySha256`**，删除集只通过 `public-review.json` 的独立字段留痕。
