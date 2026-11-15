# PR 512：Apple Watch App 初版（iOS 第 10A 批）

问题：Himawari 缺 Apple Watch 客户端。目标：手表只做“一眼和一句”：到点轻敲、最要紧的一件一点就定、抬腕说一句、表盘小组件；手表上不打字配对，由 iPhone 转交配对链接。

约束（Andy 的规则）：能动态获取的一律不写死；按钮文字、一句话、明细都来自服务器，客户端不按种类拼句子；件数的定义和 iPhone 红点相同（服务器没读全来源时不显示件数）；要本人在场的审批手表上只给“在 iPhone 上看”；理解用户意思不用词表；手表不加网页或管理页。云端是 Linux，只能跑 `clients/apple` 的 `swift test`（HimawariCore）；界面、小组件、新增 Xcode 目标只能在 Mac 上编译，已知没编译过，请重点用眼睛查 Swift 语法、API 用法、并发隔离（Swift 6 严格并发）和 pbxproj 结构。

作者的说法：
- 逻辑在 `clients/apple/Sources/HimawariCore/WatchGlance.swift`（17 条 Linux 测试）。
- 手表界面在 `Sources/HimawariWatchUI/`（仅 watchOS 编译），入口 `App/Watch/`，小组件 `App/WatchWidgets/`，Xcode 工程 `App/Himawari.xcodeproj/project.pbxproj` 手写加了两个目标和嵌入。
- iPhone 转交配对：`Sources/HimawariShell/PhoneWatchRelay.swift`、`AppModel.handlePairingLink`、`RootView` 的 `.onOpenURL` 和确认框。
- main 上服务器还没有 `GET home` / `POST home/act` 设备入口（另一线程在做），客户端按 Mac 菜单栏已在用的同一接口形状写。
