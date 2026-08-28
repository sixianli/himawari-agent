---
status: active
document_type: plan
supersedes: ""
superseded_by: ""
date: "2026-08-26"
---

# Himawari Agent v0.2 Apple/iCloud Calendar 集成 Implementation Plan

**来源 Spec：** [SOURCE: docs/execution/specs/2026-08-26-apple-calendar-integration-design.md]

**v0.2 Spec 套件：** [SOURCE: docs/execution/specs/2026-08-26-v0.2-spec-suite-integration-design.md]

**协同 Source Specs：**

- [SOURCE: docs/execution/specs/2026-08-26-portable-durable-web-agent-design.md]
- [SOURCE: docs/archive/specs/2026-08-26-authorization-capability-governance-design.md]
- [SOURCE: docs/execution/specs/2026-08-26-control-center-experience-design.md]
- [SOURCE: docs/execution/specs/2026-08-26-production-qualification-upgrade-design.md]

**依赖 Plans：**

- [SOURCE: docs/execution/plans/2026-08-26-portable-durable-web-agent-plan.md]
- [SOURCE: docs/archive/plans/2026-08-26-authorization-capability-governance-plan.md]
- [SOURCE: docs/execution/plans/2026-08-26-control-center-experience-plan.md]

**目标：** 在通过不可跳过的双平台 adapter qualification 后，实现统一 CalendarPort、Mac 与 Hermes conformance、Owner 个人事件的受控读写，以及参与人、通知、凭据、撤销和迁移的 fail-closed 边界。

**架构：** application 只依赖产品自有 Calendar 类型与 Port；平台 adapters 分别封装当时经官方支持和实测证明可行的 Mac 与 Hermes 接入；SQLite 保存产品 identity、prepared mutation、sync/cursor metadata 和结果，不保存凭据；host-bound secret store 与短期 Handle 隔离 EventKit/provider authorization。

本 Plan 的存在只记录 qualification 与后续实施顺序，不表示 qualification 已通过。Task 1–2 是硬门禁；在 Mac/Hermes 均有可重复证据、风险得到 Owner 确认且实现选择未与 Spec 冲突前，Task 3 以后保持阻塞。

---

## 执行依赖与停止点

- Task 1 必须使用执行时最新的 Apple 官方文档、目标 OS/API 版本和实际 adapter spike；历史链接、第三方文章或“存在 app-specific password”不能证明 Hermes Calendar adapter 合格。
- 建立真实 Apple/iCloud 账户连接、请求 EventKit 权限、创建 app-specific password、读取/写入真实日历均是外部/凭据动作，必须先展示账户范围、权限、风险、费用、目标和撤销方式并取得 Owner 授权。
- 若 Hermes 没有 Apple 当前支持、可自动化、可撤销、最小权限、可观察且可阻止通知副作用的路径，记录 BLOCKED_CALENDAR_COMPATIBILITY，停止 Task 3 以后和 v0.2 资格签署；不得降级为 Mac-only 后宣称完成。
- 任何 adapter 无法可靠判定 Owner、organizer、attendee 或 notification risk 时，对应事件只读；不得用模型猜测。
- S1/S4 必须先提供 credential refs、capability/Grant/Handle、SQLite、Worker、Trace/Result、migration blocked 和 authority fence。

## 文件边界

### Task 1–2 qualification 证据

- test/integration/qualification/calendar/
- test/fixtures/calendar/
- 证据由 S9 manifest 引用不可变测试 artifact，不另建手工状态缓存。

### qualification 通过后新建

- packages/integration-calendar/
- packages/integration-calendar/src/contracts/
- packages/integration-calendar/src/mac/
- packages/integration-calendar/src/hermes/
- packages/integration-calendar/test/
- packages/application/src/ports/calendar.ts
- packages/application/src/services/calendar-query-service.ts
- packages/application/src/services/calendar-mutation-service.ts
- packages/persistence-sqlite/src/calendar/
- packages/testing/src/conformance/calendar-suite.ts
- test/integration/calendar-read.test.ts
- test/integration/calendar-mutation-recovery.test.ts
- test/integration/security/calendar-credentials.test.ts
- test/e2e/browser/calendar/

### 修改

- packages/gateway-contracts/src/、packages/execution-contracts/src/：Calendar query/prepare/execute/reconcile contracts。
- packages/platform-node/：EventKit/provider process boundary、host secret 与权限状态；不泄漏 provider SDK 类型。
- packages/persistence-sqlite/：identity mapping、prepared mutation、operation/reconcile、cache/delete/migration hooks。
- packages/testing/、apps/agent-service、apps/execution-worker、apps/control-center：conformance、composition 和 UI。
- scripts/check-boundaries.mjs、manifests/lockfile：qualification 后只加入获批精确依赖和 workspace。
- Architecture/README：qualification 与行为实测后更新。

### 依赖方向

- integration-calendar → application + domain + gateway/execution contracts。
- apps/execution-worker → application + execution-contracts + integration-calendar + approved platform adapters。
- apps/agent-service/control-center 只通过产品 contracts 和 application/read model 使用 Calendar。
- integration-calendar 不依赖 runtime-pi；EventKit/provider SDK 类型不得进入 domain、application ports 或稳定 wire contracts。

### 测试

- test/integration/qualification/calendar/
- packages/integration-calendar/test/
- packages/application/test/
- packages/gateway-contracts/test/
- packages/execution-contracts/test/
- packages/persistence-sqlite/test/
- packages/platform-node/test/
- packages/testing/test/
- apps/execution-worker/test/
- apps/control-center/test/
- test/integration/
- test/integration/security/
- test/e2e/browser/

## 实施任务

### Task 1：执行双平台 adapter qualification 硬门禁

- [ ] 记录目标 Mac/Hermes OS、CPU、Node、Apple API/服务版本和测试时间，避免把旧资料当当前事实。
- [ ] 从 Apple 官方资料确认 Mac 正式 API 的授权、撤销、读取、个人事件写入和通知边界。
- [ ] 从 Apple 官方资料确认 Hermes 第三方 Calendar 接入是否受支持、认证方式、scope、撤销、服务条款和自动化接口；第三方实现资料只用于实现发现，不替代 Apple 支持证据。
- [ ] 在不使用生产秘密的 fixture/模拟层先验证所需 recurrence、timezone、pagination、idempotency、attendee/notification visibility。
- [ ] 获得账户/凭据授权后，在专用测试 calendar 上运行最小真实 spike，证明权限撤销、读写、通知保护和 failure/readback；不得触碰 Owner 正式日历。
- [ ] 输出 Mac 与 Hermes 各自 qualified/blocked、证据来源、版本、限制、secret scope 和未验证项。

### Task 2：确认实现选择、风险与依赖

- [ ] 比较两个 adapter 的 feature matrix：list/get/create/update/delete/reconcile、pagination、水位、timezone、all-day、recurrence、alarm、idempotency 和 notification control。
- [ ] 若 Hermes 使用 app-specific password 或同类账户级凭据，展示可访问范围、撤销粒度、host-bound 存储和泄漏影响，取得 Owner 对高风险路径的明确确认。
- [ ] 核验候选 SDK/bridge 的精确版本、许可证、维护、安全、Node/OS 支持、原生构建和 lockfile。
- [ ] 确认两平台可以通过同一 product conformance；无法满足时记录 BLOCKED_CALENDAR_COMPATIBILITY 并停止。
- [ ] durable adapter/bridge 决策需要时先治理 ADR；Owner 批准精确依赖后才修改 manifests。

### Task 3：建立 S7 acceptance 映射与冻结 CalendarPort

- [ ] 将 S7-A01 读取身份、S7-A02 可写个人事件、S7-A03 参与人通知保护、S7-A04 凭据撤销迁移绑定 tasks/evidence。
- [ ] 定义 listAccounts/listCalendars/listEvents/getEvent、prepareCreate/Update/Delete、execute、reconcile 和 health。
- [ ] Port 只使用产品类型，不暴露 EventKit/远端协议对象。
- [ ] adapter 显式声明 recurrence/alarm/timezone/sync/idempotency 支持，不支持字段 fail closed。
- [ ] 增加 version/unknown field、cross-account/scope、stale fence/Handle 与 blocked credential fixtures。

### Task 4：实现稳定 identity 与规范化事件

- [ ] 定义 CalendarAccountId、CalendarId、CalendarEventId 与 provider identity/version mapping。
- [ ] 规范化 title、start/end、IANA timezone、all-day、recurrence master/instance/exception、location、notes protected ref、organizer/attendee/alarm、writeability、notification risk、watermark 和 digest。
- [ ] Owner identity 只来自已验证 account/self binding，不依据显示名/email 猜测。
- [ ] provider pagination、resync 或重启不能重复创建产品事件。
- [ ] cache/sync metadata 只用于有界查询，不能成为唯一 Calendar 事实或持续监控源。

### Task 5：实现 host-bound 凭据与连接健康

- [ ] EventKit permission、token、Cookie、app-specific password 或等价材料只在目标 host secret store。
- [ ] 产品状态只保存 secret ref、provider/account label、scope、created/last-used/expiry/revoke 和 health。
- [ ] Worker 使用短期 Handle，模型、Memory、Trace、日志、浏览器和迁移包永不接收原值。
- [ ] revoke/expiry/account change 立即 blocked，依赖 Task 明确暂停，不尝试其他账户。
- [ ] authority transfer 后连接为 BLOCKED_CREDENTIALS，目标重新授权前不可用。

### Task 6：实现有界读取、分页与水位

- [ ] list/query 强制 calendar IDs、明确 interval/timezone、最大结果数、cursor 和与任务相称的 Grant。
- [ ] 大范围/高分类读取重新授权并最小披露给模型。
- [ ] 处理 timezone、DST、all-day、recurrence instance/exception 和 pagination，不静默丢字段。
- [ ] adapter 恢复后读取当前 provider 状态；离线错过 Task 按统一 MISSED/skip，不补跑。
- [ ] Trace 保存 account/calendar/event refs、范围、水位、classification 和实际 adapter/version。

### Task 7：实现确定性个人事件可写守卫

- [ ] 只有 calendar writable、Owner personal event、无其他 attendee、无邀请/通知且无 provider uncertainty 时允许 prepare mutation。
- [ ] attendee_count、organizer、共享归属、writeability 或 notification 任一未知时强制 read-only。
- [ ] mutation schemas 从类型层排除 attendee add/remove、invitation response、send updates 和 notify participants。
- [ ] provider 无法关闭/证明 update/delete 不发通知时确定性 DENY。
- [ ] guard reason 在 UI、Approval、Trace 和 stable error 中可见。

### Task 8：实现 prepare mutation 与歧义澄清

- [ ] create/update/delete 前读取 fresh snapshot，冻结 calendar、field diff、绝对时间、IANA timezone、DST、recurrence scope、notification facts、provider version 和 reversibility。
- [ ] 自然语言授权必须明确 calendar、title/purpose、datetime/timezone、recurrence 和适用 reminder；歧义同步询问。
- [ ] this_instance/series 明确选择；adapter 不支持或语义不明时停止。
- [ ] PreparedCalendarMutation 保存 canonical hash、expected version、no-attendee/no-notification facts、idempotency、expiry 和 readback plan。
- [ ] provider version、attendee/organizer、permission 或 notification 变化使 Approval 失效。

### Task 9：实现 execute 与 reconcile

- [ ] S4 签发只绑定 prepared hash 的一次性 execution Handle。
- [ ] 请求使用稳定 operation/idempotency identity，不依赖 provider row 或响应时序。
- [ ] 执行后重新读取 provider event，比较 identity/version/digest 和预期字段。
- [ ] timeout/unknown 先按 operation/idempotency/provider identity 查询，不盲目重放 create/update/delete。
- [ ] 在发送前、发送后、响应前、readback 前后 kill process，验证无重复副作用。

### Task 10：实现 Mac adapter

- [ ] 按 Task 1–2 已 qualification 的正式 Apple API 实现权限、list/get、个人事件 mutation、reconcile 和 health。
- [ ] 显式映射 API version、calendar permissions、organizer/attendee/notification 和 recurrence semantics。
- [ ] 处理权限撤销、应用授权变化、并发编辑、rate limit/平台错误和进程重启。
- [ ] 通过 provider-neutral conformance、secret、kill/restart 和真实专用测试 calendar readback。

### Task 11：实现 Hermes adapter

- [ ] 只按 Task 1–2 已 qualification 且 Owner 确认的 Apple 支持路径实现，不使用私有接口、网页登录抓取或隐式 Mac bridge。
- [ ] 实现最小 credential scope、撤销、list/get、个人事件 mutation、reconcile 和 health。
- [ ] 明确 provider 协议在 attendee、notification、recurrence、version 和 idempotency 的差异，并 fail closed。
- [ ] 使用与 Mac 相同 conformance；任何语义缺失保持 BLOCKED_CALENDAR_COMPATIBILITY。

### Task 12：接通控制中心与 Task 语义

- [ ] UI 显示 account/calendar health、writeability、event identity/timezone/recurrence、organizer/attendee 和只读原因。
- [ ] prepare/Approval 展示 field diff、绝对时间、scope、notification risk、version 和 readback。
- [ ] credential revoke、blocked migration、rate limit、unknown result 和 MISSED Task 有明确状态。
- [ ] 不提供 attendee/invitation/notification mutation controls。
- [ ] 浏览器状态只消费 authoritative read model，不缓存凭据或私人日历正文。

### Task 13：完成双平台、迁移、安全和文档收口

- [ ] Mac/Hermes 同一 suite 覆盖 list/get/create/update/delete/reconcile、pagination、水位、timezone、all-day 和 recurrence。
- [ ] 运行 Owner-only、attendee、shared calendar、non-owner organizer、unknown attendee、read-only 和 auto-notification matrix。
- [ ] 模拟 Mac↔Hermes transfer，验证凭据 blocked、重新授权、identity mapping 和按需查询。
- [ ] 运行 secret scan、credential revoke、rate limit、并发 version、kill/restart 和 deletion hook tests。
- [ ] 映射 S7-A01–S7-A04，与 S0 J07/J14、S9 qualification、Architecture/README 对账后收口。

## 验收映射

| Acceptance ID | Spec 验收组 | 主要任务 | 必需证据 | 当前状态 |
| --- | --- | --- | --- | --- |
| S7-GATE | 双平台 adapter qualification | Tasks 1–2 | current official evidence、双平台 spike、Owner 风险确认 | 待实施，阻塞后续 |
| S7-A01 | 读取与身份 | Tasks 3–6、10–13 | identity/pagination/timezone、双平台 conformance | 待实施 |
| S7-A02 | 可写个人事件 | Tasks 7–13 | frozen prepare、version guard、readback/reconcile | 待实施 |
| S7-A03 | 参与人和通知保护 | Tasks 7–13 | deterministic deny/read-only matrix | 待实施 |
| S7-A04 | 凭据、撤销与迁移 | Tasks 5、10–13 | secret scan、revoke、blocked transfer | 待实施 |

## 验证

- npm run check
- npm run test:unit
- npm run test:contracts
- npm run test:integration
- npm run test:e2e
- 本 Plan 新增的 calendar qualification、platform conformance、security、browser 和 recovery 入口
- python3 /Users/triggerjames/.codex/skills/document-governance/scripts/validate_docs.py --strict .
- git diff --check

真实 Apple/iCloud 账户与专用测试 calendar 验证必须在独立授权、最小 scope 和可撤销凭据下运行；本 Plan 当前不声称任何 adapter 已 qualification。

## 收口清单

- [ ] S7-GATE 与 S7-A01–S7-A04 全部有 fresh Mac/Hermes evidence。
- [ ] 两平台使用同一产品 contract，任何 unsupported/unknown 语义都 fail closed。
- [ ] 只有无参与人、无通知风险且 Owner 个人事件可写；schema 无邀请/通知后门。
- [ ] 凭据只在 host secret store，迁移后重新授权前 blocked。
- [ ] S0/S9 evidence、S4 conformance、Architecture 和 README 已对账。
- [ ] strict document validation、全仓检查与相关测试通过。
- [ ] 本 Plan 与来源 Spec 只在工作真正关闭后归档。
