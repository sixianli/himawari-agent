# PR 500 第 1 轮判断（deepseek-v4.1-flash）

- 1（deepseek-v4.1-flash）成立，会出错，低：### 1. 高 — `seen` 保存的是未截断的服务器字符串，64 条上限只限制条数、不限制字节。ServerValues.swift noteFallback 原先用完整 raw 做键；改为锁外先 prefix(rawLimit)，键和报告共用；新增 longValuesSharingTheirFirstCharactersCountOnce 用例；触发：服务器（或出错的服务器）为某个枚举字段发超长字符串，且不同值达 64 个；后果：seen 里常驻最多 64 条超长原文，每次解码在锁内哈希整串；只是内存和耗时变大，不丢数据不出错；判低理由：只有服务器发畸形超长枚举值才触发，且只是资源占用、不误报不丢数据；已修：先截断再去重，键与日志同一个值
- 2（deepseek-v4.1-flash）成立，可以更好：### 2. 中 — 64 条预算被所有类型共享且永不释放，单一类型就能把诊断能力耗光。ServerValues.swift:26 预算全局共享属实，但要先出现 64 个不同的未知值才耗尽，正常服务器不会；按类型分配额是设计取舍，不是照现在代码会出错的输入，列给 Andy
- 3（deepseek-v4.1-flash）成立，会出错，低：### 3. 中 — 新测试没有覆盖 64 条上限，“无观察者时无副作用”这条实际上没有验证。ServerValueTests.swift 第二条用例中间的 reset() 抹掉证据且无 64 上限用例；改为先 reset 再装 nil 观察者，不再中途 reset；新增 atMostTheDistinctLimitOfValuesIsReported；触发：有人把 noteFallback 改成无观察者也写 seen、或去掉 64 上限；后果：回归检查不会失败，只是测试覆盖不足，生产行为本身没错；判低理由：是测试漏洞，不是产品行为错误；已修
- 4（deepseek-v4.1-flash）不成立：### 4. 中 — 服务器可控字符串以 `.public` 写入系统日志，未做控制字符清洗，存在日志注入/信息泄露面。os.Logger 的每次调用是一条结构化记录，换行不能伪造新记录；值已截到 64 字符；标 .private 发布版会显示 <private>，正好让这条诊断没法用，而枚举字符串按契约不是用户数据（ServerValues.swift:9 只在 init(from:) 里对 String 比对已知枚举词）
- 5（deepseek-v4.1-flash）成立，可以更好：### 5. 低 — Apple-only 的日志挂接没有在 Mac/Xcode 编译过，Linux 的 `swiftc -parse` 无法验证 `canImport(os)` 分支。AppModel.swift:47-54 在 Linux 只能 -parse，属实；这是已知的验证局限（test-and-production-hosts.md 要求 Mac/Xcode 构建），不是代码缺陷，列给 Andy 在 Mac 上编译一次
- 6（deepseek-v4.1-flash）成立，会出错，低：### 6. 低 — 材料说“6 个枚举”、日志说“shown the general way”，都与实际代码不符。AppModel.swift:51 文案；已改为 shown as its fallback value；“6 个枚举”只是材料说法，代码 8 个扩展不影响行为；触发：服务器发未知 ThreadStatus 等值；后果：日志写“shown the general way”，实际退回 .active/.agent 等具体值，文案不准但不误导
- 7（deepseek-v4.1-flash）成立，可以更好：### 7. 低 — 观察者只有一个槽，后设置会静默覆盖先设置；`reset()` 也不清观察者。ServerValues.swift:28-38 单槽覆盖属实，但生产里每个 AppModel 装的是等价的观察者，当前无可见后果；改多观察者属设计扩展，列给 Andy
