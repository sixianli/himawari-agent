**读代码证实的**

### 1. [中] I-111 说守卫“在 `npm run check` 的测试里”，但 `npm run check` 并不会运行这个新测试
- 文件: `docs/incidents-and-gates.md:146`、`package.json:26-27`、`scripts/run-all-checks.mjs:32`、`test/tooling/ios-audio-session-haptics.test.ts:1-58`
- 问题: 事故条目的门槛一栏写“`test/tooling/ios-audio-session-haptics.test.ts`（在 `npm run check` 的测试里）”，作者材料也这么写。实际 `npm run check` 只按 `check:steps` 逐项运行，里面没有任何一步运行整个 `tooling` 项目；这个文件只在 `npm run test:tooling` 或 CI 的 `tooling` 作业里跑。因此本地按“提交前跑 `npm run check`”的流程不会触发这道门槛，文档对“规定的时机”描述有误。
- 证据:
  - `package.json:27`：`"check:steps": "npm run format:check && ... && npm run check:apple-design && ..."`，没有 `test:tooling` 或这个测试文件。
  - `scripts/run-all-checks.mjs:32`：`const names = stepNames(manifest.scripts["check:steps"]);`
  - `ci/policy.json` 的 `tooling` 项目才包含 `test/tooling/**/*.test.ts`；`npm test` 走的是 unit/contracts/integration/e2e/pi-compat，也不含 tooling。
- 建议: 要么在 `check:steps` 里加一步显式运行这个文件（例如并入 `check:apple-design` 或新增 `check:ios-audio-session`），要么把 I-111 和材料改写成“CI 的 tooling 作业 / `npm run test:tooling`”，不要声称在 `npm run check` 里。

### 2. [中] “换新采集前先释放”这条反向用例实际不会失败
- 文件: `test/tooling/ios-audio-session-haptics.test.ts:53-56`
- 问题: 测试用 `indexOf` 比较先后，但没有先断言旧采集的 `stop` 一定存在。删掉 `ListeningController.start()` 里的 `capture?.stop(deactivate: true)` 后，`indexOf` 返回 `-1`，而 `AudioCapture()` 的索引是正数，`-1 < 正数` 成立，测试仍然通过。这与 I-111 写的“去掉释放，测试失败”不符，最关键的一条释放路径没有被守住。
- 证据:
  ```ts
  const start = body(controller, "public func start() async");
  expect(start.indexOf("capture?.stop(deactivate: true)")).toBeLessThan(
    start.indexOf("AudioCapture()"),
  );
  ```
- 建议: 先 `expect(start).toContain("capture?.stop(deactivate: true)")`，或断言索引 `>= 0` 再比较；最好再断言 `capture?.stop` 在 `AudioCapture()` 之前且同一分支内。

### 3. [低] 守卫没有检查 `holdsSession` 的置位/清除，`deinit` 的“丢弃即释放”并未真正被验证
- 文件: `test/tooling/ios-audio-session-haptics.test.ts:47-52`、`AudioCapture.swift:24,41-45,56-60,74-80,83-89`
- 问题: 测试只检查 `stop`/`deinit` 文本里出现 `setActive(false`，没有检查 `configureSession` 和 `restart` 置 `holdsSession = true`、`stop(deactivate: true)` 清 `holdsSession = false`。把这些行删掉，测试仍然通过，但 `deinit` 的释放分支永远不执行（“采集对象被丢弃时释放会话”失效）。
- 证据:
  ```ts
  expect(body(capture, "func stop(deactivate: Bool)")).toContain("setActive(false");
  expect(body(capture, "deinit")).toContain("setActive(false");
  ```
- 建议: 对 `configureSession`、`restart`、`stop(deactivate:)` 分别断言 `holdsSession = true/false`，并断言 `deinit` 的 `setActive(false` 位于 `if holdsSession` 块内。

### 4. [低] “会话只在‘收听’开着时激活”与代码不符：评测录音也直接激活会话，且可能不受收听生命周期约束
- 文件: `clients/apple/Sources/HimawariListen/ListenEvalRecorder.swift:78-91,94-100,110-118`、`clients/apple/Sources/HimawariShell/RootView.swift:169-172`
- 问题: 除 `ListeningController.start` 外，`ListenEvalRecorder.start()` 也 `AudioCapture()` + `configureSession()`，而 `ListenEvalKitView` 不在 `#if DEBUG` 里，发布版可达。它同样会把会话设成 `playAndRecord` 并激活，所以“会话只在收听开着时激活”是错的。好在新的 `setAllowHapticsAndSystemSoundsDuringRecording(true)` 也在同一个 `configureSession` 里，因此不再会压掉震动；但“不收听时释放会话”仍取决于用户按停止/关闭：`recorder` 的 `writer` 任务在 `start()` 里强引用 `capture`（94-100 行），如果录音器未经 `stop()` 被丢弃，`capture` 不会 `deinit`，新加的 `deinit` 释放也就不会发生（是否能通过手势直接关掉评测页未核实）。
- 证据:
  ```swift
  // ListenEvalRecorder.swift:82-83
  let capture = AudioCapture()
  try capture.configureSession()
  // :94-100
  writer = Task.detached { [weak self] in
      for await captured in capture.buffers { ... }
  }
  ```
- 建议: 要么在事故描述里把“只在收听时激活”改成“收听和评测录音都会激活”，要么在评测页消失时也调用 `stop()`，并让 `writer` 不长期强持有 `capture`（例如用 `[weak capture]` 或结束流），保证采集对象被丢弃时确实能走 `deinit`。

**推测**

### 5. [低] （推测）`restart()` 不重新设置 haptics 允许值，打断后是否能保持未核实
- 文件: `AudioCapture.swift:83-89`
- 问题: `restart()` 只 `setActive(true)`，不再次调用 `setAllowHapticsAndSystemSoundsDuringRecording(true)`。如果系统在打断/停用会话后把这个会话级设置清掉，打断恢复后震动压缩可能回来。该行为没有文档或真机证据，属于推测。
- 建议: 若要彻底稳妥，可在 `restart()` 激活前再设置一次（幂等），或真机验证打断恢复后键盘震动仍在。

**侧重检查**

- `tearDown` 把 `capture` 置空后对 `handle(.interruptionEnded)`：`tearDown` 先 `tasks` 取消，`AsyncStream` 的消费任务会结束，事件不会继续进来；会话处于 `.interrupted` 时 `capture` 仍非空，只有变成 `.waitingForOwner`/`.stopped` 才置空，因此正常流程下不会出现“`.interrupted` 但 `capture == nil` 而跳过 `restart()`”的情况。未见明确问题。
- `liveState`/`inEar`/`capture?.` 读取：`liveState` 在 `start()` 里是在新 `capture` 赋值之后调用；`receive` 在 `session.isCapturing` / `.listening` 守卫下读取 `capture?.currentRoute`，停止后会话状态已不是 `.listening`，未见因置空改变正常行为。仅在途的 `receive` 可能在 await 后赶上 `capture` 置空，属于竞态推测，未在真机核实。
- `deinit` 访问 `engine.inputNode`：只在 `holdsSession == true` 时执行；正常路径下此时 `configureSession` 已成功，`start()` 正常会安装 tap，`removeTap` 对不存在的 tap 一般是 no-op。评测录音里若 `configureSession` 成功后、`capture.start()` 之前抛错，`deinit` 会访问未启动引擎的 `inputNode`，但没有证据表明会崩，未在真机核实。
- `start` 先停旧采集对“正在收听时再次进入 `start`/`.resume`”：会先停掉旧引擎，但旧 `observe` 任务和旧 `pipeline` 没有在这里取消/结束（改动前也没有），要等到 `tearDown` 才取消；重复进入时旧任务会暂时累积。不是本改动引入，但换新采集的路径仍可更完整地收尾。
- 其他激活会话的路径：`ListenEvalRecorder`（见第 4 条）；没有发现第三处直接 `setActive(true` 的 Swift 文件，`ListenEvalRecorder` 是通过 `AudioCapture.configureSession` 激活的。`UIBackgroundModes` 确实含 `audio`（`clients/apple/App/iOS/Info.plist:90-92`）。
- 规则/文档一致性：I-111 的 id 未重复、表格列数按表头为 7 列、门槛路径 `test/tooling/ios-audio-session-haptics.test.ts` 真实存在，`check-incident-gates.mjs` 能从反引号里解析并检查它；但“在 `npm run check` 的测试里”和“去掉释放测试失败”两处与代码不符（第 1、2 条）。

**必答问题**

1. 不会改变模型已经见过的请求开头。本次 diff 只改了 iOS 音频会话、`ListeningController` 的采集生命周期、一个读源码的测试和事故文档；没有改系统提示、工具定义、历史消息、遮盖结果或任何请求组装代码。发给模型的内容没有新增、也没有把每轮变化的值放进开头。依据：[prompt-prefix.md 的只追加规则](../../.agents/instructions/prompt-prefix.md#rules)。
2. 不会让同一段文字在不同请求里变成不同字节。`holdsSession` 只是进程内布尔值；没有新增序列化字段、标识、配置键或需要确定顺序的集合。`setAllowHaptics...` 只影响本机音频会话，不进入模型请求。
3. 有对应的自动检查，但覆盖不完整：新测试确实存在于 `test/tooling`，会被 `tooling` 项目和 CI 的 tooling 作业收集；去掉 `setAllowHaptics...` 那行或去掉 `stop`/`deinit` 里的 `setActive(false` 会让测试失败。但删掉 `start()` 里的旧采集 `stop` 不会失败（第 2 条），删掉 `holdsSession` 的置位/清除也不会失败（第 3 条）；而且它不在 `npm run check` 里（第 1 条）。
4. 逐个核对：`holdsSession` 在 `AudioCapture` 内产生和消费，置位/清除/读取三端一致，未发现类型或语义冲突；I-111 的编号唯一、表格 7 列、门槛路径真实存在且能被 `check-incident-gates.mjs` 校验；新测试文件名匹配 `test/tooling/**/*.test.ts` 的收集规则。唯一不一致的是文档声称该测试在 `npm run check` 里，实际只在 `test:tooling`/CI tooling 作业里。除此之外未发现“清单里的值过不了使用端校验”的问题。
