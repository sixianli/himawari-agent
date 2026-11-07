# 代码复核结论（PR #207，基准 7911a7a → 检出版 22ae817）

## 发现（严重度从高到低）

**1. 中｜packages/runtime-pi/src/configured-model-binding.ts:33-50 + apps/agent-service/src/production-magpie-models.ts:218-232 — 「自动」模型的可用档位表随启动时 Magpie 清单而变，旧会话保存的档位可能被拒**
- 读代码证实：启动时 `expandConfigurationWithMagpieModels` 若在清单里找到 primary（组）条目且 `reasoningLevels` 非空，就把 primary 的 `thinkingLevels` 覆写为清单值；`thinkingLevelMap`（configured-model-binding.ts:40-50）据此生成 `{minimal:null, low:"low", …}`。清单里没有的档位被标 `null`，`getSupportedThinkingLevels` 不再返回它。而请求侧对档位做硬校验：`pi-runtime-adapter.ts:1290` `if (!getSupportedThinkingLevels(binding.model).includes(request.thinkingLevel ?? "off"))` 会抛错。
- 推测：若某会话在旧版本下保存了 `minimal` 之类被新清单判为不支持的档位，该会话下一轮直接失败，需用户手动重选。是否真发生取决于 pi-ai 的默认档位集与生产清单字段（node_modules 未随仓库提供，`@earendil-works/pi-ai` 内部行为**未核实**）。这不是改写已发内容，而是显式拒绝，未违反 [I-66]。
- 建议：校验失败时回退到 `getSupportedThinkingLevels(...)[0]` 而非抛错，或在调整档位表时保留旧档位的兼容映射。

**2. 低｜apps/agent-service/src/production-magpie-models.ts:63-67、104-111、199-208、236-240 — 作者说明与实现有三处偏差**
- 读代码证实：
  - 「每个列出的、支持工具调用且收文字的模型」并不充分：还要 `context_window`、`max_output_tokens` 都是大于 0 的整数、id 全局唯一、id 不以 `auto/` 或 `group/` 开头（第 64-67、104-111、199-208 行缺任一即静默跳过）。缺 `max_output_tokens` 的模型会从目录里无声消失，仅当 primary 自己缺失时才有 `primary_missing_from_list` 诊断（第 213-219 行）。
  - 「价格档位按清单里**所有**有标价模型平分三档」不准确：`prices` 只收录 `added.some(...)` 的条目（第 236-240 行），primary（组模型）和无价模型不参与分档，也与分档无关。
  - 「已核对的字段」里 `pricing.prompt/completion` 只接受**字符串**（第 57-60 行 `typeof value === "string"`）；若 Magpie 对某模型返回数字，会被当作无价处理。字段实际格式**未核实**（依赖生产清单）。
- 建议：对「因缺少 limit 字段被跳过」写一条诊断事件；分档口径在 PCI 说明里改为「目录内有标价的模型」。

**3. 低｜packages/runtime-pi/src/configured-model-binding.ts:298-310 — 非 Magpie 的多 primary 配置从「静默忽略」变成启动崩**
- 读代码证实：旧代码 `options.descriptors.length !== 1` 时新描述符根本进不了 binding（production-model-composition.ts 旧版只传第一个 primary）；新版 `resolveConfiguredModelDescriptorSet` 把**所有** primary 传进去（第 291-293 行），binding 校验改为「非 magpie 时 `descriptor !== first` 即抛 `PI_MODEL_BINDING_REQUIRES_ONE_PRIMARY`」。即 vercel-ai-gateway 类多 primary 配置以前能跑（只用第一个），现在启动失败。
- 推测：现网配置若有多 primary 非 magpie，会无法启动。是否有此类配置**未核实**。
- 建议：在展开/组合层对非 magpie 多 primary 显式报配置错误并给出迁移提示，而不是启动中途抛错。

**4. 低｜apps/agent-service/src/production-magpie-models.ts:69-71 — 缺 cache 价格字段时默认 0，预算准许线偏松**
- 读代码证实：`cacheRead: perMillion(pricing?.["input_cache_read"]) ?? 0`；`admissionCostForConfiguredPiModel`（configured-model-binding.ts:241-256）用 `max(input, cacheRead, cacheWrite)` 估成本，cache 计 0 会让估得更低、放宽准许。真实是否收费**未核实**。
- 建议：缺缓存价时至少沿用 primary 的 cacheRead/Write 而不是 0。

**5. 低｜apps/control-center/src/components/model-picker.tsx:18-22 — 价格 ≥10 只显示整数**
- 读代码证实：`value >= 10 ? value.toFixed(0)`，10.74 显示为 `$11`，四舍五入失真（仅 UI 显示，不影响发给模型的字节）。
- 建议：≥10 也保留至少一位小数或直接 `toFixed(2)`。

**已读代码证实为正确的关键说法**（无需修改）：
- 清单解析按 `data` 数组顺序、档位用固定有序常量过滤（production-magpie-models.ts:55-56、96-100），`priceTiers` 先排序再取分位点（第 154-172 行），同一名单结果确定；分档只在启动时算一次、只进目录接口。
- 「不建路由组、按提供方/模型名直连」：`registerProvider` 一次注册全部 magpie 模型，`PI_MODEL_NOT_REGISTERED` 逐个校验（configured-model-binding.ts:367-394）；compat 测试断言组模型无 `thinkingFormat`、带 `sendSessionAffinityHeaders`（configured-model-binding.compat.test.ts:294-300）。
- 「读不到就退回原配置」：解析/请求/密钥任何一步失败都返回 `unchanged` 并写 `magpie-models.discovery_failed`，错误码白名单 `[A-Z0-9_]{1,80}`，不泄漏网络原文（第 183-198、224-231 行）。
- 「无标价沿用主模型保守单价」：`{ ...primary.cost }`（第 134 行）。
- 三语文案齐全：en/zh-CN/ja 均含 9 个新 message id（zh-CN.ts:113-121、ja.ts:121-129、en.ts:119-128），`MESSAGE_IDS`/样例值同步更新。
- 「清单只在启动读一次」：`expandConfigurationWithMagpieModels` 仅在 `runAgentService` 开头调用一次（service-main.ts:610-616），后续目录/标签全部用启动时的 `magpieModels`（service-main.ts:1843-1880）。

## 必答问题

**1. 是否改变模型已见过的请求开头？——否（读代码证实）**
- 全量 diff 只涉及：模型描述符来源/数量（production-model-composition.ts、configured-model-binding.ts）、目录接口与 UI、i18n/CSS。未触及系统指令（production-run-policy.ts	memset/`systemInstruction` 未改）、工具定义、历史消息存取、遮盖（`configuredPayloadProtector` 只依赖 `payload-encryption` 密钥引用，service-main.ts:250-270，未受展开影响）。
- 新增的 `thinkingLevels`/`thinkingLevelMap` 只进入 provider 模型注册（configured-model-binding.ts:258-284），影响的是请求的顶层思考参数（compat 测试证实 payload 是 `reasoning:{effort:...}` 这类参数，configured-model-binding.compat.test.ts:190-195），不进系统提示/工具/历史字节。档位变化只在用户主动换档位时发生，启动后一次会话内固定。
- 「每轮会变的值都在最后一条消息」：本轮改动没有新增任何每轮变化值。请求侧仍与 [prompt-prefix 规则](../../.claude/rules/prompt-prefix.md#rules) 一致；网关守门 `packages/runtime-pi/test/prompt-prefix.compat.test.ts` 存在且输入面未被本 PR 触及。
- 作者「换模型后该对话下一轮 0 命中、之后重新累积」的表述与规则一致（模型名属于请求端点而非追加内容，换模型必然换前缀）。

**2. 同一段文字会不会在不同请求里变成不同字节？——不会（读代码证实）**
- 遮盖路径零改动；diff 没有向请求内容引入时间、随机或无序集合derived 值。启动期派生（余档位、价格、分档）对同一份清单是确定性的；随清单变化只发生在重启之间，且只影响目录展示，不影响模型请求字节。

**3. 有没有对应的自动检查、反向用例会不会真的失败？——基本有（读代码证实，运行结果未核实）**
- `apps/agent-service/test/production-magpie-models.unit.test.ts` 共 14 个用例：正向（真实字段、逐模型展开、档位真实值）+ 反向（请求失败/HTTP 非 200/200 但空或畸形/空密钥/secret 卡住超时/重复 id/空价字符串/少于 3 个不同价/主模型不在清单）。这些断言逐条对应实现分支，实现若反着写会失败。
- UI 反向用例：`apps/control-center/test/model-picker.unit.test.ts` 新增搜索无结果 → 列表为空 + `chat.noModelMatch`。
- 缺口（读代码证实）：`configured-model-binding.compat.test.ts` 只有「多个 vercel descriptor 被拒」（第 124-132 行）的旧反向用例，**没有**「多个 magpie descriptor 被接受」的新增用例，本 pr 的核心放宽未直接被测试锁定；建议补一条。
- `check:prompt-prefix` 门（README 规则第 26-30 行）仍在 `npm run check` 内；本次改动未触碰其覆盖面，但我在此环境无法运行测试确认绿灯——**未核实**。
