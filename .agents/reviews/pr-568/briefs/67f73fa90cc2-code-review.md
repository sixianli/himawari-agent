# PR 568：手表装真机，免费签名下手表和小组件不要求 App Group

问题：Mac 核对说手表 App 装不到真机。工程里 `HimawariWatch`（手表 App，单 target，Bundle ID `win.siyi.himawari.watchkitapp`，`WKCompanionAppBundleIdentifier` 指向 `win.siyi.himawari`）和 `HimawariWatchWidgets` 已经是配套目标，`Himawari` 目标依赖并通过 `Embed Watch Content` 嵌入手表 App（PR 512 已合）。真缺口：手表和小组件的 `CODE_SIGN_ENTITLEMENTS` 写死 App Group，免费 Apple ID 不支持 App Group，手表目标签不过。

约束：和 iPhone App、分享扩展、Safari 扩展一致，权限文件跟 `HIMAWARI_ENTITLEMENTS_SUFFIX` 走，免费签名时清空 `HIMAWARI_APP_GROUP` 并设 `.keychain-only`；不改变付费账号默认行为。云端是 Linux，只能跑 swift test；工程只能在 Mac 上编译，请重点查 pbxproj 的改动是否正确、新权限文件是否会让付费默认签名行为改变。

作者的说法：
- 只改了 `App/Himawari.xcodeproj/project.pbxproj` 里手表和小组件各两处（Debug/Release）的 `CODE_SIGN_ENTITLEMENTS`，新增 `App/Watch/Himawari.keychain-only.entitlements` 和 `App/WatchWidgets/WatchWidgets.keychain-only.entitlements`（空字典），README 补了“手表装到真机”一段。
- 默认（付费）设置下 `HIMAWARI_ENTITLEMENTS_SUFFIX` 为空，路径解析成原来的 `Watch/Himawari.entitlements` 和 `WatchWidgets/WatchWidgets.entitlements`，行为不变。
