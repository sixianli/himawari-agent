---
status: active
document_type: spec
supersedes: ""
superseded_by: ""
date: "2026-09-07"
---

# 真实模型读取 Mac 文件并总结的验收与接入设计

## 目标

Owner 从 ego Lite 提交文件总结请求，由 OpenRouter 的真实 DeepSeek 模型选择工具，经产品授权后由 Mac Worker 读取文件；Pi 将工具结果加入模型上下文，再请求模型生成中文总结，最终结果持久保存并由浏览器回读。

P0-01 至 P0-04 的交付是验收样本、接入设计、模型与 Memory 配置及本地配置验证。P0-05 已进一步完成真实模型工具协议与 embedding 兼容性验证，P0-06 已实现模型可见的文件读取请求与参数检查。P0-07 至 P0-09 的两阶段正式入口、目标解析、逐次授权与凭证签发已接通并经过本地组合及 SQLite 测试。完整流程仍需正式 Mac 安装资格、审批后恢复的产品交互和真实模型、浏览器验收，不能用这些本地测试代替。

## 来源上下文

- 系统边界：[SOURCE: docs/architecture-v0.1.md]
- 文件授权与主机边界：[SOURCE: docs/execution/specs/2026-08-26-host-files-code-workspaces-design.md]
- 持久运行与模型边界：[SOURCE: docs/execution/specs/2026-08-26-portable-durable-web-agent-design.md]
- 真实调用授权要求：[SOURCE: docs/execution/plans/2026-08-26-portable-durable-web-agent-plan.md]

## 范围

包含 P0-01 验收合同、P0-02 Pi 复用设计、P0-03 OpenRouter 配置准备、P0-04 embedding 配置依赖准备，以及 Owner 后续要求继续完成的 P0-05 真实兼容性调用。Owner 随后要求继续完成 P0-06，本次增加模型可见的文件读取请求合同与生产暴露；Owner 已批准联动完成 P0-07 至 P0-09 的 inspect/read 两阶段方案；本轮完成正式工具入口、目标主机程序、逐次授权与凭证签发接线。

配置和验收输入位于 `test/integration/fixtures/file-summary/`，由实际产品解析器和组合代码验证。配置是独立验收候选，不会自动安装或替换现有服务。`publicMode: false` 只适用于当前准备阶段；最终浏览器验收必须补齐正式认证 HTTP 配置，不能以本配置的非公开模式代替认证。

## 验收标准

### P0-01：固定输入和可观察结果

使用本仓库新建的公开合成文件 `test/integration/fixtures/file-summary/project-brief.txt`，不使用 Owner 已有私人文件。执行时由 Mac Worker 将仓库绝对路径与该相对路径组合，记录规范化路径和文件摘要；授权必须绑定 Mac 主机及这个文件，不能授予整个仓库或主目录的读取权限。

浏览器请求为：“请读取我 Mac 上的 `<该文件的绝对路径>`，总结项目目标、已完成事项、待办事项和限制。”请求和系统指令不得提前包含答案。

通过标准必须同时成立：

- 模型返回真实工具调用，参数指向指定文件；不是测试代码预先读文件后将正文放进提示词。
- 权威授权记录和 Mac Worker 执行回执能关联到同一 Run、tool call 和文件；没有权限时拒绝，且不读取正文。
- 工具返回内容的摘要与实际文件相符；持久记录引用 Protected Payload，普通 Trace 不保存文件正文。
- 至少观察到工具调用前、工具结果返回后的两次真实生成请求；第二次确实携带对应工具结果。
- 总结包含项目代号“向日葵-海盐-4827”、整理 37 本书、已录入 25 本、12 本缺标签、先补标签再核对登记，以及不采购新书、不改变借阅规则；不能混淆完成和未完成事项。
- 结果作为助手消息持久保存，刷新 ego Lite 后可回读，重启后不会重复生成助手消息。
- 记录实际模型、供应商、usage、费用和终态。使用 fallback 的结果不能算作指定 DeepSeek 主链路成功。

文件小于 4 KiB。最终实施还需验证不存在、超范围、符号链接逃逸、二进制或过大文件、取消及重启中断；不能把文件内文本当作提高权限的指令。

### P0-02：复用 Pi，保留产品权限边界

核对版本为 `@earendil-works/pi-ai@0.84.2` 与 `@earendil-works/pi-coding-agent@0.84.2`。上游只读参考为相邻 `pi-mono` 的 coding-agent `sdk.ts`、`agent-session.ts`，并以安装包导出的 `sdk.d.ts` 和 `extensions/types.d.ts` 核对实际接口。

| 职责 | 复用或归属 | 接入设计 |
| --- | --- | --- |
| 多轮模型调用、工具调用和结果回送 | Pi `createAgentSession` / `AgentSession` | 沿用 runtime-pi 的 `customTools`，不新写循环 |
| 工具参数、结果和取消 | Pi `ToolDefinition.execute(toolCallId, params, signal, onUpdate, ctx)` | 参数使用产品 schema；正文通过 `content` 返回，执行引用通过 `details` 返回 |
| OpenRouter 模型注册与传输 | Pi ModelRuntime 与现有 ConfiguredPiModelBindingPort | 精确模型配置由产品转换，只在 runtime-pi 导入 Pi 包 |
| Owner、Run、主机和文件权限 | Himawari | 模型只能请求操作，不能签发 Capability Handle；执行前验证权威、租约、路径和披露权限 |
| 本机文件读取 | Himawari HostFileReadService 和 Mac Worker | Worker 执行已授权读操作，服务端不通过 Pi 内置 read 或 bash 绕过 Worker |
| 工具结果保存、审计和恢复 | Himawari | Protected Payload 保存内容，Trace 保存引用；不确定结果先协调，不盲目重放 |
| embedding 与向量检索 | 现有 Mem0 adapter | 复用 Mem0 OpenAI-compatible embedder，Pi 不承担 embedding |

当前 runtime-pi 已设置 `noTools: "all"` 并只启用产品给出的工具；已有 `preflight → execute → modelContent` 转换和不确定结果取消机制，应保留。

P0-06 按已确认的 Pi 复用方案提供无 Handle 的 `read`，并保留原有基于 Handle 的 `authorized_*` 工具。`read` 的名称、schema 和提示元数据来自 Pi 工具工厂，参数为 `path`、可选 `offset/limit`；生产 Run policy 仍不会从用户请求签发权限，后续需要将请求转为经过验证的动作、受保护输入和范围受限 Handle，再沿现有 Worker 执行路径返回结果。

这是后续产品工具接口调整的设计依据，影响 application 的工具请求/授权接口、agent-service 的生产组合和 execution-worker 的文件处理接线；收益是让模型可选择文件工具，同时让授权和执行留在统一产品边界内。P0-06 仅完成无 Handle 请求的类型表达、Pi 工具定义复用与产品检查接入；不启用 Pi 默认本机文件 I/O 或 Shell 工具。

### P0-03：真实 OpenRouter 配置准备

`configuration.json` 是独立候选；`catalog-observation.json` 保存 2026-09-07 无认证读取公开 endpoint 目录得到的身份、价格、容量和参数字段，排除时刻波动的健康统计。`catalog-2026-09-07` 是本地观察标识，不是供应商不可变模型版本。

| 角色 | 模型与路由 | 输入 / 输出 / 缓存读取价格，美元每百万 token |
| --- | --- | --- |
| primary | `deepseek/deepseek-v4-flash-0731`，`deepinfra/fp8` | 0.06 / 0.18 / 0.015 |
| fallback | `z-ai/glm-5.3-flash`，`z-ai/fp8`，仅 private | 0.075 / 0.25 / 0.015 |
| embedding | `qwen/qwen3-embedding-8b`，现有 Mem0 默认供应商选择 | 输入预算估价 0.04，输出 0 |

两种生成模型都设置 `allow_fallbacks: false`、`require_parameters: true`、`data_collection: deny`。公开目录不能证明这些参数组合在真实账户上有可用端点，P0-05 必须通过实际请求确认；失败时不能静默放宽路由或数据条件。

生成上下文容量采用所选端点的 1,048,576 token，候选输出配置为 2,048 token。Pi 模型绑定已可离线注册；实际请求是否携带对应输出限制仍需 P0-05 检查。Run、Worker、provider 请求时限分别为 300 秒、30 秒、120 秒。

凭据引用是 `openrouter-api-key@v1`，用途 `model-provider-auth`。Mac Keychain account 为 `himawari-agent`，service 为 `himawari-provider.openrouter-api-key.v1`。2026-09-07 只查询到该条目的元数据存在，未读取值、修改条目或验证账户余额。凭据不得写入候选、源码、Trace 或浏览器。

候选共享总预算与单 Run 预算均为 1 美元，sensitive/restricted 为 0。这是产品估算账本的限制，不是 OpenRouter 账户消费硬上限。按当前完整上下文预留公式，单次 primary 为 63,284 微美元，fallback 为 79,156 微美元；embedding 最大输入预留为 656 微美元。两次较贵生成加一次 embedding 合计 158,968 微美元，小于 1 美元；这是容量预留，不是小文件场景的预计账单。

小文件样本预计成本低于 0.01 美元，但真实 usage、模型推理 token、重试及供应商价格变化必须在调用阶段核验。首次付费调用前需确认复用上述 Keychain 条目、公开样本向 OpenRouter 披露及最多 1 美元的测试总预算。未获得该具体授权时不发起推理请求，也不把配置值当成费用授权。

### P0-04：embedding 前置依赖

当前生产 Context 获取会先执行 Memory 搜索，因此不能只配置生成模型。候选包含 embedding descriptor、对应 secret reference、Mem0 `3.1.7` 和 4096 维向量存储，采用独立 `/tmp/hma-file-loop/data/memory`。开始验收必须创建专用、Owner 所有且权限受限的状态目录；如该路径已被占用，不能复用未知数据。该目录是短期验收位置，不是长期生产数据目录。

Mem0 adapter 将模型映射到 `https://openrouter.ai/api/v1`、`qwen/qwen3-embedding-8b` 和 `embeddingDims: 4096`；向量存储维数必须一致。现有 `production-run-memory` 将 embedding 的实际 SDK 请求接入 Run 的租约、分类、deadline 和预算。

`maxSelectedMemories: 0` 保证本场景不把旧 Memory 注入模型，但不声称关闭 embedding 搜索或后台消费者。使用全新独立状态避免混入历史私人数据。现有 Mem0 embedding 不支持候选中的生成路由参数传递，所以按公开目录最高输入价格 0.04 估算；不能宣称 embedding 也固定到 DeepInfra 或继承生成请求的 `data_collection: deny`。

本场景只授权候选公开样本。Mem0 的后台 LLM 调用同样不能被当成 Pi 路由策略已覆盖；实际验收需观察全部出站请求，将任何额外生成或 embedding 计入同一预算，无法识别的请求使验收失败。

## 错误处理

缺失凭据、无匹配 provider、维数不一致、预算不足和超时必须产生可识别失败；不能退回 mock 或跳过真实依赖后报告成功。公开模型目录无法替代认证请求成功和有效向量的证据。

文件授权缺失或用户拒绝时，不读文件、不向模型披露正文。Worker 超时或执行结果不确定时保留可恢复状态，禁止将未知结果伪装成空文件成功。

## 验证策略

本次本地检查覆盖：严格产品配置解析、真实 Pi 模型离线注册且不解析凭据、生成与 embedding 共享凭据引用及预算容量、向量维数不一致拒绝、样本独特事实没有提前放入系统指令，以及生产 Mem0 配置转换。

P0-05 验证真实账户鉴权、工具参数兼容性、实际输出限制、provider 路由与 4096 维 embedding；后续完整验收必须满足上述浏览器、授权、Mac Worker、两轮模型、持久回读全部条件。当前架构图中的缺失连线保持不变，协议验证不代表这些产品功能已完成。

### P0-05：2026-09-07 真实兼容性结果

Owner 在 P0-01 至 P0-04 交付后明确要求继续完成 P0-05。本次沿用已列明的 Keychain 条目、公开合成文件、指定模型路由和最多 1 美元范围，没有修改账户权限或凭据。结果保存在 `test/integration/qualification/evidence/p005-file-summary-live.json`，包含候选配置摘要、测试源文件摘要、成功结果和此前失败记录。

最后一轮完整测试通过，发出 5 次真实推理请求：

| 验证对象 | 实际结果 | 本轮供应商返回的费用，美元 |
| --- | --- | --- |
| DeepSeek 工具请求 | DeepInfra 返回 `read_public_fixture`，参数为指定公开文件，终态为 `toolUse` | 0.00004530 |
| DeepSeek 工具结果与总结 | 第二次请求包含相同 tool call ID 和完整工具正文，终态为 `stop`；总结正确保留代号、37/25/12、待办顺序和两条限制 | 0.00007038 |
| GLM 固定候选 | Z.AI 返回预期文本；单独验证候选可调用，不代表 ModelRouter 自动切换已验收 | 0.00001060 |
| Qwen embedding 写入 | 返回 4096 个有限数值，存入 Mem0 的独立测试数据库 | 0.00000134 |
| Qwen embedding 搜索 | 返回 4096 个有限数值，并命中刚写入的公开样本 | 0.00000005 |

生成请求均实际携带 2,048 token 输出上限和候选中限定的 provider 参数。Pi 的 `ModelRuntime.completeSimple` 负责 OpenRouter 请求、流解析、工具消息序列化与 usage；测试只进行两步固定协议交换，不新增产品 Agent loop。文件由测试夹具在模型返回工具调用之后读取，没有提前放入首轮提示词；本次不经过生产 Mac Worker、正式授权服务、持久 Run 或浏览器。

本轮成功测试费用为 0.00012767 美元。包括此前已有计费结果的请求，本次全部已返回费用合计为 0.00017004 美元。共记录 10 次请求尝试，其中 8 次取得 HTTP 200；另有一次 429 和一次本地传输失败未取得计费记录。保留所有失败预留后的累计预算占用为 335,572 微美元，未超过 1 美元。预留不等于实际扣费。

此前失败也保留在证据中：

- 首次 DeepSeek 工具调用成功，但立即查询 generation 元数据返回 404；稍后对同一个 ID 查询成功。测试改为完成推理后读取元数据，仅对元数据的 404 做有限重试，不因此重发推理请求。元数据接口依据 [OpenRouter 官方接口说明](https://openrouter.ai/docs/api/api-reference/generations/get-generation)。
- 第二次生成请求收到 HTTP 429，未进入工具执行；没有放宽 provider 或数据条件。
- 首次 embedding 测试夹具混用了 fetch 实现，触发本地 `content-length` 校验错误；修正为保留 Mem0 OpenAI v4 自带的 Node fetch，并在外层检查请求和预算。
- 随后的 embedding 已返回有效向量和检索结果，但旧断言错误地要求固定 3 次调用。已核对 Mem0 `3.1.7` 的实体检索分支：额外调用取决于查询实体。本次中文查询用 2 次；验收改为验证写入、搜索、维数和命中，同时保留最多 3 次上限。

真实入口复用已有的 `qualification-generation-live` 项目，新增用例通过 `HIMAWARI_FILE_SUMMARY_LIVE=1` 显式启用；普通 CI 默认不调用真实服务。测试夹具支持 `HIMAWARI_FILE_SUMMARY_PHASE` 为 `all`、`generation` 或 `embedding`；分阶段成功只证明该阶段。`HIMAWARI_FILE_SUMMARY_PRIOR_RESERVATION_MICROS` 用于把本次此前尝试的预留带入下一次测试，不能清零后继续消费已耗用的授权预算。证据路径通过 `HIMAWARI_FILE_SUMMARY_EVIDENCE_PATH` 显式传入。新的付费执行仍须遵守对应具体授权范围，不能将历史通过结果当成持续授权。

### P0-06：复用 Pi 的文件读取工具

本节采用已确认的 Pi 复用路径，替换此前独立的 `request_file_read` 接口。工具参数和读取语义由 Pi 提供；授权、目标主机、Worker 调度和持久化由产品负责，不因需要这些约束就另建同用途工具。

- [x] 产品通过 `definition: "builtin-read"` 选择内置工具，名称为 `read`，`capabilityHandleRef: null` 表达未授权请求，不保存另一份描述和参数 schema。
- [x] runtime-pi 使用 `createGovernedPiCodingTools()` 和 `createPiOperationsFromGovernedHostPort()` 构造工具定义，复用 Pi 0.84.2 的 `path`、可选 `offset/limit` 参数及提示元数据；原有自定义工具接口保持可用。
- [x] 移除独立文件请求 schema、验证器及旧参数测试。schema 验证复用 Pi；模型生成的任何参数都不产生执行权限。
- [x] Agent Service 只复用工具定义，并用产品 `preflight → execute` 替换执行入口，保留 Run、tool call、deadline、分类、撤销与不确定结果处理。底层 Operations 显式拒绝 Agent Service 本机 I/O，不回退到默认文件操作。
- [x] 当前生产 preflight 对已向 Run 暴露的文件请求返回 `FILE_READ_AUTHORIZATION_UNAVAILABLE`；未暴露或能力类型不符返回 `FILE_READ_REQUEST_INVALID`。直接绕过 preflight 调用 execute 同样拒绝，无 Worker 派发。
- [x] 兼容测试核对实际 schema 与 Pi 工厂一致，复用 Pi 参数验证，验证允许和拒绝分支均不触发 Agent Service 的文件访问；允许分支用受控产品结果验证原始参数与调用身份传递，不作为生产授权或文件读取证据。

#### 执行所在主机与读取限制

已核对固定安装版本和只读 pi-mono 源码：Pi `read.execute()` 在调用 `ReadOperations.access/readFile` 前执行 `resolveReadPathAsync()`，其中会探测当前主机的路径存在性，并尝试 Unicode 路径变体。因此不能仅替换 Operations 就在 Agent Service 执行该函数。P0-06 的产品执行入口不调用它；后续真实读取须在已绑定的目标 Worker 上组合 Pi 工具与受约束 Operations，并将主机、原始路径和解析结果一并纳入授权检查。

模型不再传 `hostRef` 或 `maximumBytes`。本次单 Mac 场景的目标主机与授权目录由受信任产品上下文绑定，无法确定时不得猜测；实际绑定属于 P0-07。文件读取上限由服务端策略和 Worker 强制执行，不由模型扩大。首个验收场景限定 UTF-8 普通文本，Pi 原生的图片支持不代表当前产品已批准图片披露。

Pi 原生 `read` 支持按行 `offset/limit` 和带标识的输出截断，默认输出上限为 2000 行或 50 KiB；产品不再维护另一套“64 KiB 整文件读取”模型侧接口。实际文件读取上限与模型输出上限是两项不同约束：前者由后续授权和 Worker 执行策略实施，后者复用 Pi；部分读取必须保留范围和截断信息，不能声称是全文。TUI renderer 不用于产品浏览器，产品结果引用继续由自己的 UI 呈现。

P0-07 至 P0-09 现已使用下节所述的两阶段流程：模型侧仍复用同一个 Pi read 定义，目标主机程序复用 Pi read 执行器及受约束 Operations。正式主机资格与浏览器验收继续单独保留为未完成项。P0-05 真实调用证据保持原样，本次不发起付费调用或浏览器验收。

P0-06 修正阶段的验证：Pi compatibility 37 项、生产工具 15 项、受治理工具单测 2 项、参考 adapter 合同 43 项、SQLite 能力调用集成 18 项通过。类型、格式、依赖边界、v0.2 合同与不变量、秘密扫描和 CI policy 检查通过。全仓库 lint 仍有既有的 182 errors、977 warnings、712 infos，不能声称 `npm run check` 全部通过。


### P0-07：目标主机上的文件对象解析

`HostFileReadService.resolveTarget()` 接受产品选定的 `hostId`、`grantId`、`maximumBytes` 和 Pi 原始 `path`，返回只读 `ResolvedHostFileReadTarget`。主机、目录授权和大小上限不能由模型自行提供或扩大；调用方必须在对应主机组合该服务和真实平台适配器。正式 read 请求已通过现有 work.execute 路由到指定 Worker 的受隔离程序；以下组件检查和下节正式入口检查共同构成 P0-07 的代码完成证据。

- [x] 请求主机必须匹配服务主机，目录 Grant 必须存在、身份一致、具有 read 操作、未撤销、未过期，并要求同文件系统且不允许链接的路径策略。
- [x] 相对路径以选定目录为根；绝对路径必须以完整目录边界为前缀，不能将相邻同名前缀目录视为授权范围。复用 `normalizeRelativePath()` 拒绝空路径分量、`.` 和 `..`；不展开 `~`、`@`、反斜杠或控制字符。
- [x] 复用 `ConstrainedHostFileSystem.inspect()` 检查目录身份和路径链、符号链接、硬链接及跨设备对象，随后检查普通文件类型和文件字节数。解析时不调用 `read()` 或披露端口。
- [x] 结果记录主机、Grant ID/版本/授权引用、根目录身份、原始与相对路径、文件 device/inode/mode/size/mtime、大小上限及观察时间；记录和文件身份均冻结。
- [x] 文件检查后重新读取 Grant，拒绝检查期间的撤销、过期、版本或根目录变更。
- [x] 将正式工具调用路由到指定 Worker 的解析程序，并将结果交给逐次授权及独立 read 凭证签发流程；实际平台安装资格仍单独验收。

| 结果 | 稳定错误 |
| --- | --- |
| 非法路径、空路径分量、遍历表达式 | `HOST_PATH_UNSAFE` |
| 目录范围外、符号链接或跨设备路径 | `HOST_PATH_ESCAPE_BLOCKED` |
| 硬链接文件 | `HOST_LINK_ESCAPE_BLOCKED` |
| 文件或中间目录不存在 | `HOST_FILE_TARGET_MISSING` |
| 根目录身份被替换 | `HOST_ROOT_IDENTITY_CHANGED` |
| 目标不是普通文件 | `HOST_FILE_NOT_REGULAR` |
| 文件超过服务端读取上限 | `HOST_FILE_READ_LIMIT_EXCEEDED` |

主机或 Grant 不可用使用现有 `NOT_AUTHORITATIVE` 应用错误，非法字节上限使用 `INVALID_OPERATION`。文本编码与机器秘密检查属于实际读取和结果披露阶段，不能根据文件元数据判断。

此结果是解析时的元数据观察，不是权限凭证，也没有锁定文件。解析后文件、目录或授权仍可能变化，后续 Worker 必须在实际打开资源时重新核验身份与权限；本次测试不证明已消除打开时的所有竞态，也不替代目标平台隔离资格。Pi 工具定义和 Operations 适配路径保持 P0-06 的实现，不新增模型侧文件工具。

P0-07 最初解析组件的验证：受约束文件系统与目标解析测试 30 项通过，覆盖真实临时目录、文件、符号链接、硬链接、授权变更和目录替换。类型、格式、修改文件 lint、依赖边界、v0.2 合同与不变量、秘密扫描、CI policy 和文档严格校验通过；全仓库 lint 仍为既有 182 errors、977 warnings、712 infos。

### P0-07 至 P0-09：已确认并实施的两阶段接线

#### 当前断点与选择

实施前，`service-main.ts` 创建的 `ProductionRuntimeTools` 只有已有 Handle 的消费与派发接口，无 Handle 的 read 请求被固定拒绝。`ExecutionWorkerService.execute()` 在能力执行前必须获取、验证并消费 Handle，现有 Worker 通道不接受未授权的目标解析。`HostFileReadService.resolveTarget()` 又必须在目标主机执行，不能放到 Agent Service 旁路检查。

若正文读取凭证需要绑定目标主机观察到的文件身份，就必须先安排受授权的目标解析。现按 Owner 已批准方案复用现有 `work.execute` 通道，将同一个模型 read 调用拆为内部 inspect 与 read 两阶段；不新增无需凭证的元数据 RPC，不增加模型侧工具。另一种单阶段方案是在目录范围授权后让 Worker 一次完成解析与读取，内部状态更少，但不能在签发正文读取凭证前让服务端检查本次目标身份；本提案选择前者以保持原清单要求的先解析、再授权和签发顺序。Owner 已明确批准这一重构范围；当前代码已按此方案接通。

#### 完整调用过程

1. Agent Service 从受信任产品状态选择目标主机与目录 Grant，检查当前 Owner/Agent/Thread/Run、Run 租约和目录范围。配置、模型参数、Pi cwd 或目录存在本身均不构成授权。
2. 将原始 path、目录 Grant ID/版本、目标主机和检查上限保存为 Protected Payload；依据有效目录授权签发仅限此次 inputRef 的短期 inspect Handle。该操作只允许读取文件元数据，不能返回正文，也不把元数据直接披露给模型。没有相应目录范围授权时先拒绝或进入已有审批设施，不先探测文件。
3. 目标 Worker 在现有执行准入边界后调用 resolveTarget；保存受保护的元数据结果与执行回执。Agent Service 从结果通道接收，并验证来源主机、输入身份、Grant 版本及当前权威状态。
4. 服务端根据确定目标分别评估正文读取和向当前模型披露的权限。ALLOW 才继续；ASK 持久保存待批准请求；DENY、过期或撤销明确停止。不得用 inspect 凭证替代 read 权限。
5. 将目标身份、目录 Grant 版本、原始路径、Pi offset/limit 和服务端读取上限保存为新的 Protected Payload，签发独立的单次 read Handle。即使底层 Capability 共用一个声明，两个操作和输入引用也必须严格分离。
6. 目标 Worker 执行前再次核对 Grant、目录链与目标身份；同名替换、Grant 变化或不确定状态均不得自动扩大范围或改读其他文件。真实读取复用 Pi 工具及受约束 Operations，仍须满足平台隔离要求，不能伪造 Mac helper 或能力资格。
7. 读取结果经过分类、秘密排除、保护存储及披露再检查后，作为原模型工具调用的结果返回 Pi。后续正文处理与真实平台验证分别属于 P0-11 至 P0-14。

#### 影响范围和实施要求

- application：动态文件调用的持久状态、目标解析输入/输出、权限决定与 Handle 签发组合；复用现有 Directory Grant、授权服务、Payload 和 Capability Handle。
- agent-service：替换无 Handle read 的固定拒绝分支，接入受信任主机/目录选择、两阶段派发、权限判断和恢复；已有 authorized_* 路径保持原语义。
- Worker 仍使用通用 program runtime、执行准入、Payload broker 和已合格隔离后端。文件程序组合入口位于 `apps/agent-service/src/capability-programs/host-file-read-main.ts`，由 Worker 启动独立受隔离子进程；Agent Service 的服务入口不导入或执行该程序。这样保留 execution-worker 不依赖 runtime-pi 的现有依赖边界，也不增加平台包对 Pi 的依赖。程序的 hostId 与 workerInstanceId 来自能力部署的固定 argv，必须与受保护输入相符。
- 持久化：同一 Run/toolCallId 下的两个阶段分别有不可变 inputRef、调用幂等键和结果引用；进程重启读回已确认阶段，未确认的执行进入 reconciliation，不能重复消费或默默换文件。
- 资源与取消：两个阶段共享 Run deadline 和预算，分别有更小的 Worker 限额；取消、租约丢失、授权撤销后不进入下一阶段。

本地代码、组合及确定性集成测试已完成；正式安装候选与实际平台资格仍需后续验收。真实目录授权写入、生产运行变更及付费模型调用仍按各自具体授权边界执行。

#### 必须提供的验证证据

- 从 ProductionRuntimeTools 的真实 read 入口观察到 inspect/read 两个合法请求，保持一个原始 toolCallId；测试不能直接调用独立解析函数替代入口接线。
- 无目录授权时 Worker 未收到 inspect；仅有 inspect 权限不能读正文；未获模型披露权限不把正文交给 Pi。
- 目标主机、Grant 版本、文件身份、输入引用或操作不匹配时拒绝；metadata inspect 和 read 之间替换文件必须失败。
- 中途取消、崩溃恢复、重复工具调用、审批过期和结果未知分别有可观察结果，已确认阶段不重复执行。
- 本地受控测试与真实 Mac Worker 资格、OpenRouter 请求、ego Lite 验收分开记录，后者不因组合测试通过而勾选。


#### 配置与持久化合同

正式组合使用可选的 `runPolicy.fileRead` 选择路由。例如以下字段仅用于解释配置形状，不能直接作为生产授权：

```json
{
  "hostId": "mac:acceptance",
  "workerInstanceId": "execution-worker:acceptance",
  "grantId": "directory:acceptance",
  "capabilityRef": "host-file:acceptance",
  "capabilityVersion": "1.0.0",
  "maximumBytes": 4096
}
```

`maximumBytes` 必须为 1–49152 的整数。缺少路由、目录记录、匹配的 Thread 来源、有效 Run 执行租约或配置中的模型，均不派发文件检查。目录 Grant 通过同时限定 Owner 和 Agent 的 `readScopedState()` 读取现有 `host-workspace:directory-grant:<id>` 状态键，不能通过全局键读到其他身份的目录记录；模型身份包含 provider、model、配置版本和路由摘要。配置解析不创建目录 Grant、动作授权、Capability Registry 或平台资格。

能力 Manifest 必须声明 `inspect/read/disclose`；其中 disclose 只用于服务端授权，不派发为文件程序操作。program 的固定 argv 指向安装产物 `@himawari-agent/agent-service/dist/capability-programs/host-file-read-main.js`，并附带目标 hostId 和 workerInstanceId，stdin/stdout 使用受保护 Payload 通道。只有通过现有不可变部署快照、实际隔离与平台资格验证后，该程序才能由正式 Worker 启动。打包包含程序源码不等于已完成这些安装条件。

同一 Run/toolCallId 的上下文、inspect/read 输入与 Handle 引用存于受保护 Run trace artifacts；每个阶段另有不可变执行 intent、单次调用回执和结果。读取结果保存在受保护存储中，普通日志不写正文。进程恢复必须保持原调用语义和有效权威；已确认阶段不再派发，缺少结果的已派发阶段返回 `result_unknown`。目录、模型、调用参数或 authority 改变时拒绝自动续接；P0-10 的受保护恢复允许更换当前执行租约，不能通过重新签发凭证改读目标。ASK 复用持久审批记录，已确认 inspect 阶段不会因批准重试而重复派发；P0-10 将 ASK 接为非终态暂停，正式浏览器验收仍单独记录。

实际打开文件时，`ConstrainedHostFileSystem.read()` 对文件描述符的 device/inode、canonical path、mode、链接数、size 和 mtime 再核验，读取前后核对父目录链，循环处理短读，并在返回前确认对象和内容元数据未变化。文件程序在全文读取后验证 UTF-8、排除 NUL 和机器秘密，再交由 Pi 处理行范围与截断提示。此保护不宣称能防止具备主机管理权限的对手伪造全部文件元数据；真实隔离资格仍必须单独提供。

Run 状态转换与 Thread 版本及持久事件在同一事务提交，使浏览器可及时刷新等待、恢复和取消状态。审批等待也受原 Run 总期限限制；到达总期限时调度器领取并终止请求，不等待更晚的审批过期时间。

### P0-10：通用 HITL 持久执行与恢复

Owner 已确认通用 durable agent execution / suspend-resume 状态机为本次目标并授权实施。文件读取是首个生产接入场景，后续删除、Shell、邮件和高风险 MCP 应只补动作定义、授权策略与执行/核查适配，不各自创建暂停和恢复流程。[SOURCE: docs/adr/0023-durable-hitl-execution.md]

#### 状态与职责

| 层次 | 权威记录与行为 |
| --- | --- |
| 动作授权 | `GovernedActionIntent`、`ApprovalRequest` 与 Grant；ASK 通过 `runtimeToolAuthorizationResult()` 转为通用等待结果，批准前没有模型可见的最终工具结果 |
| Runtime 暂停 | `RuntimeContinuationService` 保存受保护记录，`runtime.suspended` 事件只携带引用及审批 ID、语义摘要、失效时间 |
| Run 状态 | `running → awaiting_approval → running`；拒绝或过期在条件允许时作为工具失败结果返回 Pi，Run 可以继续说明情况；取消 Run 后不再执行 |
| 恢复调度 | 持久审批决定或失效时间使请求可调度；竞争新租约后恢复，重复通知不直接派发动作，等待不占用运行槽位 |
| 工具执行 | 复用既有执行意图、单次 Handle、Worker 回执及受保护结果；已确认阶段回读，已派发但无法确认结果的阶段进入核查 |

通用机制不含路径、目录或 read 专用状态。文件工作流在自己的适配层验证主机、目录版本、文件身份、读取与模型披露；这些校验不会因恢复而跳过。

#### Pi 恢复适配

复用固定版本 `pi-coding-agent@0.84.2` 的 AgentSession、工具定义与 Agent loop。暂停时保存完整的原 assistant 工具批次、此前消息、受信任系统提示、待审批调用 ID，以及模型调用、消息和轮次序号。随后结束本次内存执行并释放执行租约；保留同一逻辑工具调用，不要求保留同一个 Promise 或 Session 实例。

恢复时，新 Session 载入保存的上下文，通过本地历史回放把原 assistant 消息交给 Pi 的工具执行器，再由 `agent.continue()` 完成原批次和后续 Agent loop。已确认阶段由产品账本回读；暂停时的本地 abort/error 不进入下一次模型请求。回放不触发 Provider、预算准入或计费，下一次真实请求从保存的 ordinal 后继续。恢复事件以 `agent_end` 确认已等待完成的原生 Agent continuation，不依赖只在 `AgentSession.prompt()` 路径产生的 `agent_settled`。

#### 不变量、期限与迁移

- 恢复记录只能从当前 Owner/Agent/Run 的活跃受保护 artifact 读取，并受当前执行租约及 Run 状态检查。产品身份、Thread、模型、上下文、预算、总期限与部署权威不能改变；只允许新的执行尝试身份和租约。
- Pi 模型描述、工具定义、授权资源、系统配置或运行目录变化时拒绝自动恢复。文件适配额外要求原目录、目标和 Worker 绑定不变，当前授权仍有效。
- `deadlines.runMs` 是任务总墙钟期限，等待审批不延长它；`providerRequestMs`、`workerRequestMs` 分别限制实际请求，审批另有 `expiresAt`。总期限耗尽后不得为解释失败而继续付费调用模型。等待本身不占 Worker，也不新增模型调用费用。
- 审批批准只使恢复成为可能，不代替执行前授权。拒绝、撤销和过期仍由原策略服务判断。页面将过期的 pending 请求显示为 expired，保留 `decidedAt: null`，不伪造 Owner 决定。
- `awaiting_approval` checkpoint 带版本化 suspension；SQLite migration 0026 保留原 checkpoint 与 Worker 结果。没有完整暂停记录的旧状态不推断为可恢复，已终结 Run 不复活，中断的 `runtime_running` 继续核查。
- `runtime-tool-intent/result` 仍防止已派发阶段被盲目重做；文件工具恢复只放开经过保护记录验证的执行租约更新，不放开动作语义更新。旧格式执行指纹不相符时明确拒绝，不静默重派。
- 同一 Thread 已有“等待审批不阻塞后续独立 Run”的调度合同保持不变；原 Run 使用自己冻结的上下文恢复，不把后续消息误当作其新指令。

#### 正式入口与验收边界

生产 HTTP 组合已接入已有治理服务中的 `approval.list/detail/respond`，复用认证会话、CSRF、Owner/Agent 与权威版本校验、幂等命令回执和 ApprovalService。其他尚未组合的治理操作保持不可用，不构造假的平台资格。控制中心可从等待中的 Run 查找并打开其对应 pending 审批，继续复用现有审批详情与决定操作。

本次本地验证已覆盖文件读取以及受控副作用工具的批准、拒绝、结果未知，多工具批次与重复阶段结果回读，重复暂停、终态不重跑、取消、受保护记录作用域、SQLite 重开、新租约竞争、迁移保留数据，以及正式认证 HTTP 的 CSRF、权威与重复批准。受控模型、传输及本地数据库测试分别记录，不据此声明真实 Mac Worker 隔离、OpenRouter 和 ego Lite 的完整验收已经完成。

#### 本轮完成情况与验证边界

- [x] P0-07：正式 read → 目标 Worker 的 inspect → 确定文件身份；覆盖越界、链接、缺失、非普通文件、大小上限和目标替换。
- [x] P0-08：当前 Owner/Agent/Thread/Run/toolCall、执行租约、文件身份与当前模型分别纳入读取和披露授权；ALLOW、ASK、DENY 有明确分支，配置或模型参数不提供权限。
- [x] P0-09：从本次请求保存受保护输入，按阶段签发独立单次 Handle，复用正式 Worker 调用回执和结果持久化；验证数据库关闭重开后回读已确认结果且两个 Handle 各消费一次。
- [ ] P0-10：通用暂停恢复、正式审批 API 与 Thread 入口已接线；本地回归已通过，完成标记仍需正式浏览器验收证据。
- [ ] P0-11 至 P0-14：虽然目标文件程序和 Pi 读取适配组件已补入，实际 Mac 部署资格、真实模型续接总结及其完整结果验收仍未完成。

组合测试使用真实临时文件、真实 ActionPolicyService/ApprovalService/CapabilityHandleService 和 Pi read；Worker 传输使用受控测试适配器。SQLite 集成另通过公开 Repository 接口验证两阶段输入、凭证、回执和结果的数据库重开。该测试发现并修复了 `capabilityInvocationResult.*` 未注册到 SQLite 分发器的缺陷；原来仅直接测试底层结果操作无法发现这一正式调用断点。

本轮未运行付费模型请求、未写入真实目录或模型披露授权，也未进行 ego Lite 或正式 Mac helper 验收。这些结论不能因组件测试、类型检查或构建成功而更改。


P007–P009 验证结果：服务与 Pi compatibility 回归共 192 项通过，其中 P007–P009 组合专项为 32 项；SQLite 能力调用集成 21 项通过，受约束文件系统 32 项通过。`npm run typecheck`、`npm run build:node`、依赖边界、v0.2 覆盖与不变量、秘密扫描、CI policy 和修改文件 lint 通过。构建产物的独立子进程冒烟验证了 inspect、Pi 行范围、主机不匹配拒绝与检查后替换文件拒绝；这不是合格隔离后端中的正式 Worker 安装验收。全仓库 `npm run check` 仍因既有 182 errors、977 warnings 的 lint 基线失败，不能标为全部通过。


P010 通用 HITL 本地验证（2026-09-07）：

- `vitest` 的 integration、node-services、browser 定向回归：14 个文件、176 项通过。覆盖受保护恢复记录、协调器重复暂停、取消与原截止时间终止、SQLite 重开与审批领取、正式认证 HTTP、两阶段文件读取、Thread 状态事件及控制中心客户端。
- 完整 `pi-compat` 项目：4 个文件、41 项通过。新增受控副作用工具的批准、拒绝、结果未知与原批次恢复测试，使用固定版本真实 Pi AgentSession 和受控模型流；没有调用真实外部模型或发送邮件。
- `npm run typecheck`、Node 与浏览器构建、修改文件格式及 lint、依赖边界、v0.2 覆盖与不变量、机器秘密扫描、CI policy 通过。
- `npm run check` 的全仓库格式检查通过，随后仍在既有 lint 基线失败：182 errors、977 warnings；不将此总命令标记通过。
- 安装、备份恢复、权威迁移三个 Runbook 已按新的暂停状态、总期限与权威绑定核对语义，再更新合同摘要。此项为静态文档核对，不是执行安装、恢复或迁移。

最终差异复查又补充了执行尝试隔离：同一 Run/toolCall 的持久语义允许在新租约下恢复，但仍在运行的 Promise 不允许跨租约共享。新增并发回归与已有 ProductionRuntimeTools、文件工作流共 49 项通过；此数量与上述文件回归有重叠，不相加为独立测试总数。
