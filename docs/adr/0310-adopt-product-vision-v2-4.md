---
status: active
document_type: adr
decision_status: accepted
supersedes: "https://github.com/sixianli/himawari-agent/blob/10dfa43248c29f0a958e92e4b9b2cffa3b48c056/docs/adr/0153-adopt-product-vision-v2-3.md"
superseded_by: ""
date: "2026-11-26"
covers: ""
verified_at: "10dfa43248c29f0a958e92e4b9b2cffa3b48c056"
---

# ADR 0310：采纳产品愿景 v2.4，每人一个只属于自己的 Himawari

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

愿景 v2.3 把 Himawari 定位成“只属于我的个人 Agent”，“我”只有 Andy 一个人。2026-11-14 Andy 叫停了多人工作，PRD v0.3 草稿也写“这一版只有 Andy 一个人用”。

2026-11-26（日本时间）讨论“每人一台电脑”时，Andy 改了方向。他先说：

> 那你还不如现在就从根本上去做支持多用户，预留干嘛？

随后在方案文档里针对愿景第 1 章那句“只属于我的”评论：

> 背景这里我同意改，改成每人一个自己的，也就是支持多用户，懂我意思吗？

愿景正文只有 Andy 能改，上面第二句就是他对这次改动的授权。

另有一处 Andy 已同意、但一直没进 main 的改动：2026-11-16 他说“追平 Muse 没办法评测”，要求把“以 Muse 为对照组量化”从愿景里去掉。这件事写在 PR 610（愿景 v2.4、ADR 0284）里，PR 和 main 冲突，一直没有合并。

<a id="decision"></a>

## 决定

1. 采纳愿景 v2.4：`docs/product-vision.md` 整篇替换，附录加第 19、20 条。
2. 多用户的形状是**每人一份、互相隔离**，不是一个 Agent 服务一群人。每个人有自己那一份 Himawari，只服务这一个人；不同人的对话、记忆、规则、工具和决策记录互相隔离，读不到、用不到别人的。愿景正文里的“我”读作每一份的主人。
3. 愿景里依赖“只服务一个人”的论证（为一个人过拟合、忠诚没有第二个对象、四样护城河资产）对每一份照样成立，所以只改主语，不改论证。具体改了：0 章定位、1 章愿景句、新增“每人一个”定义、“自有优先、数据自持”定义（当前部署改成实际的 Oracle 东京云主机，写明别人的那一份由运营者托管、主人能导出和删除自己的那一份）、原则 1（不效忠于运营者和别的用户）、3.3 对比表“服务对象”一格、第 4 章加“不做共用一个大脑的多人产品”。
4. PR 610 的改动并入本版（附录第 19 条）：3.3 删掉“以 Muse 为对照组量化（见 3.7 的配套指标）”，3.7 配套指标删掉“与对照组的差距”。PR 610 的 ADR 0284 不再使用，本 ADR 一并记录这两处改动。
5. 本 ADR 取代 [ADR 0153](https://github.com/sixianli/himawari-agent/blob/10dfa43248c29f0a958e92e4b9b2cffa3b48c056/docs/adr/0153-adopt-product-vision-v2-3.md)，并按[文档治理](../../.agents/instructions/document-governance.md)在同一个改动里删掉 0153。0153 及更早的 0134 里关于愿景地位的决定（愿景是最上层产品文档、正文只由 Andy 修改、新版本整篇替换并由新 ADR 取代旧 ADR、不再称“本地优先”）原样沿用。

<a id="options"></a>

## 比较过的方案

- **只在 PRD 里写“以后给别人用”，愿景不动**：Andy 11-26 已明确要现在就按多用户做，而愿景第 1 章写的是“只属于我”，PRD 不得违背愿景。不采用。
- **一个 Agent 服务多人（共用记忆和规则，按人区分权限）**：和原则 1“它只效忠于我”、护城河“只属于我的四样资产”冲突，也和 Andy 说的“每人一个自己的”不符。不采用。
- **只改多用户，PR 610 单独合**：两个 PR 都把愿景升到 v2.4、都取代 0153，会互相冲突，PR 610 已经冲突十天。并成一版更干净。采用并入。

<a id="consequences"></a>

## 后果

- 多用户从“暂停、等口令”变成现行方向。具体怎么实现（登录、按人分开存数据、每人一台电脑）在别的方案和 ADR 里定，本 ADR 不定实现。
- 仍要定的一件事：别人的那一份跑在 Andy 运营的服务器上，运营者在技术上能不能读到别人的数据，愿景没有承诺，留给多用户的实现方案回答。
- PRD v0.2 的产品目标改成“服务每一份的主人”；待办 BL-20261026-003 从暂缓改为待做。
- 不涉及代码、数据库和接口。

<a id="references"></a>

## 关联文档

- [SOURCE: docs/product-vision.md]
- [SOURCE: https://github.com/sixianli/himawari-agent/blob/10dfa43248c29f0a958e92e4b9b2cffa3b48c056/docs/adr/0153-adopt-product-vision-v2-3.md]
- [SOURCE: docs/backlog/BL-20261026-003-isolated-instance-per-person.md]
