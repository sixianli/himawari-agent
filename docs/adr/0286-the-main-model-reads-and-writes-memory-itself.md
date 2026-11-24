---
status: active
document_type: adr
decision_status: accepted
supersedes: docs/adr/0142-keep-background-memory-capture.md
superseded_by: ""
amends: "docs/adr/0185-mark-passwords-and-keys-sensitive-instead-of-dropping-them.md, docs/adr/0193-memory-is-visible-to-the-model.md, docs/adr/0196-index-sensitive-memory-after-masking-and-stop-idle-archiving.md, docs/adr/0231-review-past-conversations-to-fix-memory.md"
date: "2026-11-24"
---

# ADR 0286：主模型自己翻旧对话原话、知道自己记着什么、聊天时自己存记忆

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [前提](#premises)
- [决定](#decision)
- [业界怎么做](#industry)
- [放弃的做法](#options)
- [后果](#consequences)

<a id="context"></a>

## 背景

Himawari 现在由程序和单独的模型调用替主模型（和 Andy 对话的那个模型）决定它能看到什么、记什么：每轮程序搜 20 条、最多带 5 条记忆，外加 2000 字的主人资料；旧对话只能搜到每日摘要；记不记由每轮之后另一次模型调用（后台抽取）决定，主模型自己不能存。Andy 2026-11-24 在“重新设计记忆系统”线程里逐项定了新做法，详细设计见[记忆系统重新设计](../execution/specs/2026-11-24-memory-redesign-design.md)。本 ADR 记下改起来代价大、以后会被问“为什么”的几条。

<a id="premises"></a>

## 前提

1. 每轮程序搜 20 条、最多带 5 条：`scripts/delivery-mode/packet-template/maintenance/production-shape-config-template.json` 第 14、15 行是 `"memoryLimit": 20`、`"maxSelectedMemories": 5`。
2. 主人资料块：`packages/application/src/services/owner-profile-service.ts` 第 20、24 行是 `OWNER_PROFILE_CHARACTER_BUDGET = 2000`、`PROFILE_MINIMUM_IMPORTANCE = 600`。
3. 召回给的旧对话只有摘要：`apps/agent-service/src/production-memory-recall.ts` 返回 `{ day, source, summary: text }`，text 是每日摘要正文。
4. 主模型被告知自己不能记：`packages/prompt-catalog/src/chat.ts` 第 17 行“主人告诉你的事，系统会在本轮回答后尝试整理进长期记忆，但整理可能失败，你看不到结果”。
5. 以前测过主模型自己存：[ADR 0142](0142-keep-background-memory-capture.md) 的表里，主模型调 `memory_remember` 记下 93%、92%，误记 6.7%、5%，密钥被记下 2、1 条；那个工具没接后台抽取那条路上的校验。
6. 发给模型的内容只追加，系统提示和工具按对话冻结：`.agents/instructions/prompt-prefix.md` 第 36 行“已经发给过模型的内容，不得改动、重排或删除，只能在末尾追加”，第 42 行“系统提示和工具按对话冻结”。
7. 生产对话模型 DeepSeek V4.1 Flash 的上下文窗口：同一配置模板第 87 行 `"contextWindow": 1000000`。

<a id="decision"></a>

## 决定

1. **主模型自己读写记忆，后台抽取和确认裁判退役。** 取代 ADR 0142。主模型用记忆工具存、改、作废记忆，写入走后台抽取那条路上已有的校验（出处原话确实是主人说的、密钥扫描、人物、提醒、审计），抽成共用代码。实时存上线时直接关掉后台抽取和确认裁判（Andy：“它能自己存就直接关”）。ADR 0142 里主模型误记、存下密钥的问题，由共用校验和下面第 4 条的硬拦截兜住，评测照样量漏记和记错。依据“记忆可靠性”。
2. **数据库是记忆的唯一正本，不做记忆文件。** 不做 `/memories` 目录、`MEMORY.md`，也不模仿文件命令。主模型知道自己记着什么，靠新对话开头从数据库拼出的“记忆清单”（每条一行，压缩长对话时重建）；细节按编号用工具打开。Markdown 只出现在导出里。
3. **能翻旧对话原话。** 按“轮”（主人说一句、她答一句）建检索索引，按词和按意思都能搜；主模型用工具搜旧对话、打开旧对话前后原文。每日摘要不再生成，回看（ADR 0231）改为“做梦”：主模型带着全部记忆和新对话原话，合并重复、更新过时的、补漏记的、整理主题页，每句指回原话，整批生效、整批可撤销。
4. **什么都能记，只有密码、密钥不记。** 取消敏感内容审批，不再给记忆标“敏感”：健康、财务、人际关系、银行卡号、证件号都直接记、原样给模型，锁屏推送显示全文（Andy：“它必须全面掌握我的个人情况，才能做好 AI personal agent 这个角色”）。密码、密钥由程序识别后拒存，主人明说“记住”也不存；修改 ADR 0185 里“明说记住就存成敏感”这一条。ADR 0193、0196 里为敏感记忆设的上限和遮盖，随“敏感”标记一起去掉；发给模型前遮盖密码、密钥、验证码照旧。依据“用户主权”：Andy 明确接受所有记忆原样发给生产模型服务商。
5. **存记忆不打扰主人。** 对话里不出现“已记下”之类的话或标记；存失败由主模型自己处理，记进日志，评测算漏记率。
6. **上限按上下文窗口的比例定，写在配置里。** 开头快照不超过窗口 10%，每轮自动带的相关记忆不超过 1%，工具一次返回不超过 2%（放不下给下一页），做梦一次不超过 50%。另有三条防失控上限：单条记忆 300 字、一轮存改作废合计 50 次、单个主题页 5000 字。不设“因为 Andy 看不过来”的条数上限。

<a id="industry"></a>

## 业界怎么做

- Claude App 聊天时自己存记忆、能“搜索旧聊天”并带链接指回原对话（<https://support.claude.com/en/articles/11817273>）；ChatGPT 是“保存的记忆”加“参考聊天记录”（<https://help.openai.com/en/articles/8590148-memory-faq>）。都由主模型自己决定记什么、什么时候查。
- Anthropic 上下文工程文章建议先递一部分资料、其余由模型按需查，保留轻量的编号（“maintain lightweight identifiers”，<https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents>）。
- Anthropic 的做梦（<https://platform.claude.com/docs/en/managed-agents/dreams>）合并重复、替换过时条目；它的研究（<https://www.anthropic.com/research/components-of-agent-memory>）里搜索加主题页 61%，只搜索 53%。
- LongMemEval（<https://arxiv.org/abs/2410.10813>）：按轮存原始历史最好，长上下文模型直接读全部历史掉 30%–60%。

<a id="options"></a>

## 放弃的做法

- **照搬 Anthropic 记忆工具的文件目录。** 文件只是那两家的包装方式，Himawari 已有数据库、历史版本和出处，包一层文件只多一份要同步的东西。
- **只把每轮 5 条改成 20 条。** 仍是程序替主模型挑，是表面修补。
- **保留后台抽取和主模型存记忆并行。** Andy 定直接关；漏记由做梦补、原话永远能搜。
- **密码、密钥也当普通信息记。** 改由以后接密码管理器，填表时由工具取值直接填，模型看不到值（另开线程做）。

<a id="consequences"></a>

## 后果

- 分四步上线：翻原话、记忆清单和只读工具、实时存、规则搬出记忆；每步先有自动检查（请求只追加、同内容同字节、删除跟随、密码密钥存不进、外部内容不产生已确认记忆、工具调用重放不重复存），再用评测（OpenCode Go 套餐里的模型，不用 Vercel）证明不比上一步差。
- 所有记忆原样发给生产用的模型服务商，锁屏推送显示全文。
- 上线前的旧对话随统一收件箱第 1 步全部删除（Andy 2026-11-24 定），翻原话不为它们做兼容。
- 主模型存错的记忆靠出处校验、历史版本和做梦纠正；论文里模型自己管记忆不一定更好（MemDelta 42% 对 47%，<https://arxiv.org/abs/2606.29914>），评测盯住漏记和记错。
