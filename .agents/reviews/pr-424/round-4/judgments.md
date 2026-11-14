# PR 424 第 4 轮复核判断

只用 DeepSeek（Andy 选了再跑第 4 轮）。

| # | 意见 | 判断 | 处理 |
| --- | --- | --- | --- |
| 1 | `becameActive` 不再重试 `.keysUnavailable`，会把已配对用户卡在只能重新扫码的页面 | 会出错·中高 | 存储打不开单独成 storageUnavailable：说明配对和对话都还在，重试按钮，回到前台自动再试 |
| 2 | `restore()` 把“读不出/解不开配对记录”当成“没配对”，会删除密钥和本地聊天缓存；新增的自动重试和手动重试让这条路径更常被走到 | 会出错·中高 | 三项都在但记录解不开时显示 keysUnreadable，不清数据；只有确实缺东西才 forget；读不到、存储打不开的页面加“清掉，重新配对”由主人自己选 |
| 3 | `hiddenScalars` 不是完整的“不可见/方向控制字符”集合 | 会出错·低 | 改按 Unicode 类别去掉 Cc、Cf、Zl、Zp，保留 ZWJ 以免拆散 emoji；测试加用例 |
| 4 | 等待项的触发条件比作者描述宽，没有限定 `kind == .status` | 会出错·低 | message 记录不算；测试 aWaitingMessageRecordIsNotAnApproval |
| 5 | 空页继续翻页有上限，但可能每次 `executionChanged` 都打满 100 次请求 | 会出错·低 | 不改 |
| 6 | `ui-review.sh` 的新分支逻辑正确，但没有自动检查来证明反向用例真的会失败 | 会出错·低 | 脚本只在 Andy 的 Mac 上跑，Mac 线程第一次运行时验证；不加假 xcrun 的测试 |

另：Mac 上 Xcode 编译发现 ProcessRowView 的 label 声明为 Text 却用了返回 some View 的 hmType；加 Text.hmText 返回 Text。DemoChat 的 private(set) 问题已在第 3 轮改掉。
