# PR 400 第 1 轮复核的逐条判断（DeepSeek、GLM，提交 efd1796e）

成立的都已改，改在提交 aa481374。

- 中（两家）附件标签只认固定格式，旧格式标签会把内部 `ref` 留在正文：成立。改成宽松正则，可选属性、旧标签都从正文移除并进清单，补了旧标签用例。
- 中（DeepSeek）`data inspect` 无保护地解析清单：成立。包了 try/catch，报 `DATA_IMPORT_MANIFEST_INVALID`，补了坏清单用例。
- 中（DeepSeek）`verifyChatExport` 没核对完：成立。补了必需文件、`withheld.texts/threads`、`sealedOriginals`、`file` 必须指向 `chats/*.md`。
- 中（DeepSeek、GLM）大库先全读进内存、上限来得太晚，且 inspect 的 4096 文件上限会拒绝自己的导出：成立。解密前先按密文字节数检查，网页 128 MiB（413，页面提示改用命令行）、命令行 256 MiB；inspect 放宽到 20 万文件 / 2 GiB，导入仍是 4096 / 512 MB；补了 4100 个对话再 inspect 的用例。
- 中（GLM）导出后不自检：成立。`buildChatExport` 返回前跑 `verifyChatExport`；标题长度上限从 schema 去掉（数据库没有对应约束）。
- 低（GLM）前端把缺失响应头读成 0：成立，改成按失败处理，补了用例。
- 低 `CHAT_SEALED_FILE` 常量、`created_at` 路径清理、`originals` 只在有口令时写：成立，已改。
- 低（DeepSeek）检查脚本不含 UI 测试：不改，列给 Andy（UI 测试在 `npm run check` 的单元测试步骤里已跑）。
- 低（DeepSeek）Markdown 正文不转义：不改，列给 Andy；ADR 里已写明这是导出原文的取舍。
