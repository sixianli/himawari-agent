---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-11-09"
covers: "packages/application/src/services/context-formation-service.ts, packages/application/src/services/model-invocation-admission-service.ts, packages/application/src/services/model-visibility.ts, packages/memory-engine/test/episode-backfill.unit.test.ts, packages/runtime-pi/src/pi-runtime-adapter.ts, packages/runtime-pi/test/prompt-prefix.compat.test.ts, scripts/delivery-mode/packet-template/maintenance/production-shape-config-template.json, test/integration/memory-model-visible.test.ts"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0193：存入记忆的内容必须能被模型看到（模型可见上限和运行分级分开）

> 2026-11-24 补：[ADR 0286](0286-the-main-model-reads-and-writes-memory-itself.md) 决定记忆不再标“敏感”，所有记忆原样给模型；本文为敏感记忆设的上限随标记一起去掉。

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [前提](#premises)
- [决定](#decision)
- [放弃的做法](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

Andy 2026-11-09 定的产品原则：“存入记忆的内容必须能被模型看到”。凭证类内容以占位符给模型（占位符的写法另由第 4 个 PR 定）。

动手前的现状：数据分级有四档，从低到高是 public（公开）、private（私有）、sensitive（敏感）、restricted（受限）。一次对话运行（run）带一个分级，原来的代码用这个分级同时决定两件事：

1. 这次运行能用哪些记忆、历史和资料。配置项 `maxMemoryClassification` 生产上是 `private`，所以 sensitive 记忆一律被挡在模型外面。
2. 这次运行的工具调用、推送和日志按什么级别处理。

结果是：[ADR 0185](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0185-mark-passwords-and-keys-sensitive-instead-of-dropping-them.md) 把密码、密钥改成存原文并标 sensitive 之后，记忆页能看到它们，模型在对话里检索不到、档案块不带、整理和每日复盘看不到、Gmail 检查也不用。存进去的记忆模型用不上，违反上面的原则。

Andy 在方案 v3 上对三件事拍板“A、B、C 我都同意”：

- A：生产对话模型（DeepSeek）和嵌入模型（Qwen），两者都经 Vercel，允许名单加上 sensitive。名单加 sensitive，等于同意把敏感记忆发给这两家外部服务方（发出前仍经出口遮盖）。
- B：后台任务（记忆整理、事件段摘要、Gmail 检查、每日复盘）也能用敏感记忆。
- C：上线时一次性恢复因闲置被归档的记忆并重建索引，先报数量、先备份。C 由后续的第 2 个 PR 和上线步骤完成，不在本决定的代码里。

<a id="premises"></a>

## 前提

1. 原则冲突时的顺序：`docs/product-vision.md:55`，“原则冲突时，按序优先：用户主权 > 边界与可逆性 > 记忆可靠性 > 主动性与效率。”本决定按“用户主权”（Andy 明说存的要给模型看）和“记忆可靠性”（存了就能用）裁决；“边界”由服务方允许名单守住，见前提 3。
2. 原来的上限来自配置：main `fd283e43` 的 `packages/application/src/services/context-formation-service.ts:92` 是 `readonly maxMemoryClassification: DataClassification;`，第 151、183 行用它比较候选记忆的分级。
3. 真正的边界是服务方描述里的允许名单：`packages/application/src/services/model-invocation-admission-service.ts:482`，`if (!bound.descriptor.allowedDataClassifications.includes(dataClassification)) {`。名单里没有 sensitive 的服务方，不会收到 sensitive 的请求。
4. 密码不能被模型检索到是 ADR 0185 记下的代价：[`0185-mark-passwords-and-keys-sensitive-instead-of-dropping-them.md` 第 61 行（已删除）](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0185-mark-passwords-and-keys-sensitive-instead-of-dropping-them.md#L61)，“所以存下来的密码在记忆页能看到，但模型在对话里检索不到它……要让模型能用，需要另做经主人确认的敏感记忆读取路径。”
5. 生产名单原本只到 private：本次之前 `scripts/delivery-mode/packet-template/maintenance/production-shape-config-template.json` 的两个 `allowedDataClassifications` 都不含 `sensitive`，本次在第 65、107 行加上。

<a id="decision"></a>

## 决定

1. **两套分级分开。**“模型能看到什么”由固定的模型可见上限决定，上限是 sensitive，写在代码里（`packages/application/src/services/model-visibility.ts` 的 `modelVisibleCeiling()`），不再可配置；restricted 永远不给模型。[ADR 0286](0286-the-main-model-reads-and-writes-memory-itself.md) 决定 4 起，记忆不再标 sensitive：除密码、密钥（程序拒存）外，什么都原样记、原样给模型，本条的分级上限随之只剩“密码、密钥不进记忆”。运行分级（run 的 `dataClassification`）仍只管工具、推送和日志，聊天运行照旧是 private。
2. **配置项 `maxMemoryClassification` 退役。**配置里写了也接受但不生效，服务启动时记一行 `configuration.key_retired`。生产配置模板删掉这一项。
3. **按实际送出的内容定请求的分级。**同一次运行里，发给模型的请求分级取这三者的最高值：运行分级、本轮上下文投影实际含有的最高分级（`RuntimeProjection.contentClassification`）、本轮工具结果报告的最高分级（`RuntimeToolSettledResult.contentClassification`，例如记忆检索工具返回了敏感记忆）。这个分级同时用于准入检查、存历史、存最终回答、存压缩摘要和运行记录（模型请求、回答、工具结果的留档），所以只含 private 内容的对话仍按 private 发送，能继续用名单只到 private 的服务方；含敏感内容的那一刻起按 sensitive 发送，名单不含 sensitive 的服务方会被拒绝，请求不发出。
4. **派生内容取来源的最高分级。**记忆整理的推断、事件段和它的摘要、Gmail 检查带入的记忆、记忆检索工具的输出、档案块，都按它们所用记忆的最高分级标注和发送。主人消息里的附件（文件、图片）同样最多读到 sensitive，附件的分级算进这一轮的内容分级，不再因为高于运行分级显示成“读不出来”。Gmail 检查根据敏感记忆写出的提醒，按这次判断的分级存档。事件段补算向量时，每一段按它自己的分级发给嵌入模型，restricted 的不算向量。取几个分级中的最高值时（`highestClassification`），遇到不认识的分级值直接报错，不当作低分级处理；判断模型能不能看（`isModelVisible`）时，不认识的值按看不到处理。
5. **固定显示（置顶）只看类别。**敏感记忆不再因为敏感而不能置顶；健康、财务、事件、其他四类仍不能置顶（[ADR 0112](0112-memory-page-carried-memories-and-topic-browsing.md) 的类别规则不变）。
6. **生产的对话模型和嵌入模型名单加 sensitive**（Andy 的 A）。发出前的出口遮盖不变（[ADR 0286](0286-the-main-model-reads-and-writes-memory-itself.md) 决定 4 同样保留）：密码、验证码等仍按 [ADR 0183](0183-mask-only-when-data-leaves-and-keep-the-original-inside.md) 遮盖后再发。

<a id="options"></a>

## 放弃的做法

- **把 `maxMemoryClassification` 改成 sensitive 了事。**它和运行分级绑在一起比较，只改配置会让整个聊天运行升成 sensitive，名单不含 sensitive 的服务方全部不能用，推送和日志也跟着按敏感处理，影响面超出需要。
- **整个运行固定按 sensitive 发送。**多数对话不含敏感内容，固定升级会无故挡掉名单只到 private 的备用服务方。按实际内容定分级，只在真用到敏感内容时升级。
- **敏感记忆每次给模型前先问主人。**Andy 2026-11-07 的要求是产品功能尽量不让他人工介入；他已经在名单这一处一次性同意，不再逐条确认。
- **可注入的统一策略对象。**原计划把“模型能看什么”做成一个可替换的策略对象传给各通道。实际改成一个固定函数加每个通道各自的测试：上限不再可配置，可替换的对象没有用处。

<a id="consequences"></a>

## 后果

- 门槛（会自动拦下的测试）：
  - `test/integration/memory-model-visible.test.ts`：用真实的上下文组装、上下文投影和 Pi 适配器，对本机回环服务发请求。sensitive 记忆以 sensitive 准入、密码被遮盖、restricted 被排除；反向用例里名单只到 private 时请求被拒绝且没有发出；只含 private 内容时按 private 准入；记忆检索返回敏感记忆后下一次调用升为 sensitive；含敏感内容的历史在下一轮仍能带上。修复前这组用例失败，报错是 “context block Payload exceeds the Run data classification” 和 `RUNTIME_HISTORY_CLASSIFICATION_DENIED`。
  - `packages/runtime-pi/test/prompt-prefix.compat.test.ts` 的 `[RULE-memory-visible]`：敏感记忆和敏感检索结果在后续轮次里仍只追加、不改已发内容。
  - 同一个文件里：记忆检索返回敏感记忆后，最终回答按 sensitive 存（去掉修复时存成 private，用例失败）；主人消息带 sensitive 附件时附件内容进入模型视野、这一轮按 sensitive 准入（去掉修复时附件显示为读不出来、分级仍是 private，用例失败）。
  - 各通道的单元和集成测试：记忆整理、事件段、Gmail 检查（`[RULE-memory-visible]`）、档案块、每日复盘、记忆检索、置顶。
- 准入被拒时，记为这次运行失败，没有另记一条决策记录。
- 还没做、留给后续 PR：全文索引和实体索引仍不收 sensitive 记忆（[LEXICAL_CLASSIFICATIONS](https://github.com/sixianli/himawari-agent/blob/f9b138b52b360a0f09e4615d1324b0068802963f/packages/memory-engine/src/hybrid-memory-provider.ts)、[INDEXED_ENTITY_CLASSIFICATIONS](https://github.com/sixianli/himawari-agent/blob/f9b138b52b360a0f09e4615d1324b0068802963f/packages/persistence-sqlite/src/sqlite-memory-operations.ts)），在第 2 个 PR 和遮盖后建索引一起做。事件段补算向量已经按每段自己的分级标注（`packages/memory-engine/test/episode-backfill.unit.test.ts`）；sensitive 事件段目前没有检索词，不会被选去补算，第 2 个 PR 给它们建检索词后才会走到这一步。记忆的日期给模型（第 3 个 PR）、凭证占位符编号（第 4 个 PR）另做。
- 对“只追加”规则（`.agents/instructions/prompt-prefix.md` 第 4 条）的一次性影响：系统提示、工具定义和已存历史的字节不变，但老对话里以前因分级被挡在模型外面的 sensitive 历史消息，上线后第一轮会出现在历史中间，那个对话的请求开头变一次、缓存从那里起重算一次。Andy 2026-11-09 的原话：“做这个方案和后续开发的时候，不用去管以前的聊天记录，做得彻底一点。”所以不为此做迁移，规则文件第 4 条的例外里记了这一条。新对话不受影响。
- 后续：本决定部分取代的旧说法，在原 ADR 里加了指向本文的说明，决定内容不改：ADR 0185 后果里“sensitive 记忆不进全文和实体索引、不带入档案块”的代价、ADR 0112 第 3 条“敏感记忆不能打开置顶”、ADR 0158 第 3 条“敏感和受限的不进邮件检查”。

<a id="references"></a>

## 关联文档

- [产品愿景](../product-vision.md)
- [ADR 0112：记忆页的固定显示](0112-memory-page-carried-memories-and-topic-browsing.md)
- [ADR 0158：Gmail 检查带入相关记忆](https://github.com/sixianli/himawari-agent/blob/9a395ec730b7c96519309bf1199355a04d8199aa/docs/adr/0158-bring-related-memories-into-gmail-checks.md)
- [ADR 0183：只在数据离开时遮盖](0183-mask-only-when-data-leaves-and-keep-the-original-inside.md)
- [ADR 0185：密码、密钥标敏感而不是丢弃](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0185-mark-passwords-and-keys-sensitive-instead-of-dropping-them.md)
- 代码：`packages/application/src/services/model-visibility.ts`、`packages/runtime-pi/src/pi-runtime-adapter.ts`、`packages/application/src/services/context-formation-service.ts`

[返回目录](#contents)
