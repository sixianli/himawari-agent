## 侧重检查

- **错误路径 / 不可信输入**：改动只增加一个渲染分支，没有新增解析、网络或存储路径。`phase` 的输入是后端 `observation.startDay` 与 `report.complete`，经 `phaseOf` 归一为四种值（`weekly-report.tsx:135-140`），`showTable` 只排除 `unset`/`waiting`（`weekly-report.tsx:607`）。未发现新增的越权、空值或注入面；`unset`/`waiting` 下反而不再访问 `report.implicit`（类型上 `implicit` 必填，见 `weekly-report.tsx:1064`）。
- **安全 / 资源耗尽 / 不可撤销操作**：均为条件渲染，无新请求、循环、权限判断或写操作，未发现相关问题。
- **规则文件、说明文档和代码一致性**：`.claude/rules/prompt-prefix.md` 不涉及本改动（周报组件只被 `memory-page.tsx:41` 引用，未进入发给模型的内容）。设计说明文档存在一处未同步，见发现 3。
- **未核实**：受工具限制没有实际运行测试或 `check:layout`；下文“失败/通过”的判断来自读代码推断。324/36 两个数字我按脚本的组合公式核对过，与代码一致。

## 发现（按严重度）

### 1. 低：`waiting` 状态没有对应的反向用例，作者“覆盖 waiting”的说法没有被测试证明

- 文件:行：`apps/control-center/test/weekly-report.unit.test.ts:649-673`、`src/components/weekly-report.tsx:138,607`、`test/e2e/fixtures/control-center-browser-server.mjs:1122-1139`
- 问题：新用例只构造 `unset`（`startDay: null`）。`waiting` 是 `startDay` 在未来时进入的状态，而页面允许最远设到 30 天后（`LATEST_FUTURE_START_DAYS = 30`），所以它是可达状态；但单元测试和 `check:layout` 的 `weeklyUnset` 夹具都只覆盖 `startDay: null`，没有任何 `waiting` 用例。
- 证据（读代码证实）：
  - `weekly-report.tsx:138`：`if (jstToday(now) < startDay) return "waiting";`
  - `weekly-report.tsx:607`：`const showTable = phase !== "unset" && phase !== "waiting";`
  - `weekly-report.tsx:43`：`const LATEST_FUTURE_START_DAYS = 30;`
  - 测试 `weekly-report.unit.test.ts:650`：`const unset = unsetFixture();`，且 `:170` 为 `startDay: null`
  - 浏览器夹具 `control-center-browser-server.mjs:1129`：`startDay: null,`
- 建议：增加一个 `waiting` 夹具（例如 `NOW = 2026-11-04T03:00Z` 下设 `startDay: "2026-11-05"`、`earliestStartDay: "2026-11-05"`），断言观察信号卡片只显示“还没开始观察”、不出现 `%`。当前代码路径正确，但这一缺口让“waiting 也已验证”的说法不成立，未来改 `showTable` 时也没有测试拦着。

### 2. 低：新测试只断言“没有数字”，没有锁定应显示的说明文字

- 文件:行：`apps/control-center/test/weekly-report.unit.test.ts:669-672`
- 问题：断言全部是“不包含 `%` / 不包含‘另有’ / 没有 tiles”。如果以后有人把整张卡片隐藏、渲染成空字符串或换成别的错误文案，测试仍然通过，无法防止“过度隐藏”。
- 证据（读代码证实）：
  ```ts
  const card = text('#page [aria-label="观察信号 · 不是打分"]');
  expect(card).not.toMatch(/%/u);
  expect(card).not.toContain("另有");
  expect(document.querySelector("#page .weekly-tiles[data-count='3']")).toBeNull();
  ```
- 建议：补一条 `expect(card).toContain("还没开始观察");`，同时保留现有的“不出现数字”断言。

### 3. 低：被检查拦下的 UI 问题没有按规则补进“不良设计”

- 文件:行：`docs/ui-ux-design-guide.md:16,168`、`.agents/instructions/web-design-baselines.md:6`
- 问题：本问题正是“被 `check:layout` 拦下的问题”。项目说明要求每次修改网页的会话在交付时把新 UI/UX 问题补进“不良设计”，但本次只改了组件和测试，没有更新该表，也没有归纳出“观察未开始时所有卡片都不显示比例”的规则。
- 证据（读代码证实）：
  - `docs/ui-ux-design-guide.md:16`：“**不良设计**：做出来后被 Andy 指出、或被检查拦下的问题，写清原因和改法。”
  - `docs/ui-ux-design-guide.md:168`：“做出来后被 Andy 指出、或被检查拦下的问题。”
  - `.agents/instructions/web-design-baselines.md:6`：“交付时，把每个新的 UI 或 UX 问题加入其中的不良设计……能自动检查的规则还要配一项检查”
  - 我读到的不良设计表 `docs/ui-ux-design-guide.md:172-227` 中没有这次“未开始观察仍显示百分比”的条目。
- 建议：在“不良设计”表补一行（原因：信号卡片没复用观察是否开始的判断；改法：与决策类型表一致，未开始只显示“还没开始观察”；对应规则可新增“未开始观察时不显示比例”）。自动检查已经由 `check:layout` 的 `weeklyUnset` 场景承担，无需新增脚本。

### 4. 建议：未开始时类型卡片和信号卡片重复同一句状态，implicit 的说明也仍是“比例怎么算”

- 文件:行：`src/components/weekly-report.tsx:648-653,664-669,912-913,1064-1066`、`src/i18n/resources/zh-CN.ts:1182-1183`
- 问题：未开始时“决策类型”卡片和“观察信号”卡片会各显示一次“还没开始观察”，同一状态重复两次；同时 `type` 的说明框在未开始时切换成 `weekly.type.notStartedMore`，而 `implicit` 的说明框仍显示 `weekly.implicit.def`（讲分母和比例）。这不是功能错误，但“文案复用是否合适”上略显不一致。
- 证据（读代码证实）：
  - `weekly-report.tsx:912-913` 和 `:1064-1065` 两处都渲染 `message("weekly.type.notStarted")`；
  - `weekly-report.tsx:648-653`：`paragraphs: !showTable ? [message("weekly.type.notStartedMore")] : ...`、`list: showTable ? how : []`；
  - `weekly-report.tsx:664-669`：`implicit` 的说明始终是 `paragraphs: [message("weekly.implicit.def")]`；
  - `zh-CN.ts:1182-1183`：`weekly.implicit.def` 仍在解释“分母是这一周推送过提醒的决策……”。
- 建议：若不想新增文案键，至少可以接受当前实现；更一致的做法是未开始时让信号卡片显示与类型表相同的简短状态、并把说明框也换成一句“观察开始后再看这些信号”，避免同一状态重复两段不同的解释。此项不阻断合并。

## 作者说法核对

- **根因是信号卡片没有按 `showTable` 判断**：读 diff 属实，改动前该卡片只看 `pushedDecisions === 0`（`weekly-report.tsx:1066` 附近）。
- **只改一处条件和一条测试**：属实，diff 仅涉及 `weekly-report.tsx` 和 `weekly-report.unit.test.ts`。
- **不新增文案键**：属实，只复用 `weekly.type.notStarted`，该键存在于 `message-ids.ts:1059` 及中英日三份资源（`zh-CN.ts:1139`、`en.ts:1230`、`ja.ts:1219`）。
- **修前 36、修后 324**：按代码组合公式核对一致：`SCENES` 18 个 × 3 语言 × 3 视口（1280/654/390）× 2 主题 = 324；两个 `weeklyUnset*` 场景 × 18 = 36。`check-layout-audit.mjs:15-20,297-410`。
- **新用例在未修复时失败**：读代码推断成立。新夹具是 `unset`，但 `pushedDecisions: 12` 且 `ratesWithheld: false`，未修复时 `signalRow` 的 `rate` 会满足 `enough` 并渲染百分比，卡片文本必含 `%`；修复后走 `!showTable` 分支。未实际运行测试。
- **waiting 也被覆盖**：代码确实覆盖（同一 `showTable` 分支），但测试没有证明，见发现 1。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 不会。这是控制中心的纯前端渲染改动，`WeeklyReport` 只被 `memory-page.tsx` 使用，没有被任何提示词/工具/历史/遮盖装配代码引用。发给模型的内容没有变化，仍然只在末尾追加；每轮会变的值也没有被移到别处。依据 `.claude/rules/prompt-prefix.md:27-36`。
2. **会不会让同一段文字在不同请求里变成不同字节？** 不会（针对发给模型的内容）。没有新增序列化、排序、遮盖或带时间字段；`showTable` 依赖当前日期，只影响页面显示，不会影响任何模型请求字节。
3. **有没有对应的自动检查，反向用例是否真会失败？** 有：新增单元测试 + 既有 `check:layout` 的 `weeklyUnset`/`weeklyUnsetConfirm` 场景和自检（`check-layout-audit.mjs:271-295,385-401,477-484`）。新单元测试按渲染路径推断会在未修复代码上失败。缺口是 `waiting` 没有反向用例；新测试也没有正向断言“应显示还没开始观察”（发现 1、2）。
4. **每个产生/修改的值，所有使用处都能接受吗？** 改动没有产生新标识、字段、配置键、清单项或序列化格式。唯一复用的值是消息键 `weekly.type.notStarted`：它已在 `message-ids.ts:1059` 登记，中英日三份资源都有（`zh-CN.ts:1139`、`en.ts:1230`、`ja.ts:1219`），`message()` 的类型约束和 i18n 消费者都能接受。布尔值 `showTable` 的三个使用处——类型表（`weekly-report.tsx:912`）、Muse 配对率（`:1043`）、观察信号卡片（`:1064`）——语义一致，均能接受。

**结论**：未发现会误隐藏已开始状态或导致模型前缀变化的功能性问题；主要问题是 `waiting` 未被测试证明、测试正向断言不足，以及“不良设计”文档没有同步。
