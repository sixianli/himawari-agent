# PR 601 材料：收听的音频会话不再压掉整机震动

## 问题与目标
Andy 装新版后所有应用（包括键盘）的震动都没了，把 Himawari 划掉后恢复。根因：`AudioCapture.configureSession` 把会话设成 `playAndRecord`，没有打开 `setAllowHapticsAndSystemSoundsDuringRecording`，系统在录音会话激活期间压掉整机触感；`UIBackgroundModes` 含 `audio`，切到别的应用会话仍活着。会话只在“收听”开着时激活（ListenEntry → ListeningController.start）。

## 改动
- 设类别之后、激活之前打开允许触感和系统提示音。
- `holdsSession` 标记；`AudioCapture.deinit` 在仍持有会话时停引擎并 `setActive(false)`；`restart` 重新激活时置位，`stop(deactivate: true)` 清除。
- `ListeningController.start` 在新建采集前先释放旧采集；`tearDown` 释放后把 `capture` 置空。
- 新增 `test/tooling/ios-audio-session-haptics.test.ts`（读源码的守卫）；事故清单 I-111。

## 约束
- 不写代码注释；不能在 Linux 编译 iOS 目标，要 Mac 编译；不能真机验证系统行为。

## 侧重检查
tearDown 置空 `capture` 后，`handle(.interruptionEnded)` 的 `capture?.restart()`、`liveState`、`inEar` 的 `capture?` 读取是否会因为提前为空而改变行为；`deinit` 里访问 `engine.inputNode` 是否安全；`start` 先停旧采集会不会影响正在收听时再次进入 `start`（`.resume`）的路径；是否还有别的路径会让会话在不收听时保持激活。
