# PR 439 第 2 轮逐条判断

复核的提交 f744066d，只跑 DeepSeek，看第 1 轮之后的增量。没有成立的中、高意见。

## 不成立

- ds-1（模型给“中”）：`qualify` 没有核对当前主机平台，也没有核对沙箱证据和绑定是否对得上。事实属实，但不是本 PR 引入的放宽，也不是这一层能核对的：`CapabilityLifecycleService` 的依赖只有 `store`、`clock`、`artifacts`、`runtime`（`capability-lifecycle-service.ts` 的构造参数），`CapabilityRuntimeQualifierPort.qualify(manifest)`（`packages/application/src/ports/capabilities.ts:176`）是它唯一的资格来源，服务拿不到主机平台和绑定。main 上的 `qualify` 对没有沙箱证据的记录同样不核对主机平台。主机和绑定的核对在资格端口的实现一侧：加载器 `parseEntry`（`capability-deployment.ts`，hostId、profileRef、runtimeDigest、runnerDigest 对绑定）和 worker 启动时的 `verifyWorkerSandboxHostAtStartup`（`production-worker-composition.ts:378`）。本 PR 之前带沙箱证据的记录在这里一条也过不了，所以没有哪条记录因为本 PR 少核对了原来会核对的东西。这条作为接线约束转给任务 3：接到生产网关的资格端口必须返回加载器核对过的记录。
- ds-2（模型给“中”）：回滚重新调资格端口，不用存下来的 `rollbackQualification`。属实，但这是 main 上原有的行为（`git show origin/main:packages/application/src/services/capability-lifecycle-service.ts` 的 `rollback` 同样调 `this.qualify(rollback)`），本 PR 没有改它。模型自己也写“当前回滚不会重新解析已持久化的资格……因此不会因‘重新解析旧证据’被错误拒绝”。本 PR 的收紧只作用于带沙箱证据的记录，而这类记录在 main 上回滚本来就必定失败，所以不存在“原来能回滚、现在被挡住”的输入。新用例“更新激活后回滚”实际运行通过。回滚该不该改用存下来的资格是另一个设计问题，不在本 PR 范围。
- ds-5：有些新用例在第 1 轮的代码下也通过。属实，但那些用例守的是第 1 轮已有的检查，对照的基线是 main（还原成 main 的内容后 4 条失败，实际运行过）。不改变任何行为或陈述，不改。

## 会出错，低（已改，用 --accept-low 记账）

- ds-3：“证据不合契约”用例同时改了终止声明，去掉重新解析那一步它也会因终止声明不符被拒。成立。怎样触发：以后有人删掉重新解析；后果：原用例发现不了。改成只清空 `guarantees`、其余不动。实际验证：把共用函数里的解析临时去掉，这条用例失败。
- ds-4：`runtime.kind === "program"` 和 `sandbox === undefined` 两处没有用例。成立。补一条用例：`sandbox` 为 null 且六项全真被拒；MCP 清单带沙箱证据被拒。实际验证：把 kind 条件临时改成恒真、把 `sandbox === undefined` 临时改回 `!sandbox`，这条用例各失败一次。
