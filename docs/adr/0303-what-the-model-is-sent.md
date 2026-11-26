---
status: active
document_type: adr
decision_status: accepted
supersedes: "https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0084-himawari-identity-system-prompt.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0149-append-only-model-requests.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0161-keep-every-model-prompt-in-one-catalog-package.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0164-move-changing-values-out-of-the-request-head.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0165-freeze-the-request-head-per-conversation.md, https://github.com/sixianli/himawari-agent/blob/7d0ffcd52cbb69d4941871cf9bf08d93f3843da8/docs/adr/0166-prompt-wording-batch-1-system-and-tools.md"
superseded_by: ""
date: "2026-11-26"
covers: "apps/agent-service/src/production-run-policy.ts, packages/runtime-pi/src/pi-runtime-adapter.ts, packages/runtime-pi/src/runtime-environment-block.ts, packages/runtime-pi/src/pi-builtin-tool-text.ts, packages/prompt-catalog/prompt-manifest.json, apps/agent-service/src/cache-hit-monitor.ts"
verified_at: "7c8521fe5f55e7dd57c5bd52badd16eef647502e"
---

# ADR 0303：发给模型的内容怎样组织

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
  - [系统提示以 Himawari 的身份开头](#identity)
  - [只追加，会变的放最后](#append-only)
  - [按对话冻结系统提示和工具](#freeze)
  - [提示词都在一个目录包里](#catalog)
  - [提示词只写真话](#truthful)
- [放弃的做法](#rejected)
- [后果](#consequences)

<a id="context"></a>

## 背景

发给模型的系统提示、工具定义、历史和资料怎样排列，原来分散在六份 ADR 里（0084、0149、0161、0164、0165、0166）。做法的理由和一手来源在 [模型请求的 KV 缓存规范](../kv-cache-guide.md)，每个会话必须遵守的规则在 [.agents/instructions/prompt-prefix.md](../../.agents/instructions/prompt-prefix.md)。这份 ADR 只记现在为真的决定。旧文全文在 `supersedes` 列的固定提交链接里。

KV 缓存指模型服务方对重复出现的请求开头做的缓存：开头一字不差的部分不用重算，更快也更便宜。

<a id="decision"></a>

## 决定

<a id="identity"></a>

### 系统提示以 Himawari 的身份开头

- 每轮系统提示最前面是产品代码固定的身份说明（`apps/agent-service/src/production-run-policy.ts`），之后才是配置里的系统指令，不用 Pi 默认的“编程助手”开头。Pi 适配层用 `systemPromptOverride` 传入，自己带上工具简介和用法。
- 身份说明里不写主人的名字，统一称“主人”；名字来自记忆。

<a id="append-only"></a>

### 只追加，会变的放最后

- 已发给模型的内容不得改动、重排、删除，只能在末尾追加。原生历史存实际发出去的那条用户消息，资料块照留。
- 系统提示和工具定义里没有会变的值。本轮时间、记忆、工作目录、可用命令等全部放在最后一条用户消息的 `<himawari-context>` 里；运行环境说明（`runtime-environment` 块）只在压缩后第一次或内容变了时发。
- 告诉模型新情况用追加消息，例如工具循环停止时追加一条固定的 `himawari.tool-loop.stopped` 消息。
- 阻断检查 `npm run check:prompt-prefix` 用真实 Pi 适配器和真实出口遮盖跑多轮对话，核对每轮请求的开头不变。生产上后续轮次缓存命中率低于 50% 时写日志 `cache.follow_up_low_hit`。

<a id="freeze"></a>

### 按对话冻结系统提示和工具

- 一个对话第一次组好的完整系统提示和工具数组按原样字节存进 `thread_prompt_bundles`，以后不再从字段重新拼。
- 只有工具名列表、模型、推理强度、回答语言之一变了，或同名工具的参数结构变了，才换新一代并留记录；只改提示词文字或参数说明，只有新对话用新文字。
- 授权句柄带来的临时工具不进冻结记录。

<a id="catalog"></a>

### 提示词都在一个目录包里

- 所有发给模型的提示词放在叶子包 `packages/prompt-catalog`，每条有稳定编号、用途、所在层。中间夹运行时值的按段存，由 `renderPrompt` 填空，空位缺了或多了都报错。
- `packages/prompt-catalog/prompt-manifest.json` 记每条的哈希和改动原因；`npm run check:prompt-catalog` 核对改了文字必须同时更新清单。

<a id="truthful"></a>

### 提示词只写真话

- 系统提示和工具描述里每句描述系统行为的话都要对得上代码；Pi 内置工具里和 Himawari 实际行为不符的说明（`packages/runtime-pi/src/pi-builtin-tool-text.ts`）换成目录里的条目。
- 产品策略拦下工具调用时，模型看到一句看得懂的话：哪个能力不可用、不要重试、怎样告诉主人。

[返回目录](#contents)

<a id="rejected"></a>

## 放弃的做法

- 每轮重新拼系统提示：任何一个字段变化都会让整段缓存失效。
- 存历史时把资料块换回主人原话：会改掉模型已经见过的开头，缓存从那一轮起全部失效（[I-66](../incidents-and-gates.md#incidents)）。
- 把提示词散在各个函数里：改了文字没人知道，也没法锁住。

[返回目录](#contents)

<a id="consequences"></a>

## 后果

- 同一对话的后续请求开头稳定，缓存命中率高。
- 改提示词文字只对新对话生效；要让老对话用上新文字，得等换新的那几种情况。

[返回目录](#contents)
