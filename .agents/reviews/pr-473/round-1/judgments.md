# PR 473 第 1 轮复核判断

模型：DeepSeek V4.1 Flash。费用 0.0876 美元。

- **D1** 成立，会出错，中高（模型：高）。现在只有 home.read 是 none（9A device-action-registry.ts:648），它只读；仍按中高改：处理器声明只读的动作才在核对时重读，其余报 result_unknown。
- **D2** 成立，会出错，中高（模型：高）。只在 recorded 时删除；被拒的保留并标 refused，不再重发，过期后清掉。真服务端用例 aReportTheServerRefusesIsKeptSoTheActionIsNeverRedone，改回旧写法时失败。
- **D3** 成立，会出错，中高（模型：中高）。reopen 返回的一律改成 verify（checkingOnly），编号预先放进 seen。单元测试 checkingOnlyKeepsEverythingButTheMode。
- **D4** 成立，会出错，低（模型：中高）。客户端处理器的名字和 9A 登记表一致（registry 381-648 行：calendar.create、device_reminder.create 等）；设计文档里的 reminder.* 是旧写法，归 9A/规划线程更新。已把示例数据改成真实名字。
- **D5** 成立，会出错，低（模型：中）。现在 9A 对 calendar.create、device_reminder.create 都是 snapshotBefore false（registry 427、588 行）。已改成新建时返回空对象。
- **D6** 成立，会出错，中高（模型：中）。加 30 秒上限，到点返回空并按“读不到”处理；status 复用同一个 HMHomeManager。
- **D7** 成立，会出错，中高（模型：中）。先把所有字段检查完再写；写入中途出错不再当成 DeviceActionFailure，而是走读回核对，报出真实状态。
- **D8** 成立，会出错，低（模型：中低）。已改为读不出过期时间就当过期；单元测试 anExpiryThatCannotBeReadCountsAsExpired。
- **D9** 成立，会出错，中高（模型：中低）。分成三种：还没问过（去 Himawari 设置里点一下）、被拒（去系统设置）、受限（这台设备用不了）。单元测试 notYetAskedAndRestrictedPermissionsSayWhatIsTrue。线程判得比模型高，因为正常使用就会看到错误文字。
- **D10** 不成立。不成立：仓库规则只管颜色和 size/height/width/cornerRadius/opacity（clients/apple/scripts/check-design.mjs:31-34），间距用数字是现有写法（例如 SettingsRootView.swift:35 .padding(.horizontal, 16)）。是作者说明写得过宽，不是代码问题。
- **D11** 成立，会出错，中高（模型：低）。记录文件读得出但解析不了时当成丢失：先 actions/open，再只核对，不重做；读不出（例如锁屏时文件保护）仍然等待，不清空。真服务端用例 aDamagedJournalIsTreatedLikeAReinstall。网络错误吞掉后由下一个事件重试，这是有意的。
- **S1** 不成立。不成立：接口在 9A 分支 claude/project-thread-hv85es 的 packages/platform-node/src/device-api-routes.ts，6 个真服务端用例就是对它跑的。
- **S2** 不成立。审批的设备接口还没上服务端（等 PR 456 合后由 9A 加），手机拿到 404 就不显示审批卡片；按权限审批方案（ADR 0257）用确认密钥第二签名，不用 challenge。接口上线后改基线时对着真接口再测。
- **S3** 不成立。不成立：服务端编号格式就是 dact_ 加 32 位十六进制，DEVICE_ACTION_ID_PATTERN 校验（9A device-action-service.ts 的 report 第 598 行用它）。
- **S4** 不成立。不成立：服务端本地时间格式是 /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/（9A device-action-registry.ts:88 LOCAL_TIME），不带秒。
- **S5** 不成立。这个编号由手机产生、写进镜像，服务端原样送回；格式已告诉规划线程和第 6 批。
