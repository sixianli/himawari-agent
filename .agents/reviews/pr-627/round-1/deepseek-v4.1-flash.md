## 复核结论

这次改动只有 `apps/control-center/src/proactive.css` 的 5 行（`git diff` 已核对），落在已有的 `@media (max-width: 760px)` 里。就“把体检行的操作从 auto 栏挪到整行第三行”这个目标本身，读代码看是对的，没有发现高、中严重度的功能错误。以下都是低严重度问题或覆盖缺口。

### 1 [低] 体检行“已处理”状态没有自动用例，结论只靠选择器推断
- 文件：`test/e2e/fixtures/control-center-browser-server.mjs:1422-1429`、`:1438-1440`；`apps/control-center/src/components/proactive-reminders.tsx:451-457`
- 问题：fixture 里所有 checkup 都是待处理（`action: null`），`check:layout` 只会渲染三个按钮的分支；“已处理”（完成标签 + 撤销按钮）在 390/654 宽度下是否正常，没有任何自动检查。作者说它“正常”只能由“同一个 `.proactive-checkup-actions` 选择器也命中 done 分支”推断出来。
- 证据：
  - fixture：`action: null`，`checkup(0, "conflict", true)`、`checkup(1, "unused", false)`。
  - done 分支：`<span className="proactive-checkup-actions">` 内为 `<span className="proactive-review-tag">{message(done)}</span>` 加 `dailyReview.checkup.undo` 按钮。
- 建议：在 fixture 增加一个 `action: "merge"` 的 checkup 行（或在 `check-layout-audit.mjs` 增加场景），用真浏览器确认第三行里的完成标签和撤销按钮不换行、不溢出。

### 2 [低] 设计指南没有记录本次 UI 问题，且自查规模说明已和脚本不一致
- 文件：`.agents/instructions/web-design-baselines.md:6`；`docs/ui-ux-design-guide.md:227-266`、`:278`；`scripts/check-layout-audit.mjs:15-21`、`:298-422`
- 问题：规则要求“每个新的 UI 或 UX 问题加入其中的不良设计”，但本 PR 只改 CSS，`ui-ux-design-guide.md` 的不良设计表里没有这次“标签被压成竖排”的记录。另有既存不一致（不是本 PR 引入）：指南写 `18 个画面`、`1280 和 390 两种宽度`，脚本现在是 19 个场景、1280/654/390 三种宽度。
- 证据：
  - `web-design-baselines.md:6`：“交付时，把每个新的 UI 或 UX 问题加入其中的不良设计……能自动检查的规则还要配一项检查”。
  - `ui-ux-design-guide.md:278`：“18 个画面……1280 和 390 两种宽度”。
  - 脚本：`const LOCALES`, `VIEWPORTS` 含 `{ width: 654, height: 844 }`；`SCENES` 共 19 项。
- 建议：按规则补一行“日期 / 问题 / 根因 / 改法 / 对应规则”，并把自动检查表的画面数和宽度改成与脚本一致。

### 3 [低] 普通复盘行仍把评分按钮放在 auto 栏，同类结构风险未覆盖（推测）
- 文件：`apps/control-center/src/proactive.css:545-556`；`apps/control-center/src/components/proactive-reminders.tsx:61`、`:391-400`；`apps/control-center/src/i18n/resources/en.ts:1075-1076`
- 问题：新选择器只匹配 `.proactive-checkup-actions`；普通复盘行的 `<span className="proactive-rate">` 仍自动落在第一行 auto 栏（`grid-template-columns: minmax(0,1fr) auto`）。在测试过的 390/654 下应还有空间，但结构上和原 bug 同源；更窄的屏幕或更长的界面文字下是否会再挤出竖排标签，本次没有用例。
- 证据：`TEXT_SQUEEZED` 只在 `rect.width < fontSize * 2.5` 且 `rect.height > lineHeight * 3.5` 时报告（`check-layout-audit.mjs:103-111`），中等程度挤压抓不到；`.proactive-rate` 没有被新规则命中。
- 建议：若目标是“手机端所有复盘行都稳”，可把 `.proactive-rate` 也放到整行第三行，或改用 `grid-template-areas`（tag / text / actions）统一布局；若只想修体检行，在 PR 说明里明确范围即可。此条为推测，未在真浏览器跑过。

## 侧重检查

- 错误路径：`CheckupRow` 在没有 `checkup` 时返回 `null`（`proactive-reminders.tsx:431`），不会产生空行套用新规则；真正的错误路径缺口是上面第 1 条的“已处理”分支无渲染用例。
- 不合规范/不可信输入：体检正文 `item.text`、`relatedText` 来自记忆数据，`.proactive-review-text` 及其子 `span` 有 `overflow: hidden; text-overflow: ellipsis`（`proactive.css:220-225`、`:255-258`），React 默认转义；本次只改网格位置，没有改变截断策略，未见新的注入或横向撑破风险（未在真浏览器实测）。
- 安全 / 资源耗尽：纯 CSS，没有网络、循环、秘密或权限变化，不引入新的消耗点。
- 不可撤销操作：删除、合并、撤销仍走原有 `onAct(...)`（`proactive-reminders.tsx:454-480`），本次只改位置，没有放宽确认或撤销逻辑；删除后仍有 `undo`。按钮变得更显眼是否增加误触，无法用代码判定（未核实）。
- 规则/文档一致性：发现第 2 条；另外确认 `check:layout` 确在检查链里（`package.json:27` 的 `check:steps` 含 `check:layout`，`package.json:78` 定义脚本，`scripts/run-all-checks.mjs:32` 读取 `check:steps`）。

## 读代码证实与推测的边界

- 读代码证实：唯一改动是 CSS；媒体查询边界 760；新增规则只命中 `.proactive-checkup-actions`；该类全仓库只在 `proactive-reminders.tsx:450` 一处产生，父级始终是 `.proactive-review-list li` 网格；普通行的按钮类名是 `proactive-rate`，不被新规则命中；`check:layout` 的 fixture 只有待处理 checkup；设计指南没有这次问题的记录；脚本场景数和宽度与指南不一致。
- 推测/未核实：旧 CSS 在 main 上实际报 4 条 `TEXT_SQUEEZED`、改后 342 场景全过（作者提交信息，我未运行浏览器，不能独立确认）；普通行在 390 以下的行为；已处理状态的真实排版。

## 必答问题

1. **不会改变模型已见过的请求开头。** 改动只有 `proactive.css`，没有碰系统提示、工具定义、历史消息或遮盖逻辑；发给模型的内容仍是“只追加”，每轮变化的值仍只在最后一条消息里（`prompt-prefix.md:27-28`、`:36`）。这次 CSS 不会进入任何模型请求。

2. **不会让同一段文字在不同请求里变成不同字节。** 不涉及遮盖、时间字段或无序集合；CSS 与请求字节无关。

3. **有自动检查，反向用例对待处理分支会失败，但“已处理”分支没有。** `npm run check:layout`（`package.json:27`、`:78`）用真实浏览器在 390 和 654（都 ≤760）打开提醒页，fixture 里有待处理的 conflict checkup（`control-center-browser-server.mjs:1438`），`TEXT_SQUEEZED` 检测器（`check-layout-audit.mjs:103-111`）会抓住旧的挤压；检测器本身也有自检反例（`REQUIRED_KINDS` 含 `TEXT_SQUEEZED`，`REPRODUCTION` 有被挤成竖排的段落）。作者提交信息说旧代码报 4 条、改后通过（390 的日语两场景两主题正好 4 条，数量自洽），但我没有运行、未独立核实。已处理状态没有对应用例（第 1 条）。

4. **本次改动产生/修改的值两端都能接受。** 新值只有 `.proactive-checkup-actions` 上的 `grid-column: 1 / -1`、`grid-row: 3`、`justify-content: flex-start`。产生处只有 `proactive-reminders.tsx:450` 的 span；使用处是 `proactive.css:207-215` 与 `:545-547` 的网格，父元素始终是 `display: grid` 的 `.proactive-review-list li`，且体检行必有第二行的 `.proactive-review-text`，所以第三行存在、横跨两列有效；该类在仓库里没有别的使用处，没有新增标识、字段、配置键、清单项或序列化格式，不需要额外的跨端校验。

## 对作者三个核对点的直接回答

- **普通复盘行是否不受影响：** 本次规则层面不受影响（`.proactive-rate` 不匹配 `.proactive-checkup-actions`，已读代码证实）；但它仍沿用同一 auto 栏结构，极端窄屏是残留风险（第 3 条，推测）。
- **体检行“已处理”状态是否正常：** 结构上同一个 `.proactive-checkup-actions` 会被放到第三行、横跨整行、靠左，里面的完成标签和撤销按钮可以换行，读代码看应正常；但没有自动渲染用例（第 1 条）。
- **宽屏布局是否不变：** 不变。新规则在 `@media (max-width: 760px)` 内，760px 以上不会命中。
