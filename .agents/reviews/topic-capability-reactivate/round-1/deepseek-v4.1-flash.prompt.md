你是方案里“关于代码和文档现状的说法”的核对者。
你能用的工具：read、grep、glob，以及 git diff、git log、git show、git blame、git status 这几条 git 命令。不能修改任何文件，不能运行别的命令。不能上网。
下面是一份还没合并的方案或 ADR。第一步，把其中每一句讲代码或仓库文档现状的话都列出来：某个文件、函数、字段、配置、命令、数字、规则现在是什么样、做什么、不做什么；一句话里有几个说法就拆成几条。方案打算新增或修改什么，不算现状；讲外部网站、第三方产品的话也不算。第二步，逐条自己打开对应的文件核对，给出：一致、不一致、找不到（仓库里没有这个东西，或没读到能证明它的内容）。材料里的说法可能有错，写得再肯定也不能因此判一致；没有亲自读到对应代码，就判找不到。只核对事实，不评价方案好不好，不提建议。
做法：先想清楚要回答哪几个问题、需要看哪些文件或资料，再直接去读这些地方；不要漫无目的地浏览代码，也不要用相同或相近的参数反复调用工具。读到的内容一旦足以下结论，就停止调用工具，写出结论；没读到的地方标「未核实」，不要为了查全而一直查下去。
输出格式：每个说法单独一行，不换行，字段之间用竖线分隔，行首写 CLAIM：
CLAIM|<序号>|<一致 或 不一致 或 找不到>|<文件:行>|<方案原句>|<代码原文>
序号用 1、2、3……，不重复。文件:行 写你读到证据的那个文件和行号，例如 packages/x/src/y.ts:42；找不到时写 -。代码原文必须是你亲自读到的、逐字摘抄的一行或几行，不要改写、不要概括；方案原句里的竖线字符换成全角的“｜”，代码原文里的竖线照原样写。列完所有 CLAIM 行之后，另起一段，用一两句话写你没能核对的部分。用简体中文。

---- 本次材料 ----
仓库就是当前目录，已检出 de7da3639829a768182cdd5e11e296fb412c81ce。
待核对的方案：
方案文件：docs/adr/0253-capability-reactivation-is-one-atomic-command.md（在提交 de7da3639829a768182cdd5e11e296fb412c81ce 里的内容）

---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
amends: ""
date: "2026-11-12"
---

# ADR 0253：能力重新启用是一条原子命令，只对照上线包里封存的部署快照

<a id="contents"></a>

## 阅读导航

- [前提和来源](#premises)
- [背景](#context)
- [决定](#decision)
- [为什么只对照快照就够](#why-snapshot)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="premises"></a>

## 前提和来源

1. 停用能力只允许从在用状态进入：`packages/application/src/services/capability-lifecycle-service.ts` 的 `disable` 调用 `invalidate(capabilityRef, "disabled", ["active"], expectedRevision)`。
2. 现有的“激活”只接受“安装已批准”：同文件 `activate` 里 `current.lifecycle !== "installation_approved"` 时抛错。所以已停用的能力不能直接激活。
3. 停用时同一个事务撤销该能力的执行句柄并取消它名下的定时任务：`packages/persistence-sqlite/src/sqlite-durable-operations.ts` 的 `invalidateCapabilityAuthority`，把任务状态写成 `revoked` 并把个数存进 `lastInvalidation.cancelledScheduledJobs`。
4. 服务器端验最近认证的办法：`packages/application/src/services/recent-authentication-service.ts` 的 `assertRecentAuthentication` 在 `expectedAuthenticationRef` 为空或不等于当前会话的 `authenticationRef` 时拒绝。
5. 手机只填占位值 `device`、由服务器代填认证引用：`packages/platform-node/src/device-gateway.ts` 的 `DEVICE_REFERENCE_PLACEHOLDER` 和 `withServerFilledReferences`（这个文件在 PR 426 里，本 PR 的基底分支里还没有）。
6. 生产里“核对安装包”和“资格检查”都读部署快照：`apps/agent-service/src/production-capability-lifecycle.ts` 的 `artifacts.verify` 和 `runtime.qualify` 都用 `entryFor` 在快照里找同编号、同版本、同摘要的条目。
7. 快照加载时，资格记录的 `checkedAt` 距加载时刻不能超过 5 分钟：`packages/platform-node/src/capabilities/capability-deployment.ts` 的 `CAPABILITY_DEPLOYMENT_MAX_QUALIFICATION_AGE_MS = 5 * 60 * 1_000` 和 `parseQualification` 里的 `nowMs - checkedAtMs > maximumAgeMs`。
8. 带沙箱证据的资格记录，部署快照加载器只要求文件系统、网络、进程、密钥四项管控为真，`resourceCeilings` 必须为假：同文件 `checkedEnforcement.resourceCeilings !== false` 和 `requiredControls`。

[↑ 返回阅读导航](#contents)

<a id="context"></a>

## 背景

2026-11-12，Andy 同意“重新启用 = 重新检查 + 面容，定时任务不自动恢复”（四块功能接线的设计结论，方案见 `/mnt/project-files/four-features-wiring/integrated-plan.md` 的 v2 一节第 6 条）。此前能力一旦停用就只能走“重新安装审批”，而现成的安装批准命令没有面容字段，两步走失败还会停在“已批准未激活”。

对标：本线程没有单独调研其他产品的做法，沿用设计线程方案的结论。根因层面的处理是：直接给“已停用到在用”一条受控的路径（先验面容、再核对安装包），而不是把安装审批流程改宽。

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. 新增命令 `capability.reactivate`，载荷是能力编号、期望版本号（即 `expectedRevision`，能力记录的修订号）、原因码、最近认证引用。它和 `capability.disable`、`capability.rollback` 一样属于“改”类操作：手机端要面容确认，服务器端核对最近认证。
2. 顺序：先验最近认证；再读取能力记录并核对期望版本号（不符返回冲突）；状态必须是已停用；对照部署快照核对安装包摘要并取资格记录；全部通过才把状态从已停用直接写成在用。任何一步失败，能力记录一个字节都不变。
3. 不恢复执行句柄，不恢复被取消的定时任务。`lastInvalidation`（上次停用取消了几个定时任务）原样保留，界面继续显示“它们不会恢复”。
4. 现有的“已停用直接激活”仍被拒绝（`activate` 不动）；只有这条命令能让已停用的能力回到在用。
5. 审计：写一条审计记录，动作名是命令类型，复用现有治理命令的审计追加。
6. 同一条命令重放（恢复场景）：记录已是在用且修订号等于期望加 1 时，直接返回同一结果，不再验证、不重复写。
7. 手机端：把 `capability.reactivate` 登记进手机能力表，归“改”类。该表在 PR 426 里，PR 426 合并后由第 11 批线程登记；本 PR 只保证契约、已安装清单、路由和处理方四处一致。
8. 顺带修了两处会让生产里的重新启用（以及已有的退回）必定失败的缺陷（见[为什么只对照快照就够](#why-snapshot)）：资格判定对带沙箱证据的记录按加载器同样的四项要求判断；生产部署快照改为启动时加载一次，之后只复核文件摘要。

[↑ 返回阅读导航](#contents)

<a id="why-snapshot"></a>

## 为什么只对照快照就够

事实：生产里“核对安装包摘要”和“运行环境资格检查”都不是在生产机上现场重新跑隔离检查，而是把能力记录里的摘要与上线包里封存的部署快照比对，并取快照里那条资格记录（前提 6）。快照的路径和摘要写在配置的 `capabilityDeployment` 里（`packages/application/src/ports/configuration.ts`）；启动时按摘要校验，之后每次核对前再复核快照文件摘要，文件被改过就拒绝。

为什么这样够：

- 能被重新启用的能力，本来就只能是当前上线包里带的那几条；不在快照里（或版本、摘要对不上）的一律拒绝，不会把一个已经下线的包重新放出来。
- 沙箱服务执行任务时同样复核快照文件摘要（`apps/agent-service/src/production-sandbox-services.ts` 的 `revalidateCapabilityDeploymentSnapshot`）；重新启用只决定“它在不在可用清单里”，不绕过这一步。
- 现场重跑的结果和上线时是同一份检查的重复，而生产只有一台机器，多一次检查就多一份占用，收益有限。

局限，如实写：快照只证明“上线时检查通过”，不证明“此刻机器上的隔离环境仍然健康”。所以界面上不得写“已重新检查运行环境”，只能写“重新启用”，并保持对停用时取消的定时任务不恢复的提示。要不要加现场检查，留给 Andy 另议；本 ADR 不做。

顺带发现的两处缺陷，不修的话重新启用在生产里根本用不了：

- 服务里原先要求资格记录的六项管控全部为真，而部署快照加载器要求带沙箱证据的记录 `resourceCeilings` 必须为假（前提 8），所以带沙箱证据的能力永远过不了服务里的资格判定（对已有的“退回”同样成立）。现在带沙箱证据的记录只要求文件系统、网络、进程、密钥四项为真，和加载器一致；不带沙箱证据的记录仍要求六项全真。
- 原先每次核对都重新加载快照，而加载器要求资格记录 5 分钟内检查过（前提 7），所以启动 5 分钟后任何核对都会因为“资格过旧”失败。现在启动时加载一次，之后只复核文件摘要，和沙箱服务的做法一致。两处都有回归测试，且测试在修之前都复现过失败。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

- 两步走（先回到待批准安装，再由主人批准）：没采纳。现成的安装批准命令没有面容字段；第二步失败会停在“已批准未激活”，主人看到的状态更多更乱。
- 重新启用时同时恢复定时任务：没采纳。被取消的任务可能已过期、依赖已变，自动恢复等于不经确认重新授权；主人需要时可以重新建。
- 重新启用时现场重跑沙箱检查：没采纳，理由见上节；以后需要再另议。
- 在手机端自己填认证引用：没采纳，沿用设备网关“手机填占位值、服务器代填”的做法（前提 5）。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 不改表，不改迁移号，不改发给模型的内容。
- 契约新增一个命令类型；控制中心对“已停用”的能力显示“重新启用能力”按钮，确认框和停用、退回一样要求勾选确认。
- 上线后要 Andy 知道：重新启用只恢复能力本身，句柄和定时任务不回来。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- 设计方案：项目文件夹 `four-features-wiring/integrated-plan.md` 的 v2 一节第 6、7 条
- [ADR 0229：苹果端原生客户端和设备接口](0229-native-apple-clients-and-device-api.md)

[↑ 返回阅读导航](#contents)
