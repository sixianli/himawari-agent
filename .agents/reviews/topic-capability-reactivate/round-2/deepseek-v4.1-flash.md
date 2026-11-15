CLAIM|1|一致|packages/application/src/services/capability-lifecycle-service.ts:646|停用能力只允许从在用状态进入：`disable` 调用 `invalidate(capabilityRef, "disabled", ["active"], expectedRevision)`。|return this.invalidate(capabilityRef, "disabled", ["active"], expectedRevision);
CLAIM|2|一致|packages/application/src/services/capability-lifecycle-service.ts:423|现有的“激活”只接受“安装已批准”：`activate` 里 `current.lifecycle !== "installation_approved"` 时抛错。|current.lifecycle !== "installation_approved" ||
CLAIM|3|一致|packages/application/src/services/capability-lifecycle-service.ts:427|所以已停用的能力不能直接激活。|return this.invalid(current, "active");
CLAIM|4|一致|packages/persistence-sqlite/src/sqlite-durable-operations.ts:2625|停用时同一个事务撤销该能力的执行句柄。|const transaction = this.database.transaction(() => { this.revokeCapabilityHandlesCore({
CLAIM|5|一致|packages/persistence-sqlite/src/sqlite-durable-operations.ts:2662|停用时同一个事务取消它名下的定时任务。|UPDATE scheduled_jobs SET status = 'revoked', revision = revision + 1,
CLAIM|6|一致|packages/persistence-sqlite/src/sqlite-durable-operations.ts:2662|把任务状态写成 `revoked`。|UPDATE scheduled_jobs SET status = 'revoked', revision = revision + 1,
CLAIM|7|一致|packages/persistence-sqlite/src/sqlite-durable-operations.ts:2652|把个数存进 `lastInvalidation.cancelledScheduledJobs`。|cancelledScheduledJobs: jobs.length,
CLAIM|8|一致|packages/application/src/services/recent-authentication-service.ts:58|`assertRecentAuthentication` 在 `expectedAuthenticationRef` 为空时拒绝。|!expectedAuthenticationRef ||
CLAIM|9|一致|packages/application/src/services/recent-authentication-service.ts:59|`assertRecentAuthentication` 在 `expectedAuthenticationRef` 不等于当前会话的 `authenticationRef` 时拒绝。|expectedAuthenticationRef !== authentication.authenticationRef
CLAIM|10|一致|packages/gateway-contracts/src/contracts-v2.ts:1913|`capability.disable` 的载荷带 `recentAuthenticationRef`。|recentAuthenticationRef: nullable(machineString),
CLAIM|11|一致|packages/gateway-contracts/src/contracts-v2.ts:1923|`capability.rollback` 的载荷带 `recentAuthenticationRef`。|recentAuthenticationRef: nullable(machineString),
CLAIM|12|一致|apps/agent-service/src/production-capability-lifecycle.ts:52|`artifacts.verify` 用 `entryFor` 在快照里找条目。|const entry = await entryFor(manifest).catch(() => undefined);
CLAIM|13|一致|apps/agent-service/src/production-capability-lifecycle.ts:66|`runtime.qualify` 用 `entryFor` 在快照里找条目。|const entry = await entryFor(manifest);
CLAIM|14|一致|apps/agent-service/src/production-capability-lifecycle.ts:42|`entryFor` 在快照里找同编号、同版本、同摘要的条目。|candidate.ref === manifest.ref && candidate.version === manifest.version && candidate.integrity === manifest.integrity,
CLAIM|15|一致|packages/platform-node/src/capabilities/capability-deployment.ts:30|`CAPABILITY_DEPLOYMENT_MAX_QUALIFICATION_AGE_MS = 5 * 60 * 1_000`。|export const CAPABILITY_DEPLOYMENT_MAX_QUALIFICATION_AGE_MS = 5 * 60 * 1_000;
CLAIM|16|一致|packages/platform-node/src/capabilities/capability-deployment.ts:619|`parseQualification` 里的 `nowMs - checkedAtMs > maximumAgeMs`。|if (nowMs - checkedAtMs > maximumAgeMs) {
CLAIM|17|一致|packages/platform-node/src/capabilities/capability-deployment.ts:597|带沙箱证据的资格记录，部署快照加载器只要求文件系统、网络、进程、密钥四项管控为真。|checkedEnforcement.filesystem, checkedEnforcement.network, checkedEnforcement.processes, checkedEnforcement.secrets,
CLAIM|18|一致|packages/platform-node/src/capabilities/capability-deployment.ts:586|带沙箱证据的资格记录，`resourceCeilings` 必须为假。|checkedEnforcement.resourceCeilings !== false ||
CLAIM|19|一致|packages/gateway-contracts/src/contracts-v2.ts:1878|现成的安装批准命令没有面容字段。|capabilityRef: machineString, expectedRevision: integer(1), approvalRef: machineString,
CLAIM|20|一致|packages/application/src/services/capability-lifecycle-service.ts:423|现有的“已停用直接激活”仍被拒绝（`activate` 不动）。|current.lifecycle !== "installation_approved" ||
CLAIM|21|一致|packages/application/src/services/capability-lifecycle-service.ts:96|现在带沙箱证据的记录只要求文件系统、网络、进程、密钥四项为真。|? [filesystem, network, processes, secrets]
CLAIM|22|一致|packages/application/src/services/capability-lifecycle-service.ts:97|不带沙箱证据的记录仍要求六项全真。|: [filesystem, network, processes, secrets, resourceCeilings, termination];
CLAIM|23|一致|apps/agent-service/src/production-capability-lifecycle.ts:30|现在启动时加载一次。|? new CapabilityDeploymentSnapshotLoader({ ...deployment, now: () => clock.now() }) .load()
CLAIM|24|一致|apps/agent-service/src/production-capability-lifecycle.ts:39|之后每次核对前再复核快照。|const current = await revalidateCapabilityDeploymentSnapshot(loaded);
CLAIM|25|一致|apps/agent-service/src/production-sandbox-services.ts:254|沙箱服务执行任务时同样复核快照文件摘要。|const loaded = await revalidateCapabilityDeploymentSnapshot(initial);
CLAIM|26|一致|apps/agent-service/src/production-capability-lifecycle.ts:52|生产里“核对安装包摘要”和“运行环境资格检查”不是在生产机上现场重新跑隔离检查，而是读部署快照并取快照里那条资格记录。|const entry = await entryFor(manifest).catch(() => undefined); const entry = await entryFor(manifest);
CLAIM|27|一致|packages/application/src/ports/configuration.ts:167|快照的路径和摘要写在配置的 `capabilityDeployment` 里。|readonly snapshotPath: string; readonly sha256: string;
CLAIM|28|一致|packages/platform-node/src/capabilities/capability-deployment.ts:1428|启动时按摘要校验。|if (digest !== this.#expectedSha256) {
CLAIM|29|一致|packages/platform-node/src/capabilities/capability-deployment.ts:1482|之后每次核对前再复核快照文件摘要，文件被改过就拒绝。|if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== admitted.snapshotDigest)
CLAIM|30|一致|packages/application/src/services/capability-lifecycle-service.ts:661（de7da363^）|服务里原先要求资格记录的六项管控全部为真。|Object.values(qualification.enforcement).some((enforced) => !enforced)
CLAIM|31|一致|apps/agent-service/src/production-capability-lifecycle.ts:34（de7da363^）|原先每次核对都重新加载快照。|const loaded = await loader.load();
CLAIM|32|一致|test/integration/production-capability-gateway.test.ts:555|资格判定修复有回归测试。|it("reactivates a disabled capability without restoring handles or scheduled jobs", async () => {
CLAIM|33|一致|test/integration/production-capability-gateway.test.ts:589|快照加载修复有回归测试。|it("reactivates long after startup because the snapshot admitted at startup is reused", async () => {
CLAIM|34|一致|docs/adr/0229-native-apple-clients-and-device-api.md:10|关联文档 ADR 0229 存在。|# ADR 0229：做 iPhone、Apple Watch、Mac 的原生客户端，设备走专用接口、设备密钥和苹果推送
CLAIM|35|找不到|-|手机能力表和手机占位值、服务器代填认证引用的机制在另一个未合并的 PR（426）里。|-
CLAIM|36|找不到|-|生产只有一台机器。|-

未核实：另一个未合并 PR（426）里的手机能力表和占位值/代填机制（本仓库里没有该 PR 的内容）、生产是否只有一台机器（仓库里没有部署拓扑资料），以及 `/mnt/project-files/four-features-wiring/integrated-plan.md` 这份外部设计文档。
