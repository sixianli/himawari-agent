# PR 473 第 2 轮复核判断

模型：DeepSeek V4.1 Flash。费用 0.1088 美元，累计 0.1964 美元。

- **R1** 不成立。不成立：服务端把过了 expiresAt 还没结果的 delivered 改成 result_unknown（report_missing），之后每次 claim 都以 verify 返回，所以本地停在 received/started 的动作最迟在期限后被核对，用例 aLostReportIsOnlyReadBackNeverDoneTwice 走的就是这条路。重装时 actions/open 已经在服务端把它们改成 result_unknown，就算处理到一半崩溃，之后 claim 仍会以 verify 返回，不会漏也不会重做。
- **R2** 不成立。不成立：服务端只重发 queued 和 result_unknown（9A device-action-service claim），已记下结果的动作是终态，不会再下发；被拒（404/409/400 去证据后仍拒）是确定的拒绝，重试只会再被拒，过期后服务端也不会再以 perform 下发。用例 aReportTheServerRefusesIsKeptSoTheActionIsNeverRedone 覆盖。
- **R3** 成立，会出错，中高（模型：中）。读值失败一律当读不回（result_unknown）；状态快照里读失败的项不写。HomeKit 只能在 Mac 上编译，没有自动测试，交 Mac 线程编译时一并核对。
- **R4** 成立，会出错，中高（模型：中）。DeviceHTTPClient 加 correctedNow（按签名时钟偏差校正），App 把它交给执行器。DeviceHTTPClientTests.clockSkewIsCorrectedOnceFromServerTime 断言校正后的时间。
- **R5** 成立，会出错，中高（模型：中）。名字本身和 9A 登记表一致（device_reminder.*）；规格文档的 reminder.* 是旧写法，归 9A/规划线程改。加检查：端到端测试文件里新增一条，把服务端登记表里给 iPhone 的动作名和 Swift 处理器的 names 双向比对，把 device_reminder.create 改成 reminder.create 时失败。这个文件依赖 9A 代码，9A 合并改基线后随 PR 一起提交，合并前必须在。
- **R6** 成立，会出错，中高（模型：中）。三种语言都改成“系统里允许的”分区，并说要点“继续”；测试期望同步改。
- **R7** 成立，会出错，中高（模型：中）。项目规定测试不用假替身，所以不加假 transport；执行器用例对真服务端跑，由端到端测试文件在 CI 里启动（9A 合并后提交）。新增真服务端用例 anActionThatCannotBeReadBackIsNotRedoneWhenChecked（登记一个 readBack none 的会改东西的测试动作），把它标成只读时失败。新建的 snapshot 返回空对象、家庭先检查后写只能在 Mac 上编译，没有 Linux 测试。
- **R8** 成立，会出错，低（模型：低）。整串按 yyyy-MM-dd 或 yyyy-MM-ddTHH:mm 严格匹配，测试补四个坏格式。
- **R9** 成立，会出错，中高（模型：中）。处理器声明自己认的版本（默认第 1 版），版本不认就报“不会做”。测试 aSchemaVersionTheHandlerWasNotWrittenForIsNotDone。
- **R10** 成立，会出错，中高（模型：未标（推测））。创建 HMHomeManager 会触发 HomeKit 授权询问（Apple 行为，未在真机核对，按会出错处理）。改成：用户在说明页点过“继续”之前不创建 HMHomeManager，权限一律报“还没问过”。只能在 Mac 上验证。
- **R11** 不成立。不成立：9A 登记表 contact.update 的 phones/emails 是整份列表（string_list，最多 20 项），详情文字也按整份写出，服务端语义就是替换；读回按同一顺序比较。
- **R12** 不成立。同第 1 轮 S2：审批的设备接口还没上服务端，按 ADR 0257 用确认密钥第二签名；接口上线改基线时对真接口测。
