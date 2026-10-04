---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-10-04"
---

# ADR 0048：模型网关从 OpenRouter 换成 Vercel AI Gateway

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [已验证的事实](#verified)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

模型网关是一个统一入口：产品只对接它一家，就能调用多家厂商的模型，并在同一处管理密钥、计费和用量。Himawari 目前的生成模型和 Memory（长期记忆）用的嵌入模型都经过 OpenRouter（一家模型网关服务）。具体做法见[架构文档](../architecture-v0.1.md)里 Task 20 的模型路径说明：Pi（Himawari 依赖的上游 Agent 框架）的 `openai-completions` 接口负责发请求，Himawari 负责预算、密钥句柄和 OpenRouter 专有元数据的旁路读取。

2026-10-04 用户决定：“之后这个项目不在使用openrouter ,而是使用vercel作为 ai gateway”。Vercel AI Gateway 是 Vercel 提供的模型网关，地址是 `https://ai-gateway.vercel.sh`，用 `AI_GATEWAY_API_KEY` 认证，模型编号写成 `厂商/模型`（例如 `openai/gpt-6-astra`）。

[返回导航](#contents)

<a id="decision"></a>

## 决定

- Himawari 的模型请求今后都经过 Vercel AI Gateway，不再使用 OpenRouter。生成模型和 Memory 的嵌入模型都包括在内。
- 继续由 Pi 发请求：Pi 已有的 `openai-completions` 接口加上 Vercel 的 OpenAI 兼容地址 `https://ai-gateway.vercel.sh/v1` 就能工作（见[已验证的事实](#verified)），不在 Himawari 里另写一套请求协议。
- 预算、密钥句柄、Payload 保护、审计等产品职责不变，仍由 Himawari 负责。OpenRouter 专有的部分（`providerRouting` 路由字段、`openrouter_metadata` 读取、`OPENROUTER_*` 错误码）在迁移时换成 Vercel 对应的能力或删除。
- 开发用的网关密钥存放在 Mac 的钥匙串里，服务名 `himawari.ai-gateway.dev`，不写进仓库或任何文件。生产用的密钥另行创建，按生产部署规则，需要用户为那一次部署单独授权。
- 默认用哪个生成模型、备用模型是什么、嵌入模型是什么，都还没有定，迁移前要由用户决定。

[返回导航](#contents)

<a id="verified"></a>

## 已验证的事实

2026-10-04 在 Mac 上做过一次只发一条请求的检查，没有运行 Himawari 的测试或构建：

- Vercel 实时模型清单（`GET https://ai-gateway.vercel.sh/v1/models`）里有 `openai/gpt-6-astra`：上下文 105 万 token，单次最多输出 12.8 万 token，每百万 token 输入 10 美元、输出 50 美元。清单里也有 `alibaba/qwen3-embedding-8b`，和现有 Memory 用的 Qwen3 Embedding 8B 是同一款模型。
- 用项目锁定的 `@earendil-works/pi-ai` 0.84.2 的 `streamSimple`，模型写成 `api: "openai-completions"`、`baseUrl: "https://ai-gateway.vercel.sh/v1"`、`id: "openai/gpt-6-astra"`，流式返回 74 段文本，正常结束（`stop`），输入 30 个 token、输出 127 个 token，Pi 按清单单价算出的费用是 0.00665 美元。
- Pi 0.84.2 自带的 `vercel-ai-gateway` 接入只走 Anthropic 格式接口，自带模型清单里没有 `openai/gpt-6-astra`，所以迁移时不直接用它，而是沿用产品现有的 `openai-completions` 描述符，只换地址和密钥。
- 还没验证：工具调用、推理参数、用量和实际费用的回读、失败时的错误码、Memory 嵌入，以及 Linux（Hermes）和生产服务器上的行为。

[返回导航](#contents)

<a id="options"></a>

## 比较过的方案

### 沿用 Pi 的 `openai-completions` 接口，指向 Vercel 的 OpenAI 兼容地址（采用）

- 好处：产品现有的描述符、预算和流式处理都能沿用，改动集中在配置、密钥和 OpenRouter 专有字段；已经实测流式输出可用。
- 代价：Vercel 的路由和备用模型能力要另外接入或映射；用量和费用回读要重新核对。

### 直接用 Pi 自带的 `vercel-ai-gateway` 接入

- 好处：Pi 已经内置，密钥变量名一致。
- 代价：它只走 Anthropic 格式接口，模型清单里没有用户要用的 `openai/gpt-6-astra`，要么升级 Pi，要么改上游。

### 在 Himawari 里引入 Vercel AI SDK（`ai` 包）

- 好处：Vercel 官方推荐的接法。
- 代价：等于在 Pi 之外再建一套请求协议，违背 AGENTS.md 的 Pi 优先原则，还要新增依赖。

[返回导航](#contents)

<a id="consequences"></a>

## 后果

- 好处：只换网关就能调用 400 多个模型；密钥、预算和用量集中在 Vercel 管理。
- 代价：产品代码、配置、测试、Runbook 和架构文档里与 OpenRouter 有关的内容都要迁移；迁移完成前，生产配置仍指向 OpenRouter。
- 后续：迁移工作记在待办 BL-20261004-002；默认模型、备用模型和嵌入模型的选择，以及迁移排在上线前还是上线后，由用户决定。

[返回导航](#contents)

<a id="references"></a>

## 关联文档

- 现有模型路由决定：[SOURCE: docs/adr/0007-policy-controlled-model-routing.md]
- 现有模型路径说明：[SOURCE: docs/architecture-v0.1.md]
- 迁移待办：[SOURCE: docs/backlog/BL-20261004-002-模-型-网-关-迁-移-到-vercel.md]

[返回导航](#contents)
