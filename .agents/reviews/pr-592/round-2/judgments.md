# PR 592 第 2 轮判断（deepseek-v4.1-flash）

- 1（deepseek-v4.1-flash）成立，会出错，中高：### 1、中：幂等身份只存在内存里，App 重启或冷启动后的“未知结果重试”仍会重复执行。ThreadManagement.swift PendingActionIdentities 原为内存字典；规格 2026-08-26-control-center-experience-design.md:125 要求持久到结果确定。已改为经 UserDefaults 持久化（AppModel 传 .standard），补 pendingIdentitiesSurviveARestartAndStoreNoTitleText。；触发：fork/改名/归档响应丢失后 App 被杀或冷启动，用户再点同一动作；后果：内存里的待定身份丢失，重试换新 idempotencyKey 和新 targetThreadId，fork 多出第二条对话
- 2（deepseek-v4.1-flash）成立，会出错，低：### 2、低：失败动作的 identity 永不清理，字典无界增长并保留标题原文。已改：键用描述符的 SHA-256（不存标题原文），容量上限 64 条淘汰最旧，补 pendingIdentitiesAreCappedKeepingTheNewest 和不含标题的断言。；触发：离线或服务端报错后反复失败的动作；后果：字典无界增长，标题原文留在内存；只是资源和隐私上的轻微问题，不影响结果
- 3（deepseek-v4.1-flash）成立，可以更好：### 3、低：新组合出来的标识符没有对服务端校验的自动检查，fork 成功后的新动作也没有反向用例。测试缺口属实但生产代码无错：值已逐个对过服务端正则。仍已补 composedIdentifiersFitTheServerPatterns 和 aForkAfterAnAcceptedForkGetsANewTarget。
- 4（deepseek-v4.1-flash）成立，可以更好：### 4、低：作者“服务端搜索设备路由没有”的说法与代码不完全一致。client-capabilities.ts:274 确有 thread.search，只是设备侧无搜索词预处理路由（http-gateway-server.ts 的 prepare 走浏览器会话）。只影响 PR 描述措辞，代码无误。
