# 复核结论

## 按严重度排列的问题

### 1（中，读代码证实）启动时快照加载失败被静默吞掉，此后永不重试、无日志

- 文件:行：`apps/agent-service/src/production-capability-lifecycle.ts:29-33`
- 问题：修前每次核对都重新 `loader.load()`，失败原因会随请求暴露；修后改为进程启动时加载一次，`.catch(() => undefined)` 把一切失败（含瞬时 I/O 错误、挂载未就绪）吞成 `undefined`，此后 `entryFor` 永远返回 `undefined`，所有资格类操作（activate/rollback/activateUpdate/reactivate）以笼统的 `capability_not_in_deployment_snapshot` 失败，直到重启。没有日志、没有重试、没有健康暴露。
- 证据：
  ```ts
  const admitted: Promise<LoadedCapabilityDeployment | undefined> = deployment
    ? new CapabilityDeploymentSnapshotLoader({ ...deployment, now: () => clock.now() })
        .load()
        .catch(() => undefined)
    : Promise.resolve(undefined);
  ```
  失败后 `artifacts.verify` 返回 `verified: false, reasonCodes: [NOT_IN_DEPLOYMENT]`（第 51-62 行），`runtime.qualify` 抛 `NOT_IN_DEPLOYMENT`（第 67 行）。
- 建议：至少把失败原因写进服务日志（区分"摘要不符/JSON 无效/资格过旧"和瞬时读取错误），或对瞬时错误做有界重试；否则生产上一次启动竞态就表现为"所有能力永远无法重新启用/退回"且无从排查。

### 2（低，读代码证实）`requiredEnforcement` 的沙箱分支没有独立负向用例

- 文件:行：`packages/application/src/services/capability-lifecycle-service.ts:92-98, 685`
- 问题：改动后沙箱资格只要求四项。沙箱记录"四项有假"时，部署快照加载器在解析阶段就会拒绝（`capability-deployment.ts:595-609` 的 `requiredControls`），所以 lifecycle 里这个兜底分支经生产路径永远走不到负向；现有测试（`authorization-capability-governance.test.ts:214-230`）用的全六项为真的非沙箱资格，新增集成测试的"unqualified"用例实际死于加载器 `productionSuitable !== true`（`capability-deployment.ts:547-553`），不是死于 lifecycle 的判定。两处规则目前一致，但一致性没有测试锁住——将来单边改一处不会被判红。
- 建议：加一条直接注入 `CapabilityLifecycleService` 的单测：沙箱资格 `secrets: false` 被拒、非沙箱资格 `resourceCeilings: false` 仍被拒。

### 3（低，读代码证实）界面对所有"已停用"能力都显示"重新启用"，但服务端还要求能力仍在上线包快照里

- 文件:行：`apps/control-center/src/governance-control-center.tsx:242-243`
- 证据：`case "disabled": return [{ kind: "capability.reactivate", snapshot }];` 无条件给出按钮；而服务端 `entryFor` 要求快照里有同 ref、同版本、同摘要的条目（`production-capability-lifecycle.ts:40-45`）。能力已随新上线包移除后，按钮每次点都会以 NOT_IN_DEPLOYMENT 失败。服务端 fail-closed 正确，只是 UX 提示不足。
- 建议：按钮失败时把 reasonCode 展示给主人，或在快照缺失时灰置按钮。

### 4（信息，读代码证实）`reasonCode` 契约必填但服务端完全不消费

- 证据：`reactivateCapabilityCommandSchema` 要求 `reasonCode`（`contracts-v2.ts:1930` 附近），`#reactivateCapability` 从不读它，审计只记 `action/targetRef/outcome/occurredAt`（`governance-gateway-adapter.ts:1074-1090`）。与 `disable`/`rollback` 现状一致，非本次引入的缺陷。

### 5（信息，读代码证实）资格新鲜度语义从"每次核对 5 分钟内"放宽为"启动时一次"

- 证据：`capability-deployment.ts:30`（5 分钟常量）、`:619-625`（load 时检查）、`:1478-1488`（revalidate 只比字节摘要）。长期运行的进程里资格证据可以任意陈旧。ADR 0253 第 77 行已如实写明这个局限并声明"不证明此刻机器健康"，界面文案也只写"重新启用"（`zh-CN.ts:594`"重新启用能力"），没有声称重查运行环境。判定：是刻意取舍，与文档一致，不算缺陷。

## 侧重检查（普通使用流程走查）

流程：主人打开控制中心 → 能力详情（lifecycle=disabled）→ `detailActions` 给出"重新启用能力"（tsx:242-243）→ `actionDestructive` 归为破坏性、`actionRisk` 默认 critical（tsx:128-153）→ 确认框勾选 → `runMutation` 构造 `capability.reactivate` 命令（tsx:783-795，含固定 reasonCode、`recentAuthenticationRef ?? null`、幂等键）→ HTTP → `PRODUCTION_CAPABILITY_OPERATIONS` 放行（production-approval-gateway.ts:67-73）→ `GovernanceGatewayV2ControlPlane.execute` → `#assertCommand`（scope/owner/authorizationRef）→ 幂等收据 `#begin`+指纹 → `#reactivateCapability`：`#requireCapability` → 非重放时 `#assertRecentAuthentication` → `reactivate()`：期望修订号 → 状态须 disabled → manifest 须有 reviewedBy/At → `qualify`（快照摘要核对 + 资格四项）→ `save` → 结果串 → `#appendAudit` → 收据 completed。

- 有覆盖：服务器全链路由 `test/integration/production-capability-gateway.test.ts` 的 8 个新用例覆盖（含无最近认证、摘要不符、资格不合格、旧修订号、直接 activate 仍被拒、成功不恢复句柄/定时任务、启动很久后仍可用、启动后快照被改）；UI 命令绑定由 `governance-interactions.unit.test.ts:294-301` 覆盖；操作清单由 `production-http-composition.unit.test.ts:374` 覆盖。
- 无覆盖：真实 HTTP 进程级用例（`production-http-composition-process.test.ts` 的 [PR-A]/[PR-B]）没有驱动 reactivate；e2e 浏览器桩（`control-center-browser-server.mjs:1765-1772`）实现了该命令但没有 e2e 用例走它；启动加载失败被吞（问题 1）无测试。均为低风险，因为 HTTP/收据/审计机件与 disable/rollback 共用且有各自测试。

## 作者说法核对（读代码证实，除非另注）

- 「六项全真 vs 加载器要求沙箱 resourceCeilings 为假，沙箱能力过不了资格判定」：属实。修前 `qualify` 用 `Object.values(...).some(...)`（diff 可见），加载器要求沙箱 `resourceCeilings === false` 且 `termination === (platform === "linux")`（capability-deployment.ts:586-587）。
- 「生产每次核对重新加载快照、5 分钟后必败」：属实。修前 `entryFor` 每次 `await loader.load()`（diff 的 `-` 行），load 强制 `checkedAt` 距 now 不超过 `CAPABILITY_DEPLOYMENT_MAX_QUALIFICATION_AGE_MS = 5 * 60 * 1_000`（:30、:619）。
- 「服务器端验最近认证→核对期望版本→状态须 disabled→快照核对→才写 active；失败状态不变」：与 `#reactivateCapability`（adapter:1015-1034）和 `reactivate()`（lifecycle:629-643）逐条相符。
- 「不恢复句柄和定时任务」「写审计」「重放幂等」「已停用直接激活仍被拒」：分别由 lifecycle `save`（不动句柄/任务）、`#appendAudit`（adapter:604）、恢复分支（adapter:1021-1027）+ 重放测试、`activate` 只接受 `installation_approved`（lifecycle:422-427）证实。
- 「不改表和迁移号」：改动文件清单里没有任何 `packages/persistence-sqlite` 文件，属实。
- 「本 PR 只含重新启用这一个提交和 ADR 记录」：不准确——范围内有 4 个提交（feat 一个 + ADR 改写两轮 + 复核记录一个），且 feat 提交本身除 reactivate 外还含两处生产缺陷修复；作者在别处已声明缺陷修复，只是"只含一个提交"的表述与 `git log` 不符。

## 必答问题

1. **请求开头**：不受影响。改动文件清单里没有任何模型请求组装路径的代码（无 runtime-pi、prompt-catalog、thread 服务改动）；reactivate 是治理面（owner 控制面）命令，进的是 `GovernanceGatewayV2ControlPlane`，不进线程消息。能力重新启用若改变模型可见工具集合，走的是规则 6 既有的"工具集合变了→运行轮开始时换新一次"机制，该机制本 PR 未触碰。发给模型的内容仍是只在末尾追加，每轮变化的值仍在最后一条消息——本 PR 未引入新变值。
2. **确定性**：新引入的值全部恒定或来自封存字节：`reasonCode` 是固定串；快照条目选择用 `.find` 遍历按摘要钉死的冻结数组（同一份字节结果唯一）；保存的 `runtimeQualification`/`health.checkedAt` 取自快照记录（字节固定）；无时间、无无序集合、无依赖前后文的遮盖。无问题。
3. **自动检查**：有。8 个集成用例构成正反两面，反向用例（无最近认证、摘要不符、资格不合格、旧修订号、快照被改、直接 activate）断言拒绝且记录保持 `disabled/revision:2`——若放宽行为这些断言会失败。未运行测试（工具受限），"会失败"是按断言内容判断的。`npm run check:prompt-prefix` 与本改动无关且未被触碰。
4. **每个新值两端核对**：`capability.reactivate` 消息类型——产生于 `contracts-v2.ts`（类型清单、schema、schemasByType），消费于 adapter（联合类型/集合/dispatch）、control-center（清单、tsx、三语 i18n）、agent-service（操作清单）、e2e 桩、契约 fixture，逐一核对齐全，未见漏登记的枚举点；payload 四字段与 control-center 构造端逐字段匹配（`expectedRevision` 两端同源 `snapshot.payload.revision`）；`requiredEnforcement` 与加载器 `requiredControls` 规则一致（但见问题 2：一致性无测试锁定）；风险/破坏性分类与 disable/rollback 同类（critical + 勾选确认），服务端不校验客户端声称的 risk，以服务器端最近认证和授权引用为准，无越权面。
