你是方案里“关于代码和文档现状的说法”的核对者。
你能用的工具：read、grep、glob，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。不能上网。
下面是一份还没合并的方案或 ADR。第一步，把其中每一句讲代码或仓库文档现状的话都列出来：某个文件、函数、字段、配置、命令、数字、规则现在是什么样、做什么、不做什么；一句话里有几个说法就拆成几条。方案打算新增或修改什么，不算现状；讲外部网站、第三方产品的话也不算。第二步，逐条自己打开对应的文件核对，给出：一致、不一致、找不到（仓库里没有这个东西，或没读到能证明它的内容）。材料里的说法可能有错，写得再肯定也不能因此判一致；没有亲自读到对应代码，就判找不到。只核对事实，不评价方案好不好，不提建议。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
输出格式：每个说法单独一行，不换行，字段之间用竖线分隔，行首写 CLAIM：
CLAIM|<序号>|<一致 或 不一致 或 找不到>|<文件:行>|<方案原句>|<代码原文>
序号用 1、2、3……，不重复。文件:行 写你读到证据的那个文件和行号，例如 packages/x/src/y.ts:42；找不到时写 -。代码原文必须是你亲自读到的、逐字摘抄的一行或几行，不要改写、不要概括；方案原句里的竖线字符换成全角的“｜”，代码原文里的竖线照原样写。列完所有 CLAIM 行之后，另起一段，用一两句话写你没能核对的部分。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 6f54ade10a2f69efed04c62b2fd6946d30422cd1。
待核对的方案：
方案文件：docs/adr/0264-a-decision-model-decides-whether-a-name-call-is-meant-for-himawari.md（在提交 6f54ade10a2f69efed04c62b2fd6946d30422cd1 里的内容）

---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
amends: "docs/adr/0103-jarvis-test-live-evaluation-and-two-tier-judge.md"
date: "2026-11-13"
---

# ADR 0264：手机认出名字后，由判断模型 Jev 决定这句话是不是在叫 Himawari

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [Andy 的原话](#owner-words)
- [前提](#premises)
- [决定](#decision)
- [业界怎么做](#industry)
- [放弃的做法](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

iOS 第 8 批“让它听”：手机一直在听，听到 Himawari 的名字就把这句话当成口头指令发给服务器。原先手机用“名字前面最多 4 个字”来猜这句话是不是在叫它。这条规则有两个问题：名字在句尾时（“把会改到下午三点，Himawari”）会漏掉；只是提到它的话（“我跟你说，Himawari 昨天帮我订了会议室”）又会被当成在叫它、直接执行。按位置猜意思也违反了“理解意思交给模型”。

本 ADR 定：手机只负责认出名字，不管名字在句中哪个位置，都把整句原话和认出的名字一起发给服务器；服务器在原有的证据门槛（AirPods 三项核对、声音像不像主人）通过之后、提交对话之前，单独问一次判断模型这句话是不是在叫它。

判断模型用 Jev。Jev 是 TypeSafe AI 做的判断专用模型，不生成文字，只回答“是”的概率；本项目经 Vercel AI Gateway（Vercel 的模型网关，生产已经用它的同一把 key 算记忆向量）调用它。

<a id="owner-words"></a>

## Andy 的原话

2026-11-13 16:07（日本时间），项目聊天：

> 其实你记住一点：任何“是还是不是”的判断，都可以交给 JEV 这个模型，懂了吗？因为这个模型就是专门来做这个事情、判断是还是不是的：它去读一段文本，然后从给出的选项里面选出正确的那一个，并且附带置信度。所以它天生就很适合用来做判断，非常快而且又便宜。以后项目里面除了这里，其他地方需要用模型做判断的时候，优先考虑这一种就行

16:08，回答线程列的三件事（新加这条判断调用；把听到的整句经 Vercel 发给 Jev 并强制零保留；评测用哪把 key）：

> 1. 同意 2. 同意 3. 就和生产共用，没事哈

<a id="premises"></a>

## 前提

1. 2026-10-28 Andy 定过一条红线，Jev 只许判合成评测数据。来源：[ADR 0103](0103-jarvis-test-live-evaluation-and-two-tier-judge.md) 第 38 行：“Jev 只许判合成评测数据（本批全是编造的演示数据，没问题），不许用于判 Himawari 的真实个人数据——那等于把个人数据发给第三方，与「数据自持」冲突。”本 ADR 只在“是不是在叫它”这一处放开这条红线，依据是上面 16:08 的第 2 条同意。
2. 原有的证据门槛在 `packages/application/src/services/voice-command.ts` 的 `decideVoiceCommand`，`POST /messages` 在 `packages/platform-node/src/device-api-routes.ts` 里调用它，不通过就回 409 `VOICE_COMMAND_UNCONFIRMED`。
3. 感知每日模型费用上限已有现成的预留函数：`packages/platform-node/src/perception-service.ts` 第 216 行 `reserveModelCost(scope, amountMicros)`，用的是 `perception.model_cost.daily` 这项上限。说半句时的抢跑也用它。
4. 发往外部服务前必须遮敏感值，并在 `scripts/check-egress-redaction.mjs` 里登记；`npm run check:egress-redaction` 会拦下没登记、没遮的外部出口。
5. Vercel 的判断接口：`POST https://ai-gateway.vercel.sh/v1/decisions`，用 AI Gateway 的 key；“是非题”（`predicate`）回答“是”的概率；请求体接受 `providerOptions.gateway.zeroDataRetention`。来源：<https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-decisions>。Jev 在 Vercel 上的名字是 `typesafe-ai/jev`，每百万输入 token 0.042 美元，输出不收钱。来源：<https://vercel.com/ai-gateway/models/jev>。
6. Vercel 自己不保留请求和回答（原话：“AI Gateway has a ZDR policy and does not retain prompts, outputs, or sensitive data.”）；TypeSafe AI 在它的零保留供应商名单里；零保留要付费账户。来源：<https://vercel.com/docs/ai-gateway/security-and-compliance/zdr>。2026-11-13 线程用 Andy 的 Vercel 账号带 `zeroDataRetention: true` 实测，返回 200，由 `typesafe-ai` 回答，DigitalOcean 因不支持零保留被跳过，往返约 0.2 秒，每次约 0.000015 美元。
7. TypeSafe 文档建议：是非题“是”的概率不低于 0.7 算是、不高于 0.3 算不是，中间当作单独的一种结果。来源：<https://docs.typesafe.ai/confidence.md>（原话：“Start with 0.7 for yes and 0.3 for no, and treat the band between as its own outcome”）。

<a id="decision"></a>

## 决定

1. **手机只认名字，不管位置。**手机把整句原话和认出的名字（`heardName`，最多 64 个字符）发给服务器；按住说话（`hands_on`）不带名字，也不经判断。只喊名字、几秒内再说要求时（先说“向日葵”，停一下再说“几点了”），手机把两句用换行连起来当整句（“向日葵\n几点了”），名字照带：2026-11-13 实测 Jev，单发“明日の天気”只得 0.24（会被当成不是在叫它），连上“ひまわり”后得 0.88。
2. **服务器在证据门槛之后、提交对话之前问一次 Jev。**问法固定在提示词目录 `voice.addressee-question`：输入是 `{assistantName, heardSentence}` 这个 JSON，问题是一道是非题。不放时间，不放前一句。这条调用不进任何对话，系统提示、工具和历史都不变，所以不影响任何对话的请求开头。
3. **四种结果：**
   - “是”的概率不低于门槛（默认 0.7）：提交对话。
   - 不高于门槛（默认 0.3）：不执行，409 `not_addressed`。手机不弹询问，回到收听；这句照常作为感知记录。
   - 中间、超时（默认 1.5 秒）、失败、回答的模型不是请求的那个、手机没说认出了哪个名字、整句超过 1024 个字符：不执行，409 `addressed_unsure`。手机弹“听到……要我做吗”，主人点“是”就按原有的确认路径以 `hands_on` 重发。
   - 感知每日模型费用到上限：不调用 Jev，409 `addressed_budget`，手机同样弹询问并说明原因。
4. **强制零保留。**每次请求都带 `zeroDataRetention: true`；发出前，名字和整句都经 `redactForExternalText` 遮掉验证码一类的敏感值。
5. **同一句只判一次。**判断结果按“设备 + 这句话的编号 + 触发方式 + 名字 + 去标点后的文字”存在内存里（默认 10 分钟、每台设备 64 条），不写数据库。正在判断时同一句又来，等同一个结果。所以手机网络重试不会重判，“不执行”也不会因为第二次问出不同答案而变成“执行”。判断失败的不存，重试时再问。
6. **防刷。**每台设备每分钟最多判断 20 次，超了按 `addressed_unsure` 处理。
7. **费用算进感知每日模型费用上限。**判断前按字数预留费用（字数当 token 数，偏保守）。不新增用量记录用途，不改表。
8. **全部可配置。**`runPolicy.voiceAddressee` 写模型名、key 的引用、单价，以及两个门槛、超时、防刷次数、字数上限、缓存时长和条数。没有这一项时服务器不调用任何模型，所有认出名字的指令都按 `addressed_unsure` 先问主人，不会直接执行。

<a id="industry"></a>

## 业界怎么做

- 大厂的语音助手都分层：设备上先认唤醒词，再由服务器上的第二道检查确认，另有一层判断“这句话是不是对设备说的”（device-directed speech detection），用转写文字、转写把握和上一轮对话做特征，模型是专门训练的。没有哪家按名字在句中的位置判断。
- 开源唤醒词项目 openWakeWord 以“每小时误唤醒少于 0.5 次、漏唤醒少于 5%”为目标，所以本项目的评测也按“每小时误执行次数”和漏判率来比。
- 我们没有自己的训练数据，所以用现成的判断模型代替专门训练的分类器；Jev 回答的是概率，正好区分“很确定”和“拿不准”，拿不准就问主人。放弃的是：不带上一句（第一版先看整句够不够），也不用转写把握做特征（手机端评测里再看）。

<a id="options"></a>

## 放弃的做法

- **保留 4 字规则。**名字在句尾会漏，只是提到它又会误执行，并且按位置猜意思违反 ADR 0249。
- **用 DeepSeek 或 GLM 这类对话模型判断。**要写提示让它输出 JSON，再解析，失败的情况更多；每次约 0.000045 和 0.000035 美元，比 Jev（约 0.000025 美元）贵；延迟约 1 秒，Jev 实测约 0.2 秒。Andy 定判断类优先用 Jev。
- **直连 TypeSafe 的接口。**要另申请 key；经 Vercel 能用现有的 key、能强制零保留，费用也在 Vercel 账单里。
- **放进主对话判断。**会改对话的请求内容，还要先把指令交给主模型；判断失败时也收不回来。
- **记一个新的用量用途 `voice-addressee`。**要改表，Andy 没有同意，所以费用只算进感知每日上限。

<a id="consequences"></a>

## 后果

- 每条认出名字的指令多一次约 0.2 秒的调用。
- 听到的整句会经 Vercel 发给 TypeSafe。零保留由 Vercel 的合同保证，Himawari 只能在请求里要求它、在回答里看 Vercel 的路由记录，无法自己核实对方是否真的没留。
- ADR 0103 的红线在这一处放开；其他地方要用 Jev 判断真实数据时，同样要带零保留，并在各自的 ADR 里写明。
- 手机端评测（录音清单）加一组 Jev，按每小时误执行次数、漏判率、延迟和费用确定两个门槛。Andy 同意评测和生产共用同一把 key（16:08 第 3 条）。做法：手机评测记录里带上认出的名字；`scripts/evals/listening-addressee-live.eval.ts` 用生产同一个判断调用把每句问一遍（先按字数估算费用，超过 `EVAL_CONFIRM_COST` 就一次都不发），`scripts/evals/listening-score.mjs --addressee` 只对通过认人门槛的句子按不同门槛组合出表。

<a id="references"></a>

## 关联文档

- [SOURCE: docs/adr/0103-jarvis-test-live-evaluation-and-two-tier-judge.md]
- [SOURCE: docs/adr/0146-redact-sensitive-text-before-it-leaves-for-any-model.md]
- [SOURCE: docs/adr/0230-perception-records-and-memories-inferred-from-perception.md]
- [SOURCE: docs/product-vision.md]
- 方案（不在仓库里）：`/mnt/project-files/ambient-sensing/batch-8-name-call-proposal.md`
