---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-11-10"
covers: "packages/runtime-pi/test/fixtures/d4-golden-requests.json"
verified_at: "1f73e976913bbac15088d045988be291fd60d8dd"
---

# ADR 0205：模型服务方用 Pi 的原生认证声明，删除改写 hasConfiguredAuth 的 Proxy

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [前提](#premises)
- [决定](#decision)
- [业界怎么做](#industry)
- [放弃的做法](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

Pi（Earendil 开源的 Agent 框架）的会话在发送提示前会检查这个模型所属的服务方有没有配好认证，没配好就不发请求。Himawari 的密钥不放进 Pi 的凭据库，而是每次请求前由 Himawari 自己在通过权限和预算检查之后从主机取出，再作为 `apiKey` 选项传给 Pi。于是 Pi 的检查查不到密钥。原来的做法是用 JavaScript `Proxy`（拦截属性读取的包装对象）包住每个会话的 `ModelRuntime`，把 `hasConfiguredAuth` 改成对当前服务方一律返回真。这个做法登记在 [Pi 二次开发规范](../pi-development-guide.md#current-deviations)里，编号 D4，理由只写在 [架构文档](../architecture-v0.1.md)里，没有 ADR。

Andy 2026-11-10 的原话：“基于 Pi 的二次开发必须先查 Pi 官方文档/官方示例，有标准写法就照做”。同一天 Andy 回复“同意，开工”，批准了[方案](https://claude.ai/artifact/S3X53E7x5xHGS7FTUQG8Nk)。

<a id="premises"></a>

## 前提

1. 会话发送提示前的检查：`@earendil-works/pi-coding-agent` 的 `dist/core/agent-session.js`，1.5.0 第 1700 行起，1.5.1 第 1766 行起：`this._modelRuntime.hasConfiguredAuth(this.model.provider) || (await this._modelRuntime.checkAuth(this.model.provider)) !== undefined`。
2. 官方推荐：1.5.1 `docs/custom-provider.md` 第 135 行：“Use native provider authentication when the integration needs stored credentials, custom resolution, provider-scoped environment, or multiple login methods.”
3. `check` 的用途：`@earendil-works/pi-ai` 的 `dist/auth/types.d.ts`（1.5.0 与 1.5.1 逐字相同）：“Optional side-effect-free availability check. Use this when `resolve()` may execute commands or perform other request-time work.”
4. 请求带 `apiKey` 选项时，Pi 把它当凭据交给 `resolve`：`dist/auth/resolve.js`（两版相同）：`if (overrides?.apiKey !== undefined && provider.auth.apiKey) return resolveApiKey(…, { type: "api_key", key: overrides.apiKey, … })`。
5. `ModelRuntime.registerNativeProvider(provider: Provider)` 在 1.5.0 的 `dist/core/model-runtime.d.ts` 第 110 行已公开；旧式 `registerProvider` 的配置类型没有认证检查字段。
6. 缓存预热直接用请求选项里的密钥，绕过 Himawari 的准入：1.5.0 `dist/core/cache-warmer.js` 第 239–244 行 `streamSimple(run.model, run.context, { ...run.options, maxTokens: 1, … })`。

<a id="decision"></a>

## 决定

1. `ConfiguredPiModelBindingPort` 用 `createProvider` 构造完整服务方，用 `runtime.registerNativeProvider` 注册，注册后 `await runtime.refresh({ allowNetwork: false })`；流式实现复用官方的 `openAICompletionsApi()`。
2. 服务方的 `auth.apiKey.check` 固定返回 `{ type: "api_key", source: "himawari-host-secret" }`，不读密钥、不碰网络。`resolve` 只从 `credential` 取密钥（类型必须是 `api_key`），没有就返回 `undefined`；来源唯一由第 4 条的空凭据库保证。`resolve` 不向主机取密钥：Pi 在压缩、可用性刷新、缓存预热时也会调 `getAuth`，在那里取密钥会早于 Himawari 的准入。
3. 删除 [sessionModelRuntime](https://github.com/sixianli/himawari-agent/blob/e934cd2f4a7544467e83988796d3938d1cef36b6/packages/runtime-pi/src/pi-runtime-adapter.ts) 的 Proxy。准入、取密钥、传 `apiKey` 的代码（`admitPiStream`）不动，顺序仍是先过权限和预算，再取密钥，再发请求。
4. Pi 的凭据库必须保持为空：`resolve` 分不出显式传入的密钥和凭据库里的密钥，所以靠“凭据库为空”保证来源只有一个；测试断言 `listCredentials()` 为空。
5. `check` 恒返回“已配置”，不给密钥来源加只查是否存在的接口（Andy 2026-11-10 通过协调者同意）。主机密钥取不到时，失败发生在准入之后，预留会释放，和原来的 Proxy 行为相同。
6. 缓存预热会带着真实密钥绕过准入和预算，这是已有的问题，不是这次引入的；现在模型没有填 `promptCache`，预热不会跑。它的处理归 D7，这个 ADR 不碰。

<a id="industry"></a>

## 业界怎么做

Pi 自己的官方示例（1.5.1 `docs/extensions.md` 第 1987–2013 行）就是 `createProvider({ auth: { apiKey: { resolve … } }, api: openAICompletionsApi() })` 再注册；官方 `llama.cpp` 示例用占位字面量 `apiKey: "local"`。Himawari 的密钥必须每次请求前由主机取出，占位字面量会让 Pi 自发的请求带着占位词发出去，所以选原生认证。

<a id="options"></a>

## 放弃的做法

- **保持 Proxy 并补 ADR：**靠改写 Pi 内部方法的返回值，Pi 一改检查方式就悄悄失效。
- **旧式注册里填占位 `apiKey`：**“已配置”是假话，Pi 自发的请求会带占位词。
- **`resolve` 直接向主机取密钥：**取密钥的时机挪进 Pi 的调用栈，可能早于准入。
- **`setRuntimeApiKey`：**密钥进了 Pi 内存，违反“密钥不进 Pi 的凭据库”。
- **给密钥来源加 isConfigured()：**多一个主机接口，行为和现在相比没有实质好处。

<a id="consequences"></a>

## 后果

- 发给网关的请求体逐字节不变、非易变请求头一致（测试排除了易变的头，Authorization 的值换成占位）：改写前用旧写法录下 magpie 和 vercel-ai-gateway 各一份请求（`packages/runtime-pi/test/fixtures/d4-golden-requests.json`），改写后测试逐字节比对通过；故意改 `maxTokensField` 时比对失败是手工验证过的，仓库里的自动反向用例改的是 `maxTokens`（也会让比对失败）。
- 原生服务方整体替换了 Pi 内置的 `vercel-ai-gateway`：它从 `AI_GATEWAY_API_KEY` 环境变量取密钥的兜底没有了，测试断言设了该环境变量也取不到密钥。
- 升级 Pi 时，如果 `AgentSession` 的检查或 `ApiKeyAuth.check` 的行为变了，`[D4]` 开头的测试会失败。

<a id="references"></a>

## 关联文档

- [Pi 二次开发规范](../pi-development-guide.md)
- [ADR 0203：在 Pi 上加功能先照官方写法](0203-follow-pi-official-extension-patterns.md)
- [ADR 0204：D2、D3、D5 的处理](0204-handle-pi-deviations-d2-d3-d5.md)
- [架构文档](../architecture-v0.1.md)

[↑ 回到阅读导航](#contents)
