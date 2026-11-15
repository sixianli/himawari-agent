# PR 593 第 1 轮复核材料

问题：网页有“系统主动提醒”设置（总览、检查记录、来源、校准周报），iPhone 没有。
做法：只在 clients/apple 里加：HimawariCore/Proactive.swift（解码和判断逻辑）、HimawariManage 里的 ProactiveSession（请求）、ProactivePages（界面）、ProactiveStrings（三语言文案）。操作类型、字段名以 packages/gateway-contracts/src/contracts-v2.ts 和 apps/control-center/src/proactive.ts 为准；能力表档位以 packages/gateway-contracts/src/client-capabilities.ts 为准。
作者的说法，请核对：
1. 关开关发 proactive.pause（收紧档，无面容），开开关发 proactive.settings.set（改档，带原有 quietHours 和 importantSenders），载荷和合同一致。
2. 来源只关时发 proactive.source.switch_off，同时改了上限发 proactive.source.settings.set，字段齐全。
3. 检查记录能打什么分的规则（pushed、deferred 可打 useful 或 unneeded，silent 可打 missed，其余不可打）和网页 apps/control-center/src/components/proactive-reminders.tsx 一致；insight 的打分只有 useful、unneeded，且不能清空（服务器对 rate 加 null 会拒绝）。
4. 界面上每个数字都来自服务器字段，没有编造的字段。统计和周报页按协调者通知先不做。
5. 不涉及发给模型的内容，不涉及生产。
注意：SwiftUI 部分只能在 Mac 编译，请肉眼核对类型、成员初始化顺序、结果构建器里的写法。
