# PR 601 第 2 轮判断（deepseek-v4.1-flash）

- 1（deepseek-v4.1-flash）成立，会出错，中高：### 1. [中] I-111 说守卫“在 `npm run check` 的测试里”，但 `npm run check` 并不会运行这个新测试。package.json:27 的 check:steps 无 test:tooling；该测试只在 test:tooling 和 CI tooling 作业跑；已把 I-111 改成如实写法；触发：按 I-111 写的做法在提交前只跑 npm run check；后果：check:steps 里没有 tooling 项目，守卫不会跑，文档却说它在里面，人会误以为已被门槛覆盖
- 2（deepseek-v4.1-flash）成立，会出错，中高：### 2. [中] “换新采集前先释放”这条反向用例实际不会失败。已复现：把 start 里该调用改名后旧测试写法会通过；现测试先断言存在，改名后失败（本轮已跑变异）；触发：删掉 ListeningController.start() 里换新采集前的 capture?.stop(deactivate: true)；后果：indexOf 返回 -1 小于 AudioCapture() 的索引，测试仍通过，I-111 声称的反向失败不成立，旧采集的会话释放没被守住
- 3（deepseek-v4.1-flash）成立，会出错，低：### 3. [低] 守卫没有检查 `holdsSession` 的置位/清除，`deinit` 的“丢弃即释放”并未真正被验证。新增断言 configureSession/restart 置 true、stop 清 false、deinit 里 setActive(false 在 if holdsSession 之后；变异删置位和清除均失败；触发：删掉 holdsSession 的置位或清除行；后果：deinit 的丢弃即释放分支失效而测试仍通过，只是守卫偏弱，不影响运行行为
- 4（deepseek-v4.1-flash）成立，会出错，低：### 4. [低] “会话只在‘收听’开着时激活”与代码不符：评测录音也直接激活会话，且可能不受收听生命周期约束。ListenEvalRecorder.swift:82-83 调 AudioCapture().configureSession()；ListenEvalKitView.swift:56 在页面消失时调 recorder.stop()，释放有保证；已改文字；触发：读 I-111 的现象描述；后果：“只在收听时激活”不准，评测录音也经 AudioCapture 激活，但同一 configureSession 已开触感，不误导做法
- 5（deepseek-v4.1-flash）成立，可以更好：### 5. [低] （推测）`restart()` 不重新设置 haptics 允许值，打断后是否能保持未核实。推测，无文档或真机证据显示打断后会话级触感设置被清掉；restart 里再设一次是幂等的小加固，Swift 无法在本机编译，留给 Andy 决定，真机上打断恢复后试键盘震动即可验证
