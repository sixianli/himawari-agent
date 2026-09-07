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

P0-01 至 P0-04 的交付是验收样本、接入设计、模型与 Memory 配置及本地配置验证。P0-05 已进一步完成真实模型工具协议与 embedding 兼容性验证，P0-06 已实现模型可见的文件读取请求与参数检查。完整流程仍需后续工具授权、Worker 文件适配和浏览器接线；这些行为不能由配置检查或本次协议测试证明。

## 来源上下文

- 系统边界：[SOURCE: docs/architecture-v0.1.md]
- 文件授权与主机边界：[SOURCE: docs/execution/specs/2026-08-26-host-files-code-workspaces-design.md]
- 持久运行与模型边界：[SOURCE: docs/execution/specs/2026-08-26-portable-durable-web-agent-design.md]
- 真实调用授权要求：[SOURCE: docs/execution/plans/2026-08-26-portable-durable-web-agent-plan.md]

## 范围

包含 P0-01 验收合同、P0-02 Pi 复用设计、P0-03 OpenRouter 配置准备、P0-04 embedding 配置依赖准备，以及 Owner 后续要求继续完成的 P0-05 真实兼容性调用。Owner 随后要求继续完成 P0-06，本次增加模型可见的文件读取请求合同与生产暴露；P0-07 及其后的路径解析、授权与 Worker 实施仍待后续完成。

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

P0-07 的路径与主机绑定、P0-08 的读取和披露授权、P0-09 的凭证签发，以及后续 Worker 上的完整 Pi 读取执行仍未完成。P0-05 真实调用证据保持原样，本次不发起付费调用或浏览器验收。

本次修正验证：Pi compatibility 37 项、生产工具 15 项、受治理工具单测 2 项、参考 adapter 合同 43 项、SQLite 能力调用集成 18 项通过。类型、格式、依赖边界、v0.2 合同与不变量、秘密扫描和 CI policy 检查通过。全仓库 lint 仍有既有的 182 errors、977 warnings、712 infos，不能声称 `npm run check` 全部通过。
