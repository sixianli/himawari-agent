## 结论

这个改动解决 `docs/pi-development-guide.md:229` 的误报本身是对的（`apiKey: "$ACME_API_KEY"` 会被新规则跳过），但它只改了扫描器，没有同步检查“谁在消费 `credential-literal` 发现列表”。仓库里已有的 `ci/security-exceptions.json` 把这些环境变量引用登记成了“应当出现的发现”，改动后它们不再出现，发布门的精确清单比对会失败。这正是 I-73 提醒的“只看了改动，没核对另一端”。

---

## 问题（按严重度）

### 1. 高：扫描结果减少，但 `ci/security-exceptions.json` 没有同步，发布/构建门会报 `PUBLIC_FIXTURE_FINDINGS_CHANGED`

**文件:行**：`scripts/ci/security-source.mjs:74-78`（产生端）、`scripts/ci/security-published-fixtures.mjs:56-67`（消费端）、`ci/security-exceptions.json:1201-1230, 1231-1260, 1261-1290, 1316-1340, 1341-1365`（清单）。

**问题**：`credential()` 现在会跳过 `$NAME` / `${NAME}`，因此发布流程扫描 `runtime/node_modules/...` 的构建产物时，某些成员不再产生原有的 `credential-literal` 发现。但 `createPublishedFixtureReview` 要求实际发现与清单逐条、逐次数完全相等：

```js
// scripts/ci/security-published-fixtures.mjs:56-67
const actual = new Map();
for (const finding of findings) {
  const key = `${finding.rule}:${finding.digest}`;
  actual.set(key, (actual.get(key) ?? 0) + 1);
}
assert(
  actual.size === entry.findings.length &&
    entry.findings.every(
      (finding) => actual.get(`${finding.rule}:${finding.digest}`) === finding.count,
    ),
  "PUBLIC_FIXTURE_FINDINGS_CHANGED",
);
```

清单里明确把这些发现描述为环境变量引用，例如：

```json
// ci/security-exceptions.json:1224
"reason": "文档或示例扩展里的 $ACME_API_KEY、$GITLAB_TOKEN 这类环境变量名引用，不是凭据值。"
// ci/security-exceptions.json:1284
"reason": "文档示例里的 ${TOOLS_KEY}、${EXAMPLE_SECRET} 未求值环境变量插值。"
```

受影响的是 5 个已登记成员（`docs/custom-provider.md`、`docs/extensions.md`、`docs/mcp.md`、两个 `examples/extensions/.../index.ts`）。它们登记的 `findings` 全部是这类引用，改动后实际发现为 0，而清单仍要求 1～2 条，`actual.size === entry.findings.length` 不成立，构建/发布门会抛 `PUBLIC_FIXTURE_FINDINGS_CHANGED`。注意 `findings` 在 schema 里是 `minItems: 1`（`ci/security-exceptions.schema.json:268-270`），所以不能把数组清空，只能删除这些成员条目（若确实已无发现），或按新扫描结果重写。

**建议**：
- 在本 PR 中删除/重写这 5 条 `published-synthetic-fixture` 条目，使清单与新扫描结果一致。
- 增加一个反向检查：用真实的 `ci/security-exceptions.json` + 真实运行时成员跑一遍 `createPublishedFixtureReview.inspect`，确保扫描规则和清单一起演进。现有 `test/tooling/security-published.test.mjs:64-92` 自造 fixture，抓不到这种漂移。
- 若某条目还包含其他规则的发现，则只删对应的 `credential-literal` 项并调整 `count`。

**说明**：消费端代码和“发现会消失”是读代码证实的；具体 5 条的 `findings` 与 `$ACME...` 的一一对应依据的是清单里的 `reason` 文本和条数（本环境不能重算摘要，未逐字节复核）。

### 2. 中：豁免作用于所有路径，`$` 开头的全大写真实值会被静默放过

**文件:行**：`scripts/ci/security-source.mjs:7, 74-78`；拼接路径在 `scripts/ci/security-source.mjs:30-33`。

**问题**：`credential()` 是 TS/JSON/文档 quoted/dotenv 所有路径共用的，新规则不只作用于文档示例：

```js
// scripts/ci/security-source.mjs:7
const environmentReference = /^\$(?:[A-Z][A-Z0-9_]*|\{[A-Z][A-Z0-9_]*\})$/;
// scripts/ci/security-source.mjs:74-78
if (credentialName.test(key))
  for (const value of values)
    if (value.length >= 12 && !environmentReference.test(value))
      add("credential-literal", value, line);
```

因此 `$ABCDEFGHIJKL1234`（作者自己举的例子，`$` + 16 个大写字母/数字，长度 17）完全匹配，会被当成环境变量引用跳过；`const password = "$" + "ABCDEFGHIJKL";` 也会因 `literalParts` 把两段单字面量拼成 `$ABCDEFGHIJKL` 而被跳过。所以作者“放宽规则不能让真实密钥漏过”的说法与代码不符：它确实能漏过“`$` 开头、其后全为大写字母/数字/下划线”的真实值。`.env` 路径同样受影响（如 `PASSWORD=$ABCDEFGHIJKL12`）。

**建议**：
- 至少把豁免限制在非代码文档路径（当前误报只来自 `.md`），不要把源码和 JSON 的字符串一并放宽。
- 或者要求变量名同时满足更强的“环境变量名”证据（例如清单白名单、同文件/同仓库存在同名赋值、必须含下划线等）。
- 增加反向用例：`$ABCDEFGHIJKL1234`、`"$" + "ABCDEFGHIJKL"`、dotenv 路径；当前测试没有覆盖这些。

### 3. 低：新用例没覆盖 dotenv、源码中的 `${NAME}`，也没有覆盖真正的消费端

**文件:行**：`test/tooling/security.test.mjs:212-227`。

**问题**：用例覆盖了 `.md`、`.json`、`.ts` 三种路径，但：
- `${NAME}` 只通过 JSON 验证，`.ts` 源码里只验证了 `$NAME`；
- dotenv（`.env`/`.env.example`）路径没有反向/正向用例，而 `credential()` 同样改变了它的行为；
- 没有覆盖 `ci/security-exceptions.json` 这个真正的消费端（见问题 1）。

作者说“security、security-published、security-review 131 条通过”，但 `security-published` 用的是临时合成 fixture，不能证明真实清单仍匹配。

### 4. 低：代码注释与实现不再一致

**文件:行**：`scripts/ci/security-source.mjs:53`。

**证据**：注释写的是“variable references/calls are not credentials; string values are checked”，但现在某些字符串值（`$NAME`、`${NAME}`）明确不检查。建议把注释改成“变量/调用不作为凭据；字符串值会检查，但形如环境变量引用的整个值除外”，避免后来者按旧语义理解。

---

## 推测 / 未核实

- **未核实**：本 PR 的 PR CI 是否真的会跑到构建产物/发布清单这一步。若只在 main 的发布或确认流程跑到，则 PR 阶段可能显示通过，问题会在发布时暴露；无论哪种，都是回归。
- **未核实**：`ci/security-exceptions.json` 里被跳过的值是否逐个摘要匹配。无法在本环境用 Node 重算，结论依据 `reason` 文本和条数。
- **未核实**：`.github/security-review-manifest.json` 是否存在并包含同类条目。当前工作树 `glob .github/**` 无结果，`security-owner-review.mjs:111` 会读取它；若以后出现同类 `credential-literal` 清单，也会受同样影响。
- **推测**：如果发布门只在真构建后运行，那么删除这 5 条清单是安全的，因为这些成员改后已无任何发现。

---

## 侧重检查

- **错误路径**：新增正则不会抛异常；解析失败仍走 `PUBLIC_SOURCE_PARSE_FAILED`。真正的错误路径是清单比对失败：`PUBLIC_FIXTURE_FINDINGS_CHANGED`（问题 1），以及 `applySecurityExceptions` 的 `SECURITY_EXCEPTION_FINDING_UNKNOWN`（`scripts/ci/check-security.mjs:329-332`，若存在指向被跳过值的 `synthetic-secret` 条目会触发；当前清单里未发现这类条目，属未穷举）。
- **不可信/不合规范输入**：JSON、JSONC、source map 的 `sourcesContent`、非代码 quoted、dotenv 都统一经过 `credential()`，因此新豁免都会生效；没有发现换行/Unicode 绕过——`^...$` 无 `m` 标志，`$` 在 JS 中只匹配输入末尾，带尾随换行或额外字符会失败（fail-closed，会报）。
- **安全**：存在真实的漏报面（问题 2），尤其是把豁免扩大到源码和 dotenv 后。
- **资源耗尽**：新正则 `[A-Z][A-Z0-9_]*` 线性、无嵌套量词，没有 ReDoS 或额外内存风险。
- **不可撤销操作**：本改动只读扫描，不写文件、不删数据；没有不可撤销操作。
- **规则/文档/代码一致性**：`security-source.mjs:53` 注释与实现不一致；作者“真实密钥不会漏过”的说法与代码不一致；`ci/security-exceptions.json:7` 的 reviewEvidence 仍把 `$ACME_API_KEY` 类引用描述为已登记发现，与改动后的扫描结果矛盾。

---

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。diff 只涉及 `scripts/ci/security-source.mjs` 和 `test/tooling/security.test.mjs`，不涉及系统提示、工具定义、历史、遮盖或任何 `packages/`、`apps/` 的请求组装代码。发给模型的内容仍然遵循 `prompt-prefix` 规则第 4 条的“只追加”，本改动没有新增每轮变化的值，也没有把值塞进系统提示或历史中间。

2. **会不会让同一段文字在不同请求里变成不同的字节？**
   不会。`environmentReference` 是模块常量，`test()` 只依赖传入的字符串，不依赖前后文、时间、集合遍历顺序或随机数；同样的文本每次得到同样的扫描结果。而且这段代码根本不参与发往模型的内容序列化。

3. **有没有对应的自动检查，反向用例是否真的会失败？**
   有单元用例（`security.test.mjs:212-227`）。静态推导：修复前 `$ACME_API_KEY`、`${DATABASE_PASSWORD}` 长度都 ≥12 且会进入 `credential()`，所以那三条 `toEqual([])` 会失败；修复后通过，反向用例是有效的。但本环境只允许 git/read/grep/glob，**没有实际运行测试**。更大的缺口是没有自动检查覆盖真实 `ci/security-exceptions.json` 与扫描结果的同步（现有测试用合成 fixture），所以问题 1 不会被现有检查抓到。

4. **改动产生/修改的每个值，每个使用它的地方都能接受吗？**
   不能。被修改的是“`credential-literal` 发现集合”：
   - 产生端：`scripts/ci/security-source.mjs:78`。
   - 消费端 1：`scripts/ci/security-published-fixtures.mjs:61-67` 要求发现与已批准清单逐条相等，删掉的发现会让 `actual.size !== entry.findings.length`，抛 `PUBLIC_FIXTURE_FINDINGS_CHANGED`。`ci/security-exceptions.json` 里至少 5 条 `published-synthetic-fixture` 的 `findings` 正是这些环境变量引用，未被本 PR 同步。
   - 消费端 2：`scripts/ci/check-security.mjs:329-332` 的 `SECURITY_EXCEPTION_FINDING_UNKNOWN`，对 `synthetic-secret` 条目而言，发现消失会导致清单项无人消费而失败（当前清单未见此类环境变量条目，属未穷举）。
   - 规则标识 `credential-literal` 本身没变，`publishedRules`（`scripts/ci/security-exceptions.mjs:36-44`）仍包含它，这一端没问题。

   结论：产生端已经变了，但清单消费端仍按旧发现集合校验，必须同步修改 `ci/security-exceptions.json`（删除或重写这 5 条），否则这个“修复”会把 CI 红从 `PUBLIC_ARTIFACT_CONTAINS_SECRET` 换成 `PUBLIC_FIXTURE_FINDINGS_CHANGED`。
