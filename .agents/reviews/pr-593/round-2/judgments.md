# PR 593 第 2 轮判断（deepseek-v4.1-flash）

- 1（deepseek-v4.1-flash）成立，会出错，中高：### 1. 高：新增 Swift 调用方没有同步 `ci/operations-pending.json`，`npm run check:operations` 会报 `OPERATION_PENDING_BUT_COMPLETE`。ci/operations-pending.json:20-23 的四项都写着缺调用方；已移出名单，npm run check:operations 通过；触发：check:operations 扫到 clients/apple 里的 Swift 调用方，四个操作却还在 ci/operations-pending.json 的名单里；后果：npm run check:operations 报 OPERATION_PENDING_BUT_COMPLETE，npm run check 红
- 2（deepseek-v4.1-flash）成立，会出错，中高：### 2. 中：完成/不再提醒没有撤销入口，iPhone 上不可撤销；网页有 `reopen`。ProactivePages.swift 原 181-186 只有 done、mute；已加撤销条，调用 reopen；触发：在手机上点完成或不再提醒后反悔；后果：提醒从列表消失，手机上没有办法恢复，网页有 reopen
- 3（deepseek-v4.1-flash）成立，会出错，低：### 3. 低/中：来源数据加载失败没有可用的重试路径，页面还显示“下拉再试一次”。ProactivePage 下拉原只刷新 overview，ProactiveSourcePage 没有 task；已都加上；触发：来源首次读取失败（网络抖动）；后果：来源入口隐藏或来源页只显示加载失败，没有重试，退出重进可恢复，不会给出错误结果；判低理由：只影响来源入口的重试，下拉或重进页面可恢复，没有错误数据或不可逆操作
- 4（deepseek-v4.1-flash）成立，会出错，低：### 4. 低：Insight 打分入口与网页不一致；网页只在 `pushed` 时给打分。网页 proactive-reminders.tsx 174-187 只在 insight.pushed 时给打分；已改成一致；触发：对没推送过的提醒打分；后果：服务器接受这个评分，只是与网页不一致，不丢数据
- 5（deepseek-v4.1-flash）成立，可以更好：### 5. 低：`ProactiveErrors.declined` 把所有未知错误当成用户取消，真正失败会被静默吞掉。declined 与 SettingsStore.isDeclined、TuningEditPage 同一做法，已改为直接复用 isDeclined；行为不变：已知的网络、解码、网关错误都会弹失败，只有面容取消不弹
- 6（deepseek-v4.1-flash）成立，可以更好：### 6. 低：20 条 insight、30 条 decision 是硬编码截断，静默丢弃服务器数据。20 条待处理提醒、30 条检查记录是显示上限，不改变任何值的真假，只是列表长度；服务器的 insights 和 decisions 本身就是有限窗口
- 7（deepseek-v4.1-flash）不成立：### 7. 低：作者说法“来源字段以 `apps/control-center/src/proactive.ts` 为准”与代码不符。代码里没有任何地方声称来源字段出自 proactive.ts；PR 描述里来源操作以 contracts-v2.ts 为准，没有错话，复核材料措辞偏宽，不是代码问题
- 8（deepseek-v4.1-flash）成立，会出错，低：### 8. 低（推测）：`ProactiveDayLimit` 的步进计算在极端快照值下可能整数溢出。Proactive.swift 的 step 与 stepUp 用了普通整数运算；已改为封顶和饱和相加；触发：服务器返回接近 Int.max 的上下限（现在生产的上下限是代码里的小常量，不可达）；后果：Swift 溢出会让 App 崩溃，不是错误结果
