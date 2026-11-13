# PR 439 第 1 轮逐条判断

复核的提交 5cec2fab。DeepSeek 第一次跑到后台任务的 10 分钟时限被停（账本记 owner-stopped，不是 Andy 叫停），用 `--round 1` 重跑成功。

## 会出错，中、高（已改，第 2 轮复核）

- ds-2、glm-2：`qualify` 的新规则比加载器少核对平台、运行时身份和沙箱证据本身的契约，而且两边各写一套。成立：`capability-deployment.ts` 原先在 582 行自己写条件，`capability-lifecycle-service.ts` 另写一套。改法：把“声明和沙箱证据是否一致”和“四项必须管控”抽成 `packages/execution-contracts/src/sandbox-qualification-v1.ts` 的 `sandboxEnforcementClaimsMatchEvidence`、`sandboxRequiredControlsEnforced`，加载器和 `qualify` 都调它；前者会先用 `sandboxRuntimeQualificationSchema` 重新解析证据。`qualify` 另外要求清单的 `runtime.kind` 是 `program`（加载器对沙箱绑定的同一条要求，`capability-deployment.ts` parseBinding）。GLM 给的是“低”，按 DeepSeek 的“中”处理。
- ds-3、glm-3：测试只覆盖 `activate`。成立。补了更新激活后回滚、更新候选虚报资源上限被拒、终止声明与证据矛盾、平台或运行时身份对不上、证据不合契约、没有沙箱证据时仍要求六项全真。共 12 条；把 `capability-lifecycle-service.ts` 还原成 main 的内容后 4 条失败。GLM 说“两条反向用例在旧代码下本来就通过”不准：“虚报资源上限被拒”在旧代码下实际运行是失败的（旧代码六项全真就放行）。

## 会出错，低（已改）

- ds-1、glm-1：main 上的生产治理网关没有传 `capabilityLifecycle`（`apps/agent-service/src/production-approval-gateway.ts:200`），所以这次修复在 main 的生产路径上到不了。事实成立，但代码没有错：接线在任务 3 的分支里，本 PR 是它的前置。错的是 PR 描述里“激活、更新激活、回滚一律报错”没说明前提，已改描述。模型给“中”，线程判“低”的理由：不改变任何代码行为，也不会让人照着做错事。
- ds-4：加载器的冲突规则没有直接的反向测试。成立。在 `packages/platform-node/test/capability-deployment.unit.test.ts` 补了 4 条：虚报资源上限、Mac 上声称已验证终止、运行时身份不对、证据来自另一个平台。
- glm-4：作者说明写“测试不用假替身”，但产物校验和运行时资格端口是测试里手写的。成立。产物校验改成只认快照里登记过的摘要；运行时资格端口返回真实加载器从真实快照文件读出的记录。提交说明和 PR 描述改成如实的说法。

## 不成立

- ds-5：测试把非 Darwin 平台都当 Linux。项目只支持 darwin 和 linux（`sandbox-qualification-v1.ts` 的 `platform: enumeration(["darwin", "linux"])`），CI 在 Linux 上跑；`test/integration/admin-capability-upgrade.test.ts:13` 是同样的写法。不改。

## 必答问题

两个模型都确认：不改变模型已经见过的请求开头，不引入不确定的字节。
