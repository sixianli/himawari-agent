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

本次 P0-01 至 P0-04 的交付是验收样本、接入设计、模型与 Memory 配置及本地配置验证。完整流程仍需后续工具授权、Worker 文件适配和浏览器接线；这些行为不能由本次配置检查证明。

## 来源上下文

- 系统边界：[SOURCE: docs/architecture-v0.1.md]
- 文件授权与主机边界：[SOURCE: docs/execution/specs/2026-08-26-host-files-code-workspaces-design.md]
- 持久运行与模型边界：[SOURCE: docs/execution/specs/2026-08-26-portable-durable-web-agent-design.md]
- 真实调用授权要求：[SOURCE: docs/execution/plans/2026-08-26-portable-durable-web-agent-plan.md]

## 范围

包含 P0-01 验收合同、P0-02 Pi 复用设计、P0-03 OpenRouter 配置准备、P0-04 embedding 配置依赖准备。P0-05 的真实兼容性调用及其后的产品实施不在本次范围内。

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

真正缺失的是动态请求的产品入口：当前生产工具依赖预先存在的 handle，参数只能选择现有 inputRef；生产 Run policy 不会从用户请求签发权限。后续需要产品自有的文件读取请求 schema，将 `{hostRef, path}` 转为经过验证的动作、受保护输入和范围受限 handle，然后沿现有 Worker 执行路径返回结果。

这是后续产品工具接口调整的设计依据，影响 application 的工具请求/授权接口、agent-service 的生产组合和 execution-worker 的文件处理接线；收益是让模型可选择文件工具，同时让授权和执行留在统一产品边界内。本次不实施该接口调整，不提前开放 Pi 内置文件或 Shell 工具。

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

后续 P0-05 验证真实账户鉴权、工具参数兼容性、实际输出限制、provider 路由与 4096 维 embedding；后续完整验收必须满足上述浏览器、授权、Mac Worker、两轮模型、持久回读全部条件。当前架构图中的缺失连线保持不变，配置准备不代表这些功能已完成。
