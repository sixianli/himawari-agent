Diff 已通读。现在读关键文件核对：`configured-model-binding.ts` 全文、`MODEL_THINKING_LEVEL_MAPS` 是否含主模型名、`ConfiguredPiModelBindingPort` 的其他构造处，以及 prompt-prefix 反向用例。
# 代码复核报告：PR #207（模型清单和推理档位从 Magpie 动态读取）

## 侧重检查（先做）

走的流程：浏览器「模型选择」→ 启动配置展开（`apps/agent-service/src/service-main.ts:611`）→ 目录组装（`service-main.ts:1841-1881` 的 `modelCatalogTags` + `getPiModelPresentation` + `production-http-composition.ts` 的 `modelCatalog` 选项）→ 网页校验（`production-http-composition.ts:840-854` `validateModelSelection`）→ 每轮 run 策略（`production-run-policy.ts:45-54`）→ Pi 绑定（`production-model-composition.ts` → `ConfiguredPiModelBindingPort`）→ 发请求。

结论：
- 单元测试覆盖好：新 419 行测试覆盖 Magpie 字段解析、展开、失败回退、分档、重复 id、空价格、日志码白名单，并真实调用 `ConfiguredPiModelBindingPort`/`resolveConfiguredModelDescriptorSet`/`getPiModelPresentation`；UI 有列表/标签/搜索/空态单测。
- **没测覆盖的路径（证实的缺口）**：`runAgentService` 里装配（`service-main.ts:613` 展开调用、`service-main.ts:1844-1880` 的 `modelCatalogTags` 闭包）没有集成测试——grep 全仓库，`expandConfigurationWithMagpieModels` 只被 `production-magpie-models.unit.test.ts` 直接调用，启动装配是“断线”的；仓库里也没有任何集成测试覆盖“重启后 Magpie 清单变化 + 已存 owner 偏好”这条线。
- 文档：`docs/adr/0117`（Magpie 主模型）、ADR 0122:103（“已存模型从配置去掉时回退主模型，保留原选择”）都没有随这次把“主模型可动态增减”的语义更新；对这种影响授权标识的改动，没有新 ADR（读代码证实仓库里没有相关新增文档）。

## 发现（严重度从高到低）

### 1.【高·条件触发】新添模型把主模型的 `reasoningRequired` 原样拷走，可能让服务启动直接失败
- 文件：`apps/agent-service/src/production-magpie-models.ts:133-156`（`descriptorFor` 的 `{...primary}` 拷贝）→ `production-model-composition.ts:229-231` 原样转发 → `packages/runtime-pi/src/configured-model-binding.ts:196-201`：
  ```ts
  if (descriptor.reasoningRequired !== undefined && (typeof ... !== "boolean" ||
        (descriptor.reasoningRequired && !descriptor.reasoning)))
    throw new TypeError(`${field}.reasoningRequired requires reasoning capability`);
  ```
- 证据链：`strict-configuration.ts:1207-1211` 保证配置文件里只有一个 primary；`strict-configuration.ts:394-395` 只在**配置文件**层面校验"`reasoningRequired` 需配 `reasoning`"。而 Magpie 展开发生在 `JsonFileConfigurationPort.load` **之后**（`service-main.ts:611-619`），新添描述符之后不再有任何配置校验；清单里 `reasoning !== true` 但 `tool_call && text` 的模型（像测试里的 `opencode-go/plain`）会得到 `reasoning: false, reasoningRequired: true`，`ConfiguredPiModelBindingPort` 构造抛错 → 启动 fail，而不是 PR 设计的“读不到就退回”。
- 触发条件是推测：生产配置里 `reasoningRequired` 是否为 true 未核实（模板是 `false`，`scripts/delivery-mode/packet-template/maintenance/production-shape-config-template.json:82`；但 `docs/adr/0117` 风格说明生产配置不在仓库）。代码行为是读代码证实的。
- 建议：在 `descriptorFor` 里，若 `entry.reasoningLevels` 为空就删除 `reasoningRequired`（或仅当 `reasoning === true` 才保留），并补“清单含无推理模型 + 主模型 reasoningRequired: true”的测试。
- 附带（同一段拷贝的类似问题，半推测）：`capabilities`（含 `structured_outputs`）也整体拷贝，`configured-model-binding.ts:277` 由此决定 `supportsStrictMode`——清单里每个模型是否支持 structured outputs 清单未读、代码也未判别，对不支持的新模型可能请求失败。

### 2.【中】新发现的每个 Magpie 模型自动继承主模型的“可读私人数据”披露资格，并直接进入授权绑定
- 证据：`descriptorFor` 拷贝 `...primary`（含 `allowedDataClassifications: ["public","private"]`、`disclosure`）；`workspace-auto-authorization.ts:101-109`（非 embedding 且含 "private" 的全部模型构成 `binding.models` 参与 `bindingDigest`）与 `public-search-authorization.ts:60-67`、`authorize()` 的 `models.includes(...)` 判定都基于 `configuration.modelDescriptors`；`service-main.ts:619` 之后所有组装用的都是展开后的配置。
- 后果：Magpie 清单里任何能写文本、能调工具的模型，未经任何配置/审查就获得与主模型相同的私人数据资格；且清单（含每模型的 cost/窗口字段，`configured-model-disclosure-identity` 对整个描述符 JSON 做 sha256，`production-model-disclosure.ts:8`）每次变化都会在重启时改写 workspace 授权绑定（`bindingDigest` 变了会走 `sync()` 重写，`workspace-auto-authorization.ts:139-183`）。每次 Magpie 调价都会让绑定变。
- PR 说明只写了“对缓存的影响”，没有提这个授权面的变化。建议：要么明确声明“Magpie 清单内等同可信”（写进 ADR），要么对非配置模型收窄 `allowedDataClassifications`。

### 3.【中】启动路径新增最长 5 秒的同步网络等待，可能顶到上线启动读回上限
- 证据：`production-magpie-models.ts` `DEFAULT_TIMEOUT_MS = 5000`；`service-main.ts:611-613` 在加载配置后、HTTP 起服务前 `await expandConfigurationWithMagpieModels(...)`，secret resolve 卡住也计入超时。
- 而上线启动稳态记录是 12.0–31.5 秒波动、上限 30 秒（`docs/incidents-and-gates.md` I-28）。Magpie 排队或 secret store 慢时最坏多 5 秒。是不是必踩线属推测，但“把 5 秒上限留给了每次启动”是代码证实的设计。
- 建议：超时收敛到 1–2 秒，或改成后台初次失败即回退、下次再试。

### 4.【低】配置文件可写的 `thinkingLevels` 没有值域校验，且会覆盖内置表的“不支持”标记
- 证据：`configured-model-binding.ts:33-50`：`advertisedThinkingLevelMap` 对不在 levels 里的固定档位都置 `null`，且排在 `MODEL_THINKING_LEVEL_MAPS` 之后（spread 顺序）。内置表把 `deepseek/deepseek-v4.1-flash` 的 `medium` 明确标为 `null`（不支持，23-31 行）；只要配置或清单给了 `thinkingLevels` 含 `medium`，原来的“明确不支持”就变回“支持”，没有任何校验或注释说明这一覆盖语义。对 Magpie 新模型这是本意；对同名 vercel 模型是语义反转。生产数据是否撞名陕西未核实（`group/` 名 vs `deepseek/` 名目前不冲突）。
- 建议：至少加测试固化"显式 thinkingLevels 覆盖内置表”的语义，并约定清单/配置只允许六档值。

### 5.【低】清单档位名只认六个固定值，其他值静默丢失
- 证据：`production-magpie-models.ts` `THINKING_LEVELS` 常量 + `THINKING_LEVELS.filter((level) => levels.includes(level))`。清单若用 `extended` 等档位，直接丢弃，模型显示的档位表与清单不一致且无日志。建议至少记一条 diagnostic。

### 6.【低】文档/事故清单引用缺位
- 证据：`grep "I-73"` 全仓库 0 命中；`docs/incidents-and-gates.md` 里最新编号止于 I-71（第 73/105 行）。
- 建议：这次改动值得的记录点（启动阻塞、授权绑定变化、清单易变语义）没有落进 ADR 0117 或新 ADR；核对材料里的引用在当前检出中不存在。

## 必答问题逐条回答

**1. 会不会改变模型已经见过的请求开头？** 不会。读代码证实：diff 没有触碰任何消息组装路径（`pi-runtime-adapter`、投影、run policy 的系统指令 `HIMAWARI_IDENTITY/runCapabilityNotice` 都不含会变的值，`production-run-policy.ts:64-89`），也未给最后一条消息外的任何位置加每轮值。`thinkingLevels`/价格只影响请求参数和目录展示，不进入已发文本。作者声明“换模型使下轮缓存 0 命中”与代码一致。`npm run check:prompt-prefix` 的 2 条 REVERSE 用例（改写历史用户消息、系统提示带轮变值）在 `packages/runtime-pi/test/prompt-prefix.compat.test.ts:409-435` 证实存在，断言必须报失败：自动检查齐全且反向用例按写法会失败（ Ran 未执行，按断言逻辑判定）。

**2. 同一段文字会不会在不同请求里变成不同字节？** 不会引入新来源。清单只在启动读一次，`prices`/`priceTiers`/`added` 的顺序都来自同一份快照（数组顺序、排序均确定，`priceTiers` 排序无并列歧义时退化成空 map）；遮盖逻辑未触碰。Magpie 跨启动返回乱序也只影响 UI 展示顺序，不影响已发文本。

**3. 有没有对应的自动检查、反向用例会不会真失败？** 新功能自身有较完整的单测（含失败回退、重复 id、空价格、日志码白名单、UI 空态）；prompt-prefix 门槛属 `npm run check`（26 步与 `package.json:27` 清单一致，作者"26 步”说法正确）。缺口（证实）：启动装配 `service-main` 与 `modelCatalogTags` 闭包无任何测试；"重构后多 primary" 行为只被该测试文件的间接覆盖，没有独立回归用例。

**4. 产生的每个值两端口是否对得上？** 逐个核对：
- `magpie:<id>` ref：产生（`descriptorFor`/`prices` 的 key）与消费（`validateModelSelection` 按 `entry.ref`、`production-run-policy.ts:46` 按 descriptor.ref、`ConfiguredPiModelBindingPort.resolve`、UI `AvailableModel.ref`）一致，均无数字格式校验，可以接受。
- `automatic/price/priceTier`：产生于 `modelCatalogTags`（仅对 added 模型给价格档位、仅 `group/` 主模型给 automatic），消费于 `production-http-composition.ts`/`http-gateway-server.ts`/`gateway-client.ts` 类型与 `model-picker.tsx`；定义一致，后端校验仅在 `thinkingLevels` 与 class 上（tags 无副作用）。注意标签只覆盖新添模型，"自动"的主模型永不显示价格——与作者"没有标价沿用保守单价"的说法不抵。
- `thinkingLevels`：跨包三处一致（application port、composition 转发、binding map），但见发现 1/4 的 `reasoningRequired`、内置表覆盖语义问题——这正是“每个使用它的地方都能接受吗"的答案里不及格的部分。
- 多 primary + `baseUrl`：绑定端口新校验要求全部同 provider 同 baseUrl（`configured-model-binding.ts:298-310`），展开保证同 provider/baseUrl，通过；`maxTokens` 被 min 钳制在配置值内，不会超 32768 上限（234 行校验）。

附带：材料里说"必答问题 4 的依据 I-73"，其中 `docs/incidents-and-gates.md#incidents` 锚点存在，但 I-73 这一条在本仓库不存在（止于 I-71）；作者 PR 说明对字段名、26 步检查、"三者降价分档不写死”等说法均与代码一致，未发现与代码相悖的说法；"已在真实浏览器验证”属无法核实的声明。
