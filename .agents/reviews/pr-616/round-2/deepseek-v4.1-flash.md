## 上一轮意见核对

- **上一轮意见 2（“只有”与封闭清单）已改好。** `.claude/rules/owner-standing-rules.md:44` 已改成“这一条只放开合并这一步……本文件和其他规则里别的先问要求（例如大改动先出方案、删 Mac 上的文件）也照旧”，不再用“只有合并以外的事”这种封闭说法。
- **上一轮意见 1（遗漏“等 Andy 说合并”）只改好了两处，没有改全。** `deploy-speed.md:67` 和 inbox 设计规格 `:484` 已改；但 `.agents/plan-drafts/think-step-plan.md:31-32` 仍保留旧规则，见下面意见 1。

## 意见

### 1. 中（会出错）：`think-step-plan.md` 仍写着模型调用、改授权的 PR“合并前等 Andy”，与本次新规则直接冲突

- **文件:行**：`.agents/plan-drafts/think-step-plan.md:31-32`；对照 `.claude/rules/owner-standing-rules.md:44`。
- **问题**：上一轮意见 1 要求清掉“等 Andy 说合并”的现行方案文字，作者只改了 deploy-speed 和 inbox 设计规格，漏了这份仍在维护、且被已接受 ADR 引用的方案草案。按新规则，改模型调用、权限和授权的 PR 也是“复核无中高、过了合并条件就自己合”，这份方案却让线程继续等 Andy。
- **证据（我亲自读到的原文）**：
  - `.agents/plan-drafts/think-step-plan.md:31`：`2. 读完工具收窄和对话承载后，做“带工具的想一想运行”和第一次判断（Jev）、提示词登记、校验、写入提议箱（**模型调用，合并前等 Andy 说合并**）。`
  - 同文件 `:32`：`3. 选项 A'（授权规则：同意过的任务读到外部内容后写操作要主人批准），新 ADR，单独 PR（改授权，合并前等 Andy）。`
  - `.claude/rules/owner-standing-rules.md:44`：`……这包括改模型调用、提示词和工具、权限和授权、数据库表、设计文档和规则的 PR……`
  - `docs/adr/0278-tasks-the-owner-agreed-to-ask-before-writing-after-external-content.md:30` 仍把这份草案的“修订 v2”当方案来源；`git log` 显示它 2026-11-16 还在维护（提交 `920742675`），不是历史归档。
- **建议**：把 31、32 两行改成“复核无中、高‘会出错’意见并过合并条件，线程自己合并；上线生产、动生产数据、花钱仍先问 Andy”，或明确标注这两行已被 2026-11-24 规则取代。另可在链接检查之外加一个简单的文本检查，扫现行规则和方案里残留的“合并前等 Andy”，避免第三次漏改。
- **读代码证实的**：上述四处文字和 ADR 引用都是我直接读到的。**推测**：线程照这份草案实施第 2 步时会再次停下来等 Andy，导致本 PR 想消除的往返重新出现；不会造成数据或安全损害。

### 2. 低（可以更好）：`deploy-speed.md` 第 3 项已不是“要 Andy 拍板”，却仍列在“要 Andy 拍板的”标题下

- **文件:行**：`.agents/plans/deploy-speed.md:64-67`。
- **问题**：标题是 `## 要 Andy 拍板的`，第 3 项却改成“线程就自己合并”。文字本身已经把“不再等他说合并”说清楚，所以不会直接误导合并，但扫读清单的人容易误以为这一项仍要 Andy 定。
- **证据**：
  - `:64`：`## 要 Andy 拍板的`
  - `:67`：`3. 改的是上线脚本：复核没有中、高意见并过了合并条件，线程就自己合并（Andy 2026-11-24 起不再等他说“合并”）；用新脚本上线生产仍先问 Andy。`
- **建议**：把第 3 项移出“要 Andy 拍板的”清单，或把标题改成“要 Andy 知道的”，或把合并说明并入正文。
- **读代码证实的**：标题和条文原文如上。**推测**：不改也不会改变实际行为，只会增加阅读成本。

## 侧重检查

- **错误路径、不合规范或不可信输入**：本次增量是纯文档和复核记录，没有可执行输入路径、解析器或校验代码，未发现新增风险。复核记录文件受记录目录保护，未读到内容（未核实）。
- **安全与授权**：新规则确实把“合并”从“必须 Andy 点头”放开到线程自合，但同一句明确保留了“上线生产、动生产数据、花钱超过先问线仍要先问”，并写明“本文件和其他规则里别的先问要求（例如大改动先出方案、删 Mac 上的文件）也照旧”。我对照 `.agents/instructions/delivery-mode.md:27-30`、`owner-standing-rules.md:41-44`，没有发现把上线、生产数据、钱、删 Mac 文件误放开。
- **资源耗尽**：不涉及。
- **不可撤销操作**：删 Mac 文件的唯一例外仍在 `owner-standing-rules.md:42`；生产删除、上线仍由设计规格 `:72` 和交付模式 `:29-30` 要求 Andy 授权，未被这次文字放开。
- **规则/文档/代码一致**：
  - 发现 `think-step-plan.md:31-32` 一处残留，见意见 1；其余扫到的“等合并”字样都在 handoff、ADR 历史记录或已修正的 deploy-speed、inbox 设计规格里。
  - `.claude/rules/owner-global-instructions.md:61` 有“除非明确要求，不得……合并”；我判断它是通用默认，且该文件开头写明项目专用规则优先、`AGENTS.md:73` 又把 `owner-standing-rules.md` 定为所有会话必读项目规则，因此不构成新的冲突。这是解释，不是自动检查能强制的。
  - 新链接 `.claude/rules/owner-standing-rules.md#authorization-deploys-and-merges` 的锚点存在（`:38`）；`delivery-mode.md#fast-mode` 锚点存在（`:11`）。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 本次没有改任何产品提示词组装代码或 `packages/prompt-catalog`，只改代理规则、方案文字和复核记录。复核脚本只从 `model-review.md` 抽取 `<a id="checklist">` 到下一节的内容（`scripts/model-review/opencode-review.mjs:288-299`），本次改的第 5 步在 `:73`，不在抽取范围。规则文件是静态文本，改动只会被新会话加载；没有新增每轮变化的值，也没有把变化值放进系统提示或工具定义。因此不涉及“只在末尾追加”的破坏。
2. **会不会让同一段文字在不同请求里变成不同字节？** 不会。改动是静态 UTF-8 中文文本，没有依赖前后文的遮盖、时间字段或无序集合，也没有序列化格式变化。
3. **有没有对应的自动检查，反向用例会失败吗？** 没有针对“合并是否等 Andy”这种规则语义的自动检查；这类规则本来也只能由线程执行，`model-review.md:76` 已写明脚本拦不住。新增的链接由 `check:instruction-links` 和 `check:docs-links` 覆盖，我读了脚本确认会解析 `docs/` 外的落点并检查锚点（`scripts/check-docs-links.mjs:132-155`、`scripts/check-instruction-links.mjs:49-60`），但没有运行，提交说明称已通过（未核实）。`think-step-plan` 的残留文字正好没有检查能拦住，反向用例也不适用（没有代码行为可测）。
4. **增量产生的值，使用端都能接受吗？** 没有新增或修改导出函数、配置键、字段、清单项或序列化格式。新增的是文档链接和复核记录：
   - 链接值三处我都核对了目标和锚点，存在且可解析。
   - 复核记录文件由 `--assert-reviewed`、`--finish-round` 等读取；文件内容因记录目录保护读不到，**未核实**格式，但它们是复核脚本生成的记录，本次没有手工修改其格式。
   - Andy 的原话来源在仓库外，**未核实**；仓库里只有新规则中的引用。

## 查过的范围

对比了 `d42a3a0a..d7be8890` 和本轮增量 `a9325525..d7be8890`。读了 `.claude/rules/owner-standing-rules.md`、`.agents/instructions/model-review.md`、`.agents/instructions/model-review-card.md`、`.agents/instructions/delivery-mode.md`、`.agents/instructions/prompt-prefix.md`、`AGENTS.md`、`.claude/rules/owner-global-instructions.md`、`.agents/plans/deploy-speed.md`、`.agents/plan-drafts/think-step-plan.md`、`docs/execution/specs/2026-11-24-main-thread-subthreads-inbox-design.md`、`docs/adr/0278...`，以及 `scripts/model-review/opencode-review.mjs`、`scripts/check-docs-links.mjs`、`scripts/check-instruction-links.mjs`。未重读与本次增量无关的旧代码；复核记录内容没有读到。
