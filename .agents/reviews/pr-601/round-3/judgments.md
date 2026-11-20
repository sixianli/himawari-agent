# PR 601 第 3 轮判断（deepseek-v4.1-flash）

- 1（deepseek-v4.1-flash）成立，会出错，低：### 1. [低] “去掉任一处释放测试就失败”与守卫的实际覆盖面不符：`ListenEvalRecorder` 的释放调用没有被检查。I-111 文档第146行写“任一处释放”；测试未读 ListenEvalRecorder.swift；deinit 兜底见 AudioCapture.swift:41-45；触发：读 I-111 的反向说法；后果：去掉 ListenEvalRecorder 里的释放调用测试仍通过，文字说“任一处”偏宽；AudioCapture.deinit 的 holdsSession 兜底仍会释放，不误导做法
- 2（deepseek-v4.1-flash）成立，会出错，低：### 2. [低] `deinit` 守卫只按字符串先后检查，不能证明 `setActive(false)` 位于 `if holdsSession` 之内。test/tooling/ios-audio-session-haptics.test.ts:59-66 按字符先后比较；AudioCapture.swift 当前 setActive 在 if holdsSession 内；触发：把 setActive(false) 移出 if holdsSession 但字符位置不变；后果：守卫偏弱，只有故意改结构才漏检；当前代码正确
- 3（deepseek-v4.1-flash）成立，会出错，低：### 3. [低] `start()` 只停旧采集，不取消旧 observer/periodic 任务；重复进入 `start` 会累积任务（旧代码问题，非本次增量引入）。ListeningController.swift:115-128 start 不取消 tasks；tearDown 才清理；触发：在 listening 状态下直接再次调用 start()；后果：旧 observe 任务和周期任务累积；正常恢复先经 tearDown，UI 入口不会命中；旧代码问题，非本 PR 引入
