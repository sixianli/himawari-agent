# PR 512 第 3 轮判断（deepseek-v4.1-flash）

- 1（deepseek-v4.1-flash）成立，会出错，中高：### 1. 中低：Mac 菜单栏仍会把没有绑定串的 reconnect 动作发给服务器，点一次必然 400。MenuBarFeed.swift:29 shownActions 原先不过滤 binding；已改为只取有 binding 的动作，加 MacInputTests.anActionWithoutABindingIsNeverAMenuBarButton，swift test 183 条通过；触发：Gmail 账号 needs_reconnect，服务器给 binding 为 null 的 reconnect 动作，Mac 菜单栏画出按钮用户点击；后果：POST home/act 返回 400，点了没反应；与第 2 轮第 3 条（手表）同一问题
- 2（deepseek-v4.1-flash）成立，可以更好：### 2. 中低：origin 安全校验修好了，但没有任何自动检查，删掉这个条件不会有测试失败。origin 条件已正确生效，缺的是自动测试；AppModel 在 Linux 不构建，抽纯函数加反例是可选改进，不是代码错误
- 3（deepseek-v4.1-flash）成立，会出错，低：### 3. 低：README 说“入口连不上时显示暂时连不上”，但有旧卡片时会继续显示旧卡片。WatchModel refresh 失败只置 homeFailed 不清 home；已改 README 写明沿用旧卡片；触发：读 README 的人以为断网后一定显示暂时连不上；后果：README 与代码不符：有旧卡片时继续显示旧卡片，无害
- 4（deepseek-v4.1-flash）不成立：### 4. 低：作者说“17 条 Linux 测试”，`WatchGlanceTests` 实际是 16 条。17 条是 brief 里作者的说法，不在仓库文件；同第 1 轮第 11 条原判，不影响代码行为
- 5（deepseek-v4.1-flash）不成立：### 5. 低：作者说“main 上服务器还没有 GET home / POST home/act”，但对比基准已经包含这两个入口。是对 brief 里作者说法的核对，不是仓库代码或文档的错；服务器入口已存在于基准，README 只说读同一接口，没有说 main 没有入口，沿用第 1 轮第 1 条原判，不影响代码行为
