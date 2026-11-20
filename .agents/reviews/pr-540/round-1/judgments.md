# PR 540 第 1 轮判断（deepseek-v4.1-flash）

- 1（deepseek-v4.1-flash）成立，会出错，中高：### 1、高、fileMover 移走唯一的临时压缩包后，分享和再次保存仍指向旧 URL。DataExportPage.swift fileMover 完成回调为空，archive 不更新；移动成功后 URL 失效。改为移动成功后清空并重新取回；触发：点“存到文件”完成后再点“发到别处”或再存一次；后果：fileMover 移走唯一的临时包，archive 仍指向已不存在的旧 URL，分享和再次保存失败
- 2（deepseek-v4.1-flash）成立，会出错，中高：### 2、中、下载失败后没有重试入口，两个按钮会一直不可用。审查头 4be208e6e 确实如此；c0be1454c 已加 downloadFailed 分支和“再下载一次”按钮（DataExportPage.swift fetchArchive/ready），失败不再锁死；触发：取回时断网或 404；后果：两个按钮一直不可用，无重试
- 3（deepseek-v4.1-flash）成立，可以更好：### 3、中、下载后不校验 `sha256`/`sizeBytes`，坏包会被当成成功保存/分享。URLSession 在 TLS 上截断会抛错，完整但错误内容无现实触发路径；校验 sha256 是加固，不是现有错误
- 4（deepseek-v4.1-flash）成立，可以更好：### 4、中、临时导出包从不清理，敏感内容长期留在 temporaryDirectory。临时目录在 app 沙盒内，系统会清 tmp；清理和文件保护是加固，不是错误结果
- 5（deepseek-v4.1-flash）成立，可以更好：### 5、中、整包下载到内存并在 MainActor 写盘，最大 512 MB 时会卡界面/吃内存。512 MB 是服务端上限，实际导出远小；写盘放后台是性能优化，不是现有输入下的错误
- 6（deepseek-v4.1-flash）成立，可以更好：### 6、低、自动检查只覆盖参数编码和 404 映射，未覆盖真实 URL、写文件、清理和 UI 反向。测试覆盖面建议，不是代码错误；Swift 测试由 Mac 线程跑
- 7（deepseek-v4.1-flash）成立，可以更好：### 7、低、`downloadFile` 把斜杠编码成 `%2F`，但服务端白名单明确拒绝 `%2F`，带斜杠的文件编号必然 404。downloadFile 无生产调用方，生产文件编号 thread-artifact:<uuid> 不含斜杠，%3A 两端都接受；服务端拒绝 %2F 是 PR 538 有意的白名单
- 8（deepseek-v4.1-flash）不成立：### 8、低、演示用 ready 状态注入 `exportId="demo"` 后，页面 `.task` 会走 `follow()` 并转成 failed。c0be1454c 在 follow() 开头加 if case .ready = stage { return }（DataExport.swift:84），演示 ready 页不再轮询转失败
- 9（deepseek-v4.1-flash）成立，会出错，低：### 9、低、设计文档说设备不能发起导出，但代码允许 `data.export.start`，本 PR 还把入口放出来了。apple-device-body-design.md:235 写设备不能发起导出；client-capabilities.ts:207 登记了 data.export.start；触发：读规范的人以为设备不能发起导出；后果：规范与代码不符（capability 表有 data.export.start，本 PR 放出入口），文字误导但不影响运行
