---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-11-11"
covers: "apps/control-center/test/proactive-interactions.unit.test.ts, packages/application/src/ports/proactive-checks.ts, packages/domain/src/demo-persona.ts, packages/persistence-sqlite/src/data-export/import.ts, packages/platform-node/test/startup-configuration.unit.test.ts, test/integration/demo-data.test.ts, test/integration/proactive-production.test.ts"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0236：体验者用示范记忆和假收件箱，不碰任何真人的数据

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

多人方案（`/mnt/project-files/multi-user-plan/integrated-plan.md` 第 1.9 节和第五节第 6 块）规定：开体验就是加一个人，再导入示范数据（日语或英语）；邮件用假收件箱演示主动提醒。体验者一进来就应该看到记忆被用上、收到会触发提醒的邮件，又不能让他连上真实邮箱，也不能让任何真人的数据混进示范里。

本 ADR 只管这两样东西本身。体验者的创建、7 天到期、3 天没人用自动删除属于另一块任务（加人、删人、体验到期）。

[返回阅读导航](#contents)

<a id="premises"></a>

## 前提

1. 数据导入只认一种格式。来源 `packages/persistence-sqlite/src/data-export/import.ts` 的 `assertEmptyTarget`：目标库里已有记忆等数据就报 `DATA_IMPORT_TARGET_NOT_EMPTY`；导入的是记忆、人物、整理记录和决策。
2. 主动提醒读邮件只经过一个读取接口。来源 `packages/application/src/ports/proactive-checks.ts` 的 `ProactiveSourceReader`（`fetch`、`related`）。
3. 示范环境不接外部应用、可以还原。来源整合方案 W26：Arlo 的示范公司 “should not be used ... to connect to external applications”。
4. 示范环境要自动销毁。来源整合方案 W25（Codespaces、Heroku review app）。销毁本身不在本 ADR。

[返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **示范记忆做成现有导入格式的一个包，不另造导入通道。** `himawari-admin data demo-pack --locale ja|en --out <空目录>` 生成包，再用现有的 `data import` 导入。包里是 16 条记忆（含一条被取代的、一条待确认的推测、置顶的、带修改历史的）和 3 个人物，时间都按生成时刻往前推，所以每次导入都是新鲜的。内容是编出来的，邮箱一律用保留域名 `.example`，不含任何真人的信息。邮件里的日期按实例的时区（`runPolicy.timeZone`）按日历日计算。
2. **示范内容只写在 `packages/domain/src/demo-persona.ts` 一处**，记忆包和假收件箱共用同一个人设，所以收件箱里的邮件和记忆能对上（例如同事、妹妹、陶艺课）。
3. **假收件箱是一个 `ProactiveSourceReader`。** 邮件按相对连接时刻的分钟数“到达”：连接之前的邮件只作为相关旧邮件被查到（线程、订单号），连接之后的邮件到时间才出现，一封只出现一次。读取器不访问网络，遇到不是示范令牌的令牌回 `unauthorized`。
4. **体验开关是配置 `runPolicy.proactive.demoInbox: "ja" | "en"`，与 `gmail` 二选一，同时写或都不写启动就拒绝。** 开了之后：服务第一次启动时写入一条已连接的示范连接（令牌里带连接时刻和语言）；“连接 Gmail”只会恢复示范连接并回到设置页，提示“体验版用的是示范收件箱，不能连接你自己的邮箱”；假登录换不出令牌；断开时不向 Google 发任何请求。
5. **示范连接的生命周期。** 启动时：没有连接且从没开通过，写入示范连接；用户断开后重启不自动恢复；已有示范连接但状态不是已连接、或令牌里的语言和配置不同，换成新的示范连接；已有的不是示范令牌的连接（例如实例原来连过真实 Gmail）一律不碰。用户点“连接 Gmail”时：没有连接就写入，连接的令牌读不出来也换掉；仍然不碰真实令牌的连接。真实 Gmail 读取路径和撤销路径遇到示范令牌都不发请求。
6. 不新增、不修改任何表。

[返回阅读导航](#contents)

<a id="options"></a>

## 放弃的做法

- **体验者用 Andy 的真实 Gmail 令牌或共用一个测试 Gmail。** 别人的邮件会进示范，违背前提 3。
- **在数据库里直接写示范数据。** 绕过导入的校验和加密，也要另写一套维护。
- **新建 demo 包。** 要改依赖边界和覆盖率配置，收益不大；示范内容放在没有依赖的 domain 包里。

[返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 导出格式变化（P2-4 把规则手册放进导出）后，示范包要跟着改；`test/integration/demo-data.test.ts` 会在格式不符时失败。
- 假收件箱的邮件经过真实的模型判断，所以体验者的主动提醒会产生模型费用，由费用上限那一块管。
- 示范邮件是静态脚本，只有 13 封，到达时间分布在连接后 5 天内；体验期超过这个长度后不会再有新邮件。
- 测试（标签 `[P6-demo]`）：`test/integration/demo-data.test.ts`（两种语言的包能解析并导入、二次导入被拒、不含机密和真实域名、不混另一种语言、不支持的语言被拒、假收件箱按时间出现、不联网）；`test/integration/proactive-production.test.ts`（真实的邮件检查跑在假收件箱上、相关旧邮件进了提示词、不调用 Google、假登录不能连真邮箱）；`packages/platform-node/test/startup-configuration.unit.test.ts`（配置二选一）；`apps/control-center/test/proactive-interactions.unit.test.ts`（提示语）。

[返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [ADR 0106：主动闭环 v1 第一刀：Gmail 只读](https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0106-proactive-loop-v1-gmail-read-only.md)
- [ADR 0227：对外 MCP 入口改为校验 Cloudflare Access 登录凭证](0227-mcp-entry-checks-cloudflare-access-sign-in.md)

[返回阅读导航](#contents)
