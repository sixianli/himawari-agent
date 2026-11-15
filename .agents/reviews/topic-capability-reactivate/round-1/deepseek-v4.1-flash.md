CLAIM|1|一致|packages/application/src/services/capability-lifecycle-service.ts:646|停用能力只允许从在用状态进入：`disable` 调用 `invalidate(capabilityRef, "disabled", ["active"], expectedRevision)`。|return this.invalidate(capabilityRef, "disabled", ["active"], expectedRevision);
CLAIM|2|一致|packages/application/src/services/capability-lifecycle-service.ts:423|现有的“激活”只接受“安装已批准”：同文件 `activate` 里 `current.lifecycle !== "installation_approved"` 时抛错。|current.lifecycle !== "installation_approved" ||
CLAIM|3|一致|packages/application/src/services/capability-lifecycle-service.ts:427|所以已停用的能力不能直接激活。|return this.invalid(current, "active");
CLAIM|4|一致|packages/persistence-sqlite/src/sqlite-durable-operations.ts:2626|停用时同一个事务撤销该能力的执行句柄|this.revokeCapabilityHandlesCore({
CLAIM|5|一致|packages/persistence-sqlite/src/sqlite-durable-operations.ts:2635|停用时同一个事务取消它名下的定时任务|WHERE owner_id = ? AND agent_id = ? AND status != 'revoked'
CLAIM|6|一致|packages/persistence-sqlite/src/sqlite-durable-operations.ts:2662|把任务状态写成 `revoked`|`UPDATE scheduled_jobs SET status = 'revoked', revision = revision + 1,
CLAIM|7|一致|packages/persistence-sqlite/src/sqlite-durable-operations.ts:2652|并把个数存进 `lastInvalidation.cancelledScheduledJobs`|cancelledScheduledJobs: jobs.length,
CLAIM|8|一致|packages/application/src/services/recent-authentication-service.ts:59|`assertRecentAuthentication` 在 `expectedAuthenticationRef` 为空或不等于当前会话的 `authenticationRef` 时拒绝。|expectedAuthenticationRef !== authentication.authenticationRef
CLAIM|9|找不到|-|手机只填占位值 `device`、由服务器代填认证引用：`packages/platform-node/src/device-gateway.ts` 的 `DEVICE_REFERENCE_PLACEHOLDER` 和 `withServerFilledReferences`（这个文件在 PR 426 里，本 PR 的基底分支里还没有）。|-
CLAIM|10|一致|apps/agent-service/src/production-capability-lifecycle.ts:42|生产里“核对安装包”：`artifacts.verify` 用 `entryFor` 在快照里找同编号、同版本、同摘要的条目。|candidate.ref === manifest.ref &&
CLAIM|11|一致|apps/agent-service/src/production-capability-lifecycle.ts:66|生产里“资格检查”：`runtime.qualify` 用 `entryFor` 在快照里找同编号、同版本、同摘要的条目。|const entry = await entryFor(manifest);
CLAIM|12|一致|packages/platform-node/src/capabilities/capability-deployment.ts:30|`CAPABILITY_DEPLOYMENT_MAX_QUALIFICATION_AGE_MS = 5 * 60 * 1_000`|export const CAPABILITY_DEPLOYMENT_MAX_QUALIFICATION_AGE_MS = 5 * 60 * 1_000;
CLAIM|13|一致|packages/platform-node/src/capabilities/capability-deployment.ts:619|`parseQualification` 里的 `nowMs - checkedAtMs > maximumAgeMs`|if (nowMs - checkedAtMs > maximumAgeMs) {
CLAIM|14|一致|packages/platform-node/src/capabilities/capability-deployment.ts:595|带沙箱证据的资格记录，部署快照加载器只要求文件系统、网络、进程、密钥四项管控为真|const requiredControls = sandbox
CLAIM|15|一致|packages/platform-node/src/capabilities/capability-deployment.ts:586|`resourceCeilings` 必须为假：`checkedEnforcement.resourceCeilings !== false`|checkedEnforcement.resourceCeilings !== false ||
CLAIM|16|一致|packages/application/src/services/capability-lifecycle-service.ts:400|现成的安装批准命令没有面容字段|approveInstallation( capabilityRef: string, approvalRef: string, expectedRevision?: number, ): Promise<CapabilityRegistryRecord> {
CLAIM|17|一致|packages/application/src/services/governance-gateway-adapter.ts:985|`capability.disable`、`capability.rollback` 一样属于“改”类操作：服务器端核对最近认证。|await this.#assertRecentAuthentication(authentication, command.payload.recentAuthenticationRef);
CLAIM|18|找不到|-|`capability.disable`、`capability.rollback` 一样属于“改”类操作：手机端要面容确认。|-
CLAIM|19|一致|packages/application/src/ports/capabilities.ts:263|`lastInvalidation`（上次停用取消了几个定时任务）|readonly cancelledScheduledJobs: number;
CLAIM|20|一致|apps/control-center/src/i18n/resources/zh-CN.ts:581|界面继续显示“它们不会恢复”。|"governance.lastInvalidationValue": "{time}：取消了 {count} 个定时任务，不会自动恢复",
CLAIM|21|一致|packages/application/src/services/capability-lifecycle-service.ts:423|现有的“已停用直接激活”仍被拒绝（`activate` 不动）。|current.lifecycle !== "installation_approved" ||
CLAIM|22|一致|packages/application/src/ports/configuration.ts:167|快照的路径和摘要写在配置的 `capabilityDeployment` 里|readonly snapshotPath: string;
CLAIM|23|一致|packages/platform-node/src/capabilities/capability-deployment.ts:1428|启动时按摘要校验|if (digest !== this.#expectedSha256) {
CLAIM|24|一致|packages/platform-node/src/capabilities/capability-deployment.ts:1482|之后每次核对前再复核快照文件摘要，文件被改过就拒绝。|if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== admitted.snapshotDigest)
CLAIM|25|一致|apps/agent-service/src/production-sandbox-services.ts:254|沙箱服务执行任务时同样复核快照文件摘要|const loaded = await revalidateCapabilityDeploymentSnapshot(initial);
CLAIM|26|一致|packages/application/src/services/capability-lifecycle-service.ts:661（HEAD^）|服务里原先要求资格记录的六项管控全部为真|Object.values(qualification.enforcement).some((enforced) => !enforced)
CLAIM|27|一致|apps/agent-service/src/production-capability-lifecycle.ts:33（HEAD^）|原先每次核对都重新加载快照|const loaded = await loader.load();
CLAIM|28|一致|packages/application/src/services/capability-lifecycle-service.ts:603|带沙箱证据的能力永远过不了服务里的资格判定（对已有的“退回”同样成立）。|const qualified = await this.qualify(rollback);
CLAIM|29|一致|test/integration/production-capability-gateway.test.ts:555|两处都有回归测试（资格判定一处）|it("reactivates a disabled capability without restoring handles or scheduled jobs", async () => {
CLAIM|30|一致|test/integration/production-capability-gateway.test.ts:589|两处都有回归测试（快照复用一处）|it("reactivates long after startup because the snapshot admitted at startup is reused", async () => {
CLAIM|31|找不到|-|且测试在修之前都复现过失败。|-

未核对的部分：`device-gateway.ts` 及其 `DEVICE_REFERENCE_PLACEHOLDER`、`withServerFilledReferences` 在仓库中不存在，PR 426 和手机能力表也不在本仓库，无法核对；测试在修之前是否复现过失败，无法通过静态阅读当前仓库确认（未运行旧版本测试）。
