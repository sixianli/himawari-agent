## 复核结论

本轮查过：`8be72f5e..a6761f46` 的全部代码增量（execution-worker 测试、ADR 0254、合并 main 带来的两个测试），以及证据指向的 `service-main.ts`、`package.json`、`boundary-policy.mjs`、`check-boundaries.mjs`、`production-capability-reactivation.ts`。

### 1. 高：第 7 轮修复引入未声明且不被允许的 `@himawari-agent/domain` 依赖，`check:boundaries` 必然失败

- 文件:行：`apps/execution-worker/test/service-main.unit.test.ts:5`；`apps/execution-worker/package.json:13-21`；`scripts/boundary-policy.mjs:106-116`；`scripts/check-boundaries.mjs:204-219`
- 问题：第 7 轮为修“裸字符串不是品牌类型”，在测试里新增了 `import { createDeploymentId } from "@himawari-agent/domain";`。但执行进程包的 `dependencies`/`devDependencies` 都没有 `@himawari-agent/domain`，`allowedInternalDependencies` 里的 `@himawari-agent/execution-worker` 集合也不含它。静态检查会同时报“imported but not declared”和“must not import”，`npm run check:boundaries`（`check:steps` 的一环）会失败，PR 过不了 CI。
- 证据（亲自读到）：
  - 测试：`import { createDeploymentId } from "@himawari-agent/domain";`
  - `apps/execution-worker/package.json` 依赖只有 `application`、`execution-contracts`、`platform-node`、`runtime-sandbox`，devDependencies 只有 `testing`。
  - `scripts/boundary-policy.mjs` 中 execution-worker 的允许集为 `runtime-sandbox`、`application`、`execution-contracts`、`platform-node`、`integration-web`、`testing`，没有 `domain`。
  - `scripts/check-boundaries.mjs:204-219` 对“是工作区包但未声明”和“不在允许集”都会 push 错误；`walkSourceFiles` 会递归到 `test/`。
- 建议：二选一。
  1. 在 `apps/execution-worker/package.json` 的 devDependencies 加 `"@himawari-agent/domain": "0.0.0"`，同时在 `scripts/boundary-policy.mjs` 的 execution-worker 允许集加 `@himawari-agent/domain`（两处缺一不可）。
  2. 不扩大 execution-worker 的依赖面：把“构造测试用品牌标识”的辅助函数放到它本就依赖且被允许的 `@himawari-agent/testing`（该包已声明并允许 `domain`），测试改从 testing 取。

**上一轮三条意见核对**
- d1（品牌 `DeploymentId`）：类型层面已改用 `createDeploymentId`，`"deployment-other"` 也符合 `MACHINE_IDENTIFIER_PATTERN`；但如上，引入了新的边界检查失败，不能算完全改好。
- d2（ADR）：`docs/adr/0254-capability-reactivation-is-one-atomic-command.md:80` 已改成“先读 authority 并核对部署、主人、agent 三项，一致后才删”，与 `service-main.ts:152-160` 完全一致，已改好。
- d3（只断言返回 1）：已补 `event: "service.failed"` 与 `code: AUTHORITY_MISMATCH` 断言（测试 295-298 行）；`stableErrorCode` 对 `Error("WORKER_AUTHORITY_MISMATCH")` 返回该字符串，断言成立，已改好。

**侧重检查**
- 错误路径：`service-main.ts:152-163` 的顺序是读 authority → 比对 id/ownerId/agentId → 删记录 → 检查 `active`。authority 读不出或身份不符时记录保留；同部署但未激活时先删再报 `AUTHORITY_INACTIVE`。与 ADR 第 80 行一致，未发现新错。
- 不可信输入：`createDeploymentId` 会校验 1-128 位机器标识正则，`deployment-other` 合法；`readAuthorityFile` 会拒绝字段/状态/权限异常。新增测试输入无副作用。
- 安全/陈旧状态：保留合格记录本身不足以欺骗重新启用核验——`production-capability-reactivation.ts:40-48` 还比对存活对端绑定、部署号与快照摘要。其 `trustedPeerBinding` 的装配不是本轮增量，未再核实。
- 资源耗尽/不可撤销操作：测试用 `mkdtemp` 并在 `afterEach` 删除；清理用 `rm(..., { force: true })` 幂等。新顺序刻意避免在 authority 不可读/外来部署时删除文件，未发现资源或不可逆问题。
- 文档/代码一致性：ADR 第 80 行与代码一致；测试名“even when the authority check fails”指 `inactive_ready` 状态检查（同部署），行为仍是先删后报，不算错误。
- 合并进 main 的测试小改：`home-urgency.test.ts` 的 `binding: expect.stringMatching(/^b1\./)` 是合法非对称匹配；`sensitive-interceptions-browser.test.ts` 的 `middayTimezone()` 正负号换算正确（如 UTC 15 → `Etc/GMT+3` 即 UTC-3，落在正午），只影响浏览器测试时区，不涉及本轮产物。

**必答问题**
1. 不涉及。本轮增量只改测试、ADR 和复核记录（合并 main 也只带测试），没有触碰系统提示、工具定义、历史消息或遮盖代码；发给模型的内容没有任何变化，追加规则不受影响。
2. 不涉及。增量没有给模型输入的序列化引入时间字段、无序集合或上下文相关遮盖；新增的 authority 写入是运行时状态，且 `authorityJson` 字段顺序固定。合并进来的时区辅助只作用于浏览器测试。
3. 部分有、但不能通过：d3 的反向断言在“把删除挪回身份核对之前”时会让“记录仍在”的断言失败（读代码推断，受工具限制未实际运行）。但第 1 条指出的 `check:boundaries` 会先确定性失败；ADR 属文档，无自动检查；仓库内“无自动测试”的两条本轮未涉及。
4. 不能都接受。新增的 `createDeploymentId` 使用端（测试）类型没问题，但它的包级消费者 `check:boundaries` 不接受这个导入：执行进程既未声明也未获允许依赖 `@himawari-agent/domain`，会产生两条静态检查错误。其余增量值（ADR 文本、合并进来的测试断言）没有会拒绝它们的机器校验。

**确信度说明**：依赖缺失、允许集缺失、检查脚本的报错分支均为读代码直接确认；`check:boundaries`/测试的实际执行结果未运行，属按代码推断（本环境被限制只能读和跑指定 git 命令）。
