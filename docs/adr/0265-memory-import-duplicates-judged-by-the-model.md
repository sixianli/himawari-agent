---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
amends: "docs/adr/0249-the-model-judges-meaning-where-word-lists-guessed-it.md"
date: "2026-11-14"
---

# ADR 0265：导入记忆时，“是不是已经记着了”改由服务端的模型判断

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

导入记忆时，网页要标出哪些条目主人已经存过，标出来的条目不能勾选，也不会导入。原先网页用字符串相等或包含来判断：整理成同样的字（去空白、去开头的“我的”“主人”“用户”一类称呼、转小写）以后，两条相等，或者其中一条（长度超过 5）包含另一条，就算重复。换一种说法就漏掉，例如“对乳制品不耐受”和“喝不了牛奶”；字面上碰巧包含却说的是别的事，又会被误当成重复，例如已有“回答一律用简体中文”，导入“回答一律用简体中文，并且先给结论”，后一条多出来的要求就被丢了。Andy 2026-11-12 定、2026-11-13 补充的规则是：判断两句话是不是同一件事一律交给模型（[ADR 0249](0249-the-model-judges-meaning-where-word-lists-guessed-it.md)）。这一处是清查词表时发现的遗漏（起因记在 [I-100](../incidents-and-gates.md#incidents)），Andy 同意改。Andy 2026-11-14 又定：项目里“是还是不是”或“从选项里选一个”的模型判断，优先用 Jev（TypeSafe 的判断模型，经 Vercel AI Gateway 的 `/v1/decisions` 接口，带置信度）。

[返回阅读导航](#contents)

<a id="premises"></a>

## 前提

1. 原先的判重在网页：改动前的 `apps/control-center/src/memory-import.ts` 第 42 到 49 行 `isDuplicate`，其中 `(known.length > 5 && key.includes(known)) || (key.length > 5 && known.includes(key))`；整理文字的 `normalizeMemoryText` 里有 `.replace(/^(?:我的|我|主人的|主人|用户的|用户)/, "")`。本 PR 已删掉这段代码，现在的代码里找不到，所以把原文抄在下面（`git show 250455897:apps/control-center/src/memory-import.ts` 第 34 到 49 行）：

   ```ts
   export const normalizeMemoryText = (text: string) =>
     text
       .normalize("NFKC")
       .replace(/\s+/g, "")
       .replace(/^(?:我的|我|主人的|主人|用户的|用户)/, "")
       .replace(/[，。；、,.;!！]+$/, "")
       .toLowerCase();

   function isDuplicate(key: string, existing: readonly string[]) {
     return existing.some(
       (known) =>
         known === key ||
         (known.length > 5 && key.includes(known)) ||
         (key.length > 5 && known.includes(key)),
     );
   }
   ```

2. 服务端提交导入时不判重：`apps/agent-service/src/production-memory-control.ts` 的 `#importCommit`（第 1555 行起）逐条检查内容是否存在、是否可存，没有任何与已有记忆比较的步骤。所以网页漏判的条目会原样存成第二条。
3. 现成的向量检索不能直接用在网页的导入请求上：向量化要带运行上下文和执行租约（`apps/agent-service/src/production-memory-episodes.ts` 第 23 到 27 行的 `embedWithin(request, slot, operation)`），导入是网页发来的一次性查询，没有这个上下文。
4. 网页分类导入条目的做法是 [ADR 0260](0260-memory-classification-on-the-server.md)：网页把文字存成受保护内容，把引用发给服务端，服务端读出文字再处理。本决定沿用这个通道。
5. Jev 的接口：向 `https://ai-gateway.vercel.sh/v1/decisions` 发 `{model: "typesafe-ai/jev", input, questions, providerOptions: {gateway: {zeroDataRetention: true}}}`，每个多选题返回 `choice`、`confidence` 和每个选项的 `probabilities`。2026-11-14（日本时间）实测（见[决定](#decision)的第 6 点），响应里的 `answers[i].probabilities` 是 `[{value, probability}]`，用量 `input_tokens: 3237`、费用 `0.000135954` 美元（10 个导入条目对 5 条已有记忆）。
6. 发给外部服务的文字必须先过出口遮盖：`scripts/check-egress-redaction.mjs` 要求每个对外发文字的文件登记，并调用 `redactForExternalText`。
7. 发给模型的对话请求只追加：`.claude/rules/prompt-prefix.md` 第 4、6 条。本决定的调用是后台单独调用，不碰任何对话的系统提示和工具定义。

[返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **新增查询 `memory.import.duplicates.read`。**网页把每条导入文字存成受保护内容，把引用（最多 500 条）发给服务端；服务端读出文字，返回每条的判断 `same`（同一件事）、`unsure`（可能是）、`different`（不是）或 `skipped`（没能判断），`same` 和 `unsure` 带上对应已有记忆的编号。
2. **怎么比。**服务端取主人所有“可发给外部模型”（不是敏感、也不是受限）的已有记忆，最近改过的在前，默认最多 1000 条（`maximumExistingMemories`，可配置范围见 `IMPORT_DUPLICATE_RANGES`）；每个导入条目问一道多选题：选项是已有记忆的编号加 `none`。已有记忆换成 `m0`、`m1` 这样的临时编号，不把真实编号发出去。已有记忆每 200 条或 30000 个字符分一批，导入条目每 20 个一组，各组各批分别问，同一个条目取各批里概率最高的答案。不做向量检索，因为前提 3。
3. **什么算“同一件事”。**提示词（`packages/prompt-catalog/src/memory.ts` 的 `MEMORY_IMPORT_DUPLICATE_QUESTION`）写明：两条表达的事实一样才算，用词不同也算；只是话题相关，或者其中一条多了另一条没有的新信息，都不算。
4. **门槛。**所选条目的概率达到 70% 才判 `same`，高于 30% 但不到 70% 判 `unsure`，不高于 30% 或选了 `none` 判 `different`。两个数都是配置项，写在服务配置里，网页上没有改它们的界面（`runPolicy.importDuplicates`，范围和默认值写在 `packages/application/src/ports/configuration.ts` 的 `IMPORT_DUPLICATE_DEFAULTS` 和 `IMPORT_DUPLICATE_RANGES`）。网页上：`same` 标“已经记着，跳过”并且不能勾选；`unsure` 标“可能已经记着，默认不导入”，主人可以自己勾；`skipped` 标“没能核对是否重复，默认不导入”。
5. **失败怎么办。**网络、额度、响应格式、模型拒答，任何一环失败，该条目在那一份已有记忆上就没有结论：别的请求已经找到“同一件事”或“可能”的，照常保留；其余没找到的，判 `skipped`，不当成不重复。确定性检测命中的条目（证件号、卡号、密码等）不发给模型，也判 `skipped`，它们本来就默认不导入。每次查询先单独发第一个请求，等它返回再并发发其余的（并发 4 个），一次查询默认最多发 150 个请求（`maximumRequests`），每天默认最多 1500 个请求（`dailyMaximumRequests`，按 UTC 日计，服务重启后清零），超过的条目判 `skipped`；每个请求 15 秒超时。已有记忆读不全，或全部被挡掉（敏感、受限、确定性检测命中）时，找不到重复的条目判 `skipped`，已经找到的“同一件事”和“可能”照常保留。
6. **用 Jev，不用通用大模型。**这是“选一个选项”的判断，按 Andy 的新规则优先 Jev。2026-11-14（日本时间）用最终提示词做了 10 个条目的冒烟测试（不是正式评测）：5 个换了说法的条目，选中的都是对的那条已有记忆，概率分别是 100%、100%、100%、88%、100%；5 个不该命中的条目选了 `none`，其中“每周跑五次步”对“每周跑三次步”给了 48%（落在 `unsure`），数字不同本来就该让主人看一眼。费用 0.000136 美元。同一批条目换成只有一句话的简化提示词时，“喝不了牛奶”对“对乳制品不耐受”只给了 15%，所以提示词里的定义和例子不能省。
7. **配置和密钥。**`runPolicy.importDuplicates` 写模型名和密钥引用；密钥引用必须指向一条用途是 `model-auth` 的密钥，复用 Vercel AI Gateway 的那一条，不新增密钥。配置里没有这一项时，这个查询返回全部 `skipped`，网页的行为是“全部默认不导入、标没能核对”，不会回到词表。
8. **出口。**这条路由是主人在配置里明确写上的（模型名加密钥引用），不经过对话用的模型组合，所以没有“这个模型能不能看私有数据”的分级检查；这个检查在本决定里由三样东西代替：配置里写了才会发，敏感和受限的记忆与条目不发，发出去的文字先遮盖。请求体里的文字先过 `redactForExternalText`，模型走 `zeroDataRetention: true`；`packages/platform-node/src/memory-import-duplicate-decision.ts` 已在出口遮盖检查里登记。
9. **删掉词表。**网页删掉 `isDuplicate` 和 `normalizeMemoryText` 里去开头称呼的那条正则；同一批导入里完全相同的两行，仍按“去空白、转小写后相等”去重，这是格式处理，不是判断意思。这两处都不在 `docs/meaning-word-lists.md` 里登记。

[返回阅读导航](#contents)

<a id="industry"></a>

## 业界怎么做

- Mem0 写入记忆时，先检索出相似的已有记忆，再让模型在 ADD、UPDATE、DELETE、NONE 里选一个；NONE 的说明是“Make no change (if the fact is already present or irrelevant)”（[Mem0 的 `DEFAULT_UPDATE_MEMORY_PROMPT`](https://github.com/mem0ai/mem0/blob/main/mem0/configs/prompts.py)；论文：Chhikara 等，[Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory](https://arxiv.org/abs/2504.19413)）。判断同一件事的是模型，检索只负责缩小范围。
- 我们的做法和它一致：判断交给模型。区别是这里没有向量检索可用（前提 3），所以直接拿已有记忆（上限 1000 条）分批比较，换来的是不依赖向量检索、不会因为检索漏掉候选而漏判；代价是已有记忆多时请求数多。
- 放弃的是：像网页原先那样用字符串包含判重。

[返回阅读导航](#contents)

<a id="options"></a>

## 放弃的做法

- **保留字符串包含，再让模型补判。**两套判断结果会冲突：字符串说重复、模型说不重复，要再写一条规则裁决，词表也还在。
- **服务端在提交导入时判重，网页不预览。**主人看不到哪些条目被跳过，也没法自己改主意。
- **用向量检索先缩小范围。**前提 3：导入没有运行上下文；现有向量检索的召回门槛也是为对话取记忆调的，不是为判同一件事调的。
- **用通用大模型逐条写 JSON。**要写解析、处理格式错误，费用高出一个量级；Jev 的多选题直接给概率。

[返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 每次导入多发若干个小请求：10 个条目对 5 条已有记忆约 0.000136 美元；500 个条目对 1000 条已有记忆，最多 150 个请求，按每个请求约 2 万个输入 token、每百万输入 token 0.042 美元估计（单价由上面冒烟测试的账单反推：3237 个输入 token 花 0.000135954 美元），在 0.15 美元以内（估计，没有实测）。
- 已有的敏感记忆不参与比较，所以导入一条与某条敏感记忆相同的内容，不会被标成重复。
- 已有记忆超过上限（默认 1000 条）时，最早改动的那些不参与比较；这时没找到重复的条目判 `skipped`（不判 `different`），已经找到的“同一件事”和“可能”照常保留。
- 上线时生产配置里要加 `runPolicy.importDuplicates`，并指向 Vercel AI Gateway 的密钥引用；没加时导入功能照常，只是所有条目标“没能核对是否重复”。
- 这个判断是后台单独调用，不改任何对话请求的开头。
- 还没有做的：用几十条带标注的真实例子做正式评测，量一下误判和漏判的比例；评测前先把预计费用报给 Andy。

[返回阅读导航](#contents)
