# 第 5 轮判断

- r5-1（不成立）：unitOfWork 只在两处使用（production-memory-capture.ts 的 #commit、production-memory-control.ts 的 resolveSensitive），范围内调用的全是走 execute 的 memory.*、memoryCaptureBacklog.*、decisionLedger.* 等端口；commit、markPublished、authority.*、deployment.save、checkpoint 这些 worker 专属写操作没有一处在范围内被调用，找不到可达输入。
- r5-2、r5-4（成立，低，已写进 ADR 0240 决定 4）。
- r5-3（不成立）：复核材料的措辞问题，仓库 ADR 已按代码写（范围外读不等待）。
- r5-5（不成立，与 r2-7 同一理由）：入队失败时同样的写通道和磁盘余量检查也会让保存失败，错误经 onFailure 上报，不是静默丢失。
- r5-6（成立，低，已修）：close() 先等进行中的范围结束再关；新测试在旧代码上失败。operationalStatus 是只读状态查询，不影响范围。
