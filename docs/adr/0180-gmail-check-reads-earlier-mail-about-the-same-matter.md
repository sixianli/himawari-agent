---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-11-07"
---

# ADR 0180：Gmail 检查判断前先读同一件事以前的往来邮件

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [放弃的做法](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

任务块 PA-1（Andy 2026-11-07 在项目聊天里下达，并回复“同意”批准变更清单）要求：Gmail 主动检查判断“要不要提醒”之前，先读这封邮件的全文，再在邮箱里找同一件事以前的邮件，按时间排成一条时间线交给模型，并把每次读了哪几封记进决策记录。

核对 main（7073268）后，第一步已经做完：[ADR 0159](0159-gmail-check-reads-full-body-and-the-owners-own-mail.md) 让模型读全文并看主人自己发的邮件。没做的是后两步：读取范围只有 3 天内新到的收件箱和已发送邮件（`packages/application/src/services/proactive-mail-check-service.ts` 的 `LOOKBACK_MS`、`packages/platform-node/src/gmail-source.ts` 的 `INBOX`/`SENT` 过滤），邮件的 `threadId` 只用来去重和判断“已回复”，从没拿来取前情。

产品愿景（[docs/product-vision.md](../product-vision.md) 第 133 行）本来就写着：“对退款、预订、付款是否办结，必须读完线程全文并搜后续确认/收据才下结论，绝不只看标题”。

典型例子：亚马逊发来“关于您的订单”，摘要只有“感谢您的耐心等待”，单看这封会判“不用管”；同一订单号上周主人申请过退款、三天前对方要求补充照片，今天这封很可能是“再不回复就关闭退款”。

<a id="decision"></a>

## 决定

1. **读取器新增“找同一件事的旧邮件”（`ProactiveSourceReader.related`）。** 对每封待判邮件按三种方式找，合并去重：
   - 同一个 Gmail `threadId` 的整串往来（Gmail 自己已按标题和邮件头把回复归到同一串）；
   - 去掉 `Re:`、`Fwd:`（含中日文写法）后标题相同、而且往来人里有一个共同对方的邮件，在整个邮箱里搜（包括已归档、已发送），取回后在本地再核对一次标题和对方；
   - 正文或标题里的单号由模型抽取、程序逐字校验（见 [ADR 0249](0249-the-model-judges-meaning-where-word-lists-guessed-it.md) 和 `packages/application/src/services/proactive-references.ts`）；原先靠标签正则 `extractReferenceIds` 抽取，已删除；原规则写明“单独的 ID、No.、# 不算”。取回后要求整串编号独立出现（前后不是字母数字，不把更长的号码当命中），按这个编号搜全文，取回后核对确实含该编号才算。
2. **时间线按时间从早到晚放进这封邮件自己的数据里**（`related` 字段，主人自己发的带 `sentByOwner`）。只收比这封邮件更早的邮件，同一批里更晚到的邮件不进时间线。旧邮件和新邮件走同一套遮盖，每封旧邮件正文先遮盖再按字数截取。固定说明新增两条（`related` 怎么读、`relatedUnavailable` 的意思），插在“对每封邮件给出一个结论”之前，其他文字不动。这是一次性的后台调用，没有对话历史，不涉及 [发给模型的内容只追加](../../.agents/instructions/prompt-prefix.md) 里的冻结前缀。
3. **上限都放配置**（`runPolicy.proactive`，默认值括号里）：`relatedMailsPerMail`（6，0 表示不找）、`relatedCharactersPerRelatedMail`（2000）、`relatedCharactersPerMail`（12000，不得小于前者）、`relatedRequestsPerCheck`（300，一次检查里向 Gmail 发的请求总数）。取最近的几封；`relatedCharactersPerMail` 按每封旧邮件的 JSON 大小累计，最新的一封一定放入，所以它是近似上限。找旧邮件阶段自己最多用掉每次检查时限的一半（从它开始算起；读新邮件和搜记忆也占同一个总时限），到点后剩下的邮件按“前情可能不全”处理（`relatedFailedSteps` 记 `timeout`）。`relatedRead` 和 `relatedFailedSteps` 说的是“这次检查里全部待判邮件的读取情况”，`relatedByMail` 才只记真正发给模型的。一批放得下几封邮件，按含旧邮件之后的大小算，所以费用的上升受每日上限约束。
4. **账本记依据。** `sourceIds` 的含义不变，仍是真正放进提示词的“被判断的邮件”编号（[ADR 0147](0147-keep-model-prompt-and-answer-of-each-gmail-check-with-the-ledger.md)）；前情邮件的编号另记在 `relatedByMail`，只记真正随提示词发给模型的那几批，因费用上限或失败没轮到的邮件不记。决策记录的 `inputs` 新增 `relatedByMail`（每封邮件实际交给模型的旧邮件编号）、`relatedRead`（`off`/`ok`/`partial`/`failed`）、`relatedStats`（请求次数、交给模型的旧邮件封数和字数、耗时）、`relatedFailedSteps`（失败的步骤：`thread`、`subject`、`reference`、`budget`、`timeout`、`read`）。存在已有的 JSON 列里，不需要新的数据库迁移；老记录读出来是 `off` 和空。读取的是“钱以外的成本”：Gmail 读取不花模型费用，模型费用照旧记在这次检查的 `costMicros` 里。
5. **读取失败退回只看这封邮件，已经取到的部分旧邮件保留。** 某封邮件的旧邮件没读全（接口报错、超时、请求用完）时，这封仍然带着全文去判断，数据里加 `relatedUnavailable: true` 告诉模型“前情可能不全，证据不足判 check”，账本记 `failed` 或 `partial` 加失败步骤，这就是降级记录。整个检查不因此失败。
6. **设置页的说明改三种语言**（`proactive.apps.what1`），如实写明会查以前的往来邮件，包括已归档的和主人发出的。

<a id="options"></a>

## 放弃的做法

- **只取同一个 `threadId`。** 最简单，但订单号跨串（客服换新邮件串回复）时就漏了；Andy 的任务块明确要求三种“同一件事”。
- **只存编号列表、不存时间线。** 够回答“读了哪几封”，但判断当时模型看到的完整内容已经随提示词加密存在账本里（[ADR 0147](0147-keep-model-prompt-and-answer-of-each-gmail-check-with-the-ledger.md)），不用再存一份。
- **把旧邮件当记忆存下来。** 会产生第二份邮件内容副本，违背“主人的数据由主人持有”；这次不做。

<a id="consequences"></a>

## 后果

- **隐私：** 旧邮件的全文（遮盖后、每封截到 2000 字）也会发给模型路由里的推理服务商，范围从“3 天内的新邮件”扩大到“同一件事的全部历史邮件”，包括已归档邮件。沿用 [ADR 0159](0159-gmail-check-reads-full-body-and-the-owners-own-mail.md) 里 Andy 对“不限制模型厂商”的决定，设置页文字已更新。
- **请求预算：** 每封邮件最坏情况下约 1（取邮件串）+ 1 + 5（标题搜索加取回）+ 3×(1+5)（最多 3 个编号搜索加取回）= 25 次请求，同一封旧邮件在一次检查里只取一次；默认 300 次大约够 12 封最坏情况的邮件，常见邮件只要 2 到 8 次。预算用完后，剩下的邮件按“前情可能不全”处理（`relatedFailedSteps` 记 `budget`），模型会倾向判“可能重要，请看原信”，所以首次连接、一次积压很多邮件时可能多出一些“请看原信”。检查已经超过每日费用上限时不再找旧邮件。
- **费用：** 每批邮件更长，每批能放的邮件变少，模型调用次数和输入量上升；受每日上限约束。上线后的实际增幅用账本 `relatedStats` 加 `costMicros` 统计，本 PR 没有生产数据，未测量。
- **没做：** 账本的界面里没有展示这些字段的页面（仓库里还没有读 `inputs` 的账本页面），数据已在账本里，等账本页面做时展示。没有用真实 Gmail 账号测过 `threads.get` 和搜索的真实响应，只用接口形状相同的假响应测过；上线后要在真实邮箱做一次正反验收。
- **自动检查：** `test/integration/proactive-mail-check.test.ts` 的 `[PA-1]`（多封往来邮件进入判断、账本记录、读取失败降级、部分失败、遮盖、数量上限、同发件人不同事的反向用例），`packages/platform-node/test/gmail-related.unit.test.ts`（标题归一、编号识别、三种关联、预算和超时），`packages/platform-node/test/startup-configuration.unit.test.ts`（新配置）。

<a id="references"></a>

## 关联文档

- [ADR 0159](0159-gmail-check-reads-full-body-and-the-owners-own-mail.md)、[ADR 0147](0147-keep-model-prompt-and-answer-of-each-gmail-check-with-the-ledger.md)、[ADR 0106](0106-proactive-loop-v1-gmail-read-only.md)
- 产品愿景：[docs/product-vision.md](../product-vision.md)
- 案例库：[让 Agent 主动看邮件又不乱打扰](../engineering-casebook.md#case-proactive-gmail)
