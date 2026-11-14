# PR 424 第 6 轮复核判断

只用 DeepSeek（Andy 2026-11-12 原话“只用 DeepSeek 再跑一轮”）。第一次运行被线程自己设的 10 分钟时限掐断，没有结果，实际花了 0.0917 美元，账本按 0.2 美元保守计；重跑花 0.1095 美元。账本累计 1.2366 美元，实际约 1.13 美元。

| # | 意见 | 判断 | 处理 |
| --- | --- | --- | --- |
| 1 | `claim` 把“归属标记读不出”当成“换了设备”，会清空本机存储 | 会出错·中高 | `LocalStore` 加 `contains`；标记文件在但读不出时抛 `LocalStoreError.unreadable`，不清；测试 `anOwnerMarkThatCannotBeReadLeavesTheStoreAlone`。标记不存在而有数据时仍然清空：这个 App 还没有装到任何设备上的旧版本，来历不明的缓存正是第 5 轮要防的“旧待发消息发到新服务器” |
| 2 | `forget()` 吞掉清空失败，确认文案却说对话都会删除 | 会出错·中高（模型标中；拿不准按中高） | “清掉，重新配对”改走 `startOver()`：先清存储，清不掉就停在“存储打不开”页，密钥和配对不动；设备被移除时清不掉就不显示“数据清掉了”那条提示（`ForgetOutcome`，有测试），密钥照删，下次配对启用前 `claim` 会再清一次，清不掉不启用 |
| 3 | 第 5 轮的运行时改动没有自动检查 | 会出错·中高 | 能在 Linux 上测的判断都放进 HimawariCore 并补测试：`OutboxSendResult.deviceRevoked`（吊销算、断网和 400 不算）、`isRevoked`、`ForgetOutcome`、`retire`、读不出的标记。`ChatStore` 和 `AppModel` 依赖 Observation 和 SwiftUI，Linux 上编不了，`limitStreams` 的关流和重开、`activate` 失败停在哪一页仍然没有自动测试，靠 Mac 上的编译和人工走查 |
| 4 | `--only` 重复值没有报错 | 会出错·低 | 去掉 `sort -u`，重复名现在报错，提示语写明 |
| 5 | `streamConnections` 是总数还是剩余数没有核实 | 不成立 | PR 404 分支 `packages/platform-node/src/device-api-routes.ts:211` 是 `streamConnections: maximum`，第 485、664 行 `holdStream(authenticated.device.id, stream, configuration.streamConnections)` 按每台设备同时连着的总数算，和客户端“至少 2 条”的理解一致 |
| 6 | 清空之后在途的写入会把缓存写回 | 会出错·低（模型标为推测） | `FileLocalStore.retire()`：清空后这份存储不再接受写入；`AppModel` 清存储一律走它；测试 `aRetiredStoreIsEmptyAndTakesNoLateWrites` |
| 7 | 预热场景只是碰巧是静态场景 | 会出错·低 | 预热改成取第一个不是 `motion-` 开头的场景，没有就报错 |

其余“作者说法逐条核对”里指出的“`loadTexts` 和 `newThread` 出错都走 `onSessionInvalid`”说得不准：代码只在 `DEVICE_REVOKED` 时走，这是对的，是复核材料的措辞问题，不改代码。

本轮有中高意见，按规则算没过。修改后 Linux 上 `swift test` 96 条全过；界面模块的三处改动（`AppModel`、`PairingView` 一行、`ChatStore` 一行）要在 Mac 上重新编译并跑 `ui-review.sh --check`。这些修改没有再复核。
