# PR 471 第 1 轮复核：逐条判断

- D1 不成立。复核传的 `--base origin/main` 在开 PR 后已前进；PR 的真实改动是 `e4df6f6d..HEAD` 的 13 个文件（模型自己的三点 diff 也是 13 个），没有回退别的提交。
- D2 成立，会出错，低。WebKit 的消息只有“主机:端口”没有协议；改为页面地址带端口才放过（一个端口只对应一种协议），补反向单测“页面地址没写端口时同主机报错照常记录”。
- D3 成立，会出错，中高。`qualify-control-center-browser.mjs` 断网阶段的预期报错改为要求消息以 `/<夹具主机:端口><那四个路径>` 开头、以 ` due to access control checks.` 结尾。WebKit 资格检查重跑通过。
- D4 成立，会出错，中高（缺用例、说法无对照）。新增场景“卸载前已发出的同源慢请求，再 reload”：WebKit、Chromium、Firefox 各 5 次，原始报错都为空，说明在途请求被取消不报；过滤结果与原始一致。事故记录 I-97 补写这一点。
- D5 成立，可以更好。守卫正则扩到 `on`、`once`、`addListener`、`prependListener`；`waitForEvent` 用于故障注入（等注入的错误发生），不是收集，不算。
- D6 不成立。Chromium、Firefox 本来不产生这种报错，过滤取舍由单测覆盖；记录只声称 WebKit 上要求复现。
- D7 成立，会出错，低。`newContext()` 挪进 try，两个服务器 `await close`；第二个服务器启动失败时先关第一个。
- 推测 1（消息格式）：CI 日志原文就是 `/127.0.0.1:41631/api/gateway/v2/queries due to access control checks.`，本机三种场景同样格式，WebKit 上用例要求复现，格式变了会以 `SCENARIO_NOT_REPRODUCED` 失败。
