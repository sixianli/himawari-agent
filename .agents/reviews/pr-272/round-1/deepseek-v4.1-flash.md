（说明：本代理已达到允许的最大工具调用步数，以下结论仅基于已读到的代码与 diff，未再调用工具。）

## 读代码证实的问题

### 1. 中｜`scripts/check-egress-redaction.mjs:310-315`｜计数是纯文本正则，既能漏报也能误报
证据（亲自读到）：
```js
function gateCallCounts(text) {
  const counts = {};
  const pattern = new RegExp(`\\b(${SENSITIVE_GATE_FUNCTIONS.join("|")})\\(`, "gu");
```
- 漏报：只认“函数名后紧跟 `(`”。写成 `scanMachineSecrets (x)`、`scanMachineSecrets?.(x)`，或 `import { scanMachineSecrets as scan }` 后调用 `scan(...)`，都计数为 0，检查不会报“新增了整段拦下的调用”。
- 误报：注释、字符串、类型文本里出现 `scanMachineSecrets(` 也会被当成调用，使 `npm run check` 失败。
这正是“整段拦下”这道安全门槛的绕过面。建议改用语法分析（AST）识别真实调用；做不到时至少匹配 `\s*\(`、`?.\(`，并排除注释/字符串，或对别名统一禁用。

### 2. 中｜`scripts/check-egress-redaction.mjs:92-255`｜登记表的 `decision`/`reason` 没有任何校验或使用者
证据（亲自读到）：`findSensitiveGateViolations` 只读取 `entry.calls`：
```js
const entry = registered.get(relative);
...
if (!sameCounts(counts, entry.calls))
```
`decision` 与 `reason` 从未被读取。也就是说，登记行可以写成任意结论（或干脆漏写 decision）而检查照常通过，与“逐文件写明结论和理由”的目的不一致，后续 PR 若依赖这份表判断该遮还是该放行，会得到不可信数据。建议校验 `decision ∈ {保留, 改成发往外部时遮值, 改成原样放行}` 且 `reason` 非空，否则报错。

### 3. 低-中｜`scripts/check-egress-redaction.mjs:298-304`｜外部出口按“文件+名称”整体放行
证据（亲自读到）：
```js
for (const { name, pattern } of EXTERNAL_EGRESS_PATTERNS) {
  if (!pattern.test(text)) continue;
  if (ALLOWED_EXTERNAL_EGRESS_FILES.get(relative)?.includes(name)) continue;
```
一旦某文件登记了某类出口，该文件里再出现同类出口（比如 `exa-public-search.ts` 再加一个不同的 Exa URL）也不会报。正则只看路径片段（如 `/v1/systemone`），没有 host 约束，跨模块拼接 host 时可能漏检，别处恰好含相同路径时又会误报。建议按完整 URL/host 或调用点登记，并补反向测试。

### 4. 低（错误路径，部分为既有问题）｜`scripts/check-egress-redaction.mjs:276-280`、`333-341`｜读文件失败的处理不一致
证据（亲自读到）：`findSensitiveGateViolations` 对缺目录有 `try { files = sourceFiles(directory); } catch { continue; }`，但 `findEgressViolations` 直接 `sourceFiles(path.join(root, base))`，循环里 `readFileSync` 也没有 try/catch；新加的外部出口检查就在同一个循环内。遇到不可读文件/路径异常时，命令会以未处理异常退出，而不是给出可读的 violation。建议统一把读错误转成 violation 或明确跳过并记录。

## 推测（未证实会出错）

- 作者称“`npm run check` 35 步全过”“16 条测试通过”：无法运行，未核实；仅从 diff 数出原有 9 条 + 新增 7 条 = 16 条，数目吻合（`test/tooling/egress-redaction-check.test.mjs:131-221`）。
- `sourceFiles` 用 `statSync` 跟进符号链接，若 `packages/`/`apps/` 下存在符号链接环，递归可能不终止（既有实现，未核实仓库是否存在此类链接）。
- 文档一致性：`docs/adr/0146`、`0148`、`0167` 描述的是旧的出口检查，没有提到新增的外部出口放行表和“整段拦下”登记表；这不会让检查失败，但规则/文档与代码新增行为不完全同步，未核实是否有其他文档要求同步。

## 对作者说法的核对

1. **“登记表和当前代码完全对得上”**：属实。我逐个核对，`packages`/`apps` 下 `/src/`（排除 `packages/sensitive-capture/src/`）里这四个函数的调用恰为 27 个文件、合计 50 处，与 `SENSITIVE_GATE_CALLS` 的文件、函数和计数一致；没有漏登记或多登记。
2. **“计数只看紧跟 `(` 的调用，import 和测试文件不算”**：部分属实。import 确实不带紧跟的 `(`；测试文件目前不在 `/src/` 下所以被过滤，但代码并没有显式排除测试文件（`:340` 只有 `/src/` 条件），且注释/字符串会被计入（见问题 1）。
3. **“外部出口正则不会误伤，例如 `web-providers.ts` 的 `https://mcp.exa.ai` 和 `mcp.exa.ai:443` 不命中”**：对这一具体文件属实，两条字符串都缺少 `/mcp`，不匹配 `https:\/\/mcp\.exa\.ai\/mcp`（`web-providers.ts:21-22`）。但“不会误伤别处”不能由这一点推广，正则只是路径片段匹配，见问题 3。
4. **“原有 `findEgressViolations` 行为不变，原来 9 条测试照常通过”**：不准确。`findEgressViolations` 里新增了外部出口循环（`:298-304`），行为已扩大（新增失败条件）；原有 9 条测试仍会通过只是因为它们的 fixture 不含这些外部 URL。称“行为不变”与代码不符，但就产品功能而言确实没有改动运行时。

## 必答问题

1. **是否改变模型已见过的请求开头？** 不会。本次改动只涉及 `scripts/check-egress-redaction.mjs` 与 `test/tooling/egress-redaction-check.test.mjs`（`git diff --stat` 证实），没有触碰系统提示、工具定义、历史或遮盖逻辑，发送内容仍然只追加、每轮变化值仍只能在最后一条消息里。
2. **同一段文字是否会在不同请求里变成不同字节？** 不会。没有运行时路径改动，也没有新增时间字段、无序集合或依赖前后文的遮盖。
3. **有无自动检查，反向用例真会失败吗？** 有：`package.json:44` 的 `check:egress-redaction` 已列入 `package.json:27` 的 `check:steps`，测试文件属于 `ci/policy.json:243` 的 tooling 项目。新增反向用例覆盖“新文件新增调用”“登记文件多调用”“登记项已删除”“未登记外部出口”（`test/tooling/egress-redaction-check.test.mjs:140-156、193-221`），去掉对应实现会失败。但没有覆盖“空白/可选链/别名绕过”和“`web-providers.ts` 不误命中”的反向用例；是否实际执行通过，未核实。
4. **每个新值的产生方与使用方能对齐吗？** 现有值能对齐：三个 pattern 名称与 `ALLOWED_EXTERNAL_EGRESS_FILES` 的键字符串完全一致（`:68-78`）；登记表中的函数名都在 `SENSITIVE_GATE_FUNCTIONS` 内，文件路径与相对路径格式一致，计数与实际调用一致；`decision`/`reason` 没有消费者，属于未校验的“死字段”（见问题 2）。脚本消费者假定每个登记项都有 `calls`，当前静态表满足，但若以后漏写会在 `sameCounts` 里抛异常。

## 侧重检查

- **错误路径**：见问题 4，两套扫描的异常处理不一致；不可读文件会导致整条命令异常退出而非清晰报错。
- **不合规范/不可信输入**：脚本的输入是仓库源码，不是外部请求；但正则式检查可被代码书写形式绕过（问题 1）。
- **安全**：主要风险是“整段拦下”门槛可被空格、可选链、别名绕过，使新增的整段拦截调用悄悄进入代码库（问题 1）。
- **资源耗尽**：`findEgressViolations` 与 `findSensitiveGateViolations` 各自递归并读取全部 `packages`/`apps` 源码，等于扫两遍，仍是线性开销，当前规模可接受；符号链接环未核实。
- **不可撤销操作**：无，脚本只读。
- **规则/文档一致性**：ADR 0146/0148/0167 未同步新增的外部出口放行表和整段拦下登记表，属于文档滞后，不会造成检查失败；是否必须同步，未核实。
