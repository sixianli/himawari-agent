PR 540 是手机端（Swift）：导出打包好后，用设备签名的 GET 取回压缩包（服务端路由在已合并的 PR 538：GET /api/device/v1/data-export/archive?exportId=… 和 files/content/{fileId}），页面上有“存到文件”（fileMover）和“发到别处”（ShareLink）两个按钮，设置里导出入口放出（SettingsRootView.exportDownloadAvailable = true）。

目标：已打包好的导出能在手机上存到“文件”或分享出去；取回失败时有提示，不留半截文件。

约束：
- 只做读，不过面容（导出包只能由已过面容的 data.export.start 产生）。
- DeviceTransport 新增 download，带默认实现（501）让现有测试替身照常编译；真实实现走 DeviceHTTPClient.send 的 GET。
- 文件编号的冒号和斜杠先百分号编码（downloadFile）；服务端 PR 538 的白名单只放行路径段里的 %3A，%2F 必须被拒（404）。
- 没有代码注释；界面数值用 DesignTokens/Layout；Swift 本机不能编译，由 Mac 线程编译和跑测试（已验：swift test 全过，iOS 和 Mac 编译通过）。

作者的说法：
- 打包好后页面自动取回压缩包（task id 是 downloadPath），取回前两个按钮不可点；失败弹出“没办成”提示。
- 临时文件写在 temporaryDirectory 下以 UUID 命名的目录里，文件名取 fileName 的最后一段。
- 本 PR 不改服务端，文件列表里“点开文件”的入口不在本 PR。
