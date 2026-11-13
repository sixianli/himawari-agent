# PR 424 第 1 轮复核判断

| # | 模型 | 意见 | 判断 | 处理 |
| --- | --- | --- | --- | --- |
| 1 | deepseek-v4.1-flash | 长对话永远只加载最早 200 条，`nextSequence` 被完全丢弃 | 会出错·中高 | DeviceAPI.fullThread 按 nextSequence 翻到底，不前进就报错；测试 fullThreadFollowsNextSequenceUntilTheEnd、fullThreadStopsWhenNextSequenceDoesNotMoveForward |
| 2 | deepseek-v4.1-flash | 密钥缺失或记录损坏时不清旧缓存，重新配对会把旧对话显示出来，旧待发消息可能发往新服务器 | 会出错·中高 | restore 在密钥不全时走 forget，清目录、钥匙和记录 |
| 3 | deepseek-v4.1-flash | 配对二维码的 `origin` 没有固定、白名单或显示确认 | 会出错·低 | PairingInvitation.parse 拒绝 userinfo、query、fragment、空主机；测试 rejectsWrongSchemeVersionOriginAndCode |
| 4 | deepseek-v4.1-flash | 事件流握手失败时丢弃错误码，吊销后重连可能长期不清本地数据 | 会出错·中高 | openStream 读错误体保留 code，401 时钟偏差纠正一次；测试 streamRefusedAsRevokedEndsTheEventStreamWithSessionInvalid、streamCorrectsTheClockOnceWhenTheServerSaysSkewed、streamRefusalKeepsTheServerCode |
| 5 | deepseek-v4.1-flash | 本地缓存的文件保护等级和设计文档不一致 | 会出错·中高 | 改为 .completeFileProtection |
| 6 | deepseek-v4.1-flash | 初始 `GET config` 失败后心跳保持 `infinity`，半死连接永远不会被判死 | 会出错·中高 | 取配置失败按退避重试，回到前台也重新取 |
| 7 | deepseek-v4.1-flash | 可重试失败后没有自动重发，消息可能永远显示“发送中”且没有手动重试入口 | 会出错·中高 | ChatStore 对 retryLater 按 2、4、8…60 秒自动重发；发过一次没成的显示“没发出去，连上后自动重发 · 现在重发”（照原型 16 第 3 帧） |
| 8 | deepseek-v4.1-flash | 配对请求结果不确定时删除密钥，留下服务端 pending 孤儿并消耗一次性配对码 | 会出错·中高 | 网络、5xx、408、429 这类结果不确定的失败保留密钥，再试一次复用同一对密钥；服务器对同一对公钥重复兑换的处理已请第 1 批线程补 |
| 9 | deepseek-v4.1-flash | `ChatStore.flush` 的 `flushing` 守卫会丢弃并发 flush 请求 | 会出错·低 | flush 进行中再来的请求记一个标记，结束前再跑一遍 |
| 10 | deepseek-v4.1-flash | 设备名长度未在客户端校验，服务器的“配对请求无效”被显示成“配对码不对” | 会出错·低 | PairingRequestLimits.deviceName 按 Unicode 码点截到 64；测试 deviceNameIsTrimmedToTheServerLimitInCharacters |
| 11 | deepseek-v4.1-flash | 服务器返回的 `CreatedThread.threadRevision` 被丢弃，首条消息靠猜 revision | 会出错·低 | newThread 记下服务器给的 revision，send 用它兜底 |
| 12 | deepseek-v4.1-flash | 服务器返回的 `pairingNumber` 被忽略，客户端改用本地重算 | 会出错·低 | PairedDeviceInfo 读 pairingNumber，和本地算的不同就报错 |
| 13 | deepseek-v4.1-flash | `refreshThreads` 对 `nextCursor` 没有重复游标保护 | 会出错·低 | 游标重复时报错，保留旧列表 |
| 14 | deepseek-v4.1-flash | 加载失败被静默吞掉，用户可能看到空白消息而不是错误状态 | 可以更好 | 正文缺的下次加载会重取；显示“加载失败”属于原型没画的状态，列给 Andy |
| 15 | deepseek-v4.1-flash | 持久化写失败被静默吞掉，编码失败时甚至会删除旧文件 | 会出错·低 | 编码失败不再写空，保留旧文件 |
| 16 | deepseek-v4.1-flash | 线程列表同 pinOrder/updatedAt 时没有稳定 tie-breaker | 会出错·低 | 最后按 threadId 排 |
| 17 | deepseek-v4.1-flash | 流连接建立成功就重置失败计数，服务器刚连上就断开时会快速重连 | 会出错·低 | 一次连接没收到任何数据就算失败，参与退避 |
| 18 | glm-5.3-flash | 吊销发生在“打开事件流”阶段时，客户端不会清数据、也不会回到配对页，只会无限退避重连 | 会出错·中高 | 同 DeepSeek 第 4 条 |
| 19 | glm-5.3-flash | 扫码后不显示、不让用户确认目标服务器，构造的二维码可把手机配到任意 https 主机 | 会出错·低 | 同 DeepSeek 第 3 条 |
| 20 | glm-5.3-flash | 对话详情永远只取第一页（≤200 条），`nextSequence` 字段解析了但从未使用，超过 200 条的老消息永远看不到 | 会出错·中高 | 同 DeepSeek 第 1 条 |
| 21 | glm-5.3-flash | 心跳配置拿到之前（或一直拿不到时）活性看门狗窗口是 ∞，SSE 卡死永远检测不出来 | 会出错·中高 | 同 DeepSeek 第 6 条；不设写死的兜底值，改为重试取配置 |
| 22 | glm-5.3-flash | URL 构造失败时静默回退到 origin 根路径 | 会出错·低 | url 返回可选值，失败直接报错 |
| 23 | glm-5.3-flash | 三处持久化失败被静默吞掉 | 会出错·低 | 同 DeepSeek 第 15 条 |
| 24 | glm-5.3-flash | 文档说“致谢页用 `ThirdPartyLicense.all` 读出来显示”，但代码里没有任何界面使用它 | 会出错·低 | README 改为第 11 批设置页再接 |
| 25 | glm-5.3-flash | 恢复时密钥缺失会留下孤儿配对记录 | 会出错·低 | 同 DeepSeek 第 2 条 |
| 26 | glm-5.3-flash | 冲突重试计数与网络重试共用 `attempts` | 会出错·低 | 冲突重试在一次 flush 里单独计数；测试 earlierNetworkFailuresDoNotUseUpConflictRetries |

推测类意见：Hashing.swift 的 UInt8 问题被 Linux 上 swift test 72/72 否定；RelativeTime 的静态 ISO8601DateFormatter 改用 Date.ISO8601FormatStyle（可跨线程）；watchOS 平台声明暂不构建界面，不改。
