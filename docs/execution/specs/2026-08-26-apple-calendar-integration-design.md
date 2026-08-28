---
status: active
document_type: spec
supersedes: ""
superseded_by: ""
date: "2026-08-26"
---

# Himawari Agent v0.2 Apple/iCloud Calendar 集成设计 Spec

## 目标

定义 Mac 与 Hermes 上行为一致的 Apple/iCloud Calendar 正式适配器：读取 Owner 可见日程，并在明确授权内创建、修改或删除 Owner 的个人事件；任何包含其他参与人、可能发出邀请或通知、身份不清或 adapter 无法证明安全的事件均保持只读。

## 来源上下文

- 正式能力范围：[SOURCE: docs/prd-v0.2.md#产品范围]
- 机器秘密与 Trace：[SOURCE: docs/prd-v0.2.md#机器秘密敏感数据与可观察-trace]
- 行动授权：[SOURCE: docs/prd-v0.2.md#行动风险与授权]
- Calendar 产品规则：[SOURCE: docs/prd-v0.2.md#正式能力与授权边界]
- Calendar 验收：[SOURCE: docs/prd-v0.2.md#正式能力]
- Mac 与 Hermes：[SOURCE: docs/prd-v0.2.md#mac-hermes-与权威迁移]
- 确定性授权：[SOURCE: docs/adr/0004-deterministic-authorization.md]
- 能力注册表：[SOURCE: docs/adr/0008-governed-capability-registry.md]
- 权威迁移：[SOURCE: docs/adr/0019-offline-authority-transfer.md]
- 授权与能力治理：[SOURCE: docs/archive/specs/2026-08-26-authorization-capability-governance-design.md]
- 持久基础设计：[SOURCE: docs/execution/specs/2026-08-26-portable-durable-web-agent-design.md]
- v0.2 Spec 总纲：[SOURCE: docs/execution/specs/2026-08-26-v0.2-spec-suite-integration-design.md]
- Apple EventKit 授权接口：[EXTERNAL: https://developer.apple.com/documentation/eventkit/accessing-the-event-store]
- Apple 对第三方 iCloud Mail、Calendar 与 Contacts 访问的说明：[EXTERNAL: https://support.apple.com/en-us/121539]
- Apple app-specific password 说明：[EXTERNAL: https://support.apple.com/en-us/102654]

## 范围

### 本 Spec 包含

- 产品自有 `CalendarPort`、稳定账户/日历/事件身份和跨 adapter conformance。
- Mac 上基于 Apple 正式平台 API 的 adapter 资格验证与权限管理。
- Hermes 上 Apple 支持的第三方 iCloud Calendar 接入资格验证、凭据隔离和兼容性门禁。
- 日历列表、事件窗口查询、时区、全天事件、重复规则、例外和分页/同步水位。
- Owner 个人事件的 prepare、授权、创建、修改、删除、读取回查和幂等对账。
- 参与人、组织者、共享日历、通知和写权限的确定性只读保护。
- host-bound 凭据、撤销、迁移后重配、Trace 与健康状态。

### 本 Spec 不包含

- 邀请参与人、增删参与人、接受/拒绝邀请或代表 Owner 发送会议通知。
- 修改包含其他参与人的事件，即使 UI 或底层 API 技术上允许。
- 未经 Apple 支持或文档证明的私有接口、网页抓取登录、绕过双重认证或共享明文主密码。
- Google Calendar、Microsoft 365 或其他日历 provider；未来 adapter 必须单独进入治理与 conformance。
- 把 Mac EventKit 代理成 Hermes 的隐式常驻桥；若要增加此架构，必须修改本 Spec、风险和运行依赖后重新确认。
- 把 Calendar 当作 v0.2 的外部事件触发 provider 或持续监控源；本适配器由 Owner 操作或已授权 Task 按需查询。
- 主机离线时错过的 Calendar 查询 Task 补跑；它遵守统一 Task 的 `MISSED`/跳过规则。

## 前置兼容性门禁

本 Spec 完整定义产品行为，但不把尚未被官方资料证实的 Hermes 接入方式写成既定事实。实施 Plan 前必须完成一个可重复的 adapter qualification：

1. Mac candidate 必须使用 Apple 正式支持的 EventKit 或当时等价正式 API，验证 Calendar 权限授权、撤销、读写和通知边界。
2. Hermes candidate 必须证明 Apple 当前支持该第三方 iCloud Calendar 访问方式，并提供可自动化、可撤销、最小权限、可观测且符合服务条款的实现接口。
3. 若 Hermes 只能依赖 app-specific password，必须明确展示其账户级风险、可访问范围和撤销方式，并由 Owner 将该路径作为高风险能力单独确认；不能把存在密码机制等同于已经验证 Calendar adapter。
4. 两个 adapter 必须通过同一 conformance。Hermes 无合规路径、语义不一致或无法限制通知副作用时，v0.2 生产资格为 `BLOCKED_CALENDAR_COMPATIBILITY`；不得降级为 Mac-only 后仍声称完成 v0.2。

此门禁是实施前必须关闭的技术不确定性，不缩减 PRD 中 Mac 与 Hermes 同等支持的产品承诺。

## 验收标准

### 读取与身份

- Owner 完成 host-local 连接和授权后，可以查看该账户中 adapter 可见的 calendar 清单、读写状态和健康，不暴露凭据原值。
- 查询必须限定 calendar IDs、明确时间窗口、时区和最大结果数；大范围读取需要与任务相称的 Grant 与最小披露。
- `CalendarAccountId`、`CalendarId` 和 product `CalendarEventId` 稳定映射 provider identity；adapter 重新同步、分页或进程重启不能重复创建产品事件。
- 事件显示 title、时间、时区、全天/重复、位置、备注分类、organizer、attendee presence、calendar write status 和来源水位；私人正文只在批准范围内解密和发送给模型。

### 可写个人事件

- 只有同时满足“目标 calendar 可写、事件属于 Owner 的个人事件、没有其他参与人、不会发送邀请/参与人通知、没有 provider 不确定性”的事件，才进入可写候选。
- 创建、修改或删除前必须冻结目标 calendar、字段 diff、时间/时区、recurrence scope、通知影响、外部 event version 和可逆性，形成 ActionIntent。
- 自然语言任务只有在 calendar、标题/目的、日期时间、时区、重复范围和适用提醒足够明确时才能授权；歧义先询问。
- 批准绑定冻结预览。执行前 provider version、attendee、organizer、calendar 权限或通知语义变化时，旧批准失效。
- 执行后读取 provider 事件对账；请求超时或响应未知时先按 idempotency key、provider identity 和字段查询，不盲目重放。

### 参与人和通知保护

- `attendee_count > 0`、存在非 Owner attendee、Owner 不是唯一主体、organizer 不是 Owner、共享事件归属不明或 adapter 无法可靠读取参与人时，事件强制 read-only。
- v0.2 的 mutation schema 不包含 attendee add/remove、invitation response、send updates 或 notify participants 字段；模型和 adapter 不能通过自由参数注入。
- 对可能由 provider 自动发送通知但 adapter 无法关闭或证明不会发送的 update/delete，确定性规则返回 `DENY`。
- 只读限制必须在 Web UI、Approval、Trace 和错误中显示具体原因，而不是以普通 adapter 失败隐藏。

### 凭据、撤销与迁移

- EventKit permission、Apple Account authorization、token、Cookie、app-specific password 或同类凭据均为 host-bound machine secret，只保存于目标主机 secret store。
- 产品数据库只保存 secret ref、provider/account label、scope、created/last-used/expiry/revoked 和 health；凭据不进入模型、Memory、可读 Trace 或迁移包。
- 撤销 Calendar capability 或 provider 凭据后，新的读取/写入立即停止，依赖任务进入明确 blocked 状态，不自动切换账户或 adapter。
- 主机迁移后 Calendar 连接保持 `BLOCKED_CREDENTIALS`，直到目标主机重新授权。重新连接后的按需查询读取当时可见日程，不把此前错过的 Task 伪装成已追赶执行。

## 设计

### CalendarPort

~~~text
listAccounts()
listCalendars(account, cursor)
listEvents(calendars, interval, cursor, syncWatermark?)
getEvent(calendarId, providerEventId)
prepareCreate(calendarId, eventDraft)
prepareUpdate(eventRef, expectedVersion, patch)
prepareDelete(eventRef, expectedVersion, recurrenceScope)
execute(preparedMutation, executionHandle)
reconcile(operationId | idempotencyKey)
health()
~~~

Port 使用产品类型，不把 EventKit/远端协议对象泄漏到 domain/application。每个 adapter 声明支持的 recurrence、alarm、timezone、sync 和 idempotency 特性；不支持的字段 fail closed，不静默丢弃。

### 规范化事件

`CalendarEventSnapshot` 包含 account/calendar/event identities、provider version、title、start/end、IANA timezone、all-day、recurrence master/instance/exception、location、notes protected ref、organizer identity class、attendee summary、alarm summary、availability、writeability、notification risk、source watermark 和 digest。

Owner identity 通过已验证的 account binding 与 provider self identity 判定，不能由模型依据显示名或 email 字符串猜测。参与人正文在不影响确定性只读判断时不必发送给模型。

### Prepare 与执行

prepare 阶段读取最新 snapshot，规范化自然语言日期，展示绝对时间、时区和夏令时结果。重复事件修改必须明确 `this_instance` 或 `series`；不支持/有歧义时询问。

`PreparedCalendarMutation` 保存 canonical diff、expected provider version、no-attendee/no-notification facts、idempotency key、expiry 和 readback plan。Execution Handle 精确绑定该 hash，只能使用一次。

### 查询分页与缓存

adapter 只在 Owner 操作或已授权 Task 发起时读取。分页 cursor、sync watermark 或缓存只服务于一次有界查询和性能优化，不能成为 Calendar 事实的唯一来源，也不能创建未在 PRD 中定义的持续事件监控。缓存过期或 adapter 恢复后重新读取当前 provider 状态；错过的计划 Task 由统一调度规则标记为跳过或 `MISSED`，不自动补跑。

## 错误处理

| 失败 | 必需行为 |
| --- | --- |
| adapter qualification 未通过 | 阻止 v0.2 Calendar Plan/生产签署，显示平台和证据缺口 |
| Calendar permission/credential 撤销 | 连接 blocked，暂停任务，不尝试其他账户 |
| 无法判定 Owner/organizer/attendee | 事件只读，不生成 mutation Handle |
| provider 自动通知无法禁止或证明 | `DENY` update/delete |
| 时区、DST 或 recurrence 有歧义 | 同步询问并展示绝对时间/影响实例 |
| expected provider version 改变 | Approval 失效，重新读取和预览 |
| 执行结果未知 | reconcile，不重放可能重复的 create/update/delete |
| provider rate limit/暂时失败 | 有界退避；到边界后 blocked 并进入结果系统 |
| 主机离线 | 当前读取失败；计划 Task 按统一规则跳过或标记 `MISSED`，不补跑 |
| host migration | 凭据和连接不迁移；目标重新授权 |

## 验证策略

- 先保存 Mac 与 Hermes adapter qualification evidence：官方支持链接/版本、认证方式、权限、撤销、条款、API 行为和失败结论。
- 建立 provider-neutral contract suite，两个平台覆盖 list/get/create/update/delete/reconcile、pagination、水位、时区、全天和 recurrence。
- 使用 Owner-only、含参与人、共享 calendar、非 Owner organizer、未知 attendee、只读 calendar 和自动通知场景验证 deterministic guard。
- 对 create/update/delete 在请求前、发送后、响应前和 readback 前后 kill process，验证不重复副作用。
- 验证 EventKit/provider permission 撤销、凭据过期、账户变化、rate limit、并发编辑和版本冲突。
- 执行 secret scan，证明 token/password/Cookie 不进入模型、Memory、日志、Trace、迁移包和浏览器响应。
- 模拟 Mac↔Hermes 迁移，验证连接 blocked、重新授权、身份映射和按需查询恢复。
- 运行 unit、contract、integration、security、platform conformance、`npm run check` 和 strict document validation。

## 确认记录

- 确认人：Owner
- 确认日期：2026-08-26
- 确认范围：统一 CalendarPort、个人事件可写边界、参与人/通知 fail-closed 规则，以及 Hermes adapter qualification 作为生产硬门禁。
- 授权边界：允许从本 Spec 派生 Implementation Plan；本次确认不授权创建 Plan、连接 Apple/iCloud 账户、配置凭据、读写真实日历或修改产品实现。
