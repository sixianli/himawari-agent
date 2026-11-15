# PR 594 作者说明

问题：手机设置缺个性化、联网搜索授权、通知种类、接入的 agent、敏感拦截记录、Muse 对照。
目标：在 iPhone App 设置里补这六项，字段名以 packages/gateway-contracts/src/contracts-v2.ts 为准，改动类操作走 ManageGateway 现有的确认流程（档位见 Generated/ClientCapabilities.swift）。
范围：新增 clients/apple/Sources/HimawariCore/SettingsMore/*（解码、请求体、判断，Linux 可测）、clients/apple/Sources/HimawariManage/Settings/More/*（存储、页面、文案、演示数据）、两份测试；SettingsRootView.swift 只加入口和 Page.more。
约束：不改发给模型的任何内容；SwiftUI 只能在 Mac 编译，这里没编译过，请重点看 Swift 语法和类型错误。
刻意没做：新建接入和换密钥（专用地址只能由网页会话的接口取，设备接口没有该路由）；推送令牌登记；字体选择。
需要核对的点：请求体字段是否和合约一致（owner.preferences.set 全字段带 null；mcp.connection.change 五个可空字段；search.authorization.set 的 expectedRevision/enabled/recipients；push.kind.set；muse.item.rate；sensitive.interceptions.read 的 before 游标）。
