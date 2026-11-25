# PR 611：iPhone 目标的 Bundle ID 改用工程级前缀

问题：付费团队 WS6PVS5YQP 签名报 win.siyi.himawari、.share、.safari 被占用（免费 Personal Team 登记过，删不掉）。

目标：工程级新增 HIMAWARI_BUNDLE_PREFIX = win.siyi.himawari.app（Debug、Release 都加）；主 App、分享扩展、Safari 扩展、灵动岛(.listen-activity)、手表(.watchkitapp)、手表小组件(.watchkitapp.widgets)的 PRODUCT_BUNDLE_IDENTIFIER 引用它；Watch/Info.plist 的 WKCompanionAppBundleIdentifier 等于主 App ID；Mac 目标 win.siyi.himawari.mac、App Group group.win.siyi.himawari、钥匙串分组 win.siyi.himawari.shared 不动。

约束：只能在 Mac 上编译，云端无法编译，请重点查 pbxproj 改动是否正确（引号、变量引用、Mac 目标没被误改、扩展 ID 以主 App ID 开头）。列出的做法只是参考，请从问题本身出发，提出你认为更好的做法。

作者的说法：只改了 pbxproj、Watch/Info.plist、README、scripts/watch-ui-review.sh；Swift 代码里没有写死这个 ID。
