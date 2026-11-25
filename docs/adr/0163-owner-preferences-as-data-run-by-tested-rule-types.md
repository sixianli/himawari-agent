---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-11-04"
---

# ADR 0163：主人的偏好是数据，由测试过的规则类型执行

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [没有决定的部分](#open-questions)
- [关联文档](#references)

<a id="context"></a>

## 背景

产品愿景要求：“规则不是记忆，是硬性设定：记忆只保存一条规则的出处和修改历史；规则本身写进程序、必定执行，每条都有回归测试守着。”（`docs/product-vision.md` 原则 3；采纳记录见 [ADR 0134](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0134-adopt-product-vision-v2-2.md)、[ADR 0153](0153-adopt-product-vision-v2-3.md)）

2026-11-04 Andy 在侧问（项目线程之外另开的一次问答）里提出一个顾虑：如果每条偏好都要写一批代码和测试，就太重了。例如他说“中午 12 点之后不要发提醒”，一周后又说“可以发了”，不该每次都去改代码。讨论之后，Andy 定下了本文的原则。

本 ADR 只记录 Andy 对这条愿景原则怎么理解、怎么落地，不改动愿景正文。

[返回阅读导航](#contents)

<a id="decision"></a>

## 决定

以下四条是 Andy 2026-11-04 在项目线程里定下的，由线程按原意整理。Andy 的原话开头是：“对‘每条有回归测试’的理解是：测试覆盖的是每种规则类型；我的每条具体偏好只是数据，由已经测试过的程序执行。不是每条偏好写一个测试。”

1. **回归测试按规则类型写，不按每条偏好写。**愿景里的“每条有回归测试”指每种规则类型都有测试。Andy 的每条具体偏好只是数据，由已经测试过的程序执行。线程的理解是：每条偏好的执行，由它所属规则类型的程序和测试来保证。
2. **硬偏好：由程序执行，并写进决策记录。**线程的理解是：每次因为某条硬偏好而提醒或不提醒，这次判断写进决策记录；偏好本身的出处和修改历史，按愿景原则 3 保存。
   - 例子：静默时段、某类事情不提醒、某人的事一定提醒、每天提醒的上限。
   - 程序为每种规则类型写一次代码和测试；Andy 的每条偏好存成一行设置，例如“静默时段 12:00–24:00，开启，来源：某天的某句原话”（示意，不是现有格式）。
   - 改主意时只改这行数据，不改代码；旧值留在历史里。
   - 参照 [ADR 0122](0122-every-owner-setting-on-the-server-with-revision.md) 对账户设置的做法：存在服务器上、带版本号。ADR 0122 的版本号只覆盖 `owner_preferences` 里的账户设置；现有的静默时段存在 `proactive_settings` 里，既没有版本号，改动时也会直接覆盖旧值、不留历史。这些怎么补，在机制方案里定。
   - 只有出现全新的规则类型，才要加代码和测试。
3. **软偏好：存成文字，交给模型参考。**
   - 例子：语气、回答长短、格式。
   - 放进发给模型的内容时，遵守 [.agents/instructions/prompt-prefix.md](../../.agents/instructions/prompt-prefix.md) 的缓存规则：不放进系统提示和工具定义里会变的位置，只有两个去处可选：最后一条消息，或者跟着提示词第二步的“按对话冻结”走。“按对话冻结”是提示词第二步方案里的一部分，Andy 2026-11-04 在项目线程里对这个方案的六项待定事项逐项拍了板，但还没有实现，也还没有写进 `.agents/instructions/prompt-prefix.md`；实现并改好规则之前，只能放最后一条消息。
4. **一句话要经过确认卡，Andy 确认后才变成长期规则。**一次性的拒绝不变成长期规则。
   - 后续：本条已被 [ADR 0209](0209-rule-book-with-cel-expressions-and-judge.md) 取代：主人明说的“以后 / 一律”直接生效并给带一键撤销的回执卡，模型推断出来的才要确认。本条原文不改。

[返回阅读导航](#contents)

<a id="open-questions"></a>

## 没有决定的部分

具体机制现在不做，包括：

- 要不要据此改写愿景原则 3 的措辞（愿景正文只有 Andy 能改）；
- 第一批规则类型有哪些；
- 怎么存储：表结构、版本号、历史怎么记；
- 程序在哪里拦截；
- 确认卡长什么样；
- 设置页怎么做；
- 软偏好在上面两个去处里选哪一个。

提示词第二步（见 [ADR 0161](0161-keep-every-model-prompt-in-one-catalog-package.md) 的“没有处理的部分”）分两部分先后做：先把会变的值挪出系统提示和工具定义，再按对话冻结。等前一部分完成后，按大改动流程另出方案：列出前提和来源，上网查第一手资料，两个模型各自出方案并互相审核，交 Andy 拍板，再写新的 ADR 或补进本 ADR。涉及界面的部分要先做原型。

[返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [ADR 0134](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0134-adopt-product-vision-v2-2.md)：采纳愿景 v2.2，规则成为硬性设定。
- [ADR 0153](0153-adopt-product-vision-v2-3.md)：采纳现行的愿景 v2.3。
- [ADR 0122](0122-every-owner-setting-on-the-server-with-revision.md)：主人的设置存在服务器上，带版本号。
- [ADR 0161](0161-keep-every-model-prompt-in-one-catalog-package.md)：提示词集中管理，第二步另出方案。
- [.agents/instructions/prompt-prefix.md](../../.agents/instructions/prompt-prefix.md)：发给模型的内容只追加。

[返回阅读导航](#contents)
