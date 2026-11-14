# PR 500 第 2 轮判断（deepseek-v4.1-flash）

- 1（deepseek-v4.1-flash）不成立：### 1. [中] 材料称“不改任何界面”、覆盖“6 个枚举”，增量却改了界面，代码里是 8 个枚举。这条说的是材料文字，不是代码；PairingView 的恢复内容模型自己对比 a33757cae 确认一致（意见原文：“这段本身不是新风险”），代码里没有会出错的输入
- 2（deepseek-v4.1-flash）成立，会出错，低：### 2. [中] `PairingProblemCoverageTests` 只守 `key`，恢复的页面路由和本地化键没有被守住。PairingProblemCoverageTests.swift 原只检查 key；已补测并做了反向验证；触发：有人再丢掉 PairingView.swift 里把 stateUnknown 路由到重试页的条件，或某语言缺 pairing.problem.stateUnknown 等键；后果：只有 key 测试，回归检查不失败；页面落到通用的重新扫描页或显示原始键，只是错误页不贴切，不丢数据；判低理由：是测试覆盖漏洞，生产行为现在是对的；已修：新增 theUnknownStatePageIsRoutedAndTranslated，断言路由条件含 stateUnknown，并查三种语言五个键；去掉路由条件后该用例失败
- 3（deepseek-v4.1-flash）不成立：### 3. [低] 服务器给的未知值作为不可信输入被 `.public` 原样写入日志，没有去掉控制字符/换行。沿用第 1 轮第 4 条原判：os.Logger 每次调用是一条结构化记录，换行不能伪造新记录；值已截到 64 字符；标 .private 会让这条诊断在发布版显示 <private>；枚举字符串按契约不是用户数据（ServerValues.swift:9）；模型没给新证据，且 OSLog 转义行为它自己也说是推测
- 4（deepseek-v4.1-flash）成立，可以更好：### 4. [低] 64 个去重上限是全局的，用满后进程内永久静默，也没有“已停止记录”的提示。沿用第 1 轮第 2 条原判：预算全局共享属实，但要先出现 64 个不同未知值才耗尽，正常服务器不会；按类型分额或加“已达上限”提示是设计取舍，不是现有代码会出错的输入，列给 Andy
- 5（deepseek-v4.1-flash）成立，可以更好：### 5. [低] 每次 SwiftUI body 求值都同步读取并解码 outbox 文件来生成“开始重来”的提示。PairingView.swift:255 startOverWarning 在 body 求值时读 outbox 属实，但只在配对页渲染，文件小，结果正确，没有错误输入；改成点击时再算是写法改进，列给 Andy
