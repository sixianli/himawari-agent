我先确认仓库结构和方案引用的关键文件，再逐条核对。
代码核对基本完成。现在核对方案引用的业界一手来源。
# 独立审核：存入记忆的内容必须能被模型看到（第 2.1 版方案）

## 侧重检查（我走过的最普通流程）

我按“Andy 在网页聊天里问一个和已批准的 sensitive 记忆相关的问题”从入口走到结束，标出每段是否在方案里、是否有测试覆盖：

1. **入口**：打字提交，消息按 private 加密（`apps/control-center/src/thread-control-center.tsx:1026`、附件/图片 `:1869-1870`，已核实）。`test/integration/production-http-composition-process.test.ts` 的 `[PR-A]`/`[PR-B]` 用真实服务抓请求体比对（`.claude/rules/prompt-prefix.md:75`）——**有端到端覆盖，但不含 sensitive 记忆场景**。
2. **上下文拼装**：档案块 + 自动带入记忆（`packages/application/src/services/context-formation-service.ts:231-292`）。现有分级过滤只到 private（`:279-286`、`owner-profile-service.ts:17,149-151`）——方案里是“档案”和“自动带入”两个通道。
3. **把拼好的内容读进运行**（方案没写、我新发现的瓶颈，见问题 1）：`packages/application/src/services/context-projection-service.ts:528-546` 的 `readText` 硬门槛——任何 payload 高于**运行分级**就抛 `Payload exceeds the Run data classification`。**没有任何测试覆盖“sensitive 载体进入 private 运行”**，因为今天做不到。
4. **出口遮盖**：聊天和嵌入请求都过 `packages/application/src/services/model-egress.ts:263-267,492-503`——覆盖充分（`prompt-prefix.compat.test.ts`、`model-egress.unit.test.ts`）。
5. **recall 工具**：分级过滤 `apps/agent-service/src/production-memory-recall.ts:160-163`——我不确定现有测试是否断言了这套过滤的具体行为（标记**未核实**）。
6. **回答含占位符 → 显示还原**：`packages/sensitive-capture/src/restoration.ts:53` 只还原带编号的占位符；`[密钥]` 不能还原（`redaction.ts:70`）——机器密钥还原的缺口**无测试**，方案的图例修正只是文字问题。
7. **后台**：每日整理 `packages/memory-engine/src/consolidation.ts:35,244-255,426-438`、情景摘要 `packages/memory-engine/src/episodes.ts:19`、Gmail 检查 `apps/agent-service/src/production-proactive-memory.ts:51`、每日复盘 `packages/application/src/services/daily-review.ts:135-136`（最后这个**方案没列为我核实过，它确实也只放 public/private**，被 `apps/agent-service/src/service-main.ts:1593` 调用）。sensitive 参与整理的行为**无测试**（今天根本不发生）。

结论：方案列的通道大体对，但漏了一个**硬门槛**（readText）、一个**隐藏通道**（每日复盘），测试侧“现有反向断言要改”的清单没列。

---

## 问题清单（按严重度从高到低）

### 1.（高·证实）readText 硬门槛没进方案：运行分级保持 private 时，sensitive 内容一进上下文就整体报错

- **问题**：方案把“运行分级”和“记忆读取上限”当成两件事，只改记忆上限。但把 payload 读进运行投影的地方另有第三套独立过滤：`packages/application/src/services/context-projection-service.ts:528-537`——`CLASSIFICATION_RANK[payload.dataClassification] > CLASSIFICATION_RANK[input.dataClassification]` 时抛 `INVALID_OPERATION: Payload exceeds the Run data classification`。自动带入记忆、档案块、历史里的工具结果都经它读取（`:344-349,401-409`）。聊天运行分级是 private（方案明确不改），sensitive 记忆的 payload 分级是 sensitive ⇒ **第一轮带上 sensitive 记忆的运行直接失败，不是“模型看不到”，是整个 run 崩**。方案前提 5 的十个通道没包含这个；模型评审的“工具授权上限挡运行”的理由不适用于这里（这是投影层，不是授权层）。
- **证据**：`context-projection-service.ts:528-537`（上限断言）、`:538-546`（block 元数据分级必须和 payload 一致——所以档案块改成 sensitive 后还必须一起改 payload 分级）、`context-formation-service.ts:376-384`（整个上下文信封还按 `request.dataClassification` 加密盖章）、`context-formation-service.ts:628-634`（记忆块的分级取自记忆本身）。
- **建议**：把这条改动写进第一期清单，推荐两个可选做法里选一：(a) `readContextBlocks`/历史读取对“记忆类 block”的上限从 `input.dataClassification` 放宽为 `max(run分级, 记忆可读上限函数)`，其余（附件、io 结果）维持运行分级；(b) 给每次读取传入 block 的期望分级并只检查“分级一致”（`:538-546` 已经有这个检查）而不再检查 run 上限。不管选哪个，`context-formation-service.ts:376-384` 的信封盖章和 `run-coordinator` 的完成分级都要在方案里说清楚留不留 private。并补一个行为测试：private 运行注入 sensitive 记忆块不再报此错。

### 2.（高·证实的机制 + 推测的后果严重程度）派生内容分级跟来源走 + maxMemoryClassification 仍管历史和摘要——方案内部自相矛盾，且会导致违反“只追加”

- **问题**：方案第二节 4 要“摘要、整理结果、工具结果的分级取来源中最高的”，同时第二节 1 说“`maxMemoryClassification` 只继续管历史消息和摘要”。三处消费者会因此形成闭环矛盾：
  - 摘要：`context-formation-service.ts:176-185` 只允许分级 ≤ `maxMemoryClassification` 的情景摘要进上下文 ⇒ 含 sensitive 的整理摘要**在 private 聊天里永远不可见**，与题目目标（“存入记忆的内容必须能被模型看到”）相反；
  - 历史/工具结果：`runtime` 工具结果按 invocation 分级落盘（`apps/agent-service/src/production-runtime-tools.ts:1238,1575,1716,2302` 均为 `dataClassification: invocation.dataClassification`）。若按方案把 recall 结果标成 sensitive，下一轮 `context-formation-service.ts:194-198` 会把它从历史候选里**滤掉**——已经发给过模型的消息在后续请求里消失，直接违反 `.claude/rules/prompt-prefix.md` 第 4 条（只追加），除非按第 12 条走 ADR 化的成批清理；
  - 若不标 sensitive 而留 private，又是 DeepSeek 说的“洗白”——方案写了“部分采纳”，但没写出这两条路各自撞在哪堵墙上，矛盾没有解决。
- **证据**：上述行号；`prompt-prefix.md:35`（“已经发给过模型的内容，不得改动、重排或删除”）、`:74`（check:prompt-prefix 是阻断检查，反向用例会抓这类断裂）。
- **建议**：把分级拆成两个互不绑定的语义并写进新 ADR：**可见性分级**（决定这条内容能不能进模型请求；记忆类内容按“可读上限=函数返回值”，派生子本身不再按源头遮蔽模型）和**动作/存储分级**（决定推送、日志、工具调用、摘要落库边界；sensitive 继续生效）。明确“历史只追加”优先：给“sensitive 工具结果被历史过滤”的场景补一条反向用例进 `prompt-prefix.compat.test.ts`（改回现状必须失败）。

### 3.（中高·证实）文本模型的 allowedDataClassifications 名单只有 public、private，方案只改了嵌入那台

- **问题**：生产配置模板里**文本模型**（DeepSeek）的名单也是 `["public","private"]`（`scripts/delivery-mode/packet-template/maintenance/production-shape-config-template.json:63-66`），方案只提嵌入模型加 sensitive（`:104-107`）。注入门槛只检查运行分级（`production-model-composition.ts:563`），不检查块内容分级 ⇒ 改完后会出现“为 public/private 设的名单照常生效、但 sensitive 正文每次请求都发过去”的局面：名单从一个真边界降级为死字。方案把路由限制丢给 Andy 的问题 c，但没指出不采纳 c 时这个名单已被实质架空，至少应写明。
- **证据**：上述行号。
- **建议**：要么在方案里声明“文本模型名单的语义从‘按请求分级’改为‘记忆类资料块内容’，检查方式跟着变”，要么每次注入 sensitive 内容时在决策记录里留痕（对齐照抄 Zep 的“memory is evidence, not authorization”：https://help.getzep.com/memory-security ）。

### 4.（中·证实）通道清单漏了两处：每日复盘和（未核实的）工具授权清单上限

- **证据**：每日复盘 `packages/application/src/services/daily-review.ts:135-136`：`reviewMemoryVisible` 只认 public/private，`service-main.ts:1593` 调用；方案“动工前核对”里承认了这一项但没有核对结论，我现在替它核对完：**确实存在**。另外方案前提 12 提到工具授权有分级上限（`sqlite-capability-invocation-operations.ts:1605-1607`），但没核对 recall 工具的授权清单（capability manifest 的 `scopes.dataClassifications`，`action-policy-service.ts:540`）上限是多少——如果清单 cap 到 private，把 recall 结果抬到 sensitive 可能首次触发这条授权拒绝。
- **建议**：每日复盘并进“规则函数”的调用方列表；动工前核对 recall 工具 manifest 的分级上限，把结论写进前提清单。

### 5.（中·证实）现有测试是反方向断言的，方案没列出要变更的既有测试清单

- **证据**：
  - `packages/memory-engine/test/hybrid-memory-provider.unit.test.ts:110`——用例名就是 "keeps sensitive Memory out of the full-text index"，方向与第一期相反；
  - `packages/application/test/daily-review.unit.test.ts:251`——"shows only public and private memories and hides sensitive"；
  - `packages/application/test/owner-profile-service.unit.test.ts:148` 等用 `maxClassification: "sensitive"` 但断言仍被压到 private 的行为。
  - 方案第八节验收只写“把任一通道改回只取 public、private，对应测试必须失败”，没写这些**现成反向断言**会先变红、需要一起改写。文档/测试一致性（我的侧重）因此不成立。
- **建议**：方案加一节“需改写的既有测试”，把上面三类列全。

### 6.（中·证实）文档同步清单不全

- **证据**：需要修订的除了方案已列的 ADR 0185/0112/0158、spec 第 67/70/112/162 行（我都读过，确实冲突）之外，至少还有：
  - `docs/adr/0183-mask-only-when-data-leaves-and-keep-the-original-inside.md:71`——“服务端‘添加记忆’不检查敏感不能置顶”是已知缺口，置顶放开后这句要改；
  - `docs/execution/specs/2026-09-15-control-center-v4-design.md:215`——“敏感记忆和事件、健康、财务、其他类不能打开（每次对话都带上）”是 UI 文案级描述，置顶放开后过时；
  - 每日复盘相关文档（找到通道后一起改）。
- **建议**：修订清单补齐这三处；`npm run check:glossary`/文档校验会兜底，但初期防止漏改。

### 7.（中·证实）方案“动工前核对：现在的检索打分有没有用到时间和使用次数”——我已经替它核对完，答案是“有”

- **证据**：`packages/memory-engine/src/fusion.ts:27-28`（`recency: 0.1, recencyHalfLifeDays: 90`）、`:40-41`（按 `lastUsedAt ?? updatedAt` 算半衰期）、`:105`（进总打分）。所以第二期声称要新做的“闲置记忆在检索排序里往后排”**已经存在**，第二期的实际工作量只有：停用 decay、恢复生产已归档记忆并补索引。
- **建议**：把这条从未核实改为已核实写进前提，第二期缩窄。

### 8.（低·证实）`[密钥]` 图例修正的连带没写全

- **证据**：`packages/prompt-catalog/src/chat.ts:267`（`[密钥]` 被承诺“显示时会换回原值”）、`redaction.ts:70`（占位符无编号、不可还原）、`restoration.ts:53`（只还原带编号的）。修正文字本身方案已写；但使用这份文字的还有 `packages/runtime-pi/src/egress-context.ts`（chat.ts:263 的 `usedBy`），两个出口和金样（`packages/application/test/egress-himawari-text.unit.test.ts` 覆盖提示词逐字节）都要同步，方案只提了图例和金样。
- **建议**：验收项里点名这两个文件。

---

## 业界对照（Andy 的四个问题，一手来源）

1. **敏感记忆给模型看，业界怎么平衡**：没有任何一线系统按“敏感就永远不给模型”来做。Anthropic 的官方立场是**在写入侧控制而非读取侧遮蔽**："Claude usually refuses to write sensitive information to memory files. For stronger guarantees, add validation that strips sensitive data before your handler writes the file"（https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool ）。Zep 把边界放在**动作**上："Memory is evidence for a decision. Memory is not an instruction, policy, credential, permission, or authorization to act"，敏感值"Resolve sensitive values from an authenticated system of record instead of copying them from memory"，并建议用 `review_state: approved` 之类的元数据在检索层过滤（https://help.getzep.com/memory-security ）。方案“存入走审批 + 模型只看到凭证占位符 + 动作仍按运行分级”**与业界一致**；不一致处是问题 2 指出的可见/动作分级纠缠，业界做法是明确拆开。
2. **旧记忆归档还是衰减**：OpenAI 明确"Unless you delete them, saved memories are always considered in future responses"，不重要的“move less important ones to the background”，考虑的是"How recent a detail is and how often you talk about a topic"（Memory FAQ，https://help.openai.com/en/articles/8590148-memory-faq ；直抓可被 403，可读存档 https://web.archive.org/web/20260527003900/https://help.openai.com/en/articles/8590148-memory-faq ）。Letta 把“一直可见”和“要用工具按需查”分开："archival memory fragments cannot be pinned to the context window, and must be queried on-demand via tools"（https://docs.letta.com/v1-sdk/memory/archival-memory/ ），并明确"Don't use archival memory for: information that should always be visible → use memory blocks"。Zep 对矛盾旧事实标失效日期、不删除（与其 API 的时间字段格式一致，见下）。**衰减应影响排序而非可见性**：与 OpenAI 的“移到后台但一直考虑”和 Generative Agents 的检索打分（相关度×重要度×时间衰减；摘要我读过，公式细节在正文，标记**未核到公式本身**：https://arxiv.org/abs/2304.03442 ）一致。但要更正方案一句话的绝对化："没有一家自动让记忆变成查不到"——Anthropic 官方 memory tool 文档写"Memory expiration: Periodically delete memory files that haven't been accessed in a long time"（同上网址），是有业界方建议在无人访问后删除的；Mem0 的 DELETE 行为（方案引 arXiv 2504.19413）摘要只写到"dynamically extracting, consolidating, and retrieving"，具体 DELETE 决策在正文，**未核实**。取消闲置归档仍然是合理的产品选择，理由引用按上面修正。
3. **给模型的记忆要不要带日期、什么格式**：要。Zep 官方上下文块的固定格式是"# format: FACT (Date range: from - to)"，如 `user has the name of Emily Painter (2024-11-14 02:03:54 - present)`，仍有效的写"present"（https://help.getzep.com/retrieving-memory ）。方案第七节的做法和业界一致；建议把格式对齐 Zep 的写法（`事实 (从 YYYY-MM-DD - 至今)`）并在“至今”上定死字面（现在方案没写），避免各处手写不一致——这同时是必答问题 2 的字节确定性要求。
4. **后台无人值守任务读敏感记忆**：业界把管住点放在“写入需要同意、动作需要授权”，而不是“维护时不能读”。ChatGPT 的记忆整理完全是服务端自动做的，文档没有按敏感度禁止后台处理（同上 Memory FAQ）。所以方案推荐 a（允许后台整理、情景摘要、Gmail 检查带 sensitive，凭证照遮）**与业界一致**，且这些调用已经过出口遮盖（`model-egress.ts:263-267`）并在 ADR 0143/账本里有决策记录；唯独它都要发给外部服务方（DeepSeek/Qwen），这是问题 3 的语义问题，而不是后台性本身的问题。

---

## 如果由我来定

1. 方向保留：**同一目标、同一**“一条写进程序的规则 + 回归测试”的做法不动——它符合 AGENTS.md 产品愿景第 17 行“硬性设定、每条有回归测试”，也与 Zep 把 Context Block 放在末尾、官方模型文档“检索优先召回”（recall-first，让模型忽略无关事实，https://help.getzep.com/retrieving-memory ）一致。
2. 但把第一期的改动清单补三个硬项：(a) `context-projection-service` 的 readText/run 分级门（问题 1）；(b) channel 清单补每日复盘（问题 4）；(c) 文本模型名单语义声明（问题 3）。
3. 把 DeepSeek 的分级拆分工问题改判为：**可见性分级与动作分级分开写**（我的问题 2 建议），并给“sensitive 工具结果不再被历史过滤”加 prompt-prefix 反向用例，而不是交给 Andy 拍板一个“部分采纳”。
4. 第二期缩窄为“停 decay + 恢复”，不再新做衰减（fusion 已有 recency，问题 7）。
5. 发布条件动工前核对三件事写进方案前提：recall 工具授权清单上限（未核实）、嵌入模型身份哈希问题维持未核、Generative Agents 衰减公式细节（如果确实引用）。

**必答问题逐条**：

1. **会不会改变模型已见过的请求开头？**新对话之外基本不变，放行方式与 `.claude/rules/prompt-prefix.md` 兼容。逐项核对：图例文字是系统提示（只影响新对话，金样+`check:prompt-prefix` 有覆盖，方案已写）；recall 结果、自动带入/档案块都在最后一条消息（`pi-runtime-adapter.ts:600-616` 把资料块拼进主人那条消息，已核实）；日期字段取自存量属securities（`production-memory-recall.ts:224-233` 已有字段）不是每轮计算的值。唯二例外要 prose：sensitive 工具结果被历史过滤会**先在已发的开头拆**（问题 2，改方案解决后即符合）；重建索引、恢复归档是存储侧，不动已发内容。
2. **会不会同一文字变成不同字节？**方案现有做法不依赖前后文遮盖、不带时间戳、集合都定点排序（`context-formation-service.ts:257-259`、`fusion.ts`、`owner-profile-service.ts:104-114` 我都看到固定 tie-break）。两处待定死后再答“是”：“至今”的字面形式（问题 3）和规则集 1 对话里凭凭证记忆的“先不返回”（同一对话内恒定返回或不返回，跨对话不同——这合法，因为字节规则只要求同一对话内确定；但 recall 目前拿不到对话的 redactionRuleset，这段管线要补，**未核实**可不可行）。
3. **有自动检查、反向会失败吗？**模式上是（`check:prompt-prefix` 反向用例有先例，`prompt-prefix.md:74`；`identifiers.unit.test.ts:76` 的 `[mask-not-block]` 也同型）。缺口：现有反向断言的既有测试未列（问题 5），readText 门（问题 1）目前无任何测试，得按方案模式补 `[RULE-memory-visible]` 才算闭合。
4. **每个值两端都接受吗？**导出函数的调用方我逐个找到：recall 160-163、run-memory 357-363、context-formation 279-286、owner-profile 17/149-166/265、置顶 904-907、整理 35/252、情景摘要 19/236、Gmail 51、嵌入门 130/`production-memory-composition.ts:101`——.ConnectionStrings 除每日复盘（漏）和 recall 授权清单上限（未核实）外可接受；管线/嵌入入口两端一致的。方案没跑到的两端：readText/run 分级门（问题 1）、文本模型名单（问题 3）、档案块 payload 分级一致性（方案块级 max 分级和 payload 分级必须一起改，`context-projection-service.ts:538-546` 会卡）。
