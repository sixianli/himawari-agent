# PR 488 第 9 轮逐条判断

模型：opencode-go/deepseek-v4.1-flash，费用 0.0568 美元，本 PR 累计 0.6284 美元。

1. 中，成立：`test/qualification/sandbox-production-browser.mjs` 直接监听 pageerror 却在允许名单里。已改用 `collectPageErrors`，删除允许名单。反向：改回直接监听，总门槛用例报出该文件并失败，改回后通过。
2. 中，成立：只要源码里出现函数名就放行。已改成要求调用形态，加“只 import 不调用”的夹具。
3. 低，成立，可以更好：证据目录下的 `.mjs` 也被扫描。被拦下正是想要的，不改。
4. 低，成立：补上 `launchPersistentContext`、`launchServer` 两种写法并加夹具。
5. 低，成立：I-97 行补回“12:27 起点没有查清”。

有中、高意见，修改后再复核一轮（第 10 轮，这是连续第三轮）。
