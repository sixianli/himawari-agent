CLAIM|1|一致|packages/application/src/services/capability-lifecycle-service.ts:646|停用能力只允许从在用状态进入|return this.invalidate(capabilityRef, "disabled", ["active"], expectedRevision);
CLAIM|2|一致|packages/application/src/services/capability-lifecycle-service.ts:646|`disable` 调用 `invalidate(capabilityRef, "disabled", ["active"], expectedRevision)`|return this.invalidate(capabilityRef, "disabled", ["active"], expectedRevision);
CLAIM|3|一致|packages/application/src/services/capability-lifecycle-service.ts:418|现有的“激活”只接受“安装已批准”|current.lifecycle !== "installation_approved" ||
CLAIM|4|一致|packages/application/src/services/capability-lifecycle-service.ts:418|同文件 `activate` 里 `current.lifecycle !== "installation_approved"` 时抛错|current.lifecycle !== "installation_approved" ||
CLAIM|5|一致|packages/application/src/services/capability-lifecycle-service.ts:418|所以已停用的能力不能直接激活|current.lifecycle !== "installation_approved" ||
CLAIM|6|一致|packages/persistence-sqlite/src/sqlite-durable-operations.ts:2625|停用时同一个事务撤销该能力的执行句柄|const transaction = this.database.transaction(() => {
CLAIM|7|一致|packages/persistence-sqlite/src/sqlite-durable-operations.ts:2668|停用时取消它名下的定时任务|status: "cancelled",
CLAIM|8|一致|packages/persistence-sqlite/src/sqlite-durable-operations.ts:2652|把个数存进 `lastInvalidation` 的 `cancelledScheduledJobs`|cancelledScheduledJobs: jobs.length,
CLAIM|9|一致|packages/application/src/services/recent-authentication-service.ts:58|`assertRecentAuthentication` 在 `expectedAuthenticationRef` 为空时拒绝|!expectedAuthenticationRef ||
CLAIM|10|一致|packages/application/src/services/recent-authentication-service.ts:59|`assertRecentAuthentication` 在 `expectedAuthenticationRef` 不等于当前会话的 `authenticationRef` 时拒绝|expectedAuthenticationRef !== authentication.authenticationRef
CLAIM|11|一致|packages/platform-node/src/capabilities/capability-deployment.ts:30|`CAPABILITY_DEPLOYMENT_MAX_QUALIFICATION_AGE_MS = 5 * 60 * 1_000`|export const CAPABILITY_DEPLOYMENT_MAX_QUALIFICATION_AGE_MS = 5 * 60 * 1_000;
CLAIM|12|一致|packages/platform-node/src/capabilities/capability-deployment.ts:619|部署快照加载器要求资格记录的 `checkedAt` 距加载时刻不超过 5 分钟|if (nowMs - checkedAtMs > maximumAgeMs) {
CLAIM|13|一致|packages/platform-node/src/capabilities/capability-deployment.ts:1476|这条只管启动时的准入|* freshness gates admission; subsequent jobs still verify snapshot bytes and the
CLAIM|14|一致|packages/platform-node/src/capabilities/capability-deployment.ts:1476|`revalidateCapabilityDeploymentSnapshot` 上方的说明原话是 “Qualification freshness gates admission; subsequent jobs still verify snapshot bytes and the actual host/runtime binding.”|* freshness gates admission; subsequent jobs still verify snapshot bytes and the
CLAIM|15|一致|apps/execution-worker/src/production-worker-composition.ts:423|`qualifyProductionWorkerDeployment` 调用 `qualifyDeployment`|await qualifyDeployment(deployment, clock, platform, isolation);
CLAIM|16|一致|apps/execution-worker/src/production-worker-composition.ts:392|执行进程启动时现场跑一遍资格检查并和快照比对|const mismatch = qualificationMismatch(entry.qualification, actual);
CLAIM|17|一致|apps/execution-worker/src/service-main.ts:165|执行进程写启动绑定不等资格检查完成，两件事并行进行|const [binding, qualified] = await bindingThenQualification(
CLAIM|18|一致|apps/execution-worker/src/service-main.ts:165|`waitForAgentBinding` 和 `qualifyProductionWorkerDeployment` 经 `bindingThenQualification` 一起等|const [binding, qualified] = await bindingThenQualification(
CLAIM|19|一致|apps/execution-worker/src/service-main.ts:99|`waitForAgentBinding` 内部调用 `writeWorkerServiceBootBinding`|await writeWorkerServiceBootBinding(input.layout, {
CLAIM|20|一致|packages/platform-node/src/state-root-layout.ts:347|启动绑定的字段里没有快照摘要：`packages/platform-node/src/state-root-layout.ts` 的 `WORKER_BOOT_BINDING_FIELDS`|const WORKER_BOOT_BINDING_FIELDS = Object.freeze([
CLAIM|21|一致|docs/adr/0036-agent-worker-restart-as-a-pair.md:38|ADR 0036 决定第 1 条“Agent 和 Worker 是一个重启单位”|1. **Agent 和 Worker 是一个重启单位。**
CLAIM|22|找不到|-|方案在项目文件夹 `four-features-wiring/integrated-plan.md`|-
CLAIM|23|找不到|-|以 v2 第 6 条和 v3 第 17 条为准|-
CLAIM|24|一致|packages/platform-node/src/state-root-layout.ts:344|现有的启动绑定文件 `execution-worker.boot.json`|return path.join(layout.runtime, "execution-worker.boot.json");
CLAIM|25|一致|packages/platform-node/src/state-root-layout.ts:347|启动绑定文件的格式不变|const WORKER_BOOT_BINDING_FIELDS = Object.freeze([
CLAIM|26|一致|apps/execution-worker/src/service-main.ts:99|启动绑定文件的写入时机不变|await writeWorkerServiceBootBinding(input.layout, {
CLAIM|27|一致|apps/agent-service/src/service-main.ts:438|agent-service 启动时等的仍是它|const binding = await readWorkerServiceBootBinding(input.layout).catch(() => undefined);
CLAIM|28|一致|packages/platform-node/src/state-root-layout.ts:545|和启动绑定共用同一对函数（`commitWorkerRuntimeRecord`、`readWorkerRuntimeRecord`）|await commitWorkerRuntimeRecord(
CLAIM|29|一致|packages/platform-node/src/state-root-layout.ts:375|临时文件加原子改名|await rename(temporary, file);
CLAIM|30|一致|packages/platform-node/src/state-root-layout.ts:376|权限 0600|await chmod(file, 0o600);
CLAIM|31|一致|packages/platform-node/src/state-root-layout.ts:399|读时拒绝符号链接、组或其他人可读写的文件|if (!info?.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
CLAIM|32|一致|packages/platform-node/src/state-root-layout.ts:405|读时拒绝属主不是服务账号的文件|if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
CLAIM|33|一致|packages/platform-node/src/state-root-layout.ts:427|读时拒绝多余字段|if (input["schemaVersion"] !== 1 || Object.keys(input).some((field) => !fields.includes(field))) {
CLAIM|34|一致|scripts/delivery-mode/packet-template/systemd/S7-startup-readback.mjs:234|`scripts/delivery-mode/` 下读启动绑定的有两处|const [authority, agent, worker] = await Promise.all([platform.readAuthorityFile(layout), platform.readAgentServiceBootBinding(layout), platform.readWorkerServiceBootBinding(layout)]);
CLAIM|35|一致|scripts/delivery-mode/packet-template/systemd/S7-startup-readback.mjs:234|`packet-template/systemd/S7-startup-readback.mjs` 调用 `readWorkerServiceBootBinding`|const [authority, agent, worker] = await Promise.all([platform.readAuthorityFile(layout), platform.readAgentServiceBootBinding(layout), platform.readWorkerServiceBootBinding(layout)]);
CLAIM|36|一致|scripts/delivery-mode/packet-template/acceptance/cloud/probe-source/test/qualification/sandbox-install-restart-probe.mjs:1032|`packet-template/acceptance/cloud/probe-source/test/qualification/sandbox-install-restart-probe.mjs` 调用 `readWorkerServiceBootBinding`|workerBoot = await platform.readWorkerServiceBootBinding(layout);
CLAIM|37|一致|packages/platform-node/src/state-root-layout.ts:344|它们读的那份文件没有变|return path.join(layout.runtime, "execution-worker.boot.json");
CLAIM|38|一致|docs/adr/0036-agent-worker-restart-as-a-pair.md:38|两个进程成对重启|1. **Agent 和 Worker 是一个重启单位。**
CLAIM|39|一致|apps/agent-service/src/production-sandbox-services.ts:254|`apps/agent-service/src/production-sandbox-services.ts` 调用 `revalidateCapabilityDeploymentSnapshot`|const loaded = await revalidateCapabilityDeploymentSnapshot(initial);
CLAIM|40|一致|packages/platform-node/src/capabilities/capability-deployment.ts:1482|沙箱服务仍然复核快照文件摘要|if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== admitted.snapshotDigest)
CLAIM|41|一致|packages/application/src/services/capability-lifecycle-service.ts:685|`CapabilityLifecycleService` 的 `qualify` 要求资格记录的六项管控全部为真（`Object.values(qualification.enforcement).some((enforced) => !enforced)`）|Object.values(qualification.enforcement).some((enforced) => !enforced)
CLAIM|42|一致|packages/platform-node/src/capabilities/capability-deployment.ts:586|部署快照加载器要求带沙箱证据的记录 `resourceCeilings` 为假（`checkedEnforcement.resourceCeilings !== false`）|checkedEnforcement.resourceCeilings !== false ||
CLAIM|43|一致|packages/application/src/services/capability-lifecycle-service.ts:685|两处要求相反|Object.values(qualification.enforcement).some((enforced) => !enforced)
CLAIM|44|不一致|packages/platform-node/src/capabilities/isolation.ts:285|带沙箱证据的能力经 `qualify` 过不了|resourceCeilings: input.ready,
CLAIM|45|一致|packages/application/src/services/capability-lifecycle-service.ts:423|受影响的是安装批准后的激活|const qualified = await this.qualify(manifest);
CLAIM|46|一致|packages/application/src/services/capability-lifecycle-service.ts:542|受影响的是更新激活|const qualified = await this.qualify(candidate);
CLAIM|47|一致|packages/application/src/services/capability-lifecycle-service.ts:598|受影响的是退回|const qualified = await this.qualify(rollback);
CLAIM|48|一致|apps/execution-worker/test/service-main.unit.test.ts:196|执行进程“现场检查通过后才写出记录”的顺序，由代码顺序和失败路径的单元测试保证（启动失败时没有记录、上一次的记录被删掉）|it("clears an earlier boot's qualified record and publishes none when startup fails", async () => {

项目文件夹 `four-features-wiring/integrated-plan.md` 不在仓库中，因此 v2 第 6 条和 v3 第 17 条无法核对；历史性说法（此前没有任何命令能重新启用、第一版实现走加载器等）和本方案新增/修改的行为按规则未作为现状核对。
