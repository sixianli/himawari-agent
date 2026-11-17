# PR 598 材料：感知设置页的两个小体验改动（接在已合并的 PR 474 之后）

## 问题与目标
1. 日历、通讯录（镜像项）：关开关时弹底部选择——只停同步保留已存的（默认）、停同步并删掉服务器上的（红字）、取消；取消时开关保持开着。来源详情页另有“删掉服务器上的”单独入口，只在开关已关且服务器上还有数据（mirrorCounts > 0）时出现。
2. 位置：保留分两行——“路线：留 N 天”（N 读服务器配置，不写死）和“到过的地方：一直留着，直到你删”，删除入口放第二行旁，只在能力表里有 perception.records.delete 时显示。

## 约束
- 不写代码注释；文案三种语言键一致；删除相关按钮的显示条件沿用能力表。
- 只有 HimawariCore 能在 Linux 上测；SwiftUI 部分要 Mac 编译。

## 侧重检查
SenseDetailView 的开关绑定与两个 confirmationDialog 的状态；SensesModel.serverCopyRemovable 的条件；turnOffAndClear 在“已关”状态被单独入口调用时的行为；三种语言字符串。
