# 复核报告：PR #302（工具内存上限 256 MiB → 1 GiB）

## 读代码证实的结论（先列事实链）

生效链路（全部亲自读到）：

1. 工具 ceiling 初值：`apps/agent-service/src/service-main.ts:1342` `maxMemoryBytes: SANDBOX_TOOL_MEMORY_LIMIT_BYTES`。
2. 实际生效取较小值：`apps/agent-service/src/production-runtime-tools.ts:1425-1433`，`maxMemoryBytes: Math.min(configured.maxMemoryBytes, maximum.maxMemoryBytes)`，其中 `maximum` 来自 `maximumResourceCeiling` 回调（`production-sandbox-services.ts:2611-2613`，返回**签名绑定**的 `binding.maximumResourceCeiling`）。
3. Worker 允许的最大值：`apps/execution-worker/src/production-worker-composition.ts:263`，且第 277-280 行对绑定值取 `Math.max`；worker 在 `production-execution-worker.ts:209/222/439` 用 `withinCeiling` 拒绝超限计划。
4. 宿主侧硬校验：`packages/platform-node/src/capabilities/isolation.ts:383-392`，`ceiling.maxMemoryBytes > binding.maximumResourceCeiling.maxMemoryBytes` 时抛 `PROCESS_BINDING_MISMATCH`；rlimit 用 `--as=${ceiling.maxMemoryBytes}`（isolation.ts:444）。job host 路径用 plan ceiling（`product-job-host.ts:38-41`）。
5. 容器路径：`apps/agent-service/src/production-task-environments.ts:216-219`，`memoryBytes: input.binding.maximumResourceCeiling.maxMemoryBytes` → `packages/runtime-sandbox/src/execution-backend/container-execution-backend.ts:902-903` `memory: resources.memoryBytes, memorySwap: resources.memoryBytes`。
6. `PI_FILE_PREPARATION_MEMORY_BYTES`（service-main.ts:167）仍为 256 MiB，只用于预热池（service-main.ts:914），与作者说法一致。
7. 签名绑定模板 `scripts/delivery-mode/packet-template/signing/cloud-seal.mjs:377-383` 已同步为 1073741824，文件内仅此一处 `maximumResourceCeiling`。

## 按严重度排列的问题

**1.（高）作者说法与代码不符：容器内存硬上限不读新常量，实际生效上限在重签前不是 1 GiB**
- 文件：`apps/agent-service/src/production-task-environments.ts:218`
- 证据：`memoryBytes: input.binding.maximumResourceCeiling.maxMemoryBytes` —— 读的是签名绑定，不是 `SANDBOX_TOOL_MEMORY_LIMIT_BYTES`。签名绑定来自部署快照（`production-sandbox-services.ts:157/193`，`initial.snapshot.capabilities` → `entry.binding.value`），由 cloud-seal.mjs 制包时签发。改动前模板值是 536870912（512 MiB，见 diff）。若只升级软件、不重新制包签发，生效上限 = min(1 GiB, 512 MiB) = **512 MiB**，容器内存硬上限也仍是 512 MiB，且无任何运行时告警。
- 建议：部署升级流程必须确认会重签绑定；或在加载部署快照时校验 `binding.maximumResourceCeiling.maxMemoryBytes >= SANDBOX_TOOL_MEMORY_LIMIT_BYTES` 并打诊断事件。

**2.（中，I-73 型）常量与签名绑定之间没有运行时一致性门槛**
- 证据：全仓 `SANDBOX_TOOL_MEMORY_LIMIT_BYTES` 的使用点只有 service-main.ts:1342、production-worker-composition.ts:263 和测试；部署快照加载处只有 schema 下限 `integer(1)`（`packages/execution-contracts/src/sandbox-host-binding-v1.ts:98`），不与常量比对。新增的 `test/tooling/sandbox-memory-manifest.test.mjs` 只检查**仓库里的模板文件**，不检查实际部署的签名产物——这正是「清单里的 id 能通过后端校验吗」的同类缺口：模板对了，部署里的旧绑定照样静默生效。
- 建议：把第 1 条的加载时校验作为门槛，而不是只靠源码模板测试。

**3.（低）新增清单测试的反向用例不测真实文件，名称有误导**
- 文件：`test/tooling/sandbox-memory-manifest.test.mjs:24-29`
- 证据：`is rejected when the manifest still says 512 MiB or 256 MiB` 实际只对**合成字符串**跑正则助手，验证的是「如果文件回退，第 20-23 行的主用例会失败」，并未拒绝任何真实回退。主用例方向是安全的（模板回退时第 21 行断言失败），但「rejected」措辞夸大了覆盖。另外 `/maximumResourceCeiling:\s*\{[^}]*\}/s` 依赖块内无嵌套花括号，当前成立（cloud-seal.mjs:377-383），将来加嵌套字段会返回 `undefined` 使主用例失败——方向安全但属于脆弱正则。
- 建议：措辞改为「辅助正则对旧值返回小于上限的数」；可接受。

**4.（低）两处接线没有直接断言**
- 证据：`service-main.ts:1342` 所在的组装代码无单元测试触达该行；`production-worker-composition.ts:263` 的默认 ceiling（无 process/sandbox 绑定时 = 常量）在 `production-worker-composition.unit.test.ts` 中只注入自定义 `CEILING`，未断言默认值。
- 建议：可选补一条组合层断言；风险低，因为 `production-runtime-tools.unit.test.ts:313-332` 的新用例已把 min 逻辑（bound 小于/等于/大于上限三种）钉死，回退 min 逻辑会失败。

**未发现的问题（核对过）**
- 回执/恢复不一致：intent fingerprint = `executionIdentity(invocation)`（production-runtime-tools.ts:138-155），不含 resourceCeiling，旧排队计划重放不会因新上限触发 CONFLICT；admission 的 `sameCeiling`/`ceilingWithin`（production-execution-admission-handler.ts:144-162/298/520）比较的是同一往返内的 receipt 与 request，不跨版本比对。旧回执记 256 MiB 不会被拒绝。
- 无其他写死 256 MiB 影响工具命令内存的地方：`production-task-environment-backend.ts:131`（磁盘增长阈值）、`production-task-environments.ts:68`（磁盘）、`qualify-job-host.mjs:135`（资格探针的任意值）、`journal-installation-selfcheck.ts:144`（安装自检小值）均与内存上限无关。

## 侧重检查

走了一条普通流程：用户发消息 → bash 工具调用 → `ProductionRuntimeTools.#execute`（validate 1411 → `maximumResourceCeiling` 1413 → min 1425-1433）→ delegation dispatch → admission（ceilingWithin）→ worker `withinCeiling` → 沙箱执行（job host resourceLimits / 容器 memoryBytes）。
- 有测试覆盖：min 逻辑（新单测）、常量值、签名模板与常量一致（新 tooling 测试，跑在 `policy` job 的 tooling 项目，`required` 依赖 `policy`，ci/policy.json:168-178、242-243）。
- 无测试覆盖：service-main.ts:1342 接线、composition 默认 ceiling、以及「部署后的绑定确实是 1 GiB」——最后一条正是问题 1/2，现有资格证据（test/qualification/evidence/...）记录的都是 256 MiB 时代的实测。
- 文档与规则：全库检索未发现文档写死「工具命令内存 256 MiB」；文档中 256 MiB 均指 Pi 预热线程、磁盘阈值或 tar 解包，与本改动不冲突，无需改文档。

## 推测（未核实）

- 升级是否必然重签绑定（cloud-seal.mjs 属 packet-template，推测制包时签发，但未读到 Hermes 升级流程强制重签的证据）。
- 新单测和 tooling 测试在本机是否实际通过（无法运行测试）。
- 提交是否满足 ADR 0057 的「第 0 层」归属要求。

## 必答问题逐条回答

1. **不会改变请求开头。** 改动全部在执行端的资源上限；提示词目录（packages/prompt-catalog）无内存上限文字，运行环境说明（production-run-policy.ts:193-240）只含搜索/抓取服务商与抓取字节上限，不含内存值。发给模型的内容仍只在末尾追加，本轮次会变的值不新增。
2. **不会。** 上限值只进入 work.execute、计划、回执等内部消息，不进入模型请求；无遮盖、无时间字段、无集合遍历顺序问题。
3. **部分有。** min 逻辑有带反向值的单测；常量有值断言；模板一致有 tooling 测试（属 required 门槛）。缺口：service-main 与 composition 的接线无断言；清单测试的反向用例只测正则助手本身，且没有任何检查覆盖「部署产物里的绑定值」。
4. **两端核对发现一个实质缺口。** 常量的三个使用点（工具 ceiling、worker 最大值、绑定模板）两两一致；但真正决定生效值的第四端——部署快照中的签名绑定——只在重新制包签发后才变成 1 GiB，代码不校验它与常量的关系（问题 1/2）。schema 允许任意正整数，不会拒绝 512 MiB 的旧绑定，只会静默取 min。
