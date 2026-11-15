本轮只核对 `1462a914..8be72f5e` 的增量（2 个文件，+30/−4）：`apps/execution-worker/src/service-main.ts`、`apps/execution-worker/test/service-main.unit.test.ts`。另外读了 `packages/platform-node/src/state-root-layout.ts` 的 authority/qualified record 读写、`apps/agent-service/src/production-capability-reactivation.ts`、ADR 0254、domain 的标识类型、根 `tsconfig.json` 和 `package.json` 的类型检查脚本。第 6 轮意见 2/4/5 作者称不采纳，本轮未复核；增量没碰的旧代码未整份重读。

### 1. 高：新反向用例用裸字符串覆盖带品牌的 `DeploymentId`，很可能通不过 typecheck
- 文件:行：`apps/execution-worker/test/service-main.unit.test.ts:279`
- 问题：`writeAuthorityFile(layout, { ...authority(2, 2), id: "deployment-other" })` 里 `id` 的类型是普通字符串，而 `writeAuthorityFile` 要求 `DeploymentAuthorityState`，其 `id` 是品牌类型 `DeploymentId`。根 `typecheck` 包含该测试文件，CI 会报类型错误，新增用例实际上没被验证到。
- 证据（读代码证实类型定义）：
  - `packages/domain/src/durable-state.ts:34-43`：`DeploymentAuthorityState.id: DeploymentId`。
  - `packages/domain/src/identifiers.ts:3-7,19,93`：`DeploymentId` 是 `string` 与唯一符号品牌属性的交叉类型；同仓库其他测试（如 `packages/platform-node/test/startup-configuration.unit.test.ts:924`）都使用 `createDeploymentId(...)`。
  - `tsconfig.json:6-13` 包含 `apps/**/*.ts`，`package.json:97` 的 `typecheck` 会编译它。
- 建议：改为 `id: createDeploymentId("deployment-other")` 并补导入。是否真的被 `tsc` 拒绝属高置信推断，本轮未运行命令确认。

### 2. 低：ADR 0254 仍写“启动时先删旧记录”，与新的先验身份顺序不一致
- 文件:行：`apps/execution-worker/src/service-main.ts:152-163`，`docs/adr/0254-capability-reactivation-is-one-atomic-command.md:80`
- 问题：代码现在是先读 authority 并核对 `id/ownerId/agentId`，一致后才清合格记录；authority 读取失败、文件不安全或身份不符时记录会保留。ADR 仍无条件写“执行进程启动时先删掉上一次留下的记录”，与代码不符，而作者本轮又表示以 ADR 为准。
- 证据（读代码证实）：`service-main.ts:152-160` 先 `readAuthorityFile`、做三项比较并在不符时 `throw`，之后才 `clearWorkerQualifiedDeployment`；`service-main.ts:160-162` 才检查 `status !== "active"`。ADR `:80` 写的是“启动时先删掉上一次留下的记录”。
- 建议：把 ADR 改成“读取 authority 并核对 id/ownerId/agentId 一致后才删除；读取失败或身份不符时保留”，并说明 inactive 同部署仍会删除。

### 3. 低：新用例只断言返回 1，无法证明失败原因确实是 authority 不匹配，且未覆盖新增早退分支
- 文件:行：`apps/execution-worker/test/service-main.unit.test.ts:282-293`
- 问题：用例只断言 `resolves.toBe(1)`、`qualification.started === 0` 和记录仍在。如果启动因为配置、权限或其他错误失败，这两条断言同样可能通过。新增的“authority 缺失/不安全时不清记录”分支也没有用例。
- 证据（读代码证实）：`:282-293` 没有对诊断 JSON 的 `code` 做断言；同文件其他用例（`:197-201`、`:410-414`）会断言具体错误码。
- 建议：断言诊断里出现 `WORKER_AUTHORITY_MISMATCH`；补一个 authority 文件缺失或不安全的用例，锁住“先验证再删除”的新顺序。

**读代码证实的与推测**
- 读代码证实：本轮源码顺序与作者描述一致；旧提交 `1462a914` 确实是先清记录再做 authority 检查；`readWorkerRuntimeRecord` 的 16384 字节上限、符号链接/权限/属主检查仍在；重新启用核验仍在 `production-capability-reactivation.ts:38-48` 校验 worker 实例、启动编号、部署编号和快照摘要。
- 推测（未运行）：意见 1 的 typecheck 失败；其余两条是文档/测试质量问题，不影响运行期行为。

**侧重检查**
- 错误路径：authority 缺失/不安全 → 现在直接失败且保留合格记录；身份不符 → 保留；同部署 inactive → 清记录后报 `WORKER_AUTHORITY_INACTIVE`。前两条的新行为无测试。
- 不可信输入：authority 仍经 `readAuthorityFile` 校验文件类型、符号链接、权限、属主、JSON 字段；顺序调整没有绕过这些校验。
- 不可撤销操作：`clearWorkerQualifiedDeployment` 是删除文件，新的身份前置检查缩小了误删另一部署记录的范围，方向正确。
- 资源耗尽：本次增量未改读取上限；合格记录仍有 16384 字节上限（旧轮次改动）。
- 规则/文档一致性：发现 ADR 0254 的“启动时先删”与代码不一致（意见 2）。

**必答问题**
1. 不涉及。增量只改执行进程启动时的本地记录清理顺序，没有改系统提示、工具定义、历史消息或遮盖，也未进入构造模型请求的代码路径；无证据表明模型输入不再只追加。该结论仅针对本轮增量。
2. 不涉及。没有改请求序列化；合格记录是本地运行目录 JSON，字段顺序固定，且不会进入模型请求，因此不会让同一段文字在不同请求里变成不同字节。
3. 有对应检查，但被意见 1 的类型问题削弱。新用例在旧代码 `1462a914` 上会失败：旧代码先 `clearWorkerQualifiedDeployment`，记录会被删掉，`readWorkerQualifiedDeployment` 会拒绝；改后通过。不过用例没有断言错误码（意见 3），且 typecheck 很可能先失败。
4. 增量没有产生或修改导出的函数、配置键、字段或序列化格式，只改了清理顺序和 `AUTHORITY_INACTIVE`/`AUTHORITY_MISMATCH` 的优先级。使用端核对：`clearWorkerQualifiedDeployment` 只在 worker 启动/停止/catch 中使用；`readWorkerQualifiedDeployment` 的使用端是重新启用核验，它仍校验启动编号、实例编号、部署编号和快照摘要，能接受保留下来的记录且不会误用其它部署的记录。错误码只出现在诊断和测试中，没有发现依赖旧优先级的使用端。唯一不一致是 ADR 措辞（意见 2）。
