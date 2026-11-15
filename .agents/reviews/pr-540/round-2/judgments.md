# PR 540 第 2 轮判断（deepseek-v4.1-flash）

- 1（deepseek-v4.1-flash）成立，会出错，中高：### 1、中、ready 后停止轮询，导出过期或服务端 404 时页面永远停在“没能下载”，没有重新打包入口。DataExport.swift:84 ready 早返回、DataExportPage.swift:118 只置 downloadFailed、重新打包只在 expired/failed 分支(:28-31)。修：archiveFile 遇 404 把 stage 设为 .expired，页面自动转到重新导出；加测试 testDownloadingAnExpiredArchiveTurnsTheReadyPageIntoExpired；触发：导出包在服务器上过期或被删后，打开已打包好的导出页（或停在页面等过期）；后果：下载 404 只置 downloadFailed，stage 仍是 ready 且 follow() 对 ready 直接返回，页面只剩“再下载一次”，永远失败，没有重新打包入口
- 2（deepseek-v4.1-flash）成立，会出错，低：### 2、中低、保存成功后重新取回失败会把已成功的保存报成“没能下载”，并留下未清理的临时文件/重复下载。DataExportPage.swift:108-112、DataExport.swift:123-126。已在 fileMover 成功后删掉旧的临时目录；整包进内存和每次重下是上一轮 5 号已判的性能优化，沿用原判；触发：保存成功后重新取回刚好遇到过期或断网；后果：提示“没能下载”而文件其实已存好，文字有点误导；移走后留下一个空的临时目录，tmp 由系统清理；判低理由：只有保存后立刻过期或断网才触发，不丢数据、可重试；过期时现在会转成“已过期、重新导出”页，文字不再误导；空目录在沙盒 tmp 内
- 3（deepseek-v4.1-flash）成立，可以更好：### 3、低、上一轮意见 1/2 的修复没有自动检查；删掉重试或保存后重取，测试仍会全过。测试覆盖面建议；页面级交互没有测试框架，Swift 测试由 Mac 线程跑；本轮为 404 转 expired 新增了会话级测试。沿用第 1 轮 6 号原判
- 4（deepseek-v4.1-flash）成立，可以更好：### 4、低、作者说“失败弹出‘没办成’提示”，当前代码不是弹窗。不是代码错误：第 1 轮修复后失败已改成页内提示“没能下载”加“再下载一次”，只是作者说明里的“弹出提示”措辞过时；更新 brief 说法即可，不动代码
