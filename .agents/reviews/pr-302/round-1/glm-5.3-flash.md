# 复核结论（PR #302，7274a98）

## 读代码证实的

---

**1.【高】真实生效的工具内存上限不是 1 GiB，而是 512 MiB —— 作者漏了第三个约束：host binding 的 `maximumResourceCeiling`**

- 文件：`apps/agent-service/src/production-runtime-tools.ts:1413-1433`
- 证据：
  ```ts
  const maximum = await this.#options.maximumResourceCeiling?.(handle.capabilityRef, handle.capabilityVersion);
  ...
  maxMemoryBytes: Math.min(configured.maxMemoryBytes, maximum.maxMemoryBytes),   // 1429 行
  ```
  `configured` 是 service-main.ts:1342 的新常量（1 GiB），`maximum` 来自 `service-main.ts:1308` → `production-sandbox-services.ts:2611-2613`：
  ```ts
  return (await entryFor(capabilityRef, capabilityVersion)).binding.maximumResourceCeiling;
  ```
  而仓库内**所有**产生 host binding 的脚本都记录 `maxMemoryBytes: 536870912`（512 MiB）：
  - `scripts/operations/hermes-harness-seal.mjs:142`（其余 9 个 `hermes-*-seal.mjs:142` 相同）
  - `scripts/delivery-mode/packet-template/signing/cloud-seal.mjs:380`
  - `test/qualification/sandbox-install-restart-model.mjs:433`
- 最终施加到命令上的值都取自 plan 的 ceiling（= min 结果）：`apps/execution-worker/src/product-job-host.ts:40`、`production-sandbox-execution-v2.ts:516,1619`（`--as`/resourceLimits）、容器路径 `apps/agent-service/src/production-task-environments.ts:218`。
- 影响：上限确实从 256 MiB 提到 512 MiB（PDF 基线 255.9 MiB 能过），但**不是作者说的 1 GiB**。除非 Hermes 生产绑定是在仓库外用 ≥1 GiB 重新签发的（推测，仓库内无从证实），否则「Andy 已定上限改成 1 GiB」这一目标没有达成。worker 侧 `production-worker-composition.ts:277-279` 取 `max(常量, 绑定)`，是允许上限不是生效值，掩盖了这个问题。
- 建议：要么同步把 seal/cloud-seal 脚本里的绑定上限提到 ≥1 GiB 并重新签发部署，要么加一个门槛检查（类似 I-73 的教训）：`min(常量, 每个已部署绑定.maxMemoryBytes) === 常量`，让 1 GiB 真正生效才允许合并。

**2.【高】作者说「容器内存硬上限也读它（production-task-environments.ts:218）」与代码不符**

- 证据（`apps/agent-service/src/production-task-environments.ts:216-219`）：
  ```ts
  resources: {
    ...ENVIRONMENT_RESOURCES,
    memoryBytes: input.binding.maximumResourceCeiling.maxMemoryBytes,
  },
  ```
  该行读的是**绑定里的 512 MiB**，不是新常量。即使生效上限真到 1 GiB，容器内存硬上限仍卡在绑定值（512 MiB）。作者对这条链路的描述是错的。

**3.【中】升级窗口内，跨部署仍活跃的运行可能在子作用域比较处报错**

- 文件：`apps/agent-service/src/production-sandbox-services.ts:1375-1380`（另一处 1480-1482 同理）
  ```ts
  Object.entries(input.resourceCeiling).some(
    ([key, value]) => value > prior.resourceCeiling[key as keyof typeof prior.resourceCeiling],
  )
  ...
  throw new Error("SANDBOX_CHILD_SCOPE_EXCEEDED");
  ```
  父计划持久化在 SQLite（`sandboxExecutionPreparations`）。旧代码生成的父计划 ceiling 是 256 MiB；升级后新的子 ceiling = min(1 GiB, 绑定 512 MiB) = 512 MiB > 256 MiB → 直接报错。恢复/重放路径方向相反（`production-runtime-tools.ts:1485-1488` 检查旧 ceiling ≤ 新 ceiling），不受影响。此场景是否会发生取决于是否真有跨越升级且做嵌套作用域的运行——后半句是推测。

**4.【中】测试不足，反向用例不会失败**

- 证据：全部测试只有 `packages/execution-contracts/test/sandbox-memory-limit.unit.test.ts`（断言常量值）。把 `production-worker-composition.ts:263` 或 `service-main.ts:1342` 改回 256 MiB，没有任何测试失败；`production-worker-composition.unit.test.ts:37` 用自己的 64 MiB fixture，不断言组合出的 `maximumCeiling`。也没有覆盖「生效值 = min(常量, 绑定)」这一关键语义的测试（第 1 条问题正是它漏掉的）。
- 建议：至少加两条断言——组合后的 worker 允许上限 ≥ 常量；runtime-tools 的生效 ceiling = min(常量, 绑定)。

---

## 推测（未核实）

- Hermes 生产环境实际签发的绑定值是否为 512 MiB：仓库内所有绑定生产脚本和资格证据脚本都写 536870912，但真实部署目录里的绑定文件无法读到。
- `test/qualification/evidence/**/qualification.json` 中没有搜到 `maxMemoryBytes` 字段，资格证据是否单独记录内存上限未核实。

---

## 侧重检查：一条普通流程的走查

模型调用 bash/read 等工具 → `service-main.ts:1339-1345` 组装工具 ceiling（本次改动点，**无测试**）→ `production-runtime-tools.ts:1413` 取绑定上限（**本次未动的隐藏约束，无测试**）→ `:1425-1433` 取 min（**关键语义，无测试**）→ `production-sandbox-services.ts:1076+` 生成 plan → 转发注册 parent binding（`production-worker-forward-transport.ts:93`，同进程比较，新旧一致，安全）→ worker `production-execution-worker.ts:156` 校验 ≤ 组合上限（`max(1 GiB, 绑定)`，宽松，放行）→ `product-job-host.ts:40` / `production-sandbox-execution-v2.ts:516` 按计划 ceiling 施加 → 容器路径按绑定值施加（`production-task-environments.ts:218`）。

顺带排查了「还有没有别处写死 256 MiB」：`production-task-environment-backend.ts:131` 的 `maxGrowthBytes: 256 MiB` 是**磁盘**增长限制，不是内存，无需改；`service-main.ts:914` 预热池 256 MiB 按作者声明保留；`qualify-job-host.mjs:135` 的 268435456 是资格探测用的临时 limits，不是运行时上限。文档方面：prompt-catalog 全目录搜「内存/MiB/GiB/memory limit」无命中，`docs/` 下未发现写死 256 MiB 工具上限的文档需同步（未逐篇核对，标部分未核实）。

---

## 必答问题逐条回答

1. **会不会改变模型已见过的请求开头？** 不会。改动只触及内部资源上限数值；prompt-catalog（系统提示/工具定义文字）无任何内存上限相关内容，ceiling 值不进入消息、遮盖或工具定义。发给模型的内容仍只追加，本改动不触碰请求组装。
2. **会不会让同一段文字变成不同字节？** 不会。ceiling 不出现在模型可见字节里，也不引入时间字段或顺序依赖。
3. **有没有对应的自动检查？反向用例会失败吗？** 只有常量值单元测试（且它确实守着常量值）。两处接线和「min(常量， 绑定)」生效链都没有测试；把任一接线改回 256 MiB，测试全绿。
4. **每个产生/使用的地方都能接受吗？** 新常量的两个直接使用点（service-main.ts:1342、production-worker-composition.ts:263）本身一致；但按 I-73 的教训看下游：真正决定生效值的 host binding（仓库内全部为 512 MiB）既没被改动也没被核对，容器内存上限读的是绑定而非新常量（作者说法错误）。这正是「双模型复核只看 diff，没问清单值能否通过下游校验」的复发：1 GiB 在当前部署形态下到不了命令。
