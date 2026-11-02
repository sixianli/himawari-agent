---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-11-01"
---

# ADR 0151：Muse 的数据用服务令牌加应用密钥推过来，只存系统记录来源的原件

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [放弃的做法](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

Muse 是 Andy 的另一个 Agent。Andy 要对照“Muse 该提醒的有没有提醒、提醒得对不对”，原来靠他每次手工在 Himawari 里记一条（`muse_reference_entries`），他太忙，做不下去。Muse 没有公开接口，但 Muse 的运行环境能在 Andy 建的定时任务里无人值守地向外发 POST，每小时有一次清扫，发一批（空批当心跳）。

两条硬约束：

1. Muse 的请求经一个通用出口代理发出，来源地址不固定，所以不能靠来源地址认证，只能靠密钥。
2. Himawari 的生产网页在 Cloudflare Access（Cloudflare 提供的登录关卡）后面，直接 POST 会被拦到登录页。

依据：[docs/product-vision.md](../product-vision.md) 的“用户主权”和“记忆可靠”；Andy 在项目聊天里批准了方案（`/mnt/project-files/muse-auto-channel/plan.md`、`receiver-design.md`、`implementation-list.md`）。

<a id="decision"></a>

## 决定

1. **两层认证。** 边缘层用 Cloudflare Access 的服务令牌（Service Auth 策略，请求头 `CF-Access-Client-Id` 与 `CF-Access-Client-Secret`），只对 `POST /api/muse-intake/v1/batch` 这一条路径放行；应用层再要求 `Authorization: Bearer <应用密钥>`，服务端对密钥和请求头各取 sha256 后用 `timingSafeEqual` 比较，错误一律回 401 且不写库。密钥只在配置里存引用（用途 `muse-intake`），值放在主机密钥文件里。任何一层失效，另一层仍挡着。
2. **功能默认关。** `runPolicy.museIntake.enabled` 为 `true` 才注册路由，否则这条路径是 404。
3. **只收 Muse 自己能证明的东西。** 每个值带来源标签；只有 `system_record`、`chat_record`、`derived` 三种算“可计数”，参与“事件到提醒延迟”之类的数字；其他来源只存档，不进任何数字。未知字段丢弃并计数，非法条目整条拒绝并计数。
4. **机密文本不落正文。** 标题和原文走现有加密引用；含机密或受限标识的文本不存正文，只标“已隐藏”。
5. **幂等和乱序。** 按 `batch_seq` 唯一，整批重发回“重放”；迟到的批照收但不改期望序号；同一自然键、内容不同进冲突表，不覆盖。
6. **通道中断提醒。** 距上一批 ≥3 小时就推一次“Muse 通道中断”（≥2.5 小时界面标“可能中断”），复用现有“提醒”类别和开关；一次中断只推一次。
7. **评价与清除。** 评价写入 `muse_reference_entries`（带 `intake_item_key`），时机和内容必须两项都给；“清除 Muse 数据”只删自动收到的条目及其评价，手工记的保留。

<a id="options"></a>

## 放弃的做法

- **Cloudflare Worker 中转**：多一个要维护的组件和一份密钥，而 Access 服务令牌本来就是为机器调用设计的。
- **邮件当通道**：延迟大、难判断“没送到”、正文要从邮件里解析，且违背“数据自持”的直接入口。
- **整条路径绕过 Access，只靠应用密钥**：少一个要配的东西，但边缘层的限流和审计全丢；放弃，代价是 Andy 要多建一个 Access 应用和一个服务令牌。
- **Muse 只发一个 `Authorization` 头（用 `read_service_tokens_from_header`）**：这会占用我们的应用层 Bearer 头，两层认证就合并成一层。

<a id="consequences"></a>

## 后果

- **未验证的风险**：Muse 的定时任务是否能同时发 `CF-Access-Client-Id`、`CF-Access-Client-Secret` 和 `Authorization` 三个自定义请求头，还没有在真实 Muse 上验证。上线前必须在 Hermes 用真实服务令牌和虚构数据演练一遍；若 Muse 只能发一个头，需要另开 ADR 重新取舍，不得悄悄放宽认证。
- 服务令牌有有效期（创建时选），到期 Muse 的推送会被边缘拒绝；运行手册写了到期提醒和更换步骤。
- 迁移 0073 新增 4 张表；回滚程序版本不会删表，关闭功能即停收（见[运行手册](../runbooks/muse-intake-runbook.md)）。
- 门槛（测试）：`test/integration/muse-intake-http.test.ts`（认证、限流、体积、类型、暂停、重放）、`test/integration/muse-intake-store.test.ts`、`test/integration/muse-intake-control.test.ts`、`test/integration/muse-channel-push.test.ts`、`test/integration/muse-reference-browser.test.ts`（真实网页正反向）。

<a id="references"></a>

## 关联文档

- [Muse 自动接收运行手册](../runbooks/muse-intake-runbook.md)
- [ADR 0089：只用网页推送，入口改为公网域名](0089-web-push-only-owner-entry.md)
- [ADR 0143：决策账本](0143-decision-ledger-for-model-gate-decisions.md)
- Cloudflare：<https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/>

[返回目录](#contents)
