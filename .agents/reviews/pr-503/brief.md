PR 503 是 iOS 第 11 批的客户端：原生管理页面（记忆、规则、设置里的设备、添加设备、登录着的浏览器、文件、数据导出、它会的本事）。服务端部分（设备签名的网关、能力表、挑战值）已在 PR 426 合并。

目标：页面按已批准的原型实现，所有数值取自 HimawariDesign 的 DesignTokens 和 Layout，没有服务器数据的页面不显示；每个操作按 clients/apple 里的能力表（Generated/ClientCapabilities.swift）决定要不要过面容。

约束：
- 没有代码注释；没有按类型写死的分支；没有用词表猜用户意思。
- 日常和读操作只要设备签名，改和收紧要带一次性挑战值并过面容。
- 导出入口暂时由 SettingsRootView.exportDownloadAvailable 关掉，因为服务器还没有设备签名的下载路由。

作者的说法：
- Mac 上 swift test 169 个通过，iOS 和 Mac 都能编译；设计线程已验收 18 张截图。
- 本事页的开关调用 capability.disable（expectedRevision 取自详情，reasonCode 固定 owner_disabled）；停用后列表重新读取。
- 设置页容器用 containerRelativeFrame 撑满屏幕，让底部按钮贴底。
- 相对时间在中文下数字和汉字间加空格（正则只用于排版，不用于理解用户意思）。
