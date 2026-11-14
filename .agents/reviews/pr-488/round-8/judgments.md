# PR 488 第 8 轮（合并 main 后）逐条判断

模型：opencode-go/deepseek-v4.1-flash，费用 0.0772 美元，本 PR 累计 0.5716 美元。

1. 中，成立，会出错（中、高）：合并取 main 版本时丢了“启动浏览器的脚本必须收页面报错”的断言。已在 `scripts/browser-page-errors.mjs` 加 `findUnwatchedBrowserLaunches`，用例同时扫描 `scripts/` 和 `test/qualification/`，三个只截图或录像的脚本和 `sandbox-production-browser.mjs` 列入允许名单，另加放入违规文件必须报出的反向用例。反向：把 `scripts/test-mobile-composer-browser.mjs` 的收集调用改名，用例报出该文件并失败，改回后通过。
2. 低，成立：I-101 与 I-97 是同一事故。已删除 I-101 行，I-97 次数改为 3，症状写明第 3 次。
3. 低，成立：`test/qualification/` 已加入扫描。
4. 低，成立：门槛描述改为 `.mjs`、`.js`、`.ts`。

有中、高意见，修改后再复核一轮。
