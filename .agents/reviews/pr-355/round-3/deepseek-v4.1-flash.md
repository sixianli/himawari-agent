## 结论

### 严重度排序

**1. 中：ADR 0204 的决定第 4 条仍写“D6 并入 D1 的方案”，与最新修改和 ADR 0208 直接矛盾**
- 文件:行：`docs/adr/0204-handle-pi-deviations-d2-d3-d5.md:50`
- 问题：最新提交改了 ADR 0204 的背景、放弃的做法和后果，明确“D6 已单独删除”，但“决定”一节第 4 条原样保留，仍说 D6 要并入 D1、分开定会矛盾。作者声称三份文档现在彼此一致，这一条不成立。
- 证据：
  - `0204:50`：“**D6 并入 D1 的方案。**两者改的是同一处，分开定会互相矛盾。”
  - `0204:30`：“……后来查清压缩路径后推翻，D6 已单独删除，见 [ADR 0208]……”
  - `0204:72`：“D6 已按 [ADR 0208]……删除”
  - `0208:51`：“分三步做，每步单独一个 PR”，第 1 步就是“D6：删掉 `himawari-system-prompt` 扩展”。
- 建议：把第 4 条改成“D6 已按 ADR 0208 第 1 步单独删除”，或明确标注该条已被 ADR 0208 推翻，避免读者按决定第 4 条继续把 D6 和 D1 绑在一起。

**2. 低—中：`pi-development-guide.md` 的 D6 行仍是旧的 26/83 证据，未反映 ADR 0208 新增的 27/84 对比**
- 文件:行：`docs/pi-development-guide.md:351`
- 问题：ADR 0208 现在写的是两次对比：删除前后 26 个用例、83 条请求；合入 D4 后 27 个用例、84 条请求。指南 D6 行只保留前者，和 ADR 0208 的最新说法不一致，至少是过期信息。
- 证据：
  - `pi-development-guide.md:351`：“扩展已删除，D1 仍保留；26 个用例的 83 条请求逐字节不变”
  - `0208:53`：“……26 个多轮用例……83 条请求体逐字节相同……合入 D4 之后……27 个用例 84 条请求体与 `origin/main`（带扩展）逐字节相同。”
- 建议：指南 D6 行改为同时记录两次对比，或直接写“见 ADR 0208 第 1 步的两轮逐字节对比”，避免两处数字长期分叉。

**3. 低：指南系统提示一节的“只返回冻结的那一份”仍像是 `before_agent_start` 还在返回系统提示**
- 文件:行：`docs/pi-development-guide.md:179`
- 问题：同一段先说“不再在 `before_agent_start` 里重复返回”，段末又说“所以只返回冻结的那一份”，措辞自相矛盾，容易被读成 D6 扩展仍存在。
- 证据：`pi-development-guide.md:179`：“……不再在 `before_agent_start` 里重复返回……Himawari 的系统提示按对话冻结……所以只返回冻结的那一份，不每轮改。”
- 建议：把“只返回冻结的那一份”改成“只用冻结的那一份”，或明确“由资源加载器给出、请求函数采用冻结的那一份”。

**4. 低—中：这次删除没有能在“加回扩展”时失败的自动反向用例**
- 文件:行：`packages/runtime-pi/test/prompt-prefix.compat.test.ts:741`
- 问题：新增测试只检查请求体不含 `Current working directory`，它无法区分 D6 扩展存在与否；作者也在 ADR 里承认“没有‘加回就失败’的反向用例”。因此问题 3 的答案是：这次改动没有真正的自动回归保护，只有一次性手工 `cmp`。
- 证据：
  - `prompt-prefix.compat.test.ts:741`：`it("never lets Pi's own working-directory line into the request head"...)`，断言仅 `expect(bodies[0]).not.toContain("Current working directory")`
  - `0208:53`：“……所以没有‘加回就失败’的反向用例，只加了一个普通防线用例……”
  - 已有 `pi-runtime-adapter.compat.test.ts:3026` 已经在断言 `expect(context.systemPrompt).not.toContain("Current working directory")`，新用例与它重叠。
- 建议：如果希望这条改动受自动检查保护，增加能观察“是否注册了 `himawari-system-prompt` 扩展”或用例（例如断言 `before_agent_start` 不改变系统提示），否则在 ADR 里明确接受“D6 无自动反向保护”，不要把它算作已覆盖。

### 读代码证实的

- **D4 已合并、`sessionModelRuntime` 已删除**：代码中已无 `sessionModelRuntime`，只剩文档历史引用；`ConfiguredPiModelBindingPort.initializeRuntime` 使用 `createProvider` + `registerNativeProvider`（`configured-model-binding.ts:393-403`），适配器直接把 `binding.modelRuntime` 交给会话（`pi-runtime-adapter.ts:1538`）。作者的这条说法成立。
- **ADR 0208 “现在适配器直接用共享的 `binding.modelRuntime`”成立**：`configured-model-binding.ts` 的 `#runtime` 是每个绑定端口一个实例，`resolve()` 返回同一个 `runtime`（`configured-model-binding.ts:337-346`）。
- **删除扩展对对话请求开头没有影响**：`himawariRequestContext` 丢弃 Pi 传来的 system 消息，改用冻结的 `systemPrompt` 和冻结工具（`pi-runtime-adapter.ts:639-653`）；压缩请求 `himawariSummaryContext` 只看 Pi 传来的第一条 system 消息（`pi-runtime-adapter.ts:656-665`），与 `before_agent_start` 无关。`systemPromptOverride: () => systemPrompt` 仍提供同一份系统提示（`pi-runtime-adapter.ts:1410`）。
- **27 个用例与文件一致**：当前 `prompt-prefix.compat.test.ts` 中确有 27 个 `it(...)`；其中包含两条纯检查器单元用例和一条 0 请求用例，所以“27 个用例”不等于“27 个会发请求的用例”，但数字本身不矛盾。
- **`origin/main` 带扩展**：该扩展在 `bd04dd1c` 引入，基准 `11a8ec1f` 到当前提交的 diff 显示删除该扩展，所以“与 `origin/main`（带扩展）对比”这一描述在仓库历史里说得通。
- **`d4-golden-requests.json` 存在且被 `[D4]` 测试使用**：`packages/runtime-pi/test/fixtures/d4-golden-requests.json` 存在，`pi-runtime-adapter.compat.test.ts:2849-2875` 使用它做逐字节比较。ADR 0208 第 79 行引用有效。
- **架构文档改动与代码一致**：`docs/architecture-v0.1.md:454` 已去掉 `before_agent_start`，改为只写 `systemPromptOverride`，与当前代码一致。

### 推测 / 未核实

- **“84 条请求体”无法从仓库核实**：这是手工对比结果，仓库里没有提交对比脚本或输出；我能核实的是用例数 27，不能核实 84 这个总数。未发现与仓库内容矛盾，但标“未核实”。
- **ADR 0208 第 54 行计划“只覆盖 `streamSimple`”与现有直连路径的用词**：代码中 `pi-model-transport.ts:359` 用的是 `binding.modelRuntime.stream(...)`，不是 `streamSimple`。D1 计划针对的是 Pi 会话的默认请求函数，`streamSimple` 是新代理要覆盖的接缝，这两者不一定冲突；但“所有模型请求都进新代理”是否包括 `pi-model-transport` 直连路径，未核实，属于后续实施要确认的点。
- **`cacheWarming: "off"` 是否是 Pi 1.5.0/1.5.1 的合法值**：ADR 0208 第 54 行是将来计划，仓库代码里没有这个配置；未核实。
- **移除测试标题里的 `[ADR-0208]` 的原因**：仓库里其他测试仍保留 `[ADR-0188]`、`[ADR-0198]` 等标签，没有看到全局禁止规则；可能是为了减少对 ADR 编号的耦合，但未在提交说明或 ADR 里写明，未核实。

### 侧重检查

- **错误路径**：本次实际代码改动只有删除一个 `before_agent_start` 扩展。对话请求仍由 `himawariRequestContext` 构造，压缩仍由 `himawariSummaryContext` 构造；未发现删除扩展会新增失败路径。若扩展被错误加回，现有测试不会失败（见上第 4 条）。
- **不合规范或不可信的输入**：本次改动不接触用户输入、工具参数、遮盖规则或序列化输入；未发现新增攻击面。
- **安全 / 凭据**：删除的是系统提示扩展，不涉及密钥、认证、出口遮盖。D4 的原生认证与空凭据库逻辑未被这次文档修改触碰；`sessionModelRuntime` 删除已在代码中确认。
- **资源耗尽**：删除一个无状态钩子，不新增循环、重试或队列；未发现资源风险。
- **不可撤销操作**：代码层面可随时加回扩展；对模型已见请求的影响按代码分析为零。真正不可逆的是请求开头字节，而这次未改变它。
- **规则、说明文档和代码一致性**：发现 ADR 0204 决定第 4 条、指南 D6 行、指南第 179 行措辞三处不一致；其余 ADR 0208、0204、指南与代码在 D6/D4 的主要事实上一致。

### 必答问题

**1. 会不会改变模型已经见过的请求开头？**
不会。发给模型的内容仍然只在末尾追加：
- 对话请求：`himawariRequestContext` 用冻结的 `systemPrompt` 和冻结工具，过滤掉 Pi 传来的所有 system 消息（`pi-runtime-adapter.ts:639-653`）。
- 压缩请求：`himawariSummaryContext` 用 Pi 自带摘要提示作为 system 消息（`pi-runtime-adapter.ts:656-665`），与 `before_agent_start` 无关。
- 每轮会变的值仍在最后一条用户消息里：`turnPrompt` 把时间、资料、运行环境说明放进 `<himawari-context>`，主人的话放进 `<owner-message>`（`pi-runtime-adapter.ts:610-628`）；系统提示和工具由 `systemPromptOverride`/冻结工具决定（`pi-runtime-adapter.ts:1410`）。
因此删除 `himawari-system-prompt` 扩展不改变系统提示、工具定义、历史消息或遮盖结果。手工逐字节对比也支持这一点，但该对比未提交为自动检查（未核实 84 条的总数）。

**2. 会不会让同一段文字在不同请求里变成不同字节？**
不会。这次改动没有引入依赖前后文的遮盖、带时间的字段或无序集合。工具仍来自固定顺序的 `descriptors`，时间等每轮变化值仍只放在最后一条消息里；删除的扩展不参与序列化。未发现新增不确定性。

**3. 有没有对应的自动检查，反向用例真的会失败吗？**
没有真正的自动反向检查。新加的 `never lets Pi's own working-directory line into the request head`（`prompt-prefix.compat.test.ts:741`）在扩展存在时也会通过，作者也明确说“不是 D6 的反向用例”。因此“把扩展加回去”不会触发任何自动测试失败；只有一次性的手工 `cmp`。如果要求这次删改受回归保护，需要补一条能区分扩展存在与否的用例。

**4. 改动产生或修改的每个值，使用它的地方都能接受吗？**
- 删除的值是扩展名 `himawari-system-prompt`：代码中已无注册点，仓库中只剩文档历史引用（ADR 0208、ADR 0204、指南），没有配置键或清单消费者；删除后无悬空引用。
- 测试标题删除了 `[ADR-0208]`：该标签只影响可读性和追溯性，仓库没有强制要求测试标题包含 ADR 编号的检查；未发现消费者依赖它。
- ADR 0208 引用的 `packages/runtime-pi/test/fixtures/d4-golden-requests.json` 存在且被 `[D4]` 测试使用，引用两端一致。
- ADR 0208 计划里的 `cacheWarming: "off"` 尚未落地到代码，属于未来配置值，合法性未核实；`binding.modelRuntime` 的名称与共享方式已在代码中核对一致。
因此除文档一致性问题外，本次实际改动没有发现“产生方和使用方校验不匹配”的情况。
