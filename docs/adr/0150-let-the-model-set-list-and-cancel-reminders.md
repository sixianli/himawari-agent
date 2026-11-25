---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-11-02"
covers: "apps/agent-service/src/production-reminder-writer.ts"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0150：让对话里的模型能设、查、取消提醒，提醒页和对话共用一个写入入口

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [放弃的做法](#options)
- [业界做法](#industry)
- [后果](#consequences)
- [没有处理的部分](#open-questions)

<a id="context"></a>

## 背景

2026-11-01 Andy 的线上体验清单第 6 条：在对话里说「设一个周五交周报的提醒」，模型回答没有能设置定时通知的工具，只写进了文件，随后还说「记住了」。原因是对话里的模型没有任何设提醒的工具；提醒只能靠每轮结束后的自动记忆提取偶然产生。提示词里已不再允许模型声称已设（提交 b9b19e9），但它仍然真的设不了。

[返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. 新增三个模型工具，追加在工具定义列表的最末尾：`reminder_set`（事项、主人当地时间、是否每年）、`reminder_list`（列出还没到点的提醒）、`reminder_cancel`。工具描述里不放任何随轮变化的值；当前时间和时区继续只出现在最后一条消息里（[ADR 0149](0149-append-only-model-requests.md)）。
2. 一个共用的写入类 `ProductionReminderWriter`（`apps/agent-service/src/production-reminder-writer.ts`）：一条 commitment 记忆加一条提醒，沿用「一条记忆至多一条提醒」，不新增表。时间解析复用自动记忆提取已有的 `reminderSchedule`，按主人配置的时区解释；已过去、超过两年的时间，以及含机密或证件号的文字，都拒绝，并把原因返回给模型，要求它如实告诉主人。
3. 提醒页的「新建提醒」走新命令 `memory.reminder.create`，同一个写入类。设提醒只有对话和提醒页这两个入口，记忆页的「手动添加一条」不加时间字段。
4. 权限：只写主人自己的提醒，随时可取消，不弹批准卡（依据：用户主权、边界与可逆性）。

[返回阅读导航](#contents)

<a id="options"></a>

## 放弃的做法

- 只改提示词或自动提取：没有工具就没有「真的设了」的证据，不是根因修复。
- 新建提醒表、模型直接写提醒：会出现没有记忆出处的提醒，和记忆页、历史记录对不上。
- 提醒页和对话各写一套：同一个功能两个入口，时间规则迟早不一致。

[返回阅读导航](#contents)

<a id="industry"></a>

## 业界做法

- ChatGPT 的定时任务：在对话里让它做事时由模型提议时间，创建后屏幕上有确认；「Scheduled」页同一份任务列表可新建、暂停、编辑、删除（[OpenAI 帮助中心](https://help.openai.com/en/articles/10291617-scheduled-tasks-in-chatgpt)，该页本次未能直接打开，依据的是搜索结果对该页的摘要，未逐字核对）。
- Claude Code：对话里说一句话由模型调用 CronCreate / CronList / CronDelete，「Claude pins the fire time to a specific minute and hour … and confirms when it will fire」（[文档](https://code.claude.com/docs/en/scheduled-tasks)，已逐字读过）。

我们和它们一致：模型有真正的创建工具，把确切时间说给主人，主人能在一个页面看到并取消。

[返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 上线时工具定义末尾多了三项，所有进行中对话的缓存会失效一次；Andy 已同意（2026-11-02 项目聊天）。此后同一对话内工具列表不变。`npm run check:prompt-prefix` 新增带 `reminder_set` 的多轮用例，通过数要求从 7 条改为 8 条。
- 模型从网页内容里读到的指令也可能诱使它设提醒。影响有限：提醒文字过机密扫描，主人在提醒页看得到、能取消；权限上不扩大。
- 还没有任何记忆的新账号暂时设不了提醒（写记忆需要已有的记忆代次），提醒页的按钮在这种情况下隐藏，工具如实返回失败。

[返回阅读导航](#contents)

<a id="open-questions"></a>

## 没有处理的部分

- 提醒到点只在网页打开或已开启 Web Push 时送达，没有新增通道。
- 记忆整理失败的根因（辅助调用被判定返回了工具调用或输出被截断）本 ADR 不涉及，等带诊断日志的版本上线后查，见 [I-63](../incidents-and-gates.md)。
