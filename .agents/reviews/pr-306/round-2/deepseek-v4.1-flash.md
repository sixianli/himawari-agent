## 发现（按严重度从高到低）

### 1. 高｜格式化把单行 `appendFileSync` 改成单行后，会弄坏一个既有测试
**文件：行**：`scripts/model-review/opencode-review.mjs:3033`；`test/tooling/opencode-review.test.mjs:2329-2336`

**问题**：作者说这两个文件“只做格式化，不改逻辑”。运行逻辑确实没变，但这个测试把源码当文本用正则解析，源码格式就是它依赖的输入。格式化后，第 3033 行的调用变成单行，而测试正则仍要求 `);` 前面必须有换行，匹配范围会一直吞到第 3039 行的 `);`，于是第 3038 行的 `JSON.stringify` 落进 `body`，触发断言失败。

**证据**（亲自读到）：
- `scripts/model-review/opencode-review.mjs:3033`：
  ```js
  appendFileSync(join(options.out, "usage.jsonl"), ledgerLine(record));
  ```
- `scripts/model-review/opencode-review.mjs:3038`（位于匹配范围要吞到的区间内）：
  ```js
  (gatewayUsage ?? []).map((line) => `${JSON.stringify(line)}\n`).join(""),
  ```
- `test/tooling/opencode-review.test.mjs:2329`：
  ```js
  /appendFileSync\(\s*(?:ledgerFile|join\(options\.out, "usage\.jsonl"\)),([\s\S]*?)\n\s*\);/g,
  ```
- `test/tooling/opencode-review.test.mjs:2335`：
  ```js
  expect(body).not.toContain("JSON.stringify");
  ```
- 第 3033 行之后，第一个满足 `\n\s*\);` 的位置是第 3039 行的 `        );`，中间包含第 3038 行的 `JSON.stringify`。旧代码是多行调用，正则能在自身 `);` 处结束，所以旧测试本来能过。

**建议**：不要靠“把调用改回多行”来绕开，否则 `format:check` 会再次失败；应改测试，让正则接受单行调用（例如把末尾改成 `\n?\s*\);` 或改为更稳的解析方式），并实际运行 `test/tooling/opencode-review.test.mjs` 确认。

---

### 2. 低｜文档写“同一页的卡片统一”，但代码只统一了两张卡片
**文件：行**：`docs/ui-ux-design-guide.md:228`；相关代码 `apps/control-center/src/components/weekly-report.tsx:997-1038`、`:1064-1065`

**问题**：不良设计表里的改法写“同一页的卡片统一按观察是否开始决定显示数字还是‘还没开始观察’”。实际上只有“决策类型”和“观察信号”两张卡片受 `showTable` 控制；统计卡片仍显示四个数字，Muse 卡片在有条目时仍显示桶计数。文档说法比代码覆盖面大。

**证据**（亲自读到）：
- 统计卡片只判断 `metrics` 是否存在：`weekly-report.tsx:997` `{metrics ? (`
- Muse 桶计数只判断 `muse.entries === 0`：`weekly-report.tsx:1025-1038`
- 只有类型卡片和信号卡片用 `!showTable`：`weekly-report.tsx:912`、`:1064`

**建议**：把文档改成“决策类型和观察信号这两张卡片”，或明确“与观察相关的卡片”，避免以后有人误以为统计/Muse 卡片也应隐藏。

---

### 3. 低｜复用文案会让同页出现两遍“还没开始观察”，与设计指南第 43/48 条有张力
**文件：行**：`apps/control-center/src/components/weekly-report.tsx:912-913`、`:1064-1065`

**问题**：`weekly.type.notStarted` 现在在两个相邻卡片里各渲染一次。复用键本身在三种语言中都存在，语义也正确；但指南第 43 条要求“一句文案只出现一次”，第 48 条要求“页面只放标题、数字和简短状态”，同页重复同一句空状态需要产品确认。

**证据**（亲自读到）：
- 类型卡片：`<p className="weekly-empty">{message("weekly.type.notStarted")}</p>`
- 信号卡片：`<p className="weekly-empty">{message("weekly.type.notStarted")}</p>`
- 三种语言都有该键：`zh-CN.ts:1139`、`en.ts:1230`、`ja.ts:1219`

**建议**：如果按“不新增文案键”的约束不改文案，至少考虑在 `!showTable` 时把信号卡片整段留空/只保留标题，或请 Andy 确认重复一句空状态可接受。

---

### 4. 低｜作者说法与实际 diff 有出入
**文件：行**：整个 `dad7a02` 的 diff

**问题**：
- “只改……一处条件和一条测试”：实际新增了两个 `it`（`weekly-report.unit.test.ts:649`、`:676`），另加一行文档和两个格式化文件。
- “只做格式化，不改逻辑”：对 `maskSecretLikeDeep` 和 `appendFileSync` 的运行逻辑确实成立，但它引发了上面第 1 条的测试失败，不能算完全无影响。

**建议**：提交说明/PR 描述按最终 diff 更新，明确列出第二个反向用例、文档行和格式化文件及其对源码解析测试的影响。

---

## 侧重检查

- **错误路径/不可信输入**：`phaseOf` 对 `startDay` 为空返回 `unset`，未来日期返回 `waiting`（`weekly-report.tsx:135-140`）；`startDay` 只参与字符串比较，格式异常不会抛错。新增分支只是提前返回空状态，不增加解析或异常路径。
- **安全**：本次 UI 改动不接触秘密、日志、URL 或鉴权；`maskSecretLikeDeep` 的格式变化只是换行，映射逻辑不变（`opencode-review.mjs:2437-2441`）。没有新增攻击面。
- **资源耗尽**：`!showTable` 时不再渲染 signals 列表，属于减少 DOM 和计算，不会引入新的资源消耗。
- **不可撤销操作**：本次改动没有写文件、发布、删除或状态变更动作；格式化脚本只影响源码文本。
- **规则/文档/代码一致性**：`prompt-prefix.md` 与模型请求无关；`check-layout-audit.mjs:283-288` 的 `WEEKLY_UNSET_RATIO` 仍能覆盖“unset 下出现百分号”；自测中有 `WEEKLY_UNSET_BROKEN`/`WEEKLY_UNSET_CLEAN` 反向用例（`:531-538`）。文档覆盖面问题见第 2 条。
- **自动检查**：UI 反向用例逻辑上确实会在未修复时失败；但整个提交的测试集并不全绿，见第 1 条。

---

## 读代码证实的 / 推测或未核实的

**读代码证实：**
- 修复前信号卡片只看 `report.implicit.pushedDecisions === 0`，确实没有看 `showTable`；修复后加了 `!showTable` 分支。
- 两个新增反向用例在未修复代码下都会看到百分号并失败：用例给了 `pushedDecisions: 12`，`signalRow` 在 `pushed >= 5` 时会生成 `rate.enough = true`，会渲染 `weekly.ratio`。
- `showTable = phase !== "unset" && phase !== "waiting"`，因此 `observing`/`reported` 仍显示数字，`unset`/`waiting` 隐藏。
- `weekly.type.notStarted` 在 `message-ids.ts` 和三种语言资源中都存在。
- 第 1 条的正则匹配问题可由源码和正则语义静态确定；未实际运行测试。

**推测或未核实：**
- “修前 `check:layout` 36 个问题、修后 324 个场景通过”：未运行浏览器审计，未核实。
- 生产环境中 `unset`/`waiting` 是否真的会带正的 `implicit` 数据：代码和 fixture 支持这种组合，但未核对真实数据。
- `docs/ui-ux-design-guide.md:228` 把对应规则写成第 2 条是否最贴切：第 2 条确实存在（“数字和判断词必须有定义”），但更接近第 1 条或第 48 条；属主观判断，未作为独立缺陷。

---

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。改动是 control-center 的 UI 条件渲染，位于 `weekly-report.tsx`，不参与组装系统提示、工具定义或历史消息。两个格式化文件里，`opencode-review.mjs` 的改动不改变请求内容或遮盖字节，只是换行。因此仍然“只在末尾追加”，每轮变化的值仍只在最后一条用户消息里，符合 `prompt-prefix.md` 第 1、2、4 条。

2. **会不会让同一段文字在不同请求里变成不同字节？**
   不会。UI 的 `Date.now()` 只影响页面显示，不进入模型请求；`showTable` 是纯布尔判断。格式化不改变序列化输出，`maskSecretLikeDeep` 的映射逻辑也未变。

3. **有没有对应的自动检查，反向用例是否真的会失败？**
   有。新增的 `[P0-11] [negative]` 单元测试覆盖 unset 和 waiting；按代码推演，去掉修复后两者都会因为渲染百分比而失败。`check-layout` 也已有 `WEEKLY_UNSET_RATIO` 和自测反向样例。但本次“只格式化”的提交反而弄坏了 `[round-2 R2-3]` 源码正则测试，见第 1 条；该测试在我读到的代码中未被 skip。

4. **每个新值/修改值的使用方都能接受吗？**
   - `showTable`：产生于 `weekly-report.tsx:607`，使用于 `:648`、`:653`、`:912`、`:1043`、`:1064`。这些使用方都把它当“观察已开始”理解，语义一致；只是名字“showTable”现在也控制非表格卡片，建议以后重命名为 `observationStarted`。
   - `weekly.type.notStarted`：定义于 `message-ids.ts:1059`，三种语言都有翻译；新用途只要求“未开始观察”的空状态，能通过类型和文案校验。
   - 文档中的规则编号 `2`：该规则确实存在；但改法表述覆盖面过宽，见第 2 条。
   - 格式化后的源码：运行逻辑的两端一致，但“源码文本”这一端被测试正则依赖，未通过，见第 1 条。
