# PR 599 第 1 轮作者说明

问题：iPhone 要搜全部历史对话，网关操作 thread.search（thread-v3，读档，client-capabilities.ts 已登记）需要先预处理搜索词，而预处理只有网页专用的 POST /api/thread-search/v1/prepare（http-gateway-server.ts），设备签名路由没有。Andy 2026-11-15 在项目聊天同意“给手机新增搜索入口”。

改动：device-api-routes.ts 新增设备签名路由 POST /api/device/v1/thread-search/prepare（登记进 DEVICE_API_ROUTES，signed: true），调用和网页路由同一个 HttpGatewayThreadSearchPort.prepare（经 DeviceApiRouteOptions.threadSearch 传入，http-gateway-server.ts 把 options.threadSearch 传下去）。请求体校验抽成共用函数 readThreadSearchPrepareQuery（browser-thread-search.ts），网页路由改用它。智能体身份用 options.authority.agentId（和网页的 browserConfiguration.agentId 同源）。设备通道沿用统一的请求体大小上限和签名校验。手机端 ManageGateway.swift 加 prepareThreadSearch（未在 Linux 编译）。测试：test/integration/device-gateway.test.ts 新增 3 个用例（正向；未签名、签名后改正文、空、全空白、超长、多字段、非字符串、缺字段全拒绝且不调用预处理；未装配拒绝），harness 加 threadSearch 选项。

约束：不动数据库表、权限规则；不改发给模型的请求开头（预处理只做令牌化和受保护引用，分级 private，和网页一致）；能力表没变，无需重新生成 ClientCapabilities.swift。请特别看：网页路由改用共用校验后行为是否和以前逐字一致；设备路由是否绕过了网页路由有的任何保护（网页有 CSRF 和同源检查，设备用签名替代；两边都没有额外限流）。
