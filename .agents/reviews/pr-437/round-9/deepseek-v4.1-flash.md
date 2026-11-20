本轮增量（`a6761f4..58b232e`）实际只改了 `apps/execution-worker/test/service-main.unit.test.ts` 的 7 行，另加复核记录和 usage 文件；没有生产代码变化。第 8 轮“测试引入不允许的 domain 依赖”已修好；未发现增量引入的新生产缺陷，只留一条低优先级测试覆盖缺口。

### 1. 低 — 身份不匹配回归用例只覆盖 `id`，没有覆盖 `ownerId`/`agentId`
- 文件:行：`apps/execution-worker/test/service-main.unit.test.ts:270-299`、`apps/execution-worker/src/service-main.ts:153-159`、`docs/adr/0254-capability-reactivation-is-one-atomic-command.md:80`
- 问题：生产代码要求 authority 的部署、主人、agent 三项都与配置一致，但新增的反向用例只把 `authority.id` 改掉。若以后有人误删 `ownerId` 或 `agentId` 的比较，现有测试仍会通过，旧合格记录会在身份不符时被删掉。
- 证据：
  - 测试只构造了 id 差异：`const base = authority(2, 2); await writeAuthorityFile(layout, { ...base, id: `${base.id}-other` as typeof base.id });`（`service-main.unit.test.ts:279-280`）
  - 生产代码实际比较三项：`authority.id !== configuration.deploymentId || authority.ownerId !== configuration.ownerId || authority.agentId !== configuration.agentId`（`service-main.ts:153-159`）
  - ADR 也写的是“核对部署、主人、agent 三项与配置一致”（ADR 0254:80）
  - `git grep AUTHORITY_MISMATCH` 在 `apps/execution-worker/test` 下只有这一处断言（`service-main.unit.test.ts:294`），没有 owner/agent 的独立反向用例。
- 建议：把该用例参数化为 `it.each`，分别对 `id`、`ownerId`、`agentId` 追加 `-other` 后缀（沿用当前 `typeof base.xxx` 的写法即可避免 domain 导入），每个用例都断言 `AUTHORITY_MISMATCH` 且合格记录保留。

## 侧重检查

- 错误路径：核对了 `apps/execution-worker/src/service-main.ts:152-163`。顺序是“读 authority → 核对 id/ownerId/agentId → 删除旧合格记录 → 检查 status 是否 active”。身份不符时在读文件阶段就抛 `AUTHORITY_MISMATCH`，不会删除记录；同部署但未激活时仍会先删除再失败，与 ADR 0254 第 80 行一致。
- 不可信输入：本轮测试伪造的 authority id 是 `deployment-v02-fixture-other`。`readAuthorityFile` 会走 `createDeploymentId(input["id"])`（`state-root-layout.ts:661`），其正则允许该值（`identifiers.ts:39`），因此不会变成 `AUTHORITY_INVALID`，测试仍能命中目标分支。测试里的类型断言只存在于测试文件，不改变生产校验。
- 安全与不可撤销操作：删除合格记录是不可撤销操作；本轮测试明确断言身份不符后记录仍保留（`service-main.unit.test.ts:296-298`），这条路径可用。本轮没有新增删除路径。
- 资源耗尽：`readWorkerRuntimeRecord` 的 16384 字节上限、`lstat` 安全性等不在本轮增量中，未重读；ADR 第 82 行与代码描述一致。
- 规则与文档一致性：第 9 轮没有改文档。ADR 0254:80 的“先核对三项身份再删”与当前代码一致；第 8 轮加入的 `AUTHORITY_MISMATCH` 断言仍在（`service-main.unit.test.ts:292-295`）。
- 上一轮意见核对：`@himawari-agent/domain` 导入已从测试文件删除；`scripts/check-boundaries.mjs:152-230` 会扫描所有 workspace 下的 `.ts` 文件，而 `scripts/boundary-policy.mjs:106-115` 的 execution-worker 允许依赖里没有 domain，因此旧导入确实会被拦下。该意见已改好。

## 必答问题

1. **会不会改变模型已经见过的请求开头？** 本轮增量只改测试，不涉及。就整个 PR 的改动文件清单看，也没有系统提示、工具定义、历史消息或遮盖相关文件；但没有重读模型请求构造的全部旧代码，**未核实**其完整链路。增量本身不会改变“只在末尾追加”或“每轮变化值在最后一条消息”的行为。
2. **会不会让同一段文字在不同请求里变成不同字节？** 本轮不涉及。PR 新增的 `workerBootId` 是随机值，但它是 `runtime/execution-worker.qualified.json` 的进程间证据，不进入模型请求；本轮没有改到它。
3. **有没有对应自动检查，反向用例真的会失败吗？** 有。id 不一致的反向用例是 `service-main.unit.test.ts:270-299`；`git show 8be72f5e` 显示旧代码在身份检查之前就调用 `clearWorkerQualifiedDeployment`，所以这条用例在旧实现上会因记录被删而失败，是有效的回归用例。边界检查由 `check:boundaries` 覆盖，但本轮没有运行测试或检查，**未核实**实际执行结果。ownerId/agentId 两条反向路径目前没有自动用例，见上面意见 1。
4. **增量产生或修改的值，使用它的地方都能接受吗？** 本轮唯一新增/修改的值是测试中的 authority id。产生端是 `service-main.unit.test.ts:280`；使用端依次是 `writeAuthorityFile`（只序列化，不校验 id，`state-root-layout.ts:578-606`）、`readAuthorityFile`（`createDeploymentId` 校验，`state-root-layout.ts:661`）和 `runExecutionWorkerService` 的配置比较（`service-main.ts:153-159`）。该字符串长度和字符集符合 `MACHINE_IDENTIFIER_PATTERN`（`identifiers.ts:39`），两端都能接受，未发现不匹配。

本轮查过的范围：`git diff a6761f4..58b232e` 的全部增量；该增量指向的 authority 读写与 execution-worker 启动顺序；`check:boundaries` 的扫描逻辑和 boundary policy；ADR 0254 第 80 行。未重读整个 PR 的旧生产代码，未运行测试/检查。
