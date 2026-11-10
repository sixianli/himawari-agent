现状已基本读清（规则现状、推送门、工具风险门、I-73）。接下来查业界一手资料。
# 方案：硬规则的三层结构——「积木做执行、模型做翻译、做成代码要走 PR」

## 一、方案依赖的前提（已证实的）

**产品与仓库现状（读代码或文档证实）**

1. 愿景把规则定义为硬性设定，且给出裁决顺序「用户主权 > 边界与可逆性 > 记忆可靠性 > 主动性与效率」：
   `docs/product-vision.md:55`（“*原则冲突时，按序优先：用户主权 > 边界与可逆性 > 记忆可靠性 > 主动性与效率*”、`docs/product-vision.md:59`（“*规则不是记忆，是硬性设定：记忆只保存一条规则的出处和修改历史；规则本身写进程序、必定执行，每条都有回归测试守着*”）。护城河里“测得了——每条规则有回归测试”在 `docs/product-vision.md:107`。
2. Andy 本人对愿景的落地解释已经偏向 B 的骨架：`docs/adr/0163-owner-preferences-as-data-run-by-tested-rule-types.md:39`（“**回归测试按规则类型写，不按每条偏好写。**……我的每条具体偏好只是数据，由已经测试过的程序执行”）、第 43 行“改主意时只改这行数据，不改代码”、第 45 行“只有出现全新的规则类型，才要加代码和测试”、第 49 行“**一句话要经过确认卡，Andy 确认后才变成长期规则**”。机制部分明确“具体机制现在不做”（`docs/adr/0163...md:57`）。
3. 生产里今天唯一确定性的规则是 Gmail 一刀的 floor：`proactive_settings.quiet_hours / important_senders`（`packages/persistence-sqlite/src/sqlite-proactive-operations.ts:218-277`）、`floorHitIds(item, settings.importantSenders)`（`packages/application/src/services/proactive-mail-check-service.ts:808-810`），推送入队由 `final.result === "act"`、`dueSoon`、floor 共同决定（同文件 875-894 行）。模型的判定结果会被 floor 拉回来（`applyFloor(judgement.result, ...)`，839 行），即**确定性规则约束模型判定，而不是反过来**。
4. 工具调用前也有同样的结构：意图风险 = 基线与确定性事实中最高者，模型给的风险只能升不能降。`packages/application/src/services/action-policy-service.ts:63-67`（`highestRisk([...baseline, intent.modelClassification.suggestedRisk, ...facts])`）、172 行（"*Model-provided risk cannot lower the deterministic risk floor*"）。
5. 本仓库的整改守门机制存在且有先例：I-73（清单 id 过不了后端校验，双模型复核只看 diff 没问“id 能通过后端校验吗”）落在门槛 `npm run check:model-ref-contract` 上（`docs/incidents-and-gates.md:112`，含反向用例与 `accept-model-switch` 浏览器验收场景）。
6. 发给模型只追加是硬规则，改动前先自查：`.claude/rules/prompt-prefix.md:35`（已发内容“不得改动、重排或删除，只能在末尾追加”）、84-88 行（“改动前先问自己：这个改动会不会让模型已经见过的请求开头变化？……排序是否固定？”）。软偏好的去处只有两条：最后一条消息或按对话冻结（`docs/adr/0163...md:48`）。
7. 仓库已有可用的沙箱体系（`packages/runtime-sandbox/`：bubblewrap 只读 tmpfs、网络出口代理、资源观察、截止结算等），即“模型写代码后先在沙箱里跑”这件事今天有基础设施。**未逐文件核实其启用条件**，下面对 A 路线的沙箱评估以此为推测级前提。

**业界一手来源**

8. Anthropic 官方承认“让 agent 写代码”是对的用法，但把安全列为前提条件：https://www.anthropic.com/research/code-execution-with-mcp （原文：“*Running agent-generated code requires a secure execution environment with appropriate sandboxing, resource limits, and monitoring. These infrastructure requirements add operational overhead and security considerations that direct tool calls avoid.*”）。同一文还展示了把跑通的代码沉淀成 skills 的模式——“*Agents can also persist their own code as reusable functions.*”
9. Anthropic 官方把“确定性规则”和“需要判断的规则”分成两套执行机制，判断类仍不是代码：https://code.claude.com/docs/en/hooks-guide/ （原文：“*gives you deterministic control: certain actions always happen rather than relying on the LLM to choose to run them*”“*For decisions that require judgment rather than deterministic rules, you can also use prompt-based hooks or agent-based hooks that use a Claude model to evaluate conditions.*”）。且 `PreToolUse` 钩子在工具执行前可拦截——“*Before a tool call executes. Can block it*”。
10. AWS Cedar 印证“策略即数据 + 刻意受限的语言 + 重证据”这条路：https://docs.cedarpolicy.com/other/security.html （原文：“*Cedar has no facilities for I/O, so Cedar policies are unable to perform activities like reading files or talking to the network.*” 以及 “*it is ultimately the user’s responsibility to write policies correctly*”——即便引擎经 Lean 形式化验证 + 差分测试，见 https://www.amazon.science/blog/how-we-built-cedar-with-automated-reasoning-and-differential-testing ，原文：“*Because Cedar policies are separate from application code, they can be independently authored, updated, analyzed, and audited.*”）。
11. 推论（来自 10，属合理归纳而非原话）：受限语言的价值不在“写得快”，而在“错得出来”；Cedar 团队把**引擎**的正确性用形式化方法背书，把**策略内容**的正确性交给 schema 校验 + 用户自查。业界没有任何一家把“模型现场生成的策略代码”直接作为生产拦截器。

## 二、方案本身（用普通人的话）

推荐 **B 的执行层 + A 的研发管线 + 确认卡试算**三层，不是二选一：

**第 1 层：执行层 = 通用积木（B）。程序跑，模型不碰。**
规则引擎接受一行结构化数据（建议 JSON，由 contracts 包定义 schema，参数照 `modelRefString` 的教训双包共享同一校验），积木三类：条件（字段/比较符/值，可 AND/OR）、窗口计数、结果动作（放行/不推送/延后/摘要/先问我）。每个**规则类型**由开发者写一次实现 + 回归测试（与 ADR 0163 的既定理解一致），引擎挂在两个确定点：推送入队前、工具调用前（等价于 Claude Code 的 `PreToolUse` 沟槽，来源 9）。
判定性质照抄现有代码的既有原则：**规则只能降低风险/减少打扰，不能放大**（呼应 `action-policy-service.ts:63-67` 的“模型不能拉低确定性地板”）——用户规则之间冲突时按更保守的走，冲突本身在保存时提示。

**第 2 层：生成层 = 模型当翻译员。**
用户说“金额小于 100 的金钱通知不推送”，模型把它翻成积木 JSON，**只翻译，不发码**；翻不出就退两条路：存软偏好记需求；或走第 3 层。这一层解决了 A 的真实诉求（灵活、不用开发者事事写代码），又不让模型生成的代码进入生产拦截路径。

**第 3 层：新规则类型 = 模型以“PR 制造者”身份生产代码，但不“像插件直接装”。**
积木确实表达不了时，模型在沙箱里起草新规则类型的实现 + 测试，走 PR 进开发者仓库：人审 + 类型回归测试 + （可选）双模型复核，**合并后被一切产品代码同等的 CI 守护**，随版本上线，可回滚（ADR 0163 的版本号要求顺势覆盖）。A 和 B 的真正差别就在这里：模型写得出来的都能产出，但“装进来”的 stdin 是人工审核门，不是运行时动态加载。

**给普通人看的确认：把“审代码”换成“答试算”。**
确认卡上不展示代码，展示三样：一句人话（“凡是金额 < ¥100 的非紧急金钱通知，不推送”）、≥2 个试算例（一正一反：“¥35 元的话会怎样？→ 不推送；老婆发来的 ¥35 请款会怎样？→ 提醒（被下一条规则覆盖）”）、生效时间。用户确认的是**结果**，不是代码——这是把 Cedar “*it is ultimately the user’s responsibility to write policies correctly*”落成普通人能承担的审查。试算在整个机制里是黄金用例：被用户答过的样例存进该条规则，改动规则时自动重算，就地对账。

**五个例子走一遍：**

| 用户规则 | 积木 | 是否现成 |
|---|---|---|
| 23:00–07:00 不推送 | 静默时段 | 已有（`quiet_hours`，同型） |
| 金额 < ¥100 的金钱通知不推送 | 条件(金额, <, 100) AND 条件(类别, 金钱) → 不推送 | 第一批积木 |
| 同一个人一天最多提醒 3 次 | 窗口计数(按发件人, 1 天, ≤3) → 第 4 次延后 | 第一批积木 |
| 发 X 每条先问我 | 动作前门槛(X, 发帖) → 先问我 | 已有 approval gate 原语 |
| 老婆发的邮件一律提醒 | 条件(发件人, ∈, 名单) → floor 提醒 | 已有（`important_senders`，同型） |

5 条全部是数据，零新代码——这正说明**第一批积木选型不是理论题，是照着真实用法抄清单**。真正逼出第 3 层的是第 2 条这种字段没进 schema 的情况。

**失败尊重：** Jam Test #11（决策可解释）要求任意一次沉默能回答“命中了哪条规则”，积木天然可答（规则 id + 出处 + 版本）；A 方案则每次沉默的解释是“我写的代码决定不推”，出处还是“模型一句话”级别。

## 三、考虑过但不选的做法

- **纯 A：模型写插件，测试由模型自己配，直接装**。三处真实问题：①**模型自测证明不了执行**——测试断言的期望值，来自模型对同一条自然语言的理解，代码和测试共用同一个世界观：模型理解错“同一个人”是指“同一邮箱”还是“同一联系人”，测试就会把错的期望值写圆满。仓库自己的 I-73 就是现成反例——生产事故不是出在生成物的语法错，而是出在**没人问过生成物能否通过另一端的校验**（`docs/incidents-and-gates.md:112`）。②拦截器是运行时任意代码，每次改规则都是一次准生产发布，和“每条规则有回归测试守着”的**产物可测性**目标冲突。③非技术用户被要求承担代码级审查——把 Cedar 承认的“用户责任”变成了没人能负的成本。
- **纯 B：只有积木，零模型**。覆盖不了长尾，而“吃长尾”正是产品愿景明文护城河（`docs/product-vision.md:113`）。且 ADR 0163 本身就是从“Andy 每说一句就改一次代码太重”这个真实痛点出发的。
- **给拦截器写一个通用脚本解释器装规则**。看起来兼得，实则积木本来就该是解释器的一部分——限制不设手把 Cedar 选“*no facilities for I/O*”的动机（受限语言才能被静态分析）丢了，变成“没人读过的沙箱代码在生产打仗”。

## 四、风险与反例

- **试算样例被模型拣便宜**（只出容易的）。反例规避：确认卡强制一正一反且至少一条“跨规则交互”样例（如“老婆 ¥35 请款”同时踩静默时段和发件人优先）。
- **用户在卡上随手全点同意**，试算变成走过场。规避：把单条规则的试算结果存档并在后续决策记录里引用（“本次因你 11 月 X 日确认为‘不推送’”），让人为验证有持久证据，而不是一次性点头的 UI 假象。
- **规则数据变更异字节风险**：给模型看的规则摘要如果进入请求开头，就是缓存坑。规则突变时老对话老规则照常（`docs/adr/0163...md:43` 的“旧值留在历史里”），规则清单不进系统提示。
- **计数规则时区/跨天**：`同一个人一天最多 3 次`要明确“哪一天、谁的时区口径”，这是 ADR 0163 未处理、第 1 批积木测试里必须包含的黄金用例。

## 五、需要人拍板的取舍

1. **要不要把模型自造新规则类型改成 PR 流程，而不是“沙箱里跑通的代码装产品”**。这是 A 与推荐方案的核心分歧，影响长尾需求的产出速率（PR 中间有等待期）。
2. **第 1 批积木选那 5 条还是 Less**、**试算样例最少条数**（建议 3 条）、**PR 审核责任人**（要不为 Andy 每一条，要不给大家一个“规则类型贡献规范”）。
3. **软偏好去处**按 ADR 0163 已定但未实现（`docs/adr/0163...md:48`），等提示词第二步“按对话冻结”完成再选。

---

## 必答问题逐条回答

**1. 会不会改变模型已经见过的请求开头？**
不会，前提是按 ADR 0163 第 3 条的原话执行：“*放进发给模型的内容时，遵守 [.claude/rules/prompt-prefix.md](../../.claude/rules/prompt-prefix.md) 的缓存规则：不放进系统提示和工具定义里会变的位置，只有两个去处可选：最后一条消息，或者跟着提示词第二步的‘按对话冻结’走。*”（`docs/adr/0163...md:48`）。本方案不加工具、不改系统提示，新增内容全部落在最后一条用户消息或按对话冻结；已发的内容保持只追加（`.claude/rules/prompt-prefix.md:35`）。**进一步**：新规则和规则修改完全不需要发给模型——引擎直接在 `sqlite-proactive-operations` 的既有内存里生效，模型只在真的需要决策可解释时才会读到规则 id（此时它是一个不变的字符串值，选择放最后）。推断部分：确认卡试算结果是否作为产物消息回收给模型使用，我倾向不发模型，避免每次确认后请求一次性变化导致老对话缓存失效——**未核实**这条替换流程的实际成本，需按 I-66 后的方案走俩模型复核。

**2. 会不会让同一段文字在不同请求里变成不同的字节？**
不会。规则数据是被程序消费的结构化 JSON，如果不加显式字段就不进模型上下文；需要进的话，其序列化必须遵守 prompt-prefix 第 10 条（数组按 id 固定排序，不依赖对象遍历——`.claude/rules/prompt-prefix.md:51`）。计数型规则的时间窗口取值（“同一个人一天最多 3 次”）由引擎在权威时钟上判定，**判定值不进请求、只进决策记录**，直接规避掉带时间字段异字节的来源。遮盖（出口敏感词）不涉及规则内容；如果在遮盖输入流里加入规则文本，会违反第 11 条（遮盖结果“*不能取决于它后面的内容*”），方案中不引入这种输入路径。规则文件的**存储格式**（磁盘上的 JSON）与发给模型的字节是两条独立的序列化路径，各自按固定顺序写。

**3. 改动有没有对应的自动检查，反向用例是否真的会失败？**
有，且先例就贴在手边：I-73 落下的 `/apps/agent-service/test/model-ref-contract.unit.test.ts` 门槛 `npm run check:model-ref-contract` 明确验证“*清单生成出的每个引用都要过两个包的校验、两个包规则必须一致、不合格的 id 不得被提供*”，并且保留了反向用例（`docs/incidents-and-gates.md:112`）。对照地，本方案要求：规则 JSON 由 contracts 包提供 schema（两端共用同一类型定义，防 I-73 的“两端不一致”）、门槛 `npm run check:rules` 包含：清单里所有规则/schema 解析、类型校验、i确认卡试算可计算、每条规则类型回归测试全绿。**反向用例必须真的会失败**——具体做法是像 I-73 一样，修复前先写测试验证它/en示例红：注入一条不合 schema 的规则（例如 `amount < "100"` 字段类型错）和一条 schema 合法但作用域声明错的规则，验证门槛两者都报错。**未核实**：`npm run check` 是否已包含这样的规则检查位；按仓库规格（`docs/execution/specs/`），需要另写设计定门入位。

**4. 改动产生或修改的每个值，每一个使用它的地方都能接受吗？**
逐个过：
| 生产方 | 值 | 消费方 | 两端校验 |
|---|---|---|---|
| 确认卡（用户答试算） | 规则 id（新，形如 `owner_20261110_001`） | 决策记录/可解释 UI | contracts 包统一 `machineString`/新 `ruleRefString` 校验，清单生成与消费两侧同一包（审 I-73 的教训） |
| 模型翻译 | 规则 JSON（字段、比较符、值） | 规则引擎evaluate | schema 校验 + 单元级 dump + 无法表达时**拒绝保存**（fail 改为存软偏好，不许“翻译成功但跑不了”） |
| 规则引擎 | 判定结果（放行/不推送/延后/摘要/先问我） | 推送入队队列、工具调用前置岗 | 结果枚举由 contracts 包定义 singular source；沿用现有 `applyFloor`/`ACTION_KIND_RISK_BASELINE` 的“模型/外部不能拉低地板”语义 |
| 沙箱 PR 流(第 3 层) | 新规则类型实现+测试 | CI/回归测试门、版本回滚 | PR 必须通过 `npm run check` 全绿 + 人审，发布走既有上线脚本 |
| 决策记录 | 新增规则命中字段 | 校准指标（命中率/误扰率曲线指标） | 按 ADR 0163 此前既定、`decision-ledger`（`sqlite-decision-ledger-operations.ts:366`）的既有 verdict 枚举扩位 |
**未核实**部分：`decision-ledger` 是否需要 schema 迁移才能承载“按归因规则 id”这一列，需要实际迁移方案。 nik前に关闭 docking点：I-73 / I-72 / I-84 的开发背景显示仓库最近的事故都发生在“不是写新代码、就是改原子结构”的地方（见 `docs/backlog/BL-20261026-003-isolated-instance-per-person.md:36`），所以推荐方案刻意避免了每次新规则都要改 schema/运行时，只有**第 3 层 PR** 才动代码——这是刻意放慢的开始，不是缺陷。
