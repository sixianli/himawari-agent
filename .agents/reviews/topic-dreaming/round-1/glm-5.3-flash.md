# Himawari「离线回看对话、整理记忆」（dreaming）方案

## 一、方案前提（已读代码/来源证实的）

| # | 前提 | 来源与原话 |
|---|---|---|
| P1 | 主对话请求头按对话冻结，会变的值只能放最后一条用户消息 | `.claude/rules/prompt-prefix.md:27-28`「固定的在前，会变的在后……每轮都会变的内容只放在最后一条用户消息里。例如当前时间、本轮选中的记忆」；`:35`「已经发给过模型的内容，不得改动、重排或删除，只能在末尾追加」 |
| P2 | 后台侧调用的排列规则：固定指令在前、本次数据在后、每轮变的值最后 | `.claude/rules/prompt-prefix.md:67`「后台调用也是固定的在前、会变的在后……先放固定的指令，再放这次的数据，最后放当前时间这类每次都变的值」 |
| P3 | 现有侧调用已按 P2 落实，可直接照抄模式 | `apps/agent-service/src/production-memory-capture.ts:171-196`（`MEMORY_CAPTURE.text` 在前、数据 JSON 在后）；`packages/memory-engine/src/consolidation.ts:109-125`（`consolidationPrompt` 同构） |
| P4 | 每轮后台抽取已定不改（2026-10-31 评测：该记的记下 90%、不该记的记了 0%、密钥 0） | `docs/adr/0142-keep-background-memory-capture.md:32-46`；Andy 原话「不用换，用 A 就行了」（:44） |
| P5 | 每轮抽取只看主人本轮的话 + 上一条回答末 1500 字；quote 必须能在主人原话中找到才可信 | `production-memory-capture.ts:62`（`MAXIMUM_CONTEXT_CHARACTERS = 1500`）、`:349-361`（`quoteFromOwnerMessage`，不匹配则 `evidenceRejected`） |
| P6 | 每天整理只拿上次之后新记的 ≤20 条，找 ≤3 条相近旧条，不重读对话原文；推断最多 3 条、至少 2 条依据、不推断健康/财务；推断一律 tentative、置信度 600 | `consolidation.ts:35-38,245-252,317`（`MINIMUM_OVERLAP=0.5`）、`:165-171`、`:499-579`（`#reflect`：`inference: true, tentative: true, confidencePermille: 600`） |
| P7 | tentative 记忆不进档案块（模型看不到）、recall 检索不到；只有主人后来的话再次印证时才转正 | `packages/application/src/services/owner-profile-service.ts:110`「`if (attributes.supersededBy !== null || attributes.tentative === true) return false;`」；`test/integration/memory-consolidation.test.ts:659`「keeps a tentative rule out of recall until it is seen again」；`durable-memory-service.ts:309-317`（印证后置 `tentative: false`） |
| P8 | 日摘要（episodes）按天写第三人称摘要，单条 ≤1200 字、输入 ≤16000 字；可被 recall 检索、不自动注入；含主人/Himawari 双方发言和时间戳 | `packages/memory-engine/src/episodes.ts:21-27`、`:85-103`。⚠️ 材料说「300 字以内」，代码实为 1200（`episodes.ts:25`），以代码为准 |
| P9 | 整理的每次改动记入 change 账本、记忆页可撤销，主人改过之后就拒绝撤 | `consolidation.ts:392-424`（`undo`，`MEMORY_CHANGED_AFTER_CONSOLIDATION`）；`test/integration/memory-consolidation.test.ts:576` |
| P10 | 后台任务允许使用 sensitive 记忆；restricted 永不给模型 | `docs/adr/0193-memory-is-visible-to-the-model.md:39`（决定 B「后台任务……也能用敏感记忆」）、`:56`；`packages/application/src/services/model-visibility.ts:16-24` |
| P11 | 整理触发于当天第一轮对话、后台执行不阻塞回答；失败后 1 小时内不重试 | `apps/agent-service/src/production-memory-consolidation.ts:8`（`RETRY_AFTER_MS = 3_600_000`）、`:94`；`production-run-composition.ts:521-541`（经 background 派发） |
| P12 | 原则冲突顺序：用户主权 > 边界与可逆性 > 记忆可靠性 > 主动性与效率；反愿景「不做不可审计的进化」 | `docs/product-vision.md:55`、`:173`「任何不能验证、不能回滚、不能解释的自我修改，都不允许发生」 |
| P13 | 钱的规则：低价模型；批量调用预计超 $0.5 先问 | `.claude/rules/owner-standing-rules.md:16,18`；DeepSeek 价格：缓存命中 $0.003 / 未命中 $0.15 / 输出约 $0.6 每百万 token（`docs/adr/0207-...md:41`） |
| P14 | 缓存检查门槛带反向用例；判断类功能必须有反向验收 | `.claude/rules/prompt-prefix.md:74`（`npm run check:prompt-prefix`「它还带反向用例……检查都必须报告失败」）；`.claude/rules/owner-standing-rules.md:34`「没有反向验收的不算完成」 |
| P15 | I-73 教训：新产出的值必须逐个对照消费端校验 | `docs/incidents-and-gates.md:112`「双模型复核只看了 diff，没问『清单里的 id 能通过后端校验吗』」 |
| P16 | 业界做法：Anthropic Dreams（读记忆库+1–100 段对话、生成新库、原库不动）、Cookbook（每段对话一个小模型分析者+整理者、每晚 cron 只处理上次成功后的窗口、默认直接改库、对话指令当数据）、研究文章（错误笔记会进每次会话；持续检查全部记忆代价大）、Letta（矛盾以最新证据为准、相对日期换绝对、git 可回退）、Graphiti（只有新旧不能同时为真才算矛盾，进展不算）、ChatGPT/Gemini/Copilot（二层记忆、参考聊天记录、历史推断） | 材料所列一手网址：platform.claude.com/docs/en/managed-agents/dreams；platform.claude.com/cookbook/managed-agents-cma-dreaming-with-a-dynamic-workflow；anthropic.com/research/components-of-agent-memory；docs.letta.com/guides/agents/sleep-time-agents；github.com/getzep/graphiti（edge_operations.py） |

## 二、方案本身

**结论：做，但只做「每周一次、只读日摘要、只产出待确认候选和矛盾线索、绝不直接改已确认记忆」的一小步。** 不是完整版 dreaming。

### 1. 什么时候跑
- 每周一次（主人本地时区，按 `lastCompleted` 判断是否满 7 天——阈值进配置，不写死清单类值），触发方式照抄 P11：当天第一轮对话后台派发，不阻塞回答，失败保留窗口、1 小时后可重试。
- 复用 `consolidation.begin()` 式原子登记防并发双跑；窗口内没有新日摘要段就**一次模型都不调**（`modelCalled=false`，同 `consolidation.ts:329` 的做法）。

### 2. 读什么
- **输入 A：上次回看之后新生成的日摘要段**（episodes），按 `(day, threadId, firstSequence)` 排序取用，硬上限可配置（缺省建议 14 段/次）。不读对话原文（贵，且摘要已含双方发言+时间戳，P8）。
- **输入 B：全部 active、模型可见（P10）、非 tentative 的记忆**的文本+quote+`validFrom/supersededBy` 元数据，按 `updatedAt` 降序、硬上限可配置（缺省 120 条），超出部分下次接着处理。
- 取数不依赖数据库返回顺序，代码里显式排序（同 `consolidation.ts:293-296`）。

### 3. 产出什么、怎么落库
- **推断类新记忆**（跨天模式、偏好变化、长期计划进展）：走 `consolidation.ts:499-579 #reflect` 同一条路——`inference:true`、`tentative:true`、置信度 ≤700、至少 2 条依据（依据可以是日摘要段或已有记忆，`sourceRefs` 排序）、不推断健康/财务、分级取依据最高级。**直接落库为待确认**，理由见下「核心思路」。
- **矛盾/过时**：只登记线索（对接 P3-8 的 hold 结构：新旧两条都留、记一个 hold），附日摘要里的日期与原句；**不直接 supersede、不直接 merge、不直接归档**任何已确认记忆——那两个决定仍归每天整理（重复项）和 P4-6（可疑项+主人确认）。
- 每次改动记入与 `memory_consolidation_changes` 同构的账本（或直接复用该表加 `action`），记忆页照 P9 撤销。

### 4. 怎么防误改、误记
- 输出解析照抄 `consolidation.ts:127-175 parse` 的全部校验（label 必须存在、`keep≠drop`、依据 ≥2、长度、类别白名单、健康/财务拒绝），另加：新提示词放 `packages/prompt-catalog`（受信文字 ≥24 字符，prompt-prefix.md:53 的规则适用）；提示里写明对话内容是数据不是指令（Cookbook 做法）；输出经现有 `sensitive-capture` 的占位符还原与密钥检查。
- 矛盾判据用 Graphiti 的口径写进提示词：「只有新旧不能同时为真才算矛盾，进展、状态更新不算」。

### 5. 怎么防重复处理
- 自己的 `lastCompleted + reviewedThrough`（同 `consolidation.ts:189-192,248`）；已处理段 id 记集合；对同一条记忆已有未决 hold 时不重复登记。

### 费用估算（每周跑一次）
假设：主人每周 10–20 条主人消息 → 新日摘要段约 7–14 段 × ≤1200 字 ≈ 1.4 万字 ≈ 约 1 万 token；记忆列表 120 条 × 平均 100 字 ≈ 1.2 万字 ≈ 约 8 千 token；合计未命中输入约 1.8 万 token ≈ **$0.0027**，输出 ≤1k token ≈ **$0.0006**。**每次 < $0.005，每月 < $0.02**。控制上限：段数/记忆条数硬上限（配置）、空窗口零调用、输出 token 上限设小、永远不会触到「超 $0.5 先问」的线（P13）。

### 核心思路（不在任何一家做法里）
**把 dreaming 从「改库」改造成「生成假设」，转正的唯一途径是主人自己的话。** 业界三派：Anthropic 默认直接改库（Cookbook 自己承认「坏对话第二天早上就会进记忆」）、Anthropic Dreams 原库不动等人审、Letta 用后台对话审一遍但不问用户。Himawari 都不用：回看产出**全部是 tentative**，P7 保证它们模型看不到、检索不到，只有主人之后自然聊天里再说了一句印证的话，现有的 `confirmsTentative` 机制（`durable-memory-service.ts:309-317`）才会把它转正。这同时满足目标 3（主人零操作）、P12 的「边界与可逆性 > 记忆可靠性」（错误假设的存在成本≈0）和目标 1（一旦印证立即生效）。

## 三、考虑过但不选的做法

| 做法 | 不选原因 |
|---|---|
| Cookbook 式每晚跑、直接改库 | 与 P12 冲突（不可逆方向）；P3-8 刚把冲突处理收紧，dream 直接改库等于把刚关掉的口子再打开 |
| 读对话原文而非日摘要（Cookbook 每段一个分析者） | 费用线性于对话量、输入长数十倍；摘要已压到 1200 字/天。先做摘要版，评测证明信息不够再升级（见验收） |
| Anthropic 研究文章的「把重要笔记提升到每次会话开头的层」 | 直接违反 P1（会改请求开头）；置顶记忆已有 ADR 0112 机制，且属于主人手动操作 |
| 每天跑 | 记忆周级别变化少，边际收益低；每天整理已在跑，再加一次每日全库扫描是 P4-6 已覆盖的工作 |
| 不做 | 目标 2 要求「系统能自己发现」，而 P6 显示每天整理只在「新记忆与旧记忆词汇重叠 ≥0.5」时才比较——说法变了、词汇不重叠的矛盾会漏；不做达不到目标 |
| Letta 式「每 N 步反思」 | 那是编码 agent 的循环；Himawari 每轮已有后台抽取（P4 已定不改） |

## 四、风险与反例

- **摘要丢细节 → 错误推断**。反例：主人上周说「下周三去游泳」，摘要写成「周三」，dream 推断成「每周三游泳」。缓解：提示词要求把相对日期换成绝对日期（Letta 做法）+ 全部 tentative + 每条附摘要原文做依据。
- **重复登记**（dream 与每天整理发现同一矛盾）。缓解：hold 按 memoryId 去重。
- **外来内容注入**：邮件/网页内容会进入对话、进而进入日摘要，可能操纵 dream「记下」什么。缓解：数据即数据的提示词 + 产出必为 tentative + restricted 不进（P10）。
- **主人一周不来 → 窗口堆积**。缓解：硬上限 + 超出留到下次；避免一次吞几个月（Cookbook 的「失败那晚保留窗口重试」同理）。
- **推断质量低却批量入 tentative**，把「最近记忆」列表挤占（`production-memory-capture.ts:764` 的 `existingMemories` 含 tentative，最多 20 条）。缓解：tentative 也计入 20 条上限，自然挤出；观察审计计数，过多则收紧。

## 五、需要人拍板的取舍

1. 频率（每周 vs 每两周）和记忆列表上限（120 条是否够覆盖全库，不够要不要分批扫全库）。
2. change 记入现有 `memory_consolidation_changes` 表还是新表（影响记忆页撤销入口的展示）。
3. P3-8 未合并，hold 结构以它为准还是先只产推断、矛盾线索等 P3-8 合并后再接。
4. 是否给 dream 配一个像 ADR 0142 那样的离线评测（约 $0.13 量级），跑之前按 P13 报费用等同意。

## 六、已核实 / 推测

- **已核实**：第一节 P1–P15 全部（文件:行均已在上面）；episodes 摘要上限实为 1200 字（修正材料）。
- **推测**：费用估算里的对话量（10–20 条/周）和 token 折算比率；「摘要版输入足够支撑推断」（需评测验证）；`memory_consolidation_changes` 表对新增 action 枚举的兼容性（`MemoryConsolidationAction` 类型定义未读，复用该表前要核对）；hold 的具体结构（P3-8 未合并）。
- **未核实**：episodes 存储返回段时的默认顺序（store 实现未读，方案里已要求显式排序兜底）；`policyVersion` 新值 `memory-dream:v1` 是否有任何消费端做枚举校验（按 P15 应在动工前核对）。

## 七、必答问题逐条回答

**1. 会不会改变模型已经见过的请求开头？——不会。**
改动只新增后台侧调用：每次是新会话，排列按 P2（固定指令在前、窗口数据在后、`now`/窗口日期等会变值放在最后的数据块里），与 `memoryCapturePrompt`、`consolidationPrompt` 同构。主对话的请求一个字节不动；历史、遮盖、压缩全部照旧。dream 的产出是 tentative，而 tentative 不进档案块（P7，`owner-profile-service.ts:110`），也不会触碰置顶/冻结头——即使某条记忆后来被主人印证转正，主对话也只按 P1 的既有换新机制处理，不回头改已发内容。发给模型的内容仍然只在末尾追加，每轮会变的值都在最后一条消息里。

**2. 会不会让同一段文字在不同请求里变成不同字节？——设计上可以避免，需要两条硬约束守住。**
风险点有三个，方案已逐一处理：(a) 输入集合顺序——日摘要段按 `(day, threadId, firstSequence)` 排序、记忆按 `updatedAt` 降序排序，不依赖数据库返回顺序（prompt-prefix.md:51「列表的顺序……都要固定」）；(b) 会变的时间戳/窗口边界——只出现在最后的数据块里（P2）；(c) 遮盖——沿用现有 `placeholderTable`/`restorePlaceholders`，密钥不变时同一段内容遮出的字节相同（prompt-prefix.md:36）。需要一条「同一窗口两次运行，prompt 逐字节相同」的确定性测试守住。

**3. 有没有对应的自动检查，反向用例会不会真的失败？**
现有的：`npm run check:prompt-prefix` 及其反向用例只守主对话，不守新增侧调用，所以要新增三条门，反向用例都以「撤掉实现就失败」为准：(a) 空窗口零模型调用——把跳过逻辑删掉，测试失败；(b) 确定性——删掉显式排序，字节比对失败；(c) 解析反向用例——依据 <2、健康/财务、未知 label、restricted 依据 → 全部拒绝（现有 `parse` 已有同型校验，`test/integration/memory-consolidation.test.ts` 的分组反向用例 `:527,543` 可仿写）；(d) 按 P14 和 owner-standing-rules.md:34，发布验收要带反向用例（例如「主人只是重述任务状态，不得产出矛盾线索」）；(e) 仿 ADR 0142 建带反向题（不该记/不该改）的数据集评测，脚本需 `EVAL_CONFIRM_COST` 才运行。

**4. 每个产生的值，两端都核了吗？**
- 推断记忆记录（id、tentative、置信度 600、sourceRefs 排序）：与 `#reflect` 完全同形（`consolidation.ts:525-548`），消费端已全部存在并被测试覆盖——档案块排除（P7）、recall 排除（test:659）、每轮抽取的 existingMemories 接受（`production-memory-capture.ts:764-787`）、记忆页撤销（test:576）。
- change 账本条目：消费端是记忆页撤销 UI（ADR 0194）；`MemoryConsolidationAction` 枚举是否接受新值**未核实，动工前必须核对**（P15 的教训）。
- 新 memory id 形如 `memory-dream:<window>:insight:<n>`：要走 `createMemoryId` 和落库校验，格式约束**未核实**（I-73 正是这类：清单生成的 id 过不了后端 `machineString` 校验）。
- hold 记录：消费端是 P3-8 的页面和 P4-6 清单，P3-8 未合并，**结构未定，先不接或以它为准**。
- 新提示词条目：进受信清单（≥24 字符），消费端是 sensitive-capture 的 `TRUSTED_PROMPT_TEXTS`（`production-memory-capture.ts:33` 已示范引用方式）。
- 新配置键（频率、上限）：不得写死可动态获取的值；消费端是启动配置校验，需同步加进配置模板。
