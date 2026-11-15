PR 538 给设备接口加两条设备签名的只读下载路由：GET /api/device/v1/data-export/archive?exportId=… 和 GET /api/device/v1/files/content/{fileId}。原因：手机原来拿不到导出包和文件，网页的下载路由只认网页登录 cookie。Andy 已同意这个方案。

目标：已确认的、签名正确的设备能下载主人自己的导出包和文件；其他情况都拿不到。

约束：
- 认证沿用设备接口其他 GET 的签名（防重放、撤销设备、主人停用都生效）；取内容的逻辑复用网页那两处（DataExportJobs.view、BrowserThreadFiles.content），只换认证。
- 归“读”档，不过面容：导出包只能由已过面容的 data.export.start 产生。
- 没有代码注释；不用词表猜意思；响应头 no-store、attachment。

作者的说法：
- exportId 必须恰好一个且符合 DATA_EXPORT_ID_PATTERN，多余参数、缺参数 400；文件路由不接受查询参数；不存在、过期、别的主人的 404。
- 反向用例在 test/integration/device-download.test.ts。
- 本 PR 只做服务端；手机端的按钮在之后单开 PR。
