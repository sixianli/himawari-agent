# PR 617 复核材料

## 问题
Himawari 的手机推送内容是程序拼的“对话标题 已完成”，每次运行结束都推。新设计（ADR 0285，规格 docs/execution/specs/2026-11-24-main-thread-subthreads-inbox-design.md 第 339-357 行）要求：新加一种推送“她的话”，内容是她写的那条消息的原话；安静时段默认管住它；主人正在 App 里看时不弹；同一件事不因程序重试响两次。

## 目标和约束
- 不改数据库表（web_push_feedback 在表冻结名单里），推送表 kind 仍写 reminder，用编号前缀 said: 区分。
- 推送编号＝来源种类＋来源编号＋版本，每段“长度:内容”，超 256 字符用摘要截短；推送表主键拒重复。
- 主人消息叫起的运行跑完推她的回话；外来事件叫起的不推；定时叫起的暂时照旧（后续步骤改）。
- 安静时段规则默认受管类别加 her_words；已明写 classes 的旧规则不自动加。
- 主人开着 App 时：服务器已有在线心跳（WebPushPresence），推送在可见时被压下；本 PR 让“可见”先于安静时段延后判断，避免时段结束后补发主人已看过的话。

## 作者的说法（请核对）
1. pushClassOf 对 kind=reminder 且以 said: 开头的编号返回 her_words，不会落到 unknown 绕过安静时段。
2. listFinishedRuns 新增的 startedBy、replyMessageId 两列查询在真实 SQLite 上正确，回话取这次运行最后一条已提交的 agent 消息。
3. herWordsPushKey 对不同事件不会产生相同编号（含分隔符碰撞、超长截短）。
4. 打开记录表 web_push_feedback 收 kind=reminder，所以“她的话”推送能记成已发出。

列出的说法只是参考，请从问题本身出发找问题，不要局限于这几条。

## 每次都要问的问题
1. 这个改动会不会改变模型已经见过的请求开头？（本 PR 改了 rule_set 工具的说明和参数结构；按 .agents/instructions/prompt-prefix.md 第 6 条，老对话会在下一轮开始时换新一次。）
2. 同一段文字会不会在不同请求里变成不同字节？
3. 改动有没有对应的自动检查，反向用例是否真的会失败？
4. 改动产生或修改的每个值（said: 编号、her_words 类别、startedBy/replyMessageId），每个使用它的地方都能接受吗？

## 第 2 轮新增
- 第 1 轮两条中高已修（没点名类别不存默认清单；敏感回话不上锁屏）。
- 管着 run_result 的安静时段规则同时管 her_words（她的回话接替了任务完成推送），见 rule-types.ts 的 pushQuietClassesOf。
- 新增通知页接口 quiet_hours.read / quiet_hours.set（apps/agent-service/src/production-quiet-hours-control.ts、production-owner-rules.ts 的 quietHours/setQuietHours），写的是同一份 push_quiet_hours 主人规则，带版本号防并发；立规则写入器在 production-http-composition.ts 里提成一个实例共用。
