## 发现的问题（按严重度）

### 1.【高】【已核实】实际生效上限只有 512 MiB，不是 1 GiB；真正需要同步改的是签名清单，不是 execution-worker

- **文件:行**
  - `apps/agent-service/src/production-runtime-tools.ts:1425-1433`
  - `apps/agent-service/src/service-main.ts:1308, 1339-1345`
  - `apps/agent-service/src/production-sandbox-services.ts:2611-2613`
  - `scripts/delivery-mode/packet-template/signing/cloud-seal.mjs:377-383`
  - `apps/agent-service/src/production-task-environments.ts:216-219`
- **问题**：作者说“实际生效的是两者的较小值，所以 service-main 和 worker composition 两处一起改”。但 `production-runtime-tools.ts` 里参与 `min` 的并不是 worker composition 算出的 `maximumCeiling`，而是 capability deployment 里的 `binding.maximumResourceCeiling`。生产签名模板把这个值固定为 `536870912`（512 MiB），所以新代码实际算出的上限是 `min(1 GiB, 512 MiB) = 512 MiB`，不是 1 GiB。容器的 `memoryBytes` 也是读这个签名绑定值，不是新常量。
- **证据**：
  - `apps/agent-service/src/service-main.ts:1308`：`maximumResourceCeiling: sandboxServices.maximumResourceCeiling,`
  - `apps/agent-service/src/production-sandbox-services.ts:2611-2613`：`maximumResourceCeiling: async (...) => { ... return (await entryFor(...)).binding.maximumResourceCeiling; }`
  - `apps/agent-service/src/production-runtime-tools.ts:1429`：`maxMemoryBytes: Math.min(configured.maxMemoryBytes, maximum.maxMemoryBytes),`
  - `scripts/delivery-mode/packet-template/signing/cloud-seal.mjs:377-383`：`maximumResourceCeiling: { ... maxMemoryBytes: 536870912, ... }`
  - `apps/agent-service/src/production-task-environments.ts:216-219`：`resources: { ...ENVIRONMENT_RESOURCES, memoryBytes: input.binding.maximumResourceCeiling.maxMemoryBytes, }`
  - `apps/execution-worker/src/production-worker-composition.ts:263` 改的是 worker 自己的 `maximumResourceCeiling`；它不参与上面的 `min`。worker 侧还会在 `packages/platform-node/src/capabilities/sandbox-host-verifier.ts:232-236` 校验 `plan.resourceCeiling <= binding.maximumResourceCeiling`，同样会拒绝超过 512 MiB 的计划。
- **影响**：旧代码实际是 `min(256 MiB, 512 MiB)=256 MiB`；新代码实际是 `min(1 GiB, 512 MiB)=512 MiB`。PR 标题和作者说明的“1 GiB”没有生效。若某些部署的签名绑定仍是 256 MiB，则完全没有变化。
- **建议**：把 `cloud-seal.mjs` 的 `maxMemoryBytes` 同步改到 1 GiB，并重新签名、重新安装、按流程重做资格验证；或者如果目标就是 512 MiB，则把常量改成 512 MiB 并修正标题/说明。另加一道检查，确保签名清单里的上限与新常量一致，避免再次只改代码、不改清单。

### 2.【中】【逻辑已核实，触发条件为推测】跨部署恢复时，旧父计划 256 MiB 可能拒绝新的 512 MiB 子工具

- **文件:行**
  - `apps/agent-service/src/production-sandbox-services.ts:1478-1485`
  - 同文件 `1375-1380`
  - `packages/application/src/services/sandbox-execution-plan.ts:129-132, 200`
- **问题**：普通计划是从已消费的 receipt 复制 `resourceCeiling`，所以“旧回执 256 MiB”不会直接变成“新计划 1 GiB”。但子工具路径会用**新算出的** `input.resourceCeiling` 去和**已持久化的父计划**比较。若父计划是在旧版本创建的、记录 256 MiB，而子工具在升级后算出 512 MiB，就会被判为超限。
- **证据**：
  - `production-sandbox-services.ts:1478-1485`：
    ```ts
    if (
      binding.hostId !== parent.plan.identity.hostId ||
      Object.entries(input.resourceCeiling).some(
        ([key, value]) =>
          value > parent.plan.resourceCeiling[key as keyof typeof parent.plan.resourceCeiling],
      )
    )
      throw new Error("SANDBOX_CHILD_SCOPE_EXCEEDED");
    ```
  - `production-sandbox-services.ts:1375-1380` 对 `prior.resourceCeiling` 也有同样的比较。
  - `sandbox-execution-plan.ts:129-132` 说明普通计划来自 `receipt.resourceCeiling`，因此这条风险主要在子工具/父计划路径。
- **推测部分**：这是否会在生产发生，取决于部署切换时是否有同一 Run 的子工具在旧父计划上继续执行；仓库外实际部署快照和在线恢复过程未核实。
- **建议**：子工具的 ceiling 不应无条件用新配置值；可取 `min(input.resourceCeiling, parent.plan.resourceCeiling)` 后再生成子计划，或对旧计划做显式迁移/兼容。至少加一条跨版本恢复测试。

### 3.【中】【已核实】自动检查只验证常量；把生产接线改回 256 MiB 不会让测试失败

- **文件:行**：`packages/execution-contracts/test/sandbox-memory-limit.unit.test.ts:4-13`
- **问题**：新增测试只断言常量为 1 GiB 和几个算术关系，没有覆盖 `service-main.ts:1342`、`production-worker-composition.ts:263`、`production-runtime-tools.ts:1429` 的实际生效路径，也没有覆盖签名清单的 512 MiB 上限。把两处生产接线改回 256 MiB、常量保持不变时，这个测试仍然全绿。第二个用例用 `3 * 1 GiB < 4 GiB` 检查“生产主机够用”，但 4 GiB 不是总内存或可用内存，也不是 `totalRuns` 的约束；即使实际只有 512 MiB 生效，它也会通过。
- **建议**：
  - 加测试：给生产 composition 一个 `maximumResourceCeiling.maxMemoryBytes = 512 MiB` 的 deployment 绑定，断言工具实际 plan 的 `maxMemoryBytes` 是 512 MiB（或按目标改成 1 GiB）。
  - 加反向用例：把 `service-main`/worker 的接线改回 256 MiB 时测试必须失败。
  - 加清单一致性检查：签名脚本的 `maxMemoryBytes` 必须等于 `SANDBOX_TOOL_MEMORY_LIMIT_BYTES`，或至少不小于它。
  - 把“3 个并发”用例改成基于真实生产可用内存和实际生效上限的检查，而不是任意的 4 GiB。

### 4.【低】【已核实】测试名称和 PR 说明会误导后续维护者

- **文件:行**：`packages/execution-contracts/test/sandbox-memory-limit.unit.test.ts:5-12`
- **问题**：测试名说“four times the 256 MiB”，但按生产签名绑定，实际只从 256 MiB 提到 512 MiB（2 倍）；PR 标题说 1 GiB。后续读者会以为已生效 1 GiB。
- **建议**：修正测试名称和 PR 说明；如果实际目标是 1 GiB，则先修问题 1。

---

## 侧重检查

- **错误路径**：检查了 `sandbox-host-verifier.ts:232-236`（计划超过绑定上限即拒绝）、`production-sandbox-services.ts:1375-1380`/`1478-1485`（子工具超过父计划即拒绝）、`production-execution-admission-handler.ts:298`（receipt 与请求 ceiling 必须逐字段相等）。发现第 2 条跨版本子工具不一致风险；普通计划从 receipt 复制 ceiling，未发现旧 receipt 直接与新 1 GiB 计划比较的路径。
- **不合规范/不可信输入**：新常量是编译期常量，不接收外部输入；真正的上限来自签名 deployment 绑定，修改常量不会绕过签名校验。未发现新增的外部输入面。
- **安全与资源耗尽**：由于绑定仍是 512 MiB，容器硬上限并未变成 1 GiB；若按建议把签名绑定也改到 1 GiB，则 3 个并发最坏 3 GiB，相对作者给出的 available 6409 MB 仍有余量，但新测试并没有真正验证这一点，也没有 swap 保护下的 OOM 行为测试。worker 的 `maximumResourceCeiling` 现在宣称 1 GiB，而签名绑定只有 512 MiB；worker 侧 `verifySandboxHost` 仍会拒绝超过 512 MiB 的计划，属于防御性拒绝，不是资源放宽。
- **不可撤销操作**：本改动不涉及删除、覆盖或迁移数据，没有不可撤销副作用。
- **规则文件、说明文档与代码一致性**：`.claude/rules/prompt-prefix.md` 未被改动，提示词目录也未改动；但 PR 说明与代码实际效果不一致（见问题 1、4）。仓库内 `scripts/delivery-mode/packet-template/signing/cloud-seal.mjs:380` 和 `scripts/operations/hermes-*.seal.mjs:142` 仍是 512 MiB，是当前最关键的“代码与说明不一致”。
- **“还有没有别处写死 256 MiB”**：我搜到的其余 `256 * 1024 * 1024` / `268435456` 主要是测试夹具、Pi 文件预热、磁盘 `privateStorageBytes`/`maxGrowthBytes`、以及独立的资格自检，不是生产工具命令内存上限。真正卡住 1 GiB 的是 512 MiB 的签名绑定，而不是另一处 256 MiB。

---

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。这次 diff 只改了 `service-main.ts`、`production-worker-composition.ts`、`execution-contracts` 的导出和新常量/测试，没有改 `packages/prompt-catalog`、系统提示、工具定义、历史消息或遮盖逻辑。发给模型的内容仍然只在末尾追加，工具执行结果/错误仍属于追加内容；没有新增每轮变化、需要放进最后一条消息的值。**依据：diff 文件清单和 `.claude/rules/prompt-prefix.md` 第 4、6 条。**

2. **会不会让同一段文字在不同请求里变成不同字节？**
   不会。新值是固定常量 `1024 * 1024 * 1024`，不依赖时间、前文或无序集合。它会进入新 receipt/plan 的序列化内容，但同一版本内始终是同一值；跨版本新旧 receipt 字节不同是版本差异，不是同一请求的非确定序列化。

3. **有没有对应的自动检查，反向用例是否真的会失败？**
   不够。新增测试只检查常量值和算术；把 `service-main` 或 `production-worker-composition` 的实际接线改回 256 MiB，测试仍会通过。签名清单被改成 512 MiB 也不会被现有测试发现。**反向用例不会真正失败。**

4. **改动产生/修改的每个值，每个使用它的地方都能接受吗？**
   - `SANDBOX_TOOL_MEMORY_LIMIT_BYTES = 1 GiB`：`service-main` 的 `ceiling.maxMemoryBytes` 能通过类型和正整校验，但随后被 deployment 绑定的 512 MiB 限制住。
   - `production-worker-composition` 的 `maximumCeiling.maxMemoryBytes = 1 GiB`：worker 的 `withinCeiling` 能接受，但 worker 自己的 `verifySandboxHost` 仍会拒绝超过 512 MiB 的计划；且这个值不参与工具实际生效的 `min`。
   - `production-task-environments.ts:218` 的容器 `memoryBytes`：使用的是签名绑定的 512 MiB，不是新常量。
   - 旧 receipt/恢复：普通计划从 receipt 复制 ceiling，未发现“旧 receipt 256 MiB 直接对比新 1 GiB 计划”的失败路径；但子工具对已持久化父计划的比较存在跨版本超限风险（第 2 条）。
   结论：这些值都能通过校验，但**实际生效链路没有全部接受 1 GiB**；生产签名绑定是漏掉的一端。
