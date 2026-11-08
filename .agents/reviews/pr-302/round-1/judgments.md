# PR #302 第 1 轮复核：核实后的判断（提交 7274a981，REVIEW_SPENT_TOTAL 0.1268 美元）

两个模型都跑完（经 Magpie，推理强度 High）。原文：deepseek-v4.1-flash.md、glm-5.3-flash.md。

## 会出错（高）：生效上限实际是 512 MiB，不是 1 GiB —— 我已读代码证实
- production-runtime-tools.ts:1413-1429：生效值 = min(service-main 的常量, 部署绑定的 maximumResourceCeiling)。
- 绑定来自 service-main.ts:1308 → production-sandbox-services.ts:2611-2613（binding.maximumResourceCeiling），不是 worker composition 的 maximumCeiling（后者只是 worker 的允许上限，取 max(常量, 绑定)）。
- 签名清单里的绑定上限写死 512 MiB：scripts/delivery-mode/packet-template/signing/cloud-seal.mjs:380（maxMemoryBytes: 536870912），scripts/operations/hermes-*-seal.mjs 共 10 个文件同值，test/qualification/sandbox-install-restart-model.mjs:433。
- 容器内存硬上限 production-task-environments.ts:218 读的也是绑定值，不是新常量；简报里"也读它"的说法不对。
- 结果：256 → 512 MiB（PDF 基线 255.9 MiB 能过，但没到 1 GiB）。
- 建议：要么把签名清单（cloud-seal.mjs 等）的 maxMemoryBytes 同步提到 1 GiB，并按流程重新签发/资格验证；要么 Andy 接受 512 MiB，把常量和标题改成 512 MiB。无论哪种，加一道门槛：签名清单里的上限必须 ≥ SANDBOX_TOOL_MEMORY_LIMIT_BYTES（这也是 I-87 该有的自动检查）。注意：改签名清单属于改签名上线包内容，需要 Andy 确认是否要 1 GiB。
- 未核实：Hermes/生产实际签发的绑定值（仓库外），预计也是 512 MiB。

## 会出错（中）：升级窗口内子作用域比较
- production-sandbox-services.ts:1375-1380、约 1478-1485：子计划的 resourceCeiling 与已持久化父计划比较，value > parent 就抛 SANDBOX_CHILD_SCOPE_EXCEEDED。升级前创建的父计划记 256 MiB，升级后子计划算出更大值（512 或 1 GiB）→ 失败。
- 逻辑成立；是否真发生取决于是否有跨越升级、仍在嵌套执行的运行（推测）。普通计划从回执复制上限，不受影响。
- 建议：子工具 ceiling 取 min(新算值, 父计划值)，或在上线流程里说明升级时没有活跃运行；至少补一条跨版本测试。严重度我判中偏低（上线是停服窗口，未必有活跃运行）。

## 会出错（中）：测试不守接线
- 只有 sandbox-memory-limit.unit.test.ts 检查常量值；把 service-main.ts:1342 或 production-worker-composition.ts:263 改回 256 MiB，测试仍全绿。没有"生效值 = min(常量, 绑定)"和"清单上限 ≥ 常量"的断言，也没有反向用例。
- 建议：加清单一致性测试（解析 cloud-seal.mjs 与 hermes-*-seal.mjs 的 maxMemoryBytes ≥ 常量，反向用例：清单写 256 MiB 必须失败）；加 runtime-tools 生效 ceiling = min(常量, 绑定) 的单元测试；"4 GiB"那条算术用例没有依据，删或改成基于 totalRuns×常量。

## 可以更好（低）
- 测试名写"四倍于 256 MiB"，与实际生效不符；修好第一条后一并改。

## 必问问题
- 会不会改变模型已见过的请求开头：两个模型和我都确认不会（prompt-catalog 无内存上限文字，ceiling 不进消息）。
- 还有没有别处写死 256 MiB：除签名清单的 512 MiB 外没有；其余 256 MiB 是磁盘增长上限、预热池（按设计保留）、资格探测临时 limits。
