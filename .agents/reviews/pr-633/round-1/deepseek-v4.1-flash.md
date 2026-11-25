## 结论

未发现阻断性或中等问题。改动只增加了一行测试期望项，与生产代码中的只读判定一致；作者的两条说法都与代码相符。

**作者说法核对（读代码证实）**

- 说法 1 成立：`apps/agent-service/src/production-tool-actions.ts:299-311` 中 `memory_open` 展开 `READ_DEFAULTS`（`:60-68`），并且 `family: "builtin"`、`actionKind: "READ"`、`sideEffect: "none"`；`packages/application/src/services/tool-action-registry.ts:97-105` 的 `readOnlyRow` 正是要求 `READ` + `none` + family 为 `builtin`/`web`，所以它会进入只读清单。运行时 `apps/agent-service/src/production-runtime-tools.ts:629-639` 也确实对追加后的 `memoryOpenDescriptor()` 再做一次 `readOnly` 过滤。
- 说法 2 成立：`git diff` 只改了 `apps/agent-service/test/tool-read-only-offer.unit.test.ts:35`，没有任何生产代码、提示词、工具定义、历史或遮盖逻辑的改动，因此不会改变发给模型的内容。

**未核实**

- 作者“agent-service 单测 1232 条全过”无法在本环境运行验证。
- 未逐条追溯 PR 629 的提交历史，只核对了当前基线中 `memory_open` 的生产实现与相关测试。

## 侧重检查

- 错误路径 / 不可信输入：本次是测试改动，没有新增运行时代码路径；`memory_open` 的输入校验（`production-memory-open.ts:82-86,144-147`）是既有代码，未被本次修改。
- 安全 / 不可撤销操作：`readOnlyRow` 仅接受 `READ` + `sideEffect: "none"` + `builtin`/`web`，`memory_open` 是读取记忆记录，没有新增写操作或不可撤销操作。
- 资源耗尽：没有新增循环、分页或外部调用；测试只对固定行做纯内存筛选。
- 规则文件 / 文档一致性：`.agents/instructions/prompt-prefix.md` 关于“不增删工具、不改请求开头”的约束没有被本 diff 触碰；`production-runtime-tools.unit.test.ts:2330,2421` 的既有清单也已包含 `memory_open`，与本次测试期望一致，没有发现文档或清单互相矛盾之处。

## 必答问题

1. **不会改变模型已经见过的请求开头。** 本 diff 只改测试；测试中的 `descriptors` 用占位 `description: "x"`、`parameters: {}`（`tool-read-only-offer.unit.test.ts:11-19`），只调用纯内存的 `registry.offer`，不构造也不发送模型请求。生产侧 `memory_open` 是否出现在工具列表完全由既有代码 `production-runtime-tools.ts:629-639` 决定，本次未改。发给模型的内容仍只在末尾追加；`memory_open` 结果里确实含 `recordedAt`、历史 `time`、依赖 `now()` 的 `status`（`production-memory-open.ts:125-133,204-231`），但它们作为工具结果追加在末尾，不是请求开头，而且这是既有生产行为，不是本 diff 引入的。

2. **不会让同一段文字在不同请求里变成不同字节。** 测试使用 `.sort()` 后与固定数组比较（`:32-43`），输入固定、无遮盖、无时间字段、无无序集合。生产 `memory_open` 对历史版本按 `occurredAt` 再按 `id` 排序（`production-memory-open.ts:185-187`），也是确定的；其中的时间字段问题见第 1 条，属于既有代码且位于末尾工具结果。

3. **有对应的自动检查。** 就是本测试：`readOnly` 的精确清单断言（`:32-43`）在缺少 `memory_open` 时会失败（基线正是如此），在 `memory_open` 被错误改成非只读时也会因清单不等而失败；`:24-29` 逐个校验只读项确为 `READ`/`none`，`:30-31` 校验非只读项不会混入。反向用例在逻辑上确实会失败。未实际运行测试（未核实）。

4. **唯一被修改的值是测试期望项 `"memory_open"`，使用它的两端一致。** 产生方是 `production-tool-actions.ts:301` 的 `tool: "memory_open"`；使用方是本测试的 `:35` 期望清单以及 `:24-26` 通过 `registry.forTool` 查到的同一行。`readOnlyRow` 对该行返回 true，两边校验吻合。其他使用处也已接受该标识：`production-memory-open.ts:25` 的 descriptor 名、`production-runtime-tools.unit.test.ts:1637,1674,2330,2421` 的运行时清单。没有遗漏需要同步修改的清单项。

方案评价：直接把 `memory_open` 补进硬编码期望清单是合适的；改成从 `PRODUCTION_TOOL_ACTION_ROWS` 推导期望值会让断言恒真、失去“新增只读工具未同步”的回归检测作用，不建议。
