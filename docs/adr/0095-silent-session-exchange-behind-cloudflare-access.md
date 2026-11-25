---
status: active
document_type: adr
decision_status: accepted
supersedes: ""
superseded_by: ""
date: "2026-10-27"
---

# ADR 0095：过了 Cloudflare 邮箱验证码后，网页自动换取 Himawari 登录，不再要求点按钮

<a id="contents"></a>

## 阅读导航

- [背景](#context)
- [决定](#decision)
- [比较过的方案](#options)
- [后果](#consequences)
- [关联文档](#references)

<a id="context"></a>

## 背景

[ADR 0089](https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0089-web-push-only-owner-entry.md) 第 4 条定了“生产只用一道门：Cloudflare 邮箱验证码”。Cloudflare Access（Cloudflare 提供的登录关卡，这里只放行 Andy 的邮箱）放行后，每个请求都带着 Cloudflare 签发的身份令牌（请求头 `cf-access-jwt-assertion`）。Himawari 还需要自己的登录（浏览器里的 `himawari_session` 会话 Cookie，Cookie 是网站存在浏览器里的一小段登录凭据），由 `POST /api/identity/v1/sessions` 用 Cloudflare 的身份令牌换出来（`packages/platform-node/src/identity-gateway.ts`）。这个接口只检查请求来自本站和 Cloudflare 身份令牌有效，不需要用户做任何操作。

2026-10-27 12:54（日本时间）生产切到只用邮箱验证码后，Andy 在 iPhone 上输完验证码，网页仍停在一个黄色框里，标题“このブラウザーでログインしてください”（请登录以连接此浏览器），要他再点“Himawari にログイン”，框里还露出给程序看的错误码 `HTTP_GATEWAY_AUTHENTICATION_REQUIRED`。原因在网页：`apps/control-center/src/app.tsx` 读配置收到 401/403 时，故意只摆一个按钮，等用户点了才去调用上面的换取接口。

Andy 原话（2026-10-27 13:14）：“为什么我既然都输入验证码了，还要让我来这里点一下呢？”

[↑ 返回阅读导航](#contents)

<a id="decision"></a>

## 决定

1. **自动换取。** 网页读配置失败时，先问一次 `GET /api/identity/v1/method`（返回登录方式的公开接口）。登录方式是 `cloudflare-access`、且读配置的失败是 401/403 时，网页自己调用一次换取接口，成功就重新读配置，直接进入对话。整个过程只显示转动的葵盘和“正在进入 Himawari…”。
2. **只换一次。** 每次进入只自动换取一次。换取成功后读配置仍被拒，就停下来显示“暂时连不上”和“重试”按钮，不反复换取，避免死循环。
3. **认出 Cloudflare 登录过期。** 上面那次 `method` 请求用 `redirect: "manual"`（让浏览器不跟随跳转，只告诉网页“被跳转了”）。Cloudflare 登录过期时，这个请求会被跳到 Cloudflare 的登录页，浏览器返回 `opaqueredirect` 类型的响应，网页据此显示“需要重新验证邮箱”。点按钮会重新加载整页，让 Cloudflare 显示它自己的验证码页面；验证完自动回到对话。
4. **连不上时自动重试。** 网络断开、服务在重启（无状态码、429 或 5xx）时显示“Himawari 暂时连不上”，5 秒倒计时后自动重试，也可以手动点“重试”。其他被拒（例如换取接口拒绝了身份）只给“重试”按钮，不自动重试。
5. **不给用户看错误码。** 这几个页面都不显示内部错误码，文字有中文、英文和日文三种。
6. **内置登录不变。** 登录方式是 `built-in`（Himawari 自己的用户名、密码和验证器）时，仍显示原来的登录表单。
7. 服务器端不改。连接中断时实时推送（SSE，服务器持续向网页推消息的连接）报告会话失效，网页同样重新走上面的流程，不再停在“请登录”。

[↑ 返回阅读导航](#contents)

<a id="options"></a>

## 比较过的方案

- **保留按钮，只把页面做好看**：改动最小，但多出的一步本来就不需要，没有解决 Andy 的问题。
- **服务器在请求带着有效 Cloudflare 身份令牌时直接自动建立会话（每个请求都检查）**：网页不用改，但读配置这样的普通请求会顺带建立会话、写设备记录，把“创建登录”这个有副作用的操作混进只读请求，也改变了服务器的安全检查范围。不选。
- **网页在打开时总是先换取一次**：最简单，但每次打开都会多建一条设备记录。改为只有读配置被拒时才换取。

[↑ 返回阅读导航](#contents)

<a id="consequences"></a>

## 后果

- 好处：输完邮箱验证码直接进对话；Himawari 会话过期（Cloudflare 登录仍有效）时，用户也感觉不到；页面上不再出现错误码。
- 坏处：读配置失败时多一个 `method` 请求（同机，耗时未测量）；“只换一次”的规则意味着服务器持续拒绝时要用户点一次“重试”。
- 发布走查测试 `test/integration/product-path-browser.test.ts` 去掉了点“登录 Himawari”这一步，打开网页后直接等输入框出现。
- 页面的视觉稿在 Andy 批注后可能调整，见[原型](https://claude.ai/artifact/BxexuxfGz84FFYTSnqu5Y6)；本决定只管行为。

[↑ 返回阅读导航](#contents)

<a id="references"></a>

## 关联文档

- [SOURCE: https://github.com/sixianli/himawari-agent/blob/baf02ebc4f376a27aa2a8d2871cc4a897a42c7e2/docs/adr/0089-web-push-only-owner-entry.md]
- [SOURCE: docs/engineering-casebook.md#case-silent-access-entry]
- 界面原型：<https://claude.ai/artifact/BxexuxfGz84FFYTSnqu5Y6>
- 代码：`apps/control-center/src/browser-entry.ts`、`apps/control-center/src/components/browser-entry-screen.tsx`、`apps/control-center/src/app.tsx`

[↑ 返回阅读导航](#contents)
