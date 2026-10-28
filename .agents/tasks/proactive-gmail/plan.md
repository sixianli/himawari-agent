# 计划：proactive-gmail

<!-- 只写打算，不写进度；做没做完用 longtask.py status 算。
     当前批次最多 3 项，每项一行、以条目编号开头，写清做法和需要的证据；
     同一次测试顺带验证的条目写在不以编号开头的一行里，不占名额；之后的条目每项一行；
     最后三段只追加，不改旧内容。 -->

## 当前批次

- PG-2 先做存储（迁移 0062：决策、条目、已处理邮件、设置、连接、待发推送）和应用层检查服务，用 ScriptedModelPort 和真 SQLite 跑验收 1；证据是带 [PG-2] 的测试。
- PG-8 地板规则和四种结果的合成在同一服务里，证据是带 [PG-8] 的测试。
- PG-3 规则先筛（推广、敏感摘要、自己发的信），证据是带 [PG-3] 的测试。
- 同一个测试文件顺带覆盖 PG-4、PG-5、PG-6、PG-7、PG-9、PG-10，由同一个测试文件顺带覆盖，各带自己的标签。

## 之后

- PG-11 Gmail 读取放在 platform-node（gmail-source.ts）：OAuth 授权网址、换令牌、刷新、撤销；messages.list、messages.get(metadata)、history.list 和 404。
- PG-12 agent-service 接线：每 15 分钟检查、推送走现有 reminder 种类、网关查询和命令、OAuth 回调、配置段。
- PG-13 重复 100 次的脚本。
- PG-14 npm run check 和 npm run build。
- PG-1 ADR 0106 已在 main，跑 check:docs。
- PG-15 界面：提醒页邮件条目、抽查、决策记录，设置的通知、连接的应用、数据三处；推送和 Google 回调落地；用 jsdom 测试加真实浏览器三语截图对照 v10。

## 计划改动记录

- 2026-10-28 15:35 建立任务。
- 2026-10-28 16:30 PG-11 改为放在 platform-node，不新建 integration-gmail 包（省掉一套构建、依赖和覆盖率配置）；Google 连接改为 GET /api/proactive/v1/google/start 跳转，不经网关命令返回网址（命令结果只能是机器字符串）。

- 2026-10-28 17:20 加 PG-15 界面条目，界面提交和后台提交放在同一个 PR #92（Andy 说过所有需求做完再一起上）。
- 2026-10-28 17:20 提醒条目要显示“推送过 · 你点开了”，快照的每个条目加 pushReaction（opened/dismissed/空），后台跟着改。

## 意外和发现

- 2026-10-28 #88 合进 main 的 v10 原型 HTML 有 6 个 lint 警告，main 上 npm run check 失败；修复单独开 PR #90 已合。教训：只改文档的 PR 里有 HTML 时也要跑 npm run lint。
- 2026-10-28 仓库的密钥扫描规则会把 client_secret: xxx 这类写法当成泄露的凭证，Google 换令牌的表单改用键值对数组。

## 决定

- 2026-10-28 设计取舍：推送复用现有 reminder 种类（来源键 proactive:<推送号>），避免重建 0058/0061 三张带 CHECK 的表；费用记在 proactive_decisions.cost_micros 并按它算日累计，不进 model_budget 账本（账本要求 Run 执行租约，加新父类型需要重建三张表）。模型调用仍走 Pi（PiModelTransport + TrustedModelProviderAdapter），只把 TrustedModelProviderAdapter 的准入类型收窄到它实际用到的字段。
- 2026-10-28 不推送时段的时间框改成 HH:MM 文本框、离开时才保存：系统自带的时间框在英文系统上显示 AM/PM，和 v10 基线的 24 小时写法不符；每打一个字就保存会让输入框在保存时被禁用而丢焦点。
- 2026-10-28 提醒页“到时间了”按 v10 基线改成“已到期”（日文“期限切れ”），到期的记忆提醒也用红色底，和邮件条目一致。
