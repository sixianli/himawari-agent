# PR 565 复核材料

## 问题
85c11a949 在 test/integration/product-path-browser.test.ts 的发布验收 describe 里直接写了 `phone.locator(\`${UI.turn}:not(.chat-turn-outgoing)\`)`。test/tooling/release-walkthrough-locators.test.mjs 规定验收里的页面定位只能从 apps/control-center/test/release-walkthrough-ui.ts 的 RELEASE_WALKTHROUGH_UI 取（不允许 `locator(` 后面直接跟字符串字面量），所以 main 上 `npm run check` 的 check:release-walkthrough 失败。

## 改法
在 RELEASE_WALKTHROUGH_UI 里加 `settledTurn: ".chat-turn:not(.chat-turn-outgoing)"`，测试里改成 `phone.locator(UI.settledTurn)`。选中的元素与原来完全相同（apps/control-center/src/components/chat-history.tsx:350 乐观发送轮的 class 是 `chat-turn chat-turn-outgoing`）。

## 约束
只改测试代码，不动产品代码；不写代码注释。

## 作者的说法
- 改后选择器字符串与原来逐字相同，行为不变。
- release-walkthrough.unit.test.ts 不需要新增断言：它不逐项遍历 UI 清单。
- 这个改动不涉及发给模型的请求。
