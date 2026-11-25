---
status: active
document_type: adr
decision_status: accepted
supersedes: "https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0163-owner-preferences-as-data-run-by-tested-rule-types.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0209-rule-book-with-cel-expressions-and-judge.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0211-hard-rule-points-back-to-its-rule-memory.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0213-owner-sentence-becomes-a-standing-rule.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0215-decision-record-points-at-the-rule-version.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0244-hard-rules-step4-unified-push-gate.md"
superseded_by: ""
date: "2026-11-26"
covers: "packages/application/src/rules/rule-book.ts, packages/application/src/rules/rule-expression.ts, packages/application/src/rules/rule-judge.ts, packages/application/src/rules/rule-types.ts, packages/application/src/rules/rule-review.ts, packages/application/src/rules/field-catalog.ts"
verified_at: "7d0ffcd52cbb69d4941871cf9bf08d93f3843da8"
---

# ADR 0301：主人的规则手册

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
  - [偏好是数据，规则类型才是代码](#types)
  - [规则怎样表达和判断](#expression)
  - [一句话立规则](#from-a-sentence)
  - [推送的统一闸门](#push-gate)
  - [规则和记忆的对应](#memory-link)
  - [决策记录指向那一版规则](#versions)
- [放弃的做法](#rejected)
- [后果](#consequences)

<a id="context"></a>

## 背景

愿景 v2.2 起，Andy 定的规则是程序里必定执行的硬设定，不是记忆。规则手册怎样存、怎样判断、怎样从一句话立起来，原来分散在六份 ADR 里（0163、0209、0211、0213、0215、0244）。这份 ADR 只写现在为真的做法。旧文全文在 `supersedes` 列的固定提交链接里。

规则手册指每个 Himawari 实例（主人加 Agent）的一组规则，每条有固定编号、修订号、条件、结果、出处和状态。

<a id="decision"></a>

## 决定

<a id="types"></a>

### 偏好是数据，规则类型才是代码

- “每条规则有回归测试”指每种规则类型都有测试。主人的每条具体偏好是一行数据，由测过的规则类型执行；改主意只改数据，旧值留在历史表 `rule_book_history`。只有出现全新的规则类型才加代码和测试。
- 硬偏好（静默时段、某类邮件一定提醒等）由程序执行，每次因它提醒或不提醒都写进决策记录。软偏好（语气、长短、格式）存成文字交给模型参考，放进模型上下文时遵守 [只追加规则](../../.agents/instructions/prompt-prefix.md)。
- 规则类型登记在 `packages/application/src/rules/rule-types.ts`，每种写明闸门、结果和测试文件；没有测试文件的类型写入时拒绝（`RULE_TYPE_UNTESTED`）。现有主人规则类型：`mail_must_notify`、`mail_read_whole_thread`、`push_quiet_hours`。

<a id="expression"></a>

### 规则怎样表达和判断

- 规则条件用 CEL（Google 的受限表达式语言）写，实现用 `@marcbachmann/cel-js`，只允许白名单里的写法。
- 每个闸门有固定的字段目录（例如邮件的发件域名、文字，推送的类别和时刻），字段由程序算出，规则只读字段。
- 裁判 `RuleJudge` 输入闸门、字段和规则，输出所有命中的规则。字段缺失或类型不对直接报错，不当成“没命中”放过。
- 内置规则（公共机构域名、钱相关词等）写在代码的数据文件里，随版本发布。
- 门槛：`npm run check:rule-registry` 检查每条规则有出处、表达式通过类型检查、例子通过，并且例子改错时必须报错。

<a id="from-a-sentence"></a>

### 一句话立规则

- 对话工具 `rule_set`、`rule_list`、`rule_undo`。主人明说“以后 / 一律……”的直接生效，同时给一张回执卡，列出在近 30 天邮件上重算的命中数，带一键撤销；模型从对话里推断的，只作为提议，主人点头才生效。
- 规则参数只有发件域名、发件地址、词语、英文整词和排除词，有长度和条数上限，拒绝正则。主人规则的编号以 `owner:` 开头。

<a id="push-gate"></a>

### 推送的统一闸门

- 所有推送在发送那一刻经过闸门 `push_delivery`，同一来源键只判断一次。
- 审批、服务告警和认不出来源的推送由代码直接放行，不交给规则判断，规则写错也拦不住它们。
- 静默时段命中时推送延后（最多延后 24 小时），每次延后写一条决策记录。闸门或规则读取出错时推送照发并告警，不会悄悄吞掉。
- 设置页“发一条测试”不走闸门。

<a id="memory-link"></a>

### 规则和记忆的对应

- 规则记着它来自哪条规则类记忆（`source_memory_id`）。那条记忆被改、被取代、被删或改了类别时，数据库触发器把规则标成待重审（`needs_review`）；待重审的规则照常执行，之后的自动核对和暂停见 [ADR 0300](0300-how-memory-works-now.md#downstream)。

<a id="versions"></a>

### 决策记录指向那一版规则

- 决策记录的 `ruleIds` 写“规则编号@修订号”，读取时按版本去历史表查那一版的内容。依据抽屉显示规则种类、原文、出处、修订号，并用那一版的例子当场计算“例子是否全部通过”。

[返回目录](#contents)

<a id="rejected"></a>

## 放弃的做法

- 每条偏好写一份代码和测试：偏好一多代码就失控，改主意还要发版。
- 让模型直接判断要不要遵守规则：规则必须必定执行，不能看模型当时的发挥。
- 一切规则都先确认再生效：主人已经明说的话再让他确认一次是多余的点击；只有推断出来的才确认。

[返回目录](#contents)

<a id="consequences"></a>

## 后果

- 主人改一条偏好不需要发版，而且每次执行都能追到是哪一版规则。
- 新的规则类型要先写测试，否则写不进去。

[返回目录](#contents)
