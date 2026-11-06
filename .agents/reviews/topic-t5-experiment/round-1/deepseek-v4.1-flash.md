## 复核结论（按严重度）

### 1. 严重度高（实证）：新模型的 `ref` 含 `/`，会卡在网关契约和浏览器存储上，选完模型后发不出消息、偏好也存不住

**文件:行**：`apps/agent-service/src/production-magpie-models.ts:111`；相关契约在 `packages/gateway-contracts/src/validation.ts:49`、`packages/gateway-contracts/src/thread-contracts-v3.ts:158`、`packages/gateway-contracts/src/contracts-v2.ts:470`

**问题**：新增模型用 `magpie:${entry.id}` 做 ref，而真实的 `entry.id` 形如 `opencode-go/deepseek-v4-pro`（PR 说明和测试都这么写）。但模型选择进入 `thread.message.submit_configured` 的 `modelRef` 字段时，用的是 `machineString`，正则不允许 `/`；`owner.preferences.set` 的 `modelRef` 同样如此。浏览器本地读取偏好时还有 `CURSOR_PATTERN`，也不允许 `/`。结果：选择新模型后，构造/解析命令就会失败，刷新页面后偏好也会被丢掉。

**证据**：
- `production-magpie-models.ts:111`：`ref: \`magpie:${entry.id}\`,`
- 测试自身用带斜杠的 id：`apps/agent-service/test/production-magpie-models.unit.test.ts:39`：`entry("opencode-go/deepseek-v4-pro", {`
- `packages/gateway-contracts/src/validation.ts:52-55`：
  ```ts
  input.length > 128 ||
  !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(input)
  ```
- `packages/gateway-contracts/src/thread-contracts-v3.ts:158`：`modelRef: machineString,`
- `packages/gateway-contracts/src/contracts-v2.ts:470`：`modelRef: nullable(machineString),`
- 客户端提交前会解析：`apps/control-center/src/messages.ts:138-139`：`threadGatewayMessageSchema.parse({...})`
- 服务端也会再解析：`packages/platform-node/src/http-gateway-server.ts:365`：`threadGatewayMessageSchema.parse(input)`
- 浏览器读取偏好时过滤掉带 `/` 的 ref：`apps/control-center/src/browser-storage.ts:29`：`const CURSOR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;`，以及 `:248` 的 `CURSOR_PATTERN.test(parsed.modelRef)`
- 提交路径：`apps/control-center/src/thread-control-center.tsx:1051-1053` 用 `intent.selection` 生成 `thread.message.submit_configured`，`:1208-1212` 的 selection 直接取 `selectedModel.ref`。

**建议**：不要直接把 `entry.id` 拼进受 `machineString` 约束的 ref。可以生成契约安全的 ref（例如把 `/` 换成 `:` 或 `.`，或用稳定哈希），实际模型名继续放在 `model` 字段；然后补“带斜杠 id 的端到端往返测试”：`thread.message.submit_configured`、`owner.preferences.set`、`ControlCenterBrowserStorage.readPreferences` 各走一遍真实 schema。若决定放宽 `machineString`/`CURSOR_PATTERN`，需要审计所有使用方，不能只改一处。

---

### 2. 严重度中（实证）：价格与档位耦联，少于 3 个不同价格时连价格本身都不再返回

**文件:行**：`apps/agent-service/src/service-main.ts:1850`；`apps/agent-service/src/production-magpie-models.ts:142`；`apps/control-center/src/components/model-picker.tsx:140`

**问题**：紧凑修复说“少于三个不同价格不打贵便宜标签”，但现实现是：`priceTiers` 返回空 Map 时，`modelCatalogTags` 连 `price` 都不返回。于是清单里明明有标价，UI 却整行不显示价格，和 PR 的“每行显示价格”不一致。

**证据**：
- `production-magpie-models.ts:142`：`if (new Set(totals).size < 3) return new Map();`
- `service-main.ts:1850`：`...(price && tier ? { price, priceTier: tier } : {}),`
- `model-picker.tsx:140`：`: item.price ? (`；`:149`：`{item.priceTier ? (`
- 页脚也只在有 `priceTier` 时出现：`model-picker.tsx:170-172`：`models.some((item) => item.priceTier) ? ... chat.priceNote`

**建议**：把价格和档位解耦。只要有价格就返回 `price`，档位不足三条时只省略 `priceTier`；页脚判断改为 `models.some((item) => item.price)`。补一条“只有 1～2 个不同价格时价格仍显示、但不显示档位”的测试。

---

### 3. 严重度中（实证）：档位并非按“清单里所有有标价模型”计算，只覆盖新增模型

**文件:行**：`apps/agent-service/src/production-magpie-models.ts:213-221`、`:232-235`；文案在 `apps/control-center/src/i18n/resources/en.ts:127-128`

**问题**：`added` 排除了 `auto/`、`group/`、已配置模型；随后 `prices` 又只收集这些 `added` 模型的价格。因此档位分界线只由“新加进去的直连模型”决定，不是清单里所有有标价模型。页脚却写的是 “all priced models in this list”，文案与实现不一致；已配置主模型或 `auto/` 即使有标价也不会显示价格/档位。

**证据**：
- `production-magpie-models.ts:216-220`：
  ```ts
  !entry.id.startsWith("auto/") &&
  !entry.id.startsWith("group/") &&
  !known.has(entry.id) &&
  entry.toolCall &&
  entry.acceptsText,
  ```
- `production-magpie-models.ts:234`：`if (entry.price && added.some(({ model }) => model === entry.id))`
- `en.ts:128`：`"Labels split all priced models in this list into three equal groups by input price + output price."`

**建议**：要么按“所有列出的有标价模型”构建价格 Map，并明确如何映射到实际可选的 ref；要么把文案改成“按本次新增的直连模型分档”。同时补测试，覆盖 `auto/`、`group/`、已配置主模型有标价时的行为。

---

### 4. 严重度中（推测，需用真实清单核实）：解析强依赖 `reasoning === true` 和 `tool_call === true`，但唯一的“真实字段”测试是自造 fixture

**文件:行**：`apps/agent-service/src/production-magpie-models.ts:81-87`；测试 `apps/agent-service/test/production-magpie-models.unit.test.ts:10-25`

**问题**：解析把推理档位的门槛写成 `entry["reasoning"] === true`，把模型入选门槛写成 `entry["tool_call"] === true`。作者列出的“生产清单真实字段”只提到 `context_window`、`max_output_tokens`、`reasoning_levels`、`modalities.input`、`pricing.prompt/completion`，没有 `reasoning` 和 `tool_call`。如果真实 Magpie 清单用的是 `supported_parameters` 里的 `reasoning`/`tools`，或者缺少这两个布尔字段，结果会是：
- `tool_call` 不为 `true`：所有模型都不被加入，功能静默失效；
- `reasoning` 不为 `true`：所有模型都只显示“关闭”，主模型问题照旧。

此外 `perMillion` 只接受字符串价格（`:52`），如果清单返回数字，价格会全部丢失并回退到主模型单价。

**证据**：
- `production-magpie-models.ts:81-84`：
  ```ts
  reasoningLevels:
    entry["reasoning"] === true
      ? THINKING_LEVELS.filter((level) => levels.includes(level))
      : [],
  ```
- `production-magpie-models.ts:87`：`toolCall: entry["tool_call"] === true,`
- `production-magpie-models.ts:52`：`const parsed = typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;`
- 测试 fixture 默认把两个字段都写成 `true`：`production-magpie-models.unit.test.ts:20-22`：
  ```ts
  reasoning: true,
  reasoning_levels: ["high", "max"],
  tool_call: true,
  ```
- 测试名却叫“reads the real /v1/models fields”：`:111`。它并没有使用真实抓包，只是用解析器期望的键自造数据，无法证明真实 schema。

**建议**：提交一份脱敏后的真实 `GET /v1/models` 响应作为 fixture，直接断言“新增了几个模型、主模型档位是什么”。在解析器里对 `reasoning`/`tool_call` 做兼容（布尔或 `supported_parameters` 能力列表），价格同时接受字符串和数字；诊断日志增加 `dropped_missing_context`、`dropped_no_tools` 等计数，避免静默失效。

---

### 5. 严重度中低（实证）：`priceTiers` 在重复价格下不是三等分，甚至可能没有 high 档

**文件:行**：`apps/agent-service/src/production-magpie-models.ts:139-150`

**问题**：分档用 `total <= lowCut` 和 `total > highCut`。当高价重复较多时，位于 `highCut` 的模型全部落进 mid，high 档可能为空。例如 totals 排序后 `[1,2,3,3,3,3]`：`lowCut=2`、`highCut=3`，结果 1/2 为 low，所有 3 都为 mid，没有任何 high；这不是“平分三档”。

**证据**：
- `production-magpie-models.ts:143-149`：
  ```ts
  const lowCut = totals[Math.ceil(totals.length / 3) - 1] ?? 0;
  const highCut = totals[Math.ceil((totals.length * 2) / 3) - 1] ?? 0;
  ...
  return [ref, total <= lowCut ? "low" : total > highCut ? "high" : "mid"] as const;
  ```

**建议**：按排序后的名次分档（例如按 `rank < n/3`、`< 2n/3`），相同价格保持在同档，或者先对 distinct 价格分档；把边界规则写进测试，覆盖重复价格和“最高价重复”的情况。若产品接受这种近似，也应在文案里说明。

---

### 6. 严重度低（实证）：PR 说“最大输出取自清单”，实际被主模型的 `maxTokens` 截断

**文件:行**：`apps/agent-service/src/production-magpie-models.ts:122`

**问题**：`maxTokens: Math.min(entry.maxOutputTokens, primary.maxTokens)`。生产主模型通常是 32768，而清单里的 `max_output_tokens` 可能是 131072、384000；最终展示/使用的能力被截到 32768。测试也明确断言了这个截断。

**证据**：
- `production-magpie-models.ts:122`：`maxTokens: Math.min(entry.maxOutputTokens, primary.maxTokens),`
- 测试 `production-magpie-models.unit.test.ts:299-315` 专门验证“caps the output limit at the configured one”。

**建议**：代码限制可能合理（Pi/网关上限 32768），但 PR 说明应改成“上限按清单取值，但不超过配置的主模型上限”；如果产品希望展示真实上限，应在 UI/文案中区分“可配置最大输出”和“实际使用上限”。

---

### 7. 严重度低（实证）：读清单失败回退时，“自动”标签会消失

**文件:行**：`apps/agent-service/src/production-magpie-models.ts:157-161`、`:247-253`

**问题**：`automaticRefs` 只在成功读取清单后根据配置计算；失败时直接返回 `unchanged`，其中 `automaticRefs` 是空 Set。因此 Magpie 不可达时，即便主模型仍是 `group/himawari-main`，UI 也不会显示“自动”。由于回退时通常只有一个模型、选择器被隐藏，影响有限，但和“自动显示为自动”不一致。

**证据**：
- `production-magpie-models.ts:157-161`：`const unchanged: MagpieModelExpansion = { configuration, prices: new Map(), automaticRefs: new Set() };`
- `production-magpie-models.ts:247-252`：只在成功返回时计算 `automaticRefs`。

**建议**：把 `automaticRefs` 的计算提到 discovery 之前，失败回退也带上；或至少在回退路径复用同一套标签逻辑。

---

## 未核实的部分

- 真实生产 Magpie `/v1/models` 的字段名、`reasoning`/`tool_call` 是否存在、价格是字符串还是数字：仓库里没有真实抓包，只有在测试里自造的 fixture，**未核实**。
- `npm run check`（26 步）、`npm run build`、31 个派生测试文件/746 用例、真实浏览器三语验收：复核者没有运行权限，**未核实**。
- 实际生产模型 id 是否全部含 `/`：PR 说明和测试都使用 `provider/model` 形式，代码也按这个形式生成 ref，**高度可能**，但清单本身未读到。

---

## 必答问题

### 1. 这个改动会不会改变模型已经见过的请求开头？

**不会改变已发内容的前缀。** 依据：

- 本 diff 没有修改 `packages/runtime-pi/src/pi-runtime-adapter.ts` 等消息/历史组装代码；改动集中在模型发现、模型描述、思维档位和网页展示。
- 系统提示由 `production-run-policy.ts:64-83` 的 `[HIMAWARI_IDENTITY, policy.systemInstruction, capabilities]` 决定；`runCapabilityNotice` 只包含搜索/编码/沙箱命令/工作目录，不含模型清单或价格（`production-run-policy.ts:142-169`）。
- 模型清单只在启动时读取一次：`service-main.ts:610-619`，不是每轮请求。
- 规则要求“每轮会变的值只在最后一条用户消息里”（`.claude/rules/prompt-prefix.md:16-19`）；本 diff 没有改变这条路径。

需要提醒的两点：

- 换模型本身会更换 provider/模型，作者已说明“该对话下一轮缓存 0 命中”，这不是本 PR 改写了前缀。
- 新增模型的 `contextWindow` 来自清单，会影响超过窗口时的压缩阈值/压缩时机；这属于压缩行为，不是每轮改写前缀，但如果用户切到上下文窗口更小的模型，历史被压缩的时机会变。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

**没有发现本 PR 新增这样的路径。** 价格/档位是启动时的快照，`priceTiers` 对 totals 排序后计算，给定快照结果是确定的；没有时间字段、随机数或依赖请求上下文的遮盖；diff 也没有触碰脱敏逻辑。

但有一个**读代码确认的副作用**需要注意：`configuredModelDisclosureIdentity` 会对 `JSON.stringify(model)` 做哈希（`production-model-disclosure.ts:8`）。Magpie 发现会给主模型补上 `thinkingLevels`，并按清单新增模型，所以模型披露身份会随清单内容/启动结果变化。这不改变发给模型的字节，但会让之前按模型身份保存的授权/摘要不再匹配；具体哪些授权会因此失效需要结合授权存储再核实（**未完全核实**）。

### 3. 改动有没有对应的自动检查，反向用例是否真的会失败？

**有单测，但关键路径覆盖不足。**

已有且有意义的部分：

- 解析、展开、价格分档、失败回退都有单测；`production-magpie-models.unit.test.ts` 里带 `[review]` 的反向用例覆盖了重复模型去重、空/畸形 200 响应、空密钥、密钥读取卡住、稳定错误码、无价格、少于三个不同价格、主模型不在清单等。
- 思维档位用真实 `ConfiguredPiModelBindingPort`/Pi runtime 核对（测试 `:253-272`），不是纯 mock。
- 界面单测覆盖列表、价格标签、搜索和“无匹配”提示。

但关键缺口：

- **没有测试“选中带 `/` 的发现模型 → 提交/保存”**，所以上面第 1 条的核心阻断没有被自动检查发现；现有 UI 测试使用的是 `model-ui`、`m-0` 这类安全 ref。
- “reads the real /v1/models fields”用的是自造 fixture，不能验证真实 Magpie schema，因此 `reasoning`/`tool_call`/数字价格的风险不会被发现。
- 没有测试“价格存在但档位不足时价格仍应显示”，第 2 条的价格丢失不会被发现。
- 没有测试档位在重复价格、最高价重复时是否仍符合“三等分”语义。

因此：反向用例对它们覆盖的行为是真会失败的；但本 PR 最大的实际风险没有被反向用例覆盖。`npm run check` 的通过情况未核实；`check:prompt-prefix` 与本改动无直接冲突，但也没有因为这次改动新增针对模型目录的检查（鉴于本改动不碰请求内容，这一点本身不是问题）。
