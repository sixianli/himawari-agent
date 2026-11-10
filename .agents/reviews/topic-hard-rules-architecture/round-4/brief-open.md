# 问题：用户的“硬规则”怎样从架构上接入 Himawari Agent

请你开放地思考，不受任何现成方案限制。下面只有需求、硬约束和已经核实的事实；没有给出任何方案，也不希望你从仓库里某个已有的规则实现出发去修补。请先想清楚“最好的架构应该长什么样”，再去查业界（各大 AI 公司、成熟开源 Agent 框架、策略引擎、通知系统等）的一手资料印证或推翻你的想法，最后再对照本仓库现状说怎么落地。你可以提出和主人设想不同的做法，但要说清理由。

## 主人（Andy）的需求，原话

- “用户规则，之前不是定下来该写成硬规则的落实到代码和测试……结合 pi agent 的现有功能，架构上我们要怎么把这些硬规则接入 himawari。”
- “像这些通用的硬规则（比如说静默时段），难道整个 Agent 项目的代码里面到处写的都是吗？……怎么把这些硬规则很方便地从项目里面插拔。”
- “以后用户可能还会有非常多的硬规则加入到整个 Himawari Agent 里面……比如说现在是有静默规则，那过两天我又有一个规则：所有涉及金钱的通知，如果金额大于 100 块才通知我，小于 100 块就不通知。难道又要把这个规则写得到处都是吗？”
- “Pi 它不是有扩展功能吗？那我们这些所谓的用户硬规则不是要写成程序吗？”
- “我期望的是这样：把所有的规则都加到 Pi agent 的 loop 里面去。比如有一封订阅邮件，需要我赶快去支付 90 块钱。这封邮件送到 Pi agent 的 loop 里面后，模型判断这个是需要推送的。在调用推送工具之前，模型先扫一下现在往 Himawari agent 系统里注册的硬规则都有哪些。当它发现有一条规则是‘小于 100 块钱就不给用户发推送提醒’时，它就不会再调起发推送这个工具了。”
- “我举的只是邮件这个例子。你在考虑硬规则接入我们 Himawari Agent 这个系统的时候，要站在架构的角度去思考，而不是陷到某一个具体功能里面去。”

## 硬约束（项目规则，必须满足）

1. 规则是硬性设定，不是记忆：`docs/product-vision.md` 第 59 行附近“规则本身写进程序、必定执行，每条都有回归测试守着”；“记忆只保存一条规则的出处和修改历史”。
2. 主人的具体偏好是数据，测试按规则类型写；一句话变长期规则要经主人确认：`docs/adr/0163-*.md` 决定 1、2、4。
3. 产品原则的裁决顺序：用户主权 > 边界与可逆性 > 记忆可靠性 > 主动性与效率（`docs/product-vision.md`）。
4. 发给模型的内容只能往末尾追加，每轮会变的内容只放最后一条消息，系统提示和工具定义按对话冻结（`.claude/rules/prompt-prefix.md`）。
5. 在 Pi 上开发先照 Pi 官方写法，偏离要单独出方案（`docs/pi-development-guide.md`）。只有 `packages/runtime-pi` 能导入 Pi 包。
6. 只有主人一个用户；不必为旧数据兼容花心思。

## 已核实的事实（可自行再查）

- Pi 是 Himawari 的 Agent 框架（npm `@earendil-works/pi-*`，锁定 1.5.0），官方文档 https://github.com/earendil-works/pi/tree/main/packages/coding-agent/docs ，扩展事件见 extensions.md（`tool_call` 可拦截、`tool_result`、`context`、`before_agent_start`、`agent_before_settle` 等）。Pi 自己没有权限系统。
- 现有审批（等主人批准，可能几小时、跨服务重启）写在工具的 execute 里，主人已批准保留（`docs/adr/0204-*.md`）。
- 邮件主动检查由 Himawari 自己的定时器触发（`apps/agent-service/src/production-proactive.ts:194`），判断邮件是单次模型调用而不是 Agent 循环（`packages/application/src/services/proactive-mail-check-service.ts` 的 `#judge`）。
- 浏览器推送由一个后台循环产出（`apps/agent-service/src/production-web-push.ts` 的 `#collect`），来源包括到点提醒、待审批、任务完成、邮件主动提醒、Muse 通道中断，都不经模型。
- 现有规则散在多处：`packages/application/src/services/proactive-rules.ts`（静默时段 `quietUntil`、重要发件人等）、`attention-policy-service.ts`（另一份静默时段）、`action-policy-service.ts`（动作授权，已有 ALLOW/ASK/DENY）、`docs/agent-rulebook-inventory.md`（54 条规则盘点）。

## 请你交付

1. 你认为最好的架构（规则怎么表示、在哪里生效、怎么插拔、模型扮演什么角色、程序扮演什么角色），用主人能听懂的话先写一段总述。
2. 主人的设想（模型先扫规则、不调推送工具）你同意哪部分、不同意哪部分，为什么。
3. 业界一手资料印证（附网址和原话）。
4. 用“金额小于 100 不推送”和“23:00–07:00 静默”两个例子走一遍完整流程，再举一个和通知无关的规则例子走一遍，证明架构不只适用于邮件。
5. 风险、代价（包括 token 费用变化）和你放弃了什么。
