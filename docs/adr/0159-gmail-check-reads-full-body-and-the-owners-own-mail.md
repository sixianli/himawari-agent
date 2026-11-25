---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-11-04"
covers: "packages/application/src/services/proactive-mail-check-service.ts, packages/application/test/proactive-mail-body.unit.test.ts, packages/platform-node/src/gmail-body.ts, packages/platform-node/test/gmail-body.unit.test.ts, packages/runtime-pi/src/configured-model-binding.ts"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0159：Gmail 检查读邮件正文，并把主人自己发的邮件也交给模型

> 2026-11-25 补：Gmail 检查不再调用模型逐封判断，新邮件改为进收件箱、由主对话里的她自己决定要不要告诉主人（[ADR 0285](0285-one-main-thread-subthreads-and-one-inbox.md) 第 1 步，PR 648）。本文里关于邮件判断提示词、判断结果和判断前带给模型的内容的部分已不再执行；规则手册、决策记录等其余部分照旧。

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [放弃的做法](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

Andy 2026-11-04 在项目聊天里做了三个决定，原话由协调者附在线程里：

- 只跳过垃圾邮件，其余邮件（包括他自己发出的）都交给模型看。起因是他自己答应别人的事（例如“周五前给你报价”）只写在他发出的邮件里，现在这类邮件在送模型之前就被规则丢掉了（`packages/application/src/services/proactive-mail-check-service.ts` 里原来的 `own_mail` 跳过）。
- 模型读邮件的全部内容（正文）。这改变了他自己此前保留的决定：[ADR 0134](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0134-adopt-product-vision-v2-2.md) 第 98 行“要不要让主动检查读正文，由 Andy 决定”（ADR 0134 现已被 [ADR 0153](0153-adopt-product-vision-v2-3.md) 取代，愿景 `docs/product-vision.md` 第 133 行本来就写着“对退款、预订、付款是否办结，必须读完线程全文并搜后续确认/收据才下结论，绝不只看标题”）。
- 记录里只存遮盖掉密码、卡号后的版本；这次只读新收到的邮件和已发送邮件；“只发给不保留数据的模型厂商”这一条他决定先不关注，所以本次沿用现有模型路由。

方案由线程和 OpenCode 上的两个模型（`deepseek-v4.1-flash`、`glm-5.3-flash`）各自独立出方案、再互相审核后整合。完整比较在项目文件夹 own-mail-to-model/plan-v2-full-body.md。

<a id="decision"></a>

## 决定

1. **只跳过垃圾邮件。** 主人自己发出的邮件（Gmail 的 `SENT` 标签）进入候选，由模型判断。`own_mail` 这个跳过原因保留在数据库允许的取值里（旧记录要能读），新代码不再写入。
2. **取信改成 `format=full`，一次取回。** `packages/platform-node/src/gmail-body.ts` 把 Gmail 返回的 MIME 树（邮件各部分的树状结构）抽成纯文本：
   - 同一封邮件的纯文本版和网页版并存时优先纯文本；纯文本不到 20 个字符（例如“请用 HTML 查看”）而网页版更长时用网页版。
   - 网页版用 `html-to-text` 9.0.5 转纯文本，丢掉脚本、样式、注释、隐藏块、图片和链接地址；零宽字符、方向控制字符一律删掉。
   - 按每一部分声明的字符集解码；字节里有 ISO-2022-JP 的转义序列时按 ISO-2022-JP 解；严格 UTF-8 合法就按 UTF-8；否则按声明的字符集，最后回退 UTF-8。
   - 不剥引用的历史邮件和签名，原样保留（剥离不可靠，剥错会丢掉承诺）。
   - 作为附件的部分不读，只列文件名、类型和大小。正文只以 `attachmentId` 形式另存、没有 `body.data` 时，标记 `bodyUnavailable`，不读附件，模型改看 Gmail 摘要。
3. **限长且只由这封邮件自己决定。** 每封邮件正文先遮盖，再按每封上限取头部 70% 加尾部 30%，中间放固定标记“……（中间省略）……”，并标 `bodyTruncated`。上限放配置：`runPolicy.proactive.bodyCharactersPerMail`（默认 16000，范围 500–200000）和 `bodyCharactersPerBatch`（默认 64000，范围 500–1000000，不得小于前者）。一批邮件的正文总量超过每批上限就换下一批，单封邮件的截断不受同批其他邮件影响。Gmail 读取层另设 20 万字符的硬上限，超过时也先遮盖再截，免得密码或卡号被截成半截而认不出。
4. **提示词。** 固定说明改一次：原来的“只能看到发件人、标题和一行摘要”换成能看到正文的说法，并加两条：`sentByOwner` 的邮件只有主人明确答应了将来要做的事才判“要你做事”，回执、致谢、确认判“不用管”；`bodyTruncated`、`bodyUnavailable` 时不要假设看过全文。这是对固定开头的一次性改动，让这个提示词的缓存失效一次。每封邮件的数据里有正文时不再送摘要；收到的邮件没有 `sentByOwner` 字段。“现在是…”仍在最后一行，邮件在它前面。
5. **送模型前逐封遮盖，账本存遮盖后的版本。** 发件人、标题、正文、附件名在拼提示词时各自用 `redactForEgress`（不带编号）遮住认得出的密码、验证码、银行卡号和证件号，结果只由这一段文字决定，不依赖同批其他邮件。`model.prepare` 存进账本的就是这份已遮盖的提示词；账本里模型的输入和回答不再保存原文；条目里加密保存的发件人和标题也先遮盖再存。其他内容（金额、病情、人名）认不出，不遮。
6. **自己发的邮件不套地板规则。** 重要发件人、官方域名、金钱词这三条地板规则只对收到的邮件生效；到每日费用上限时也不为自己发的邮件直接生成提醒。地板规则的匹配面仍是标题和摘要，不加正文。
7. **“已回复”改在判断之后按邮件串计算。** 只有当邮件串里最新一封自己发的邮件已经被模型判过、结果是“不用管”、把握是“有把握”，并且本次取到的邮件里没有更晚的候选邮件、数据库里该串也没有更晚的已处理邮件（见下面“已处理邮件的时间”）时，才把这个邮件串的待处理提醒标成已回复。产生了提醒的（例如承诺），用新提醒替换同一邮件串的旧提醒，不再被同一次检查里的“标记已回复”立刻关掉。没判到的（到费用上限、超时、模型输出无效）不关闭任何旧提醒，下次检查再判。
8. **记忆检索的查询。** 用“发件人（自己发的邮件不带）+ 标题 + 正文前 300 字（没有正文用摘要）”，各自先遮盖、再按字取前 300 字，最后合起来取前 500 字；这份查询文字会发给嵌入服务商，所以也先遮盖。
9. **模型写回的文字当不可信文本。** `todo`、`reason` 去掉 HTML、链接、不可见字符和控制字符再存，界面也不会自动变成链接。
10. **提示词注入。** 模型没有任何工具；正文只作为 JSON 字符串字段进入提示词；输出只接受批内的邮件编号和四选一的结果；标题、链接由系统生成。这些只能降低风险，不能保证。
11. **费用。** 沿用每天上限，调用前仍按提示词长度估算；单批放不下就拆批，一批至少放一封（配置要求每批上限不小于单封上限），所以单封放不下不会让检查卡住；每日费用上限、单次时限和模型输出无效仍会让检查停下。

<a id="options"></a>

## 放弃的做法

- **先取标题头判断是不是垃圾邮件，再对其余邮件取全文。** 主人一天收几封信，两次请求多一倍请求，只省下垃圾邮件正文的下载。
- **剥掉引用的历史邮件和签名。** 业界成熟库的成功率也只有约 92%（Mailgun 自己公布的数据），误剥会把承诺剥掉；改用头尾截断控制长度。
- **关键词规则先筛“答应、报价、截止”。** 违反“不写死”，多语言漏得多。
- **新增“承诺”结果类型。** 要改输出契约、提醒页和校准分桶；现有“要你做事”已经能表达。
- **把模型路由限制到零保留厂商。** Andy 2026-11-04 决定这次先不关注，沿用现有路由（见[后果](#consequences)）。
- **读附件内容、读整个邮件串历史、读已归档邮件。** 超出本次范围，列为第二阶段。
- **账本存原文。** 正文里的密码、卡号会以密文长期留在账本里，Andy 选了存遮盖后的版本。

<a id="consequences"></a>

## 后果

- **还没解决的隐私风险。** 邮件全文现在会发给模型路由里的推理服务商；路由只是优先顺序，会退回到备用厂商（2026-10-29 实测有 22 家，其中包含数据在中国大陆处理的）。遮盖只认得出密码、验证码、银行卡号、证件号。Andy 决定这次先不关注；要加硬限制，需要给 `packages/runtime-pi/src/configured-model-binding.ts` 的路由加 `only` 白名单并为 Gmail 检查单独建模型配置，另开方案。
- **已知限制。** 一个邮件串只有一条提醒，同串后到的覆盖先到的；“已回复”只看本次取到的邮件，已归档或不在本次窗口里的更晚邮件看不到；退款、预订是否办结需要整个邮件串，留给第二阶段。
- **“已回复”看已处理邮件的时间。** 已处理记录新增 `received_at`（迁移 0076，旧行为空，空值不挡）。一次检查要把某串的提醒标成已回复时，数据库里该串只要有一封已处理邮件比这封自己发的邮件更晚，就不标；这样积压超过一次取的 300 封、较新来信先处理的情况也不会误关提醒。
- **没核实的。** Gmail `format=full` 返回的正文是否已统一成 UTF-8（文档没写，现在的解码不依赖这点，但真实 Gmail 响应的样本还没抓）；一次取 300 封全文的耗时和配额；邮件头里的编码词是否已被 Gmail 解码。
- **旧决定的修订。** [ADR 0106](0106-proactive-loop-v1-gmail-read-only.md) 的决定第 3 条（模型不看正文）和第 7 条（不存正文）、[ADR 0158](https://github.com/sixianli/himawari-agent/blob/9a395ec730b7c96519309bf1199355a04d8199aa/docs/adr/0158-bring-related-memories-into-gmail-checks.md) 的决定第 5 条（跳过主人自己发的邮件）、[ADR 0147](0147-keep-model-prompt-and-answer-of-each-gmail-check-with-the-ledger.md) 后果里“等送模型前统一脱敏完成”的前置条件（[ADR 0148](0148-send-every-model-request-through-one-in-process-egress.md) 已落地），以本 ADR 为准。ADR 0147 决定第 8 条“不自动删除，断开或清除记录时才删”不变。
- **缓存。** 固定说明改一次，之后跨检查的缓存照常命中；每批邮件的内容本来就每次不同。
- **以前被 `own_mail` 跳过的邮件不回溯。**
- **自动检查。** [test/integration/proactive-mail-check.test.ts](https://github.com/sixianli/himawari-agent/blob/9a395ec730b7c96519309bf1199355a04d8199aa/test/integration/proactive-mail-check.test.ts) 的 `[OM-1]` 至 `[OM-10]`，`packages/platform-node/test/gmail-body.unit.test.ts`（`[OM-11]`），`packages/application/test/proactive-mail-body.unit.test.ts`（`[OM-12]`）。`[OM-1]` 至 `[OM-9]` 在旧代码上全部失败。
- **界面说明。** 设置页“Himawari 会读什么、发给谁”三种语言同步改写，不再说“不发正文”“不存邮件正文”。

<a id="references"></a>

## 关联文档

- [ADR 0106](0106-proactive-loop-v1-gmail-read-only.md)、[ADR 0147](0147-keep-model-prompt-and-answer-of-each-gmail-check-with-the-ledger.md)、[ADR 0148](0148-send-every-model-request-through-one-in-process-egress.md)、[ADR 0153](0153-adopt-product-vision-v2-3.md)、[ADR 0158](https://github.com/sixianli/himawari-agent/blob/9a395ec730b7c96519309bf1199355a04d8199aa/docs/adr/0158-bring-related-memories-into-gmail-checks.md)
- 产品愿景：[docs/product-vision.md](../product-vision.md)
- 规格：[主动闭环 v1 Gmail 设计](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/execution/specs/2026-10-29-proactive-loop-v1-gmail-design.md)
