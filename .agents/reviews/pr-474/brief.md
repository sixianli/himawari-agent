# PR 474 材料：iOS 第 6 批，感知六项（位置、日历、健康与运动、联系人、照片、剪贴板）

## 问题与目标
苹果端（clients/apple）新增“让 Himawari 感知”：总览页（含“你交给它的”入口行）、首次打开说明、系统授权、已开启的项（今天的条数、保留天数、关掉并删掉）、系统设置里被拒的状态；六项各自的采集器把记录经设备接口 POST perception、POST track、POST mirror 上传；状态、今天、设置、删除经设备网关 v2（PR 426）。

## 约束与作者的说法
- 状态、今天、设置三个操作已在 main 的能力表里；`perception.records.delete` 还不在表里（删除方案等 Andy 定），所以“删掉全部记录”按钮由 `AppModel.phoneOperations` 按能力表决定显不显示，现在隐藏。
- 除 track（默认 90 天）和 surroundings（30 天）外，其余感知记录服务器一直留到主人删，界面写“一直留，直到你删”。
- 日历和联系人是镜像：关掉时要删服务器上的副本，需要确认。
- 开启一项而服务器那项感知是关的，会先开服务器那项，需要 Face ID；关掉不需要。
- 不写代码注释；界面文字走 Localizable.strings（简体、英文、日文键一致）。
- 只有 Linux 上能编译 HimawariCore（192 个测试通过）；界面层已在 Mac 上编译并截图验收（5 屏浅色深色）。

## 侧重检查
HimawariCore 里的 Senses、SenseRecords、SenseUpload、MirrorSync、SensesGateway；HimawariSenses 里 SensesModel 的状态流转（开启、关闭、删除、Face ID 取消）；采集器的权限和后台行为；App/iOS 的 Info.plist 和 entitlements 改动。
