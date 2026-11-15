# PR 512 第 4 轮判断（deepseek-v4.1-flash）

- 1（deepseek-v4.1-flash）成立，会出错，中高：### 1. 中低：Mac 菜单栏对“只有无绑定串动作”的卡片会变成没有任何按钮、也没有出口的卡片，并继续挡住后面待办。production-home.ts:309-330 单条 reconnect、151 行 binding 为 null；MenuBarFeed.swift:37 mostPressing 原先不看可执行动作；已改为跳过没有可点动作的项，加 MenuBarFeedTests.anItemWhoseOnlyActionHasNoBindingIsNotTheMostPressingCard，swift test 266 条通过；触发：Gmail 账号 needs_reconnect，服务器给只有一条 binding 为 null 的 reconnect 动作，该待办排在最前；后果：Mac 面板显示一张没有按钮的卡片并占住位置，后面的待办不显示
- 2（deepseek-v4.1-flash）成立，会出错，低：### 2. 低：`offerable` 用 URL 原样相等判断“同一服务器”，同一 origin 带不带尾斜杠会被判成不同服务器。WatchGlance.swift offerable 原先用 URL == 比较；已改为 sameServer 归一化 scheme、小写 host、端口，加 theSameServerWrittenTwoWaysIsStillTheSameServer 测试；触发：配对 origin 与手表链接 origin 一个带尾斜杠一个不带，或显式默认端口；后果：同一服务器不弹“给这块手表用吗”，静默不提示，用户仍可手动配对
- 3（deepseek-v4.1-flash）不成立：### 3. 低：作者说“main 上服务器还没有 GET home / POST home/act”，与当前代码不符。是对 brief 里作者说法的核对，不是仓库代码或文档的错；服务器入口已在基准里，沿用第 3 轮第 5 条和第 1 轮第 1 条原判，不影响代码行为
