CLAIM|1|一致|packages/application/src/services/capability-lifecycle-service.ts:646|停用能力只允许从在用状态进入：`disable` 调用 `invalidate(capabilityRef, "disabled", ["active"], expectedRevision)`。|    return this.invalidate(capabilityRef, "disabled", ["active"], expectedRevision);
CLAIM|2|一致|packages/application/src/services/capability-lifecycle-service.ts:423|现有的“激活”只接受“安装已批准”：`activate` 里 `current.lifecycle !== "installation_approved"` 时抛错。|      current.lifecycle !== "installation_approved" ||
CLAIM|3|一致|packages/application/src/services/capability-lifecycle-service.ts:423|所以已停用的能力不能直接激活。|      current.lifecycle !== "installation_approved" ||
CLAIM|4|一致|packages/persistence-sqlite/src/sqlite-durable-operations.ts:2625|停用时同一个事务撤销该能力的执行句柄并取消它名下的定时任务。|    const transaction = this.database.transaction(() => {
CLAIM|5|一致|packages/persistence-sqlite/src/sqlite-durable-operations.ts:2662|把任务状态写成 `revoked`。|            `UPDATE scheduled_jobs SET status = 'revoked', revision = revision + 1,
CLAIM|6|一致|packages/persistence-sqlite/src/sqlite-durable-operations.ts:2652|把个数存进 `lastInvalidation.cancelledScheduledJobs`。|                  cancelledScheduledJobs: jobs.length,
CLAIM|7|一致|packages/application/src/services/recent-authentication-service.ts:58|`assertRecentAuthentication` 在 `expectedAuthenticationRef` 为空时拒绝。|      !expectedAuthenticationRef ||
CLAIM|8|一致|packages/application/src/services/recent-authentication-service.ts:59|`assertRecentAuthentication` 在 `expectedAuthenticationRef` 不等于当前会话的 `authenticationRef` 时拒绝。|      expectedAuthenticationRef !== authentication.authenticationRef
CLAIM|9|一致|packages/gateway-contracts/src/contracts-v2.ts:1913|`capability.disable` 的载荷带 `recentAuthenticationRef`。|    recentAuthenticationRef: nullable(machineString),
CLAIM|10|一致|packages/gateway-contracts/src/contracts-v2.ts:1923|`capability.rollback` 的载荷带 `recentAuthenticationRef`。|    recentAuthenticationRef: nullable(machineString),
CLAIM|11|一致|packages/gateway-contracts/src/contracts-v2.ts:1875-1882|现成的安装批准命令没有面容字段。|export const approveCapabilityInstallationCommandSchema = object({
CLAIM|12|一致|apps/agent-service/src/production-capability-lifecycle.ts:51-66|生产里“核对安装包”和“资格检查”都读部署快照：`artifacts.verify` 和 `runtime.qualify` 都用 `entryFor`。|        const entry = await entryFor(manifest).catch(() => undefined);
CLAIM|13|一致|apps/agent-service/src/production-capability-lifecycle.ts:40-45|`entryFor` 在快照里找同编号、同版本、同摘要的条目。|        candidate.integrity === manifest.integrity,
CLAIM|14|一致|apps/agent-service/src/production-capability-lifecycle.ts:51-62|生产里“核对安装包摘要”不是在生产机上现场重新跑隔离检查，而是把能力记录里的摘要与上线包里封存的部署快照比对。|        const entry = await entryFor(manifest).catch(() => undefined);
CLAIM|15|一致|apps/agent-service/src/production-capability-lifecycle.ts:65-69|生产里“运行环境资格检查”不是现场重跑隔离检查，而是取快照里那条资格记录。|        return entry.qualification;
CLAIM|16|一致|packages/platform-node/src/capabilities/capability-deployment.ts:30|资格记录的 `checkedAt` 距加载时刻不能超过 5 分钟：`CAPABILITY_DEPLOYMENT_MAX_QUALIFICATION_AGE_MS = 5 * 60 * 1_000`。|export const CAPABILITY_DEPLOYMENT_MAX_QUALIFICATION_AGE_MS = 5 * 60 * 1_000;
CLAIM|17|一致|packages/platform-node/src/capabilities/capability-deployment.ts:619|`parseQualification` 里的 `nowMs - checkedAtMs > maximumAgeMs`。|  if (nowMs - checkedAtMs > maximumAgeMs) {
CLAIM|18|一致|packages/platform-node/src/capabilities/capability-deployment.ts:586|带沙箱证据的资格记录，`resourceCeilings` 必须为假：`checkedEnforcement.resourceCeilings !== false`。|      checkedEnforcement.resourceCeilings !== false ||
CLAIM|19|一致|packages/platform-node/src/capabilities/capability-deployment.ts:595-601|带沙箱证据的资格记录，`requiredControls` 只要求文件系统、网络、进程、密钥四项管控为真。|  const requiredControls = sandbox
CLAIM|20|一致|packages/application/src/ports/configuration.ts:167|快照的路径写在配置的 `capabilityDeployment` 里。|  readonly snapshotPath: string;
CLAIM|21|一致|packages/application/src/ports/configuration.ts:168|快照的摘要写在配置的 `capabilityDeployment` 里。|  readonly sha256: string;
CLAIM|22|一致|packages/platform-node/src/capabilities/capability-deployment.ts:1427-1432|启动时按摘要校验快照。|    if (digest !== this.#expectedSha256) {
CLAIM|23|一致|apps/agent-service/src/production-capability-lifecycle.ts:34-45|之后每次核对前再复核快照文件摘要。|    const current = await revalidateCapabilityDeploymentSnapshot(loaded);
CLAIM|24|一致|packages/platform-node/src/capabilities/capability-deployment.ts:1481-1486|快照文件被改过就拒绝。|  if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== admitted.snapshotDigest)
CLAIM|25|一致|apps/agent-service/src/production-sandbox-services.ts:253-259|沙箱服务执行任务时同样复核快照文件摘要。|    const loaded = await revalidateCapabilityDeploymentSnapshot(initial);
CLAIM|26|一致|apps/agent-service/src/production-capability-lifecycle.ts:51-60|不在快照里（或版本、摘要对不上）的能力一律拒绝，不会把一个已经下线的包重新放出来。|          verified: entry !== undefined,
CLAIM|27|一致|packages/application/src/services/capability-lifecycle-service.ts:92-98|现在带沙箱证据的记录只要求文件系统、网络、进程、密钥四项为真，和加载器一致。|    ? [filesystem, network, processes, secrets]
CLAIM|28|一致|packages/application/src/services/capability-lifecycle-service.ts:92-98|不带沙箱证据的记录仍要求六项全真。|    : [filesystem, network, processes, secrets, resourceCeilings, termination];
CLAIM|29|一致|apps/agent-service/src/production-capability-lifecycle.ts:29-39|现在启动时加载一次，之后只复核文件摘要，和沙箱服务的做法一致。|    const current = await revalidateCapabilityDeploymentSnapshot(loaded);
CLAIM|30|一致|packages/application/src/services/capability-lifecycle-service.ts:415（de7da363^）|此前能力一旦停用就只能走“重新安装审批”。|      current.lifecycle !== "installation_approved" ||
CLAIM|31|一致|packages/application/src/services/capability-lifecycle-service.ts:661（de7da363^）|服务里原先要求资格记录的六项管控全部为真。|      Object.values(qualification.enforcement).some((enforced) => !enforced)
CLAIM|32|一致|packages/application/src/services/capability-lifecycle-service.ts:661（de7da363^）|所以带沙箱证据的能力永远过不了服务里的资格判定。|      Object.values(qualification.enforcement).some((enforced) => !enforced)
CLAIM|33|一致|packages/application/src/services/capability-lifecycle-service.ts:595（de7da363^）|对已有的“退回”同样成立。|    const qualified = await this.qualify(rollback);
CLAIM|34|一致|apps/agent-service/src/production-capability-lifecycle.ts:33（de7da363^）|原先每次核对都重新加载快照。|      const loaded = await loader.load();
CLAIM|35|一致|apps/agent-service/src/production-capability-lifecycle.ts:33（de7da363^）|所以启动 5 分钟后任何核对都会因为“资格过旧”失败。|      const loaded = await loader.load();
CLAIM|36|一致|test/integration/production-capability-gateway.test.ts:555,589|两处都有回归测试。|it("reactivates a disabled capability without restoring handles or scheduled jobs", async () => { it("reactivates long after startup because the snapshot admitted at startup is reused", async () => {

未核对的部分：手机端能力表登记、控制中心按钮、审计与重放等计划项，以及 `/mnt/project-files/four-features-wiring/integrated-plan.md` 的外部设计文档；这些要么是计划事项，要么不在仓库内。历史“原先”说法我按 `de7da363^` 的代码对照过。
