你是方案里“关于代码和文档现状的说法”的核对者。
你能用的工具：read、grep、glob，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。不能上网。
下面是一份还没合并的方案或 ADR。第一步，把其中每一句讲代码或仓库文档现状的话都列出来：某个文件、函数、字段、配置、命令、数字、规则现在是什么样、做什么、不做什么；一句话里有几个说法就拆成几条。方案打算新增或修改什么，不算现状；讲外部网站、第三方产品的话也不算。第二步，逐条自己打开对应的文件核对，给出：一致、不一致、找不到（仓库里没有这个东西，或没读到能证明它的内容）。材料里的说法可能有错，写得再肯定也不能因此判一致；没有亲自读到对应代码，就判找不到。只核对事实，不评价方案好不好，不提建议。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
输出格式：每个说法单独一行，不换行，字段之间用竖线分隔，行首写 CLAIM：
CLAIM|<序号>|<一致 或 不一致 或 找不到>|<文件:行>|<方案原句>|<代码原文>
序号用 1、2、3……，不重复。文件:行 写你读到证据的那个文件和行号，例如 packages/x/src/y.ts:42；找不到时写 -。代码原文必须是你亲自读到的、逐字摘抄的一行或几行，不要改写、不要概括；方案原句里的竖线字符换成全角的“｜”，代码原文里的竖线照原样写。列完所有 CLAIM 行之后，另起一段，用一两句话写你没能核对的部分。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 14398657a9978d43f6d5a4c1bb0edf1186eb32c0。
待核对的方案：
方案文件：docs/adr/0254-capability-reactivation-is-one-atomic-command.md（在提交 14398657a9978d43f6d5a4c1bb0edf1186eb32c0 里的内容）

---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
amends: ""
date: "2026-11-12"
---

# ADR 0254：能力重新启用是一条原子命令，核对封存快照和执行进程通过检查后的公布

<a id="contents"></a>

## 阅读导航

- [前提和来源](#premises)
- [背景](#context)
- [决定](#decision)
- [进程之间新增的一份文件](#process-contract)
- [为什么对照快照就够](#why-snapshot)
- [比较过的方案](#options)
- [已知问题](#known-issues)
- [后果](#consequences)
- [关联文档](#references)

<a id="premises"></a>

## 前提和来源

1. 停用能力只允许从在用状态进入：`packages/application/src/services/capability-lifecycle-service.ts` 的 `disable` 调用 `invalidate(capabilityRef, "disabled", ["active"], expectedRevision)`。
2. 现有的“激活”只接受“安装已批准”：同文件 `activate` 里 `current.lifecycle !== "installation_approved"` 时抛错。所以已停用的能力不能直接激活。
3. 停用时同一个事务撤销该能力的执行句柄并取消它名下的定时任务：`packages/persistence-sqlite/src/sqlite-durable-operations.ts` 的 `invalidateCapabilityAuthority`，把个数存进 `lastInvalidation` 的 `cancelledScheduledJobs`。
4. 服务器端验最近认证的办法：`packages/application/src/services/recent-authentication-service.ts` 的 `assertRecentAuthentication` 在 `expectedAuthenticationRef` 为空或不等于当前会话的 `authenticationRef` 时拒绝。
5. 部署快照加载器要求资格记录的 `checkedAt` 距加载时刻不超过 5 分钟：`packages/platform-node/src/capabilities/capability-deployment.ts` 的 `CAPABILITY_DEPLOYMENT_MAX_QUALIFICATION_AGE_MS = 5 * 60 * 1_000`。这条只管启动时的准入，同文件 `revalidateCapabilityDeploymentSnapshot` 上方的说明原话是 “Qualification freshness gates admission; subsequent jobs still verify snapshot bytes and the actual host/runtime binding.”
6. 执行进程启动时现场跑一遍资格检查并和快照比对：`apps/execution-worker/src/production-worker-composition.ts` 的 `qualifyProductionWorkerDeployment` 调用 `qualifyDeployment`。
7. 执行进程写启动绑定不等资格检查完成，两件事并行进行：`apps/execution-worker/src/service-main.ts` 里 `waitForAgentBinding` 和 `qualifyProductionWorkerDeployment` 经 `bindingThenQualification` 一起等，`waitForAgentBinding` 内部调用 `writeWorkerServiceBootBinding`。启动绑定的字段里没有快照摘要：`packages/platform-node/src/state-root-layout.ts` 的 `WORKER_BOOT_BINDING_FIELDS`。
8. 两个进程成对重启：[ADR 0036](0036-agent-worker-restart-as-a-pair.md) 决定第 1 条“Agent 和 Worker 是一个重启单位”。

[↑ 返回阅读导航](#contents)

<a id="context"></a>

## 背景

2026-11-12，Andy 同意“重新启用 = 重新检查 + 面容，定时任务不自动恢复”（四块功能设计线程的结论；方案文件在仓库之外的项目文件夹里，本 ADR 把用到的结论都写在下面）。此前能力一旦停用，没有任何命令能让它回到在用（前提 2）。

对标：本线程没有单独调研其他产品的做法，沿用设计线程方案的结论。根因层面的处理是：给“已停用到在用”一条受控的路径（先验面容、再核对），而不是把安装审批流程改宽。

第一版实现让重新启用走部署快照加载器，结果启动 5 分钟后必然失败（前提 5）。设计线程因此定下：运行期核验另写入口，不走启动准入那条规则，也不放宽那个数。

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. 新增命令 `capability.reactivate`，载荷是能力编号、期望版本号（即 `expectedRevision`，能力记录的修订号）、原因码、最近认证引用。本命令归“改”类操作：要面容确认，服务器端核对最近认证。
2. 顺序：先验最近认证；再核对期望版本号（不符返回冲突）；状态必须是已停用；然后做下面三项核对，全部通过才把状态从已停用直接写成在用。任何一步失败，能力记录不变。
   - (a) 快照文件的摘要仍等于配置里封存的摘要。
   - (b) 这个能力的编号、版本、安装包摘要和快照里那一条完全一致。
   - (c) 执行进程在通过现场检查之后公布了一份记录，记录里的启动编号等于 agent-service 当前认定的对端启动编号，记录里的快照摘要等于配置里封存的摘要。
3. 每种失败给出各自的原因码：快照读不出、快照摘要不符、能力不在快照里、执行进程没有公布、启动编号不符、执行进程准入的是另一份快照。
4. 不恢复执行句柄，不恢复被取消的定时任务。`lastInvalidation` 原样保留。重新启用不改能力声明和资格记录，只改状态和修订号。
5. 现有的“已停用直接激活”仍被拒绝（`activate` 不动）。重新启用不依赖退回上一版。
6. 审计：复用现有治理命令的审计追加，动作名是命令类型。
7. 同一条命令重放：记录已是在用且修订号等于期望加 1 时，直接返回同一结果，不再核对、不重复写。
8. 生产网关只在核验入口已装配时才把 `capability.reactivate` 列进已安装清单；网页只对已安装的操作显示按钮。配置里没有部署快照时不装配核验入口，命令不进已安装清单。
10. 最近认证在写幂等收据之前先验一次（和停用、退回相同）：认证没过的请求不留收据，不占用那个幂等键。
9. 界面和回执的说法是“核对安装包和上线时的检查结果”，不写“已重新检查运行环境”。

[↑ 返回阅读导航](#contents)

<a id="process-contract"></a>

## 进程之间新增的一份文件

这是进程间契约的改动，单列说明。

- 执行进程启动时先删掉上一次留下的记录；现场检查通过、且拿到 agent-service 的绑定之后，才写出 `runtime/execution-worker.qualified.json`。字段：`schemaVersion`、`workerInstanceId`、`workerBootId`、`deploymentId`、`snapshotDigest`。读到这份文件且启动编号对得上，就等于这次启动的现场检查已经通过。写出记录之后启动仍然失败的（例如后面的装配或监听出错），退出前把记录删掉。
- 现有的启动绑定文件 `execution-worker.boot.json` 的格式和写入时机都不变，agent-service 启动时等的仍是它，启动顺序不受影响。
- 读写沿用启动绑定的安全做法，和启动绑定共用同一对函数（`commitWorkerRuntimeRecord`、`readWorkerRuntimeRecord`）：临时文件加原子改名、权限 0600；读时拒绝符号链接、组或其他人可读写的文件、属主不是服务账号的文件、超过 16384 字节的文件、多余字段。
- 两个进程成对重启（前提 8），所以不考虑新旧版本混跑，文件不做旧格式兼容。
- 上线脚本不用改：`scripts/delivery-mode/` 下读启动绑定的有两处，`packet-template/systemd/S7-startup-readback.mjs` 和 `packet-template/acceptance/cloud/probe-source/test/qualification/sandbox-install-restart-probe.mjs`（都调用 `readWorkerServiceBootBinding`），它们读的那份文件没有变。

[↑ 返回阅读导航](#contents)

<a id="why-snapshot"></a>

## 为什么对照快照就够

事实：重新启用时不在生产机上现场重跑隔离检查。它核对的是上线包里封存的部署快照，加上执行进程这次启动时现场检查通过的证据（决定第 2 条的 (c)）。

为什么够：

- 能被重新启用的只能是当前快照里带的那一条；不在快照里、版本或摘要对不上的一律拒绝。
- 现场检查在执行进程启动时做过一次（前提 6），(c) 确认的就是“这次启动做过、通过了、对的是同一份快照”。
- 重新启用只决定这个能力在不在可用清单里。真正调用时，沙箱服务仍然复核快照文件摘要（`apps/agent-service/src/production-sandbox-services.ts` 调用 `revalidateCapabilityDeploymentSnapshot`）。

局限：快照和执行进程的公布只证明“启动时检查通过”，不证明“此刻机器上的隔离环境仍然健康”。所以界面不写“已重新检查运行环境”。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

- 两步走（先回到待批准安装，再由主人批准）：没采纳。第二步失败会停在“已批准未激活”，主人看到的状态更多。
- 重新启用时同时恢复定时任务：没采纳。被取消的任务可能已过期，自动恢复等于不经确认重新授权。
- 让重新启用走部署快照加载器，或给加载器传一个很大的最大年龄：没采纳。那条新鲜度规则是启动准入用的（前提 5），放宽它会同时放宽启动准入。
- 不加文件，只确认执行进程在服务：没采纳。那样“同一份快照”只是假设两个进程的配置相同，不是核对。
- 把摘要加进现有的启动绑定：没采纳。写启动绑定不等现场检查完成（前提 7），加进去就不能表示“检查已通过”。

[↑ 返回阅读导航](#contents)

<a id="known-issues"></a>

## 已知问题

- `CapabilityLifecycleService` 的 `qualify` 要求资格记录的六项管控全部为真（`Object.values(qualification.enforcement).some((enforced) => !enforced)`），而部署快照加载器要求带沙箱证据的记录 `resourceCeilings` 为假（`checkedEnforcement.resourceCeilings !== false`）。两处要求相反：加载器放行的带沙箱证据的资格记录，`resourceCeilings` 一定为假，交给 `qualify` 的这项判断就一定不过。重新启用不走 `qualify`，不受影响；受影响的是安装批准后的激活、更新激活和退回。本 PR 不修，已报给协调者另开任务。
- 执行进程“现场检查通过后才写出记录”的顺序，由代码顺序和失败路径的单元测试保证（现场检查没通过时没有记录、上一次的记录被删掉）；完整启动成功后写出记录、写出之后启动失败时删掉记录这两条，要在有上线包的环境里用进程级测试或上线后的读回确认，云端容器里跑不了。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 不改表，不改迁移号，不改发给模型的内容。
- 契约新增一个命令类型；运行目录多一份文件。
- 手机端要把 `capability.reactivate` 登记进手机能力表，归“改”类；等手机相关的改动合并后由第 11 批线程做。
- 重新启用只恢复能力本身，句柄和定时任务不回来。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [ADR 0036：Agent Service 与 Execution Worker 必须成对重启](0036-agent-worker-restart-as-a-pair.md)

[↑ 返回阅读导航](#contents)
