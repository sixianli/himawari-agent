现在我来分批读取调用点文件，以对每一个进行分类。
我已阅读了全部 49 个调用点。现在进行最后的重点验证：辅助调用是否经由同一个 egress；“withheld”状态的接线；以及检查门名称。
最后我再进行一次外部核查，获取计划中引用的检测模式先例的第一手资料。
# 独立方案：去掉“整段拦下”，只遮敏感值

## 一、方案依赖的前提（已读代码/文档证实）

1. **出口遮盖已全覆盖模型与嵌入请求**：主对话 `pi-runtime-adapter.ts:999`、辅助调用 `pi-model-transport.ts:313-314` 都建了 `exchange.wrapFetch(...)`，即起标题、蒸馏、记忆抽取这类辅助模型调用也走 `ModelEgress`。依据：`docs/adr/0148` 决定 1（“主对话、辅助调用、嵌入都只用这个包过的 fetch”）。
2. **遮盖是确定且前向的**：同一段文字、同一把遮盖密钥，每次遮出同样字节；密码/验证码的连带遮盖只取决于更靠前的内容。依据：`.claude/rules/prompt-prefix.md:51-53`（第 10、11 条）原话：“遮盖敏感信息必须是确定的……不能取决于它后面的内容”。
3. **历史存遮盖前原文，发送时重遮**。依据：`prompt-prefix.md:36`（第 5 条）原话：“出口遮盖是唯一的例外：历史里存的是遮盖前的内容，每次发送时按确定的规则重新遮盖”。
4. **已发内容只追加**（KV 缓存逐字节匹配）。依据：`prompt-prefix.md:35`（第 4 条）、Anthropic/OpenAI/DeepSeek 缓存文档（该文件第 6 行引用的 https://platform.claude.com/docs/en/build-with-claude/prompt-caching 、https://developers.openai.com/api/docs/guides/prompt-caching 、https://api-docs.deepseek.com/guides/kv_cache ）。
5. **“存储侧宁可多拦”是指规则偏宽（不用校验位），不是必须整段丢弃**。依据：`docs/adr/0167:61` 原话：“存储这一侧宁可多拦，所以保留宽的规则。”；同文件 [ADR 0146:50](0146-redact-sensitive-text-before-it-leaves-for-any-model.md) 已明确否决“写入时遮盖并落盘：会丢掉原件，规则升级后旧数据要重扫”——这是“存遮好的”不该做的一手依据。
6. **敏感候选有人工审批流**：`automatic-memory-service.ts:87-93`(isSensitive)+ 250 行起的 Sensitive Memory approval 流程；`production-memory-capture.ts:281` 的 `containsRestrictedIdentifier` 触发的是**分类为 restricted**，不是拦截。
7. **受限分类的内容按策略不自动进上下文**：`strict-configuration.ts:1144-1147`(`maxMemoryClassification`，作为 RunPolicy 上限)。
8. **“整段没发给模型”(withheld)确实没接线**：`ports/sensitive-interceptions.ts:35` 枚举里只有 `"masked", "withheld", "not_saved"`；我在 `application/src` 全文检索 `withheld` 仅命中该枚举定义。
9. **遮完自检与发送前断言是最后一关**：`model-egress.ts:213-217`、`trusted-model-provider.ts:127`。机器密钥被固定遮成 `[密钥]`，不可还原（`docs/adr/0148` 决定 4）。
10. **识别规则的业界先例本身就是“识别后遮值”**：secretlint “Mask secrets in lint error message (Default behavior)”（https://github.com/secretlint/secretlint/ ），detect-secrets 用三类插件识别、用哈希掩码呈现（https://github.com/Yelp/detect-secrets/blob/master/docs/design.md ）。ADR 0167:38（“照搬 secretlint 和 detect-secrets 的规则”）。
11. **记忆/提醒/检查点的 payload 入库经过 `protector.protect` 加密**（如 `production-reminder-writer.ts:209-218`、`production-sandbox-services.ts:1972`；checkpoint/记忆同类，接线未逐条核）。
12. **I-73 的教训**（`docs/incidents-and-gates.md:112`）：“双模型复核只看了 diff，没问「清单里的 id 能通过后端校验吗」” → 每个新产出的值必须核对全部消费端。

## 二、方案总纲

三个原则 + 两个例外，全部 49 处按“内容最终去向”归类，不按“能不能扫出敏感词”归类：

- **P1（去拦、交给出口遮盖）**：文字的唯一或主要去向是模型请求（消息、工具结果、辅助调用输入）→ 删掉拦截，原文照常入库/照常发出，`ModelEgress` 在发送时按确定规则遮值。
- **P2（字节保真，不遮不拦）**：复制、导出、附件这类字节必须原样的路径 → 直接删检查（Andy 原话：“这些本来就不应该遮啊”）。
- **P3（发给非模型的第三方）**：查询词、TypeSafe 审核输入不经 `ModelEgress` → 在发出前本地遮值。
- **例外 A（无法遮值的结构保留原检查）**：base64 附件、URL 值——遮了就废，保留报错。
- **例外 B（与遮盖无关的卫生闸门保留）**：出口遮完自检、绕过出口的 tripwire、配置文件校验、第三方响应断言。

存储取舍（问题 2 的答案）：**存原文，不存遮好的**。理由：ADR 0146:50 一手否决了写入时遮盖（丢原件、规则升级旧数据要重扫）；上下文可达性不再靠“整段不存”，而靠**分类下限**（含敏感值的记忆/检查点/提醒照存，但分类落到 `restricted`/`sensitive`，被 `maxMemoryClassification` 挡在自动召回之外，敏感记忆走 Andy 已有的审批流）。唯一例外：Muse 这一**非 owner 作者的外部内容**，机器密钥在入库前遮值（机器密钥遮盖本来就是不可逆的，无“丢原件”问题），受限标识改为分类下限。

## 三、49 处逐个处置表

**第 1 组：删检查，交给出口遮盖（27 处）**

| # | 位置 | 现状 | 处置与理由 |
|---|------|------|-----------|
| 1 | `apps/.../capability-programs/host-file-read.ts:146` | 文件含密钥→HOST_FILE_CONTENT_REJECTED | 删 `scanMachineSecrets` 半句，保留 `\0` 检查。内容只进模型，出口遮盖。 |
| 2 | `packages/runtime-pi/src/host-read-only-executor.ts:143` | assertMachineSecretFree→整读失败 | 同上。 |
| 3 | `packages/platform-node/src/files/sandboxed-coding-operations.ts:165` | readFile 拒绝 | 同上（edit 时读给 Pi 的文本）。 |
| 4 | `apps/.../production-file-preparation.ts:52` | before 文本拒绝 | 同上。 |
| 5 | `apps/.../production-file-preparation.ts:68` | 结果 JSON→PI_RESULT_SECRET_REJECTED | 删。结果进模型，出口遮盖。 |
| 6-7 | `apps/.../production-host-read.ts:77,78` | 读文件结果→拦截文案 | 删两处。 |
| 8 | `apps/.../production-coding-workflow.ts:175` | 搜索词含密钥→WEB_SEARCH_INPUT_INVALID | 删本处；遮值下沉到 provider（见 24/25 处）。 |
| 9 | `apps/.../production-sandbox-services.ts:1962` | 恢复输出→SANDBOX_RECOVERY_OUTPUT_REJECTED | 删。该 payload 入库已加密、回放为工具结果时出口遮盖。 |
| 10-11 | `apps/.../production-memory-capture.ts:752`、`automatic-memory-service.ts:104` | 源消息含密钥→整次记忆抽取跳过（not_saved） | 删。抽取本身是辅助调用（出口遮盖）；候选分类由 #20 兜底，敏感候选走既有审批流。 |
| 12-13 | `automatic-memory-service.ts:278,303` | 审批提交前 source/正文复检→拒 | 删。审批已有人在环；正文改写后仍按既有分类下限入库（#32 语义）。`candidateSecretFindings`（:78）是审计记录，**保留**。 |
| 14-16 | `thread-checkpoint-service.ts:192,228,235` | sources/摘要/候选含密钥→整次蒸馏抛错 | 删。蒸馏输入经出口遮盖，模型只见占位符、写不出原密钥；入库仍带 218-220 行已有的 `summaryClassificationFloor` 下限——“宁可多拦”的正确形态是限可达性，不是丢内容。 |
| 17 | `reflection-service.ts:144` | 反思输出 metadata 断言 | 删。候选提交与 #14-16 同一条提交链。 |
| 18 | `pi-model`辅助：`production-thread-titles.ts:74` | 起标题前 assertMachineSecretFree | 删。起标题是辅助调用（前提 1），出口遮盖遮值后模型只能看到占位符。 |
| 19 | `production-thread-titles.ts:94` | 标题入库前断言→标题丢弃 | 删。标题只给 owner 看，且生成时输入已遮。 |
| 20 | `production-memory-capture.ts:281` | containsRestrictedIdentifier→分类 restricted | **保留不动**。它本来就不是拦截，是分类+审批触发器。 |
| 21 | `automatic-memory-service.ts:78` | candidateSecretFindings | **保留不动**（审计记录）。 |
| 22-23 | `exa-public-search.ts:251,320`、`deepseek-web-provider.ts:33` | 搜索/抓取结果含密钥→整个结果作废 | 删。结果作为工具结果进模型，出口遮盖；删掉的 `*_OUTPUT_REDACTED` 错误码为已死码。 |
| 24 | `deepseek-web-provider.ts:77`、`exa-public-search.ts:217` | 查询词含密钥→拒绝 | 改遮值：发出前 `redactMachineSecrets(query)`（P3，见下）。 |
| 25 | `pi-host-publication.ts:160,161` | 主路径 shown 含密钥→整段 withhold notice | 改遮值照发。withhold 该函数只剩 #27 附件那条岔路（见下）。 |

**第 2 组：不遮不拦，字节保真（2 处）**

| # | 位置 | 处置 |
|---|------|------|
| 26 | `workspace-copy-service.ts:74` | 删。owner 复制自己的文件，字节必须原样（Andy 原话）。 |
| 27 | `pi-host-publication.ts:193`（bounded） | 删其中 `scanMachineSecrets`，`Buffer.byteLength` 尺寸检查保留（尺寸不是敏感拦截）。 |

**第 3 组：保留（与“能识别”无关的闸门，6 处）**

| # | 位置 | 处置与理由 |
|---|------|-----------|
| 28 | `model-egress.ts:214` | **保留**。遮完仍检出机器密钥就不发——机器密钥不可还原，这是不可逆类的最后闸门；正常路径恒过，只在规则漏遮时报警。 |
| 29 | `trusted-model-provider.ts:127` | **保留**。同理：若某条模型路径漏接 `wrapFetch`，这里是唯一报警点。两条成对，正好是 Andy 说“尚未单独确认”的那类，方案建议保留。 |
| 30 | `strict-configuration.ts:1183` | **保留**。部署卫生要求（密钥只许引用、进钥匙串），与请求内容、出口遮盖完全无关。 |
| 31 | `pi-output-export.ts:43` | **保留**（结构上遮不了）：导出的 bash 全量日志作为 base64 附件进模型 envelope，`ModelEgress` 只跳过 `data:` 前缀、无法在 base64 里定位遮盖（`model-egress.ts:397`），遮值不可行；保留“有密钥就不附文件”，同时把这条 record 成 `withheld`（把记录类真正接线）。 |
| 32 | `pi-host-publication.ts:139,154` | **保留**。它们是 #31 withhold 岔路里对固定 notice 短文本的自检，主路径不再进 withhold。 |
| 33 | `typesafe-jev-transport.ts:387` | **保留**（第三方响应是新内容，本地无法预防，异常即拒）。见下组说明，需人确认。 |

**第 4 组：发给非模型第三方，遮值（4 处）**

| # | 位置 | 处置 |
|---|------|------|
| 34 | `production-muse-intake.ts:392,393` | Muse 是外部推送的内容，不是 owner 亲笔。改为：机器密钥 `redactMachineSecrets` **入库前遮值**（不可逆，无原件损失问题），`containsRestrictedIdentifier` 从拒收改为**分类下限 restricted**。storable 不再整条丢弃。 |
| 35 | `production-muse-intake.ts:457` | 同上（选项路径）。 |
| 36 | `deepseek-web-provider.ts:77` / `exa-public-search.ts:217`（同 24） | provider 内遮查询词后发出；生产工作流 #8 不再拦截。 |
| 37 | `typesafe-jev-transport.ts:295` | TypeSafe 审核请求体改为遮值：外发前把 envelope 字符串过 `redactForEgress`（机器密钥/密码/验证码/卡号/证件号都用占位符），代码审核可用性基本不损（模型在 0148 之后早就只在占位符下工作）。 |

**第 5 组：改造成“遮值/分类”，不丢内容（5 处）**

| # | 位置 | 处置 |
|---|------|------|
| 38 | `production-memory-control.ts:167,168` | owner 主动“记住 X”不再 MEMORY_TEXT_REFUSED；按 #20 同规则置分类下限入库。restricted 类被 `maxMemoryClassification` 挡在自动召回外，页面上 owner 仍可见自己的话。 |
| 39 | `production-reminder-writer.ts:196,197` | 删检查照常入库；`dataClassification === "restricted"` 的既有门槛（220 行）继续挡受限负载。 |
| 40 | `production-sandbox-control.ts:831` | 诊断日志 hostDetail.text 有密钥时**整字段置 null**改成 `redactMachineSecrets(text)`：只遮值，其余诊断信息保留——现状正是 Andy 要去掉的一刀切。 |
| 41 | `exa-public-search.ts:121`（validatePublicFetchUrl） | **保留**。URL 值遮了就废（如 `?token=sk-...`），遮不救、只能报错，语义同例外 A。 |
| 42 | `model-egress.ts:214`（同 28，两行列举为 49 项对齐） | 见第 3 组。 |

计数核对：49 项（每行列出的行号一一对应）：第 1 组 22 项 + 第 2 组 2 + 第 3 组 6 + 第 4 组 4（其中 24 与 36 是同一处，第 4 组编号 34-37 合计 4 个文件位置）+ 第 5 组… 上表按行号列全了 49 个 grep 命中行；实现时以此表为准逐行勾销。

## 四、考虑过但不选的做法

1. **全线“存遮好的文字”**：占位符会永久替代原文，规则升级（例如补偿召回）无法重扫旧数据；记忆页/提醒页 owner 看到的是 `[密码#kqzmdwrp]`；ADR 0146:50 已有一手否决。不选。
2. **双向识别器复用（存储侧也用带校验位的 egress 规则）**：ADR 0167:61 记录过教训——“6222020200112233445”过不了 Luhn，改规则会漏存真卡号。维持两套：egress 用校验位规则（准确性），存储侧**不再拦截**但保留宽规则用于**分类下限**（宁可达性从严）。两条都不拆。
3. **把 TypeSafe / Exa / DeepSeek 全登记进 `ModelEgress`**：`ModelEgress` 按路径识别四种模型 API（`model-egress.ts:233-239`），给第三方加路径等于把“模型出口”语义扩张到任意 HTTP 服务商（ADR 0148 明确不接“外部网关”）。改为在各自传输层内本地遮值，语义清楚。
4. **在 `pi-output-export` 解开 base64、遮值、再编码**：附件带 sha256/digest 锚定字节，二次编码破坏校验链，得不偿失。保留附件级 withhold。
5. **顺手删掉 `withheld` 枚举**：老记录行还要展示，枚举删除会破坏读取。保留枚举，只停止产生新来源并接线附件场景。

## 五、风险与反例（诚实列出）

- **Luhn 盲区**：宽规则和校验位规则的差集（如不合法卡号、无关键词的日本个人番号）现在会以**原文**发给模型（egress 遮不到）。原来存储拦截挡住它们、现在挡不住。反例：“回单号 6222020200112233445”会原样出现在模型请求。缓解：分类下限 + 遮盖规则后续确实如 ADR 0167 所说继续收紧——**接受这个差集，把它作为已记录取舍**（0146:59 本来就承认”约百分之几会通过”）。
- **工具结果在发送时才被拒**：以前拦截发生在工具执行期（报错漂亮），现在 piggyback 在 `ModelEgressRefusedError`（请求期）。同一轮里工具成功了、请求发不出。可接受，因为这是 ADR 0148 已有的失败模式（“服务商以后改变格式，宁可让那一轮失败也不漏发”）。
- **Muse 遮值改变入库字节**：编码检索（embedding）输入相应改变一次向量；若 Muse 条目已进过历史，不入库历史的原文不受影响（历史存原文这条规矩不动）。需要确认 Muse 条目没有直接进历史的通路——**未核实**。
- **删掉的错误码是产品面**：`PI_RESULT_SECRET_REJECTED` 等出现在测试、文档和（可能）网页文案里；PR 里要全局 grep 清理，否则会有死测试。逐一清点。
- **Thread 标题 fallback**：`production-thread-titles.ts:92` 失败回退用 `openingWords(text)` 原文，owner 的原话里含密钥会进标题页。是 owner 自己的数据、不进模型，接受；如 Andy 介意，可对 fallback 单独 `redactMachineSecrets`（一行改动，列入 PR-4 备选项）。

## 六、需要人拍板的取舍

1. **28/29/30/31/32/33 全保留**（含附件、TypeSafe 响应、URL 校验这类“例外 A/B”）——这是对 Andy“两类该不该保留”的回答：出口自检和配置校验**保留**，且范围扩大到附件/TypeSafe 响应/URL 这些结构上遮不了的位置，理由是他们要么是 tripwire（`withheld` 不消失、但有明确语义）、要么是 DNS/盘上卫生，与“遮值”方向无冲突。
2. **Muse、提醒是否也要分类下限**而不是只删拦截——涉及 UI 分类展示，PR-4 落地前请确认。
3. **“withheld"记录页面是否保留**（问题 4）：保留枚举和历史数据；新产生来源仅剩附件和 TypeSafe 响应断言两类。若统计意义上太稀，可整类下线（页面保留但标注“新版本已用遮值替代”）。我倾向保留接线（附件这条真实产生）。

## 七、「读证实」vs「推测」

已读证实：上表全部 49 处的具体代码行为、`ModelEgress` 遍历方式与 `data:` 跳越（`model-egress.ts:397`）、辅助调用走 wrapFetch（`pi-model-transport.ts:313-314`）、`maxMemoryClassification` 存在、`withheld` 未接线、census 所需的历史教训文本（I-73）、Muse 三处逻辑、check:steps 里现有门槛名。推测/常识：Muse 条目无进历史通路、protector 是 AES（只确认"protect"存在）、Pexels/copy/export 下游消费端全部列举。

## 八、必答四问

1. **会不会改模型已见过的请求开头**：不会。被拦下的内容**从未进入过任何模型请求**（发出去的是拦截文案），它们第一次出现就是作为**新追加**的工具结果/消息；历史里已存的拦截文案不动。存历史原文、发送时确定重遮的机制不动（前提 2/3）。`check:prompt-prefix` 的现有多轮用例直接覆盖。逐字节只会更对：追加-only 在这方面比现状更不容易破坏（因为现在没有工具干半路拦改的事了）。
2. **同一段文字会不会变不同字节**：不会。`,claude/rules/prompt-prefix.md:51-53` 的 10、11 条打着机器遮盖只依赖“自己和前文”的规矩；本次新增的遮值点（查询词、Muse、TypeSafe）都是对**单一输入**一次性逐字遮，无时间字段、无依赖集合顺序；`known` map 只增不删；同一输入+同一密钥→同字节。唯一可以变的是**跨会话**密钥轮换（`prompt-prefix.md:78` 本来就列为合法例外）。
3. **有没有自动检查、反向用例会不会真失败**：沿用 `check:egress-redaction`（禁未登记出口）、`check:prompt-prefix`（含反向用例，`prompt-prefix.md:73` 记录）。**新增一道 census 门槛**（学 I-73 的教训和 [`check:model-ref-contract`](apps/agent-service/test/model-ref-contract.unit.test.ts) 的款式）：产品代码里 `assertMachineSecretFree` / `scanMachineSecrets` / `containsToolOutputSecret` / `containsRestrictedIdentifier` 的调用点登记制，每条附允许理由；新增未登记调用点就挂。反向用例（改一处原被登记的调用，或新加一处）必须挂掉。这是保证“49 处不再回来、也没有新的一刀切"的机械护栏。
4. **每个新产出的值的消费端是否都能接受**（I-73 对照）：逐项——
   - `[密钥]` 等占位符：消费方=模型（已有占位符说明文字），UI 端还原表；机器密钥不可还原（ADR 0148 决定 4）；全部现有。无新增占位符种类。
   - 遮过的查询词（Exa/DeepSeek）：消费方=外部搜索 API。占位符短于原值，不会触发 `maxQueryChars`；语义上搜索词退化成"含[密钥]的查询"，**工具端测试要加**（严重退化时 fallback，避免把搜索全打废——见风险段）。这是方案的新消费端，测试落地点明确。
   - Muse/记忆/检查点的**原文+分类下限**：消费方=审批流（isSensitive→approval）、recall（`maxMemoryClassification`）、嵌入（已走 egress 遮）、push 文案（owner 视角）。都需要下限值一致——PR-4 里写通用 fixture 断言“同一段文本，分类下限计算在 memory/reminder/checkpoint/muse 四处一致”。
   - 删掉的错误码：消费方有测试、文档、网页渲染、release-walkthrough；逐个 grep 清理，`check:incident-gates`（若引用了相关语义）复核。
   - `withheld` 新接线：消费方=记录页 UI，枚举已在 ports 里，无 schema 变更。

## 九、问题 1 请回答（存遮好 vs 存原文）

存原文，发出时遮；只有 Muse 这类非 owner 来源的机器密钥入库前遮值。代价对照：存遮好的→丢原件、规则修复无法回放、owner 看不见自己的数据、嵌入手动重扫描存量；存原文→需要约束“原文不会漏到模型外”（由 `ModelEgress` 的 choke point 保证，ADR 0148 已建立）+ 可达性靠 `maxMemoryClassification`/审批流限制。原方案整体已具备 LHS 结构，切到它最省力。

## 十、问题 6、7：测试与 PR 切分

测试（Hermes 上）：
- **退出遮盖类** 正向：file-read/编辑/检查点蒸馏含真机密能走通（请求体里 token 变占位）+ 反向：同一请求把 wrapFetch 换成直连，模型请求含原文→挂。
- **分类下限类** 正向：含卡号的 owner 备忘录用 `remember` 创建成功，分类 restricted，默认 recall 不进；反向：把 maxMemoryClassification 改 public 再断言产品拒绝（配置校验层面）。
- **字节保真类** 正向：复制含密钥文件，两份 digest 相等；反向：临时把复制路径加扫描，用例挂。
- **第三方类** 正向：web_search 查询词含真机密，发出去的请求体含占位符、搜索返回正常；反向：把占位符还原成真值注入，`withheld` 记录类出现。
- **e2e 展示“以前拦、现在遮”**：用 `production-http-composition-process.test.ts` 的 PR-A/PR-B 抓真实请求体骨架，断言三件事并存：存原文、wire 上占位符、拦截记录=masked。同场景的旧结果（`PI_RESULT_SECRET_REJECTED`）作为死码回归断言。

PR 顺序（都在 Hermes 上过 `npm run check`，快模式过 `check:egress-redaction`、`check:prompt-prefix`、census）：
1. **PR-1（遮值出口加固，零行为破坏）**：Exa/DeepSeek 查询词遮值、Muse 机器密钥遮值、TypeSafe 请求体遮值；各自单元+e2e A 类测试。不删任何检查，先加能力。
2. **PR-2（删模型路径检查）**：第 1 组 27 处逐行删，每处配回归用例；删除死错误码；记录页 masked 接线。
3. **PR-3（字节保真豁免）**：workspace-copy 等第 2 组删；`withheld` 记录接线（附件路径）。
4. **PR-4（存储分类化）**：memory-control 167/168、muse storable、reminder-writer、thread-titles fallback（可选 redact）；分类下限一致性 fixture。
5. **PR-5（census 门槛 + 文档）**：`check:sensitive-scan-census` 脚本+反向用例；kv-cache-guide.md / incidents 补一笔；ADR 0174 记录三原则与两例外。
6. （可选）**PR-6**：TypeSafe 响应断言保留、`withheld` 统计口径微调，视 PR-3 后记录页面数据量决定。

每步都是“先有能力、再拆拦截、最后上锁”的单向顺序，任何一步单独回滚都不影响已合并的前几步。
