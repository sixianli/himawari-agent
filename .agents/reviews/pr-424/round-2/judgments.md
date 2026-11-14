# PR 424 第 2 轮复核判断

只用 DeepSeek。

| # | 意见 | 判断 | 处理 |
| --- | --- | --- | --- |
| 1 | 并发 flush 仍会丢消息，消息可无限停在“正在发送” | 会出错·中高 | flush 改成循环：每一轮发完、排重试、刷新列表后再看 flushAgain，没有新请求才退出 |
| 2 | 密钥读取失败会不可逆清空配对记录和全部本地数据 | 会出错·中高 | 钥匙串读取分成有、没有、读不到三种；读不到时显示“钥匙暂时读不到”不清数据，回到前台再试；只有确实没有才清 |
| 3 | `loadExecution` 翻页没有“必须前进”校验，可死循环并无限增长内存 | 会出错·中高 | DeviceAPI.executionRecords 要求每页前进且非空，最多 100 页；测试 executionRecordsRejectAPageThatDoesNotMoveForward、executionRecordsRejectAnEmptyPageThatStillPointsFurther、executionRecordsGiveUpAfterThePageLimit、executionRecordsFollowNextSequenceFromWhatIsAlreadyKnown |
| 4 | 单个 deferred 会让整次正文加载失败，已取到的正文被丢弃 | 会出错·中高 | 整批都被延后时停止并返回已取到的部分，下次加载再取；测试 textsKeepWhatArrivedWhenTheServerDefersEveryRemainingRef |
| 5 | 配对重试遇到 `DEVICE_PAIRING_CODE_USED` 会删掉可能已配对的密钥 | 会出错·低 | 无需客户端改动 |
| 6 | 失败的运行会显示成“完成”，带勾图标 | 会出错·中高 | ProcessLine 新增 failed，收起行用 alert-circle 图标并发出失败触感；图标已请设计线程确认；测试 finishedRunCollapsesWithItsDuration |
| 7 | `check-design` 的“散数值”规则漏掉页面里真实存在的大量字面量，测试反向用例也是假形式 | 会出错·中高 | 规则补上 .lineSpacing( .cornerRadius( .opacity( .kerning( .tracking( 和 idealWidth、Color(white:)、UIColor/NSColor 成员；颜色规则合成一条；反向用例改成真实写法 |
| 8 | 配置没取到前心跳是 `infinity`，静默断流永远不会被判失败 | 会出错·低 | 保持；配置取到之前的窗口靠重试缩短 |
| 9 | `waiting` 取“任意最后一个 waiting 步骤”，不是最后一步 | 会出错·低 | 改成按 sequence 最新的一条是 waiting 才显示等你点头；也认 main 上 kind=status 的 waiting；测试 waitingShowsWhileItIsTheLatestRecord、aRunSuspendedForApprovalWaitsOnItsLastStep、aNewerRecordEndsTheWait |
| 10 | `fullThread` 对“空页 + 非空 nextSequence”静默截断，且无页数/内存上限 | 会出错·低 | 空页而仍有下一页时报错，最多 100 页；测试 fullThreadRejectsAnEmptyPageThatStillPointsFurther、fullThreadGivesUpAfterThePageLimit |
| 11 | Mac 上设备名为空白时会回退成 “iPhone” | 会出错·低 | deviceName 的兜底名由调用方传，Mac 传 Mac |
| 12 | 文档/原型路径仍是 v1，代码和 tokens 已指向 v2 | 会出错·低 | README 和计划第 95 行改指 v2 |
| A | `activity` / `activityIcon` 及 `waiting` 工具记录在本仓库服务端不存在 | 会出错·低 | 客户端认 kind=status 的 waiting；契约已交过程图标线程确认 |
| B | `pairingNumber` 的格式假设 | 不成立 | PR 404 device-api-routes.ts 第 177 行返回 devicePairingNumber，网页 device-settings.tsx 第 159 行按 6 位纯数字切成两段显示，与客户端一致 |
| C | `pairingCodeTtlSeconds` 的 JSON 字段名与语义 | 不成立 | PR 404 paired-device-service.ts 第 195 行 pairingCodeTtlSeconds: PAIRING_CODE_LIFETIME_MILLISECONDS / 1000，字段名和单位与客户端一致 |
| D | 设备名“64 码点”与 JS 服务端的长度定义可能不一致 | 会出错·低 | PR 404 boundedString 用 input.length（UTF-16 单元）并拒控制字符；deviceName 改为按 UTF-16 单元截 64、按字形不拆、去掉控制字符；测试 deviceNameIsTrimmedToTheServerLimitInCharacters 加 emoji、家庭 emoji、控制字符 |
| E | `.completeFileProtection` 让锁屏后的后台写入失败 | 会出错·低 | 保持 |
