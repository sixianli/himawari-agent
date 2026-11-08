## 结论

没有发现高、中严重度的代码缺陷。核心修复（`!showTable` 分支）符合目标：观察未开始时，观察信号卡片不再渲染数字；观察开始后的“本周尚未结束 / 样本不足”路径保持不变。本轮增量（R2-3 正则、文档措辞）也核对为正确。

以下按严重度列出问题，均为低严重度或提醒性质。

## 发现

### 低

**1. 正则只覆盖两种固定的账本写入写法，新增写入点不会被计数**

- 文件:行：`test/tooling/opencode-review.test.mjs:2329`
- 问题：R2-3 只匹配首参为 `ledgerFile` 或精确的 `join(options.out, "usage.jsonl")` 的调用。将来若新增账本写入，例如使用另一个变量或 `join(repo, ledgerPath, "usage.jsonl")`，`appends.length` 仍是 3，检查会静默漏掉这个新写入点。这是既有测试的覆盖限制，不是本次改动引入。
- 证据：正则本体
  ```js
  /appendFileSync\(\s*(?:ledgerFile|join\(options\.out, "usage\.jsonl"\)),([\s\S]*?)\)\s*;\s*\n/g
  ```
  实际写入点只有三处，例如 `scripts/model-review/opencode-review.mjs:3033`：
  ```js
  appendFileSync(join(options.out, "usage.jsonl"), ledgerLine(record));
  ```
- 建议：把匹配放宽到所有 `appendFileSync(`，再按目标路径含 `usage.jsonl` 或 `ledgerFile` 过滤；或为这个正则单独加一条“故意写成 JSON.stringify 的坏源码必须被抓到”的自检。

**2. `maskSecretLike(` 的断言匹配不到实际函数名 `maskSecretLikeDeep(`**

- 文件:行：`test/tooling/opencode-review.test.mjs:2336`
- 问题：`expect(body).not.toContain("maskSecretLike(")` 对 `maskSecretLikeDeep(` 不成立。实际 `ledgerLine` 用的是 `maskSecretLikeDeep`。不过因为同一循环还要求 `body` 含 `ledgerLine(`，直接改用 `maskSecretLikeDeep` 的回归通常仍会因缺少 `ledgerLine(` 而失败，实际风险低。
- 证据：
  ```js
  // test/tooling/opencode-review.test.mjs:2334-2336
  expect(body).toContain("ledgerLine(");
  expect(body).not.toContain("JSON.stringify");
  expect(body).not.toContain("maskSecretLike(");
  ```
  ```js
  // scripts/model-review/opencode-review.mjs:2446-2448
  export function ledgerLine(record) {
    return `${JSON.stringify(maskSecretLikeDeep(record))}\n`;
  }
  ```
- 建议：改成 `expect(body).not.toMatch(/maskSecretLike(?:Deep)?\(/u);`。

**3. 文案复用语义略有偏差（推测为产品取舍）**

- 文件:行：`apps/control-center/src/components/weekly-report.tsx:1064-1065`
- 问题：观察信号卡片的数据说明写的是“这一周推送过提醒的决策”（与观察期无关），而观察未开始时新增分支显示“还没开始观察”。隐藏数字符合本次目标，但文案会让人以为本周不存在这些信号，而不是“观察未开始所以不展示”。这属于设计取舍，需产品确认；代码本身没有错误。
- 证据：
  ```tsx
  {!showTable ? (
    <p className="weekly-empty">{message("weekly.type.notStarted")}</p>
  ) : report.implicit.pushedDecisions === 0 ? (
  ```
  ```ts
  // apps/control-center/src/i18n/resources/zh-CN.ts:1182-1183
  "weekly.implicit.def":
    "这三个信号是不需要你动手评价就能看到的事……分母是这一周推送过提醒的决策；同一条决策出现多次同类信号只算一次。",
  ```
- 建议：若沿用现有文案，可在 `weekly.implicit.def` 或卡片空状态里补一句“观察开始后再显示”；不改也可接受。

## 读代码证实的

- `showTable = phase !== "unset" && phase !== "waiting"`（`weekly-report.tsx:607`），而 `phaseOf` 只有 `startDay` 为空才是 `unset`、`jstToday(now) < startDay` 才是 `waiting`（`weekly-report.tsx:135-140`）。因此 `showTable` 为假与“观察未开始”等价，`observing` / `reported` 不会被误隐藏。
- 类型卡片原本就用同一个 `showTable`（`weekly-report.tsx:912-913`），本次只是让观察信号卡片与之一致。
- 观察开始后的路径未变：`withheld` 时仍显示 `weekly.implicit.notFull`，样本不足仍显示 `weekly.few`（`weekly-report.tsx:1080-1098`），因为那些渲染都在 `!showTable` 为假的分支里。
- `weekly.type.notStarted` 已存在于 `message-ids.ts:1059`、`zh-CN.ts:1139`、`en.ts:1230`、`ja.ts:1219`，未新增文案键，三语齐全。
- 新增的两个反向用例在旧代码下会失败：旧分支只看 `pushedDecisions`，两个夹具都设了 `pushedDecisions: 12` 且 `rate(6,12)` 为 `enough`，会渲染 `%`，因此 `expect(card).not.toMatch(/%/u)` 会失败。这是按代码推演，没有实际执行测试。
- R2-3 正则改动仍能抓到 `JSON.stringify`：对 `appendFileSync(..., ledgerLine(record));` 捕获到的 `body` 是 ` ledgerLine(record)`；若改成 `JSON.stringify(...)`，该文本会落在捕获体里并触发 `not.toContain("JSON.stringify")`。源码中目标写入点正好 3 处（`opencode-review.mjs:1342、1369、3033`），匹配数量仍为 3。
- `scripts/model-review/opencode-review.mjs` 的 diff 只有两处重排：`Object.fromEntries` 换行、`appendFileSync` 合并为一行并去掉调用末尾的冗余逗号；参数和语义完全一致，没有逻辑变化。`test/tooling/opencode-review.test.mjs` 在 dad7a02 之前的改动是纯格式化，正则变化只出现在 f644c4c。

## 推测 / 未核实

- 作者说“修后 324 个场景通过”：无法在本次复核中运行需要浏览器的 `check:layout`，未核实。按脚本计算是 `18 个场景 × 3 语言 × 3 视口 × 2 主题 = 324`；两个 unset 场景 × 18 = 36，与“修前 36 个问题”吻合（`scripts/check-layout-audit.mjs:14-20, 610-617, 702-704`）。
- 作者说“36 个组合”：与 `weeklyUnset`、`weeklyUnsetConfirm` 两个场景 × 18 种组合的算术一致。
- R2-3 正则对模板字符串内部出现 `);\n` 时会过早结束捕获，但当前三个写入点都没有这种内容，只是理论风险。

## 侧重检查

- 错误路径：`phaseOf` 对 `startDay` 为空已有处理；新分支只渲染静态文案，不新增异常路径。
- 不合规范 / 不可信输入：`report.implicit.signals` 来自后端，React 默认转义；本次只是不渲染，没有引入新的解析或拼接。
- 安全：没有新增秘密、网络请求、认证或权限逻辑；`opencode-review.mjs` 只做空白格式化，`ledgerLine` 未动。
- 资源耗尽：新的 `check:layout` 改动不增加场景数；渲染分支还减少了 DOM（不渲染三块 tiles）。测试正则是在约 3000 行源码上做一次匹配，复杂度与原来同量级。
- 不可撤销操作：本次改动不涉及写入、删除、启动观察等操作，确认弹窗逻辑未动。
- 文档与代码一致：`docs/ui-ux-design-guide.md:228` 改为“决策类型和观察信号这两张卡片统一按观察是否开始决定显示数字还是‘还没开始观察’”，与代码（两处 `!showTable`）一致；表格列数仍为 5 列，`对应规则` 列用 `2` 与相邻行使用裸数字的写法一致。
- 作者关于“只格式化的两个文件”的说法：`opencode-review.mjs` 确认只有重排；测试文件在 dad7a02 的相对基线里的改动也是纯格式化，R2-3 正则变化属于后续 f644c4c，符合作者分轮说明。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。改动只涉及周报 UI 渲染、文档、以及复核脚本的空白格式化和测试正则；没有触碰系统提示、工具定义、历史消息或遮盖逻辑。发给模型的内容仍然只在末尾追加，会变的值仍只放在最后一条消息里（`prompt-prefix.md` 第 2、4 条）。
2. **同一段文字会不会在不同请求里变成不同字节？** 不会。没有新增时间字段、顺序依赖或遮盖逻辑；`ledgerLine` 的序列化未改，新增的 `weekly.type.notStarted` 是静态文案。脚本 diff 只有空白变化。
3. **有没有对应的自动检查，反向用例会不会真的失败？** 有。新增两个 `[P0-11] [negative]` 单元测试，按旧代码推演都会因出现 `%` 而失败；`check:layout` 的 `weeklyUnset` / `weeklyUnsetConfirm` 场景会直接报 `WEEKLY_UNSET_RATIO`（修前 36 个）。R2-3 是读取真实源码的静态检查，三个写入点若改回 `JSON.stringify` 会失败。不足是：该正则没有针对“坏源码”的自检，且只覆盖两种固定写入表达式（见发现 1）。
4. **改动产生或修改的每个值，使用它的地方都能接受吗？** 能。没有新增标识、字段、配置键或协议格式；唯一被新使用的值是既有文案键 `weekly.type.notStarted`，它在 `message-ids.ts` 和三套语言资源里都存在。测试正则只在 R2-3 内部使用，数量仍为 3。后端和前端其他地方不消费这个正则。
