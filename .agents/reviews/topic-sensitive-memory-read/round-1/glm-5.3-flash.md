# 方案：让 `sensitive` 记忆能被召回，且明文密钥不出库、不出索引

## 一、方案依赖的前提（读代码或来源证实的）

1. **占位符是稳定的**。出口遮盖的占位符标签是 `HMAC(稳定密钥, kind + "\u0000" + 值)`：`packages/application/src/services/model-egress.ts:120-125`（`letters(options.sign(key, `${kind}\u0000${value}`))`），密钥由固定标签 `himawari.model-egress.placeholder.v1` 派生（`apps/agent-service/src/production-model-egress.ts:16`、77-85）。同一个密码值在所有请求里遮成同一个 `[密码#abcdefgh]`；记忆提取用的 `externalTag()` 也是同一个 tag（`apps/agent-service/src/production-run-composition.ts:455` → `model-egress.ts:524-526`）。遮盖是幂等的（`packages/sensitive-capture/test/redaction.unit.test.ts:111-113`：`redact(redact(x)) === redact(x)`）。
2. **遮盖只覆盖密码、验证码、机器密钥、银行卡、证件号**；健康、财务等敏感文字不被遮（`packages/sensitive-capture/src/identifiers.ts:10-14` 的 `CREDENTIAL_KINDS`；材料第 5 条，ADR 0183 决定 2）。`containsCredential` 就是现成的“凭证型”判定器（identifiers.ts:16-18）。
3. **主对话显示端已经会把模型回复里的占位符换回原文**：流式与整条都有（`packages/runtime-pi/src/egress-context.ts:52`、58、86），对照表来自本次请求实际遮盖时建的表（`model-egress.ts:128`、155-162、302-314）。也就是说模型只见到占位符、主人看到原文这条链路**已经存在**，不必新建。
4. **凭证型敏感文字发出去时本来就会被遮**：工具结果也走同一个出口遮盖（`model-egress.ts:400-414` 的 `maskArguments`、463-479 的 `maskRequest`，tool_result 一样处理）。所以“召回结果带占位符发给模型”不新增任何暴露面。
5. **模型准入按请求级分类卡**：聊天模型的 `allowedDataClassifications` 只有 public、private（`production-shape-config-template.json:63-66`），卡在请求入口（`apps/agent-service/src/production-model-composition.ts:563`、`production-run-policy.ts:77`），不逐条检查工具结果内容。嵌入模型同样只有 public、private（同模板 104-107），嵌入请求的遮盖走 `redactEmbeddings`（`model-egress.ts:488-499`）。
6. **检索排序是确定的**：融合打分平局按 `memoryId` 排序（`packages/memory-engine/src/fusion.ts:113`）。
7. **已有一次授权、长期有效、可撤销的机制**：Governed Grant 带 `scope.maxDataClassification`、`expiresAt`、`maxUses`、`revokedAt`（`packages/application/src/services/governance-gateway-adapter.ts:493-549`）。
8. **“主人明说记住”已经免审批**：`explicitRememberCandidateOrdinal` 命中即直接落库（`packages/application/src/services/automatic-memory-service.ts:144-145`）；未明说的敏感候选走待批准（同文件 145-162）。
9. **业界参照（一手，已读原文）**：Claude 默认不存健康、信仰等敏感主题；主人可开 “include sensitive topics in memory”，打开后每次保存都有提示；无论如何都不存社保号等证件号。来源：https://claude.com/blog/claudes-memory-works-everywhere-and-you-decide-whats-in-it （2026-11-08 读取，原话见上文 "By default, Claude does not store topics related to personal or sensitive subject matter…" 及 "there are some topics that Claude does not store even when you have sensitive topics in memory turned on"）。ChatGPT 官方页 403，标**未核实**。

## 二、方案

核心思路：**把“出口遮盖的产物”当索引原料**。遮盖是确定性的、幂等的、密钥稳定的，所以“遮盖后的文字”是可重建、可比对、可入库的安全衍生物——它满足规格里“全文索引和向量是明文衍生物”这条禁令的字面意图（禁的是**明文**衍生物，`docs/execution/specs/2026-10-25-self-built-memory-engine-design.md:162`）。

### 第 1 步（最小可行）：凭证型敏感记忆可召回

把 sensitive 记忆在**入库投影时**分成两类，用 `containsCredential`（identifiers.ts:16-18）判定：

**A. 凭证型（命中 password / verification-code / machine-secret / 卡号 / 证件号）**
- 投影时算 `masked = redactForEgress(原文, { tag: externalTag() })`，改动 `packages/memory-engine/src/hybrid-memory-provider.ts:85-97`：
  - `terms = indexTerms(masked + entities)`（占位符替换掉值之后，“家里 / Wi-Fi / 密码”这些上下文词进全文索引；值本身不进）；
  - `embedding = embed(masked)`——发给外部嵌入模型的是遮盖后文字，披露级别与今天聊天里发遮盖后内容完全相同；该嵌入请求按 private 申报即可过现有模型门槛（前提 5），**不需要改嵌入模型的 `allowedDataClassifications` 配置**。
- 召回（`apps/agent-service/src/production-memory-recall.ts:160-163`）：允许 sensitive 进入普通对话的召回，但 `render()` 里把返回给模型的 `text` 换成同一把 tag 遮出的遮盖文（`readText` 拿原文 → `redactForEgress` → 只把遮盖文放进工具结果）。工具结果**只含占位符**，明文连请求体都不碰。历史里存的就是这条遮盖后的工具结果，符合规则 5“存实际发出去的那一条”（`.claude/rules/prompt-prefix.md:36`）。
- 模型回答“你家 Wi-Fi 密码是 [密码#abcdefgh]”，显示端流式还原成原文（前提 3，现成机制）。模型全程没见过明文。
- **零新增主人确认**：主人明说“记住”才存（前提 8）；召回不放明文给外部方，只是让模型转述主人自己存的占位符。

**B. 非凭证型（健康、财务、过敏等，遮盖不动它）**
- 第 1 步**不建任何文本索引**（维持现状：terms 空、无向量）。
- 召回结果里追加“隐藏条目存根”：`{ hidden: true, topic, recordedAt }`（topic 是枚举词，不是明文），每轮至多 2 条、按 updatedAt 降序、平局按 memoryId。模型据此可以说“你有一条 2026-10-30 记的健康类记忆，我还没获得在对话里使用它的授权”。
- 主人在存根提示或记忆设置里**开一次开关**（一次授权、长期有效、可撤销），落成 Governed Grant：`capabilityRef = memory.recall`、`scope.maxDataClassification = "sensitive"`（前提 7 的现成机制）。授权生效后后台重新投影这批记忆：向量索引对**原文**做（披露对象与聊天相同的网关嵌入模型，属于主人已授权的披露），全文仍然不进（FTS 是落库的明文衍生物，规格 162 行的禁令只对向量放宽——向量是本地库里不可逆的有损表示，原文本来就在同一库里）。

### 第 2 步及以后
- 评测集加“敏感记忆召回”分组（`test/fixtures/memory-evaluation/dataset.json`），关口进 `npm run check` 的记忆评测。
- 阶段四规格里“可选评估本地嵌入模型”（设计规格 153 行）若落地，非凭证型敏感记忆可不经外部嵌入、无需授权即可建向量，把 2 的授权面缩到零。
- 网页导入 `parseMemoryText` 丢含密码行的旧行为（ADR 0183 后果第 3 条列的遗留）与本方案对齐。

## 三、考虑过但不选的做法

| 做法 | 不选的原因 |
| --- | --- |
| sensitive 记忆全文/向量照常建，用明文 | 违反规格 162 行“sensitive 以上不进全文和实体索引；全文表不存原文”；且把明文发给外部嵌入模型越过其 `allowedDataClassifications`（模板 104-107） |
| 对健康/财务类自创遮盖规则（如统一替换成 `[健康#x]`） | 健康文字没法“值化”，整段替换等于把整条记忆毁掉，模型答不了“我对什么过敏”；且新遮盖规则会改变既有历史消息的字节，违反规则 11 确定性遮盖（`.claude/rules/prompt-prefix.md:52`） |
| 每次召回敏感记忆都弹确认 | 违反“常规判断应预先授权，不逐次确认”（`docs/product-vision.md:58`）；Claude 的对照做法也是**设置级开关**而非逐次弹窗（来源见前提 9） |
| 把 sensitive 放进主人档案块/置顶“每次对话都带上” | 规格明确“敏感记忆……不能打开”（设计规格 112 行，`owner-profile-service.ts:17` 也只收 public/private）；且档案块每轮组成变化会加重上下文抖动 |
| 加密检索（先加密后搜索） | 需要可搜索加密方案，复杂度远超收益；本方案用“遮盖衍生物”已覆盖凭证型这个主诉求 |
| 为敏感召回改 `recall` 工具参数（如加 `includeSensitive` 布尔） | 改工具参数结构会让所有老对话按规则 6 换新一次（`.claude/rules/prompt-prefix.md:41`）；且把敏感决策推给模型，不该由模型选 |

## 四、风险和反例

1. **（已证实前提、未核实后果）跨轮占位符还原**：模型第 3 轮召回占位符、第 10 轮再次提到密码时，还原表是按请求建的（`model-egress.ts:127-128`）。遮盖幂等性测试（redaction.unit.test.ts:111-113）提示历史里的占位符重遮后不变，但“历史里的 `[密码#x]` 能否在后续请求的还原表里重建映射”**未核实**。缓解：显示端还原改用会话级累积对照表，或召回命中敏感记忆时由运行时把映射注册进会话表；需要一条集成测试钉住。
2. **密钥轮换**：轮换后同一密码遮出的占位符变了，已发历史的占位符字节会变一次——这是规则文档已列明的已知失效原因（`prompt-prefix.md:79`），索引需按“配置变了自动重建”的现成通道重投影（设计规格 120、126 行）。可接受，但要写进 ADR。
3. **遮盖文索引的召回质量**：值被换成占位符后，靠上下文词命中。主人问“abc12345 是什么的密码”这种以值查语境的题答不了。反例要进评测集并接受该类 Recall 偏低。
4. **episodes 路径**：`production-memory-recall.ts:245-256` 把 `allowed` 传给情景摘要搜索；放宽到 sensitive 后，情景摘要文字也可能含敏感原文，必须走同一“凭证型→遮盖文”出口，反向用例要覆盖 conversations 字段。
5. **非凭证型存根的噪声**：每轮 recall 带存根会加大工具结果；要限条数并可由模型忽略。是否“仅当命中少于 limit 时附带”是可调项。

## 五、需要人拍板的取舍

1. 非凭证型敏感记忆授权**粒度**：一个总开关（Claude 式，推荐）还是按 topic（health/finance 分开）授权。总开关确认次数最少，粒度粗。
2. 授权后向量索引发**原文**给外部嵌入模型是否可接受（披露级别 = 主人自己在聊天里发过的同款网关）；不可接受则只能等本地嵌入模型（阶段四），期间该类记忆不可召回。
3. 凭证型召回**零确认放行**是否符合“用户主权”直觉：模型永远看不到明文、显示端还原，但毕竟“问一句就能拿到密码”。若要加一道，可只在**首轮**召回凭证时提示一次。
4. 情景摘要（episodes）是否与记忆同规则放宽，还是第 1 步先不动。

## 六、证实与推测的分界

- **证实**：前提 1-8 全部读代码核实（引了文件：行）；Claude 的做法读了官方原文。
- **未核实/推测**：跨轮占位符还原的具体行为（风险 1）；Governed Grant 的创建入口与 UI 接线只读了快照端（governance-gateway-adapter.ts:493），授权按钮到 grant 落库的链路需落实；ChatGPT 官方记忆政策（403，未核实）；存根对召回质量的实际影响（推测，靠评测集验收）。

## 七、必答问题逐条回答

**1. 会不会改变模型已经见过的请求开头？**
不会。系统提示、工具定义一字不动（不改 `recall` 参数结构，不动工具集合，规则 6 的换新条件一个都不触发）；改动只出现在**本轮新增的工具结果/存根**里，即每轮末尾追加的内容。每轮会变的值（召回结果、`recordedAt`、`current`、存根列表）都在本轮末尾追加的消息里，历史里存的是当时实际发出的字节（规则 5）。

**2. 会不会让同一段文字在不同请求里变成不同字节？**
不会（一项保留）。占位符由稳定 HMAC 决定（前提 1），遮盖幂等（前提 1），索引词由遮盖文确定生成，融合排序平局按 memoryId（前提 6）。保留项：遮盖密钥轮换会让占位符字节整体变一次并触发重投影（风险 2，属规则已列明的已知失效源，`prompt-prefix.md:79`）。

**3. 有没有对应的自动检查，反向用例会不会真的失败？**
有，需新增（现检查不覆盖本改动）：
- 集成测试（照 `test/integration/production-http-composition-process.test.ts` 的 [PR-A]/[PR-B] 模式，真实 HTTPS 模型桩抓原始请求体）：主人存 Wi-Fi 密码→追问，断言 (a) 所有发往模型和嵌入模型的请求体（含 embeddings）都不含密码明文；(b) recall 工具结果含 `[密码#…]`；(c) 显示给主人的回复含明文（还原生效）；(d) SQLite 全文表与索引 terms 不含密码明文。反向用例：去掉召回侧遮盖、把明文写进 terms、`allowed` 放宽但不遮盖——三者都必须使断言失败。挂进 `npm run check`。
- 记忆评测集加敏感召回题，Recall@5 不达标不上线（同现有阶段一关口的模式，设计规格 141 行）。
- 沿用 `npm run check:prompt-prefix`（含反向用例，规则文档 74 行）确认本改动不触发换新、历史不被改写。

**4. 改动产生/修改的每个值，两端都核对了吗？**
- **遮盖文 terms / 遮盖文向量**：产生于 `hybrid-memory-provider.ts:85-97`；消费于索引搜索与外部嵌入调用。校验端：嵌入请求按 private 申报且实际字节确为遮盖文（集成测试断言明文不出现在请求体）；库内断言 FTS/terms 无明文。
- **召回 `allowed` 放宽**：产生于 `production-memory-recall.ts:160-163`；消费于 `render`（217 行）、episodes（252 行）。两端校验：render 处加“凭证型必须遮盖后返回”，episodes 同规则（风险 4 的用例）；restricted 仍被 133-137 行丢弃，不放宽。
- **工具结果中的占位符**：产生于召回 render；消费于出口遮盖（占位符幂等通过，前提 1）、显示端还原表、历史存储。校验端：风险 1 的跨轮还原测试。
- **新授权 Grant 的 `scope.maxDataClassification="sensitive"`、`capabilityRef="memory.recall"`**：产生于授权入口；消费于召回判定与治理快照（`governance-gateway-adapter.ts:530` 已把快照封顶在 private，不会把 sensitive 泄到低权限界面）。按 I-73 的教训：capabilityRef 必须用**现有**的 `memory.recall` 常量（`production-memory-recall.ts:19`）而不是新造字符串，避免新 id 过不了后端校验；若确要新增偏好键/引用，须同时加类似 `check:model-ref-contract` 的两端一致门槛（incidents-and-gates.md I-73 行）。
- **不新增**：配置键、序列化格式、清单项均不新增；不改动记忆 topic 枚举（密码仍填 other，`packages/prompt-catalog/src/memory.ts:16`）。

**附：六个问题怎么答（对应材料第 1-6 问）**
1. 凭证型用遮盖文建全文+向量（代价：以值查语境不可检索、密钥轮换需重投影）；非凭证型先只给存根，授权后仅向量。
2. 凭证型：模型只见占位符，显示端还原，永不需要主人再确认；非凭证型：授权前模型只见存根，授权后见原文；restricted 永不召回。
3. 一次授权、长期有效、可撤销（总开关，推荐），外加每条自动提取的敏感候选走现有待批准；“明说记住”零确认。
4. 不动系统提示与工具集合，敏感内容只经末尾追加进入请求；遮盖确定性由稳定 HMAC 保证。
5. 上面第 3 条的自动检查，含三组反向用例。
6. 第 1 步 = 只做凭证型（A）：改动集中在 `hybrid-memory-provider.ts`、`production-memory-recall.ts` 两处加一条集成测试与评测题，零配置改动、零新增确认；后面扩 = 存根 + 授权开关（B）→ 本地嵌入模型评估（阶段四）→ 导入/遗留路径对齐。
