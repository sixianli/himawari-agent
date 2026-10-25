# 服务与规则依据

基础检查日期：2026-10-05；改稿 API 和链接计数于 2026-10-06 补充核对。下面记录查到的依据；使用时应重新核实服务条款、套餐和 CLI 功能。没有公开证据支持“使用 Buffer 就不会封号”，本 skill 不作这种承诺。

## 为什么使用 Buffer Free

用户选择是“不支付 X API 费用，可以使用免费的发布服务，并允许服务在后台使用 X 官方 API”。Buffer Free 提供 X 频道连接和公开 API，可避免购买个人 X API 访问，也适合定时器通过确定的帖子 ID 查询结果。[Buffer 套餐](https://buffer.com/pricing)、[API 套餐说明](https://support.buffer.com/en-us/articles/what-is-buffers-api-GtIYIQilz5)。

Free 当时列出的限制为最多 3 个频道、每频道同时 10 条排队帖子、1 个 API key。Free API 在滚动窗口内最多每 15 分钟 100 次、每 24 小时 250 次、每 30 天 3000 次请求。[API 请求限制](https://developers.buffer.com/guides/api-limits.html)。频率由用户设定，脚本遵守当前 Free 上限；没有默认的“每天一条”限制。

Buffer 表明发布经各平台官方 API 进行；用户不需要运行 X 网页自动化。[Buffer 的发布来源](https://support.buffer.com/en-us/articles/where-does-buffer-publish-my-post-from-and-which-regions-will-see-it-gmMvh4C3KX)。账号连接仍需要一次由运营者完成 X 授权。

Buffer API endpoint 为 `https://api.buffer.com`，使用 Bearer personal API key。密钥不能按组织缩小权限。[认证](https://developers.buffer.com/guides/authentication.html)。调用 `createPost` 时使用 `customScheduled`、`automatic`、`dueAt`、`needsApproval=false`、`saveToDraft=false` 和 `aiAssisted=true`；文本帖仍传空 `assets` 数组。[当前 GraphQL 类型](https://developers.buffer.com/reference.html)。

原位改稿使用公开 `editPost`，只传 `id`、`text`、`aiAssisted`。省略 `mode`、`dueAt`、`schedulingType` 和 `assets` 时保留原排期与媒体。修改后按同一 ID 独立读取正文和状态，不能用重新创建帖子替代改稿。[EditPostInput](https://developers.buffer.com/reference.html#EditPostInput)。

公开 API 不提供写入幂等键（服务据此保证同一个请求只处理一次的标识），也没有帖子状态 webhook。因此响应丢失后必须查询，不能把请求再发一遍。[高效 API 使用](https://developers.buffer.com/guides/efficient-api-usage.html)。图片需要 Buffer 能访问的公开 URL；此版本不要求另买上传服务。[媒体托管](https://developers.buffer.com/guides/hosting-media.html)。

## X 规则带来的边界

X 的 t.co 链接计数固定为 23；普通帖子的加权上限为 280。脚本仍保守计算正文和 emoji，但有效公开 HTTPS 链接不再按原始 URL 的长度挤占正文空间。[twitter-text 当前配置](https://github.com/twitter/twitter-text/blob/master/config/v3.json)、[X 链接发布说明](https://help.x.com/en/using-x/how-to-post-a-link)。

X 当前自动化规则禁止非 API 自动化，包括浏览器脚本；也限制重复或实质相同内容，以及自动发布 X 热门话题。它允许符合规则的自动信息和娱乐类内容，但这不是对所有 AI 自主内容或任何具体账号的批准。[X 自动化规则](https://help.x.com/en/rules-and-policies/x-automation)。因此不把 ego-lite、computer use、随机延迟、指纹伪装或验证码处理作为规避措施。

AI 自动回复明确要求 X 的书面批准。当前开发者指南中 AI 内容与回复的表述还使“全自动 AI 原创发帖”的适用范围存在歧义；开发者政策也有向用户显示准确待发内容的要求。Buffer 使用官方 API 能解决发布渠道问题，不能证明无人审核的 AI 原创内容已经得到 X 许可。[开发者指南](https://docs.x.com/developer-guidelines)、[开发者政策](https://docs.x.com/developer-terms/policy)。启用前核实这些条款对自己的实际用途的适用性；不要把本文当成平台授权。

本 skill 只处理自有账号的原创内容，不包含自动回复、私信、点赞、关注、买量或热榜追逐。减少重复、核实事实、确认媒体使用权、遵守用户频率和保留可查询历史，能减少可观察的违规行为。没有可靠数据可以把这些做法换算成封号概率。也不能承诺完全消除账号限制风险。

## Agent 和定时器依据

Codex 支持非交互 `exec`、schema 输出和 sandbox，`web_search=live` 为当前配置选项。[非交互模式](https://developers.openai.com/codex/noninteractive)、[配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)。Claude Code 支持 `-p`、schema 输出和允许工具列表；`--bare` 不读取订阅 OAuth 登录，所以此版本沿用用户正常 CLI 登录。[程序化运行](https://code.claude.com/docs/en/headless)、[CLI 参数](https://code.claude.com/docs/en/cli-reference)。

Skill 是宿主读取的指令和资源，不是持续运行的服务。macOS launchd 定时调用辅助脚本，才能在无人逐次触发时继续选材。当前包会生成配置，真正激活和本机登录仍需一次设置。已经进入 Buffer 的队列不依赖本机醒着；新的选材依赖本机运行状态。模型和账号的实际运行结果需要启用后单独检查。
