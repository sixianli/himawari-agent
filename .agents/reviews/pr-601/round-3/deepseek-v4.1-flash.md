## 本轮范围与结论

本轮只核对了 `41f5f8019..b5c3518` 的增量：`docs/incidents-and-gates.md` 的 I-111 一行、`test/tooling/ios-audio-session-haptics.test.ts` 的改动（另有复核记录文件）。随后按证据跟读了 `AudioCapture.swift`、`ListeningController.swift`、`ListenEvalRecorder.swift`、`ListeningSession.swift`、`package.json`、`ci/policy.json`、`.github/workflows/ci.yml`、`scripts/ci/{local,run,test-scope}.mjs`、`vitest.workspace.ts`、`scripts/check-incident-gates.mjs` 和 iOS `Info.plist`。没有运行测试，只读代码。

**本轮未发现中高严重度的新问题。上一轮 4 条意见都已实质改好：**

1. **已改好。** I-111 不再说测试在 `npm run check` 里，而是说“CI 的 `tooling` 作业和 `npm run test:tooling`”。我核对了 `.github/workflows/ci.yml:311-340` 的 `tooling` 作业、`package.json:102` 的 `test:tooling`，以及 `ci/policy.json:232-236` 的 `tooling` 项目包含 `test/tooling/**/*.test.ts`；`package.json:27` 的 `check:steps` 确实没有跑完整 tooling 项目。
2. **已改好。** `test/tooling/ios-audio-session-haptics.test.ts:54-56` 现在先断言 `release > -1`，再断言它在 `AudioCapture()` 之前；删掉或后移“换新采集前释放”那一行都会失败。
3. **基本改好，仍有低严重度残留（见下面第 2 条）。** `test/tooling/ios-audio-session-haptics.test.ts:59-66` 已检查 `configureSession`/`restart` 置位、`stop(deactivate:)` 清除，以及 `deinit` 里的 `if holdsSession`。
4. **已改好。** I-111 现在明确写了评测录音 `ListenEvalRecorder` 也经 `AudioCapture` 激活；`ListenEvalRecorder.swift:82-90` 确实调用 `capture.configureSession()`，且全仓库只有 `AudioCapture.swift` 调用 `setActive(true`（见下面第 4 问）。

## 意见

### 1. [低] “去掉任一处释放测试就失败”与守卫的实际覆盖面不符：`ListenEvalRecorder` 的释放调用没有被检查

- **文件:行：** `docs/incidents-and-gates.md:146`、`test/tooling/ios-audio-session-haptics.test.ts:47-57`、`clients/apple/Sources/HimawariListen/ListenEvalRecorder.swift:102,113`
- **问题：** 新文档说“去掉任一处释放……测试失败”，但守卫只读 `AudioCapture.swift` 和 `ListeningController.swift`，完全没有读 `ListenEvalRecorder.swift`。删掉评测录音里的 `capture.stop(deactivate: true)` 后，现有断言仍然全部通过，所以“任一处”这个说法不成立。
- **证据（读代码证实）：** 守卫只覆盖这些位置：
  ```ts
  expect(body(capture, "func stop(deactivate: Bool)")).toContain("setActive(false");
  expect(body(capture, "deinit")).toContain("setActive(false");
  ...
  expect(tearDown).toContain("capture?.stop(deactivate: true)");
  ...
  const release = start.indexOf("capture?.stop(deactivate: true)");
  ```
  而评测录音还有两处独立的释放调用：
  ```swift
  } catch {
      capture?.stop(deactivate: true)      // ListenEvalRecorder.swift:102
  ...
      capture.stop(deactivate: true)       // ListenEvalRecorder.swift:113
  ```
- **推测/影响：** 目前删掉这两处不一定会真的泄漏：`AudioCapture.deinit` 在 `holdsSession` 为真时会兜底释放（`AudioCapture.swift:41-45`），评测录音停止时也会取消 writer 并置空 `capture`。所以这是“文档与测试范围不一致、反向用例覆盖不全”，不是已确认的运行时泄漏。
- **建议：** 要么把 I-111 的反向说法收窄到实际覆盖的路径，要么在守卫里加上对 `ListenEvalRecorder.start` 的 catch 和 `stop()` 中 `capture.stop(deactivate: true)` 的断言。

### 2. [低] `deinit` 守卫只按字符串先后检查，不能证明 `setActive(false)` 位于 `if holdsSession` 之内

- **文件:行：** `test/tooling/ios-audio-session-haptics.test.ts:59-66`、`clients/apple/Sources/HimawariListen/AudioCapture.swift:39-45,74-80`
- **问题：** 新守卫只检查 `if holdsSession` 出现，并且 `setActive(false` 的字符位置在它之后。把 `setActive(false)` 移出 `if` 块、但仍放在后面的字符位置，测试仍会通过。同理，`holdsSession = false` 只检查存在于 `stop(deactivate:)` 内，不检查它是否在 `if deactivate` 内；如果被移到外面，`stop(deactivate: false)` 会在会话仍激活时清掉标记，之后 `deinit` 不会再兜底释放，而测试不会发现（当前没有调用方使用 `deactivate: false`，属于推测的将来回归）。
- **证据（读代码证实）：**
  ```ts
  const dropped = body(capture, "deinit");
  const guarded = dropped.indexOf("if holdsSession");
  expect(guarded).toBeGreaterThan(-1);
  expect(dropped.indexOf("setActive(false")).toBeGreaterThan(guarded);
  ```
  对应的实现是：
  ```swift
  if holdsSession {
      engine.inputNode.removeTap(onBus: 0)
      engine.stop()
      try? session.setActive(false, options: [.notifyOthersOnDeactivation])
  }
  ```
- **建议：** 用现有 `body` 先截出 `if holdsSession { ... }` 这一整段再断言其中包含 `setActive(false`；对 `stop` 也截出 `if deactivate { ... }` 断言 `holdsSession = false` 在其中，而不是只比较整个函数里的字符顺序。

### 3. [低] `start()` 只停旧采集，不取消旧 observer/periodic 任务；重复进入 `start` 会累积任务（旧代码问题，非本次增量引入）

- **文件:行：** `clients/apple/Sources/HimawariListen/ListeningController.swift:120-128,230-243,270-282`
- **问题：** 增量新增的 `capture?.stop(deactivate: true)` 只处理旧采集的音频会话，没有像 `tearDown` 那样取消 `tasks`、结束旧 `pipeline`。如果 `start()` 在已有 `capture` 时再次进入，旧的 `observe` 任务仍持有旧 `AudioCapture` 并永远等待不会结束的 `AsyncStream`，`schedulePeriodicWork()` 还会再追加两个周期任务。增量让“换新采集”看起来是完整替换，但实际只替换了会话。
- **证据（读代码证实）：**
  ```swift
  capture?.stop(deactivate: true)
  let capture = AudioCapture()
  self.capture = capture
  ...
  observe(capture)
  schedulePeriodicWork()
  ```
  `tearDown` 才做完整清理：
  ```swift
  for task in tasks { task.cancel() }
  tasks.removeAll()
  capture?.stop(deactivate: true)
  capture = nil
  ...
  let pipeline = pipeline
  self.pipeline = nil
  Task { await pipeline?.finish() }
  ```
- **推测/可达性：** 正常“暂停后继续”会先经过 `tearDown` 把 `capture` 置空、`tasks` 清空，因此不会命中；只有在 `.listening`/`.interrupted` 状态下直接调用 `start()`，或用户快速重复触发开始时才会累积。当前 UI 的恢复入口主要在暂停后，因此严重度定为低。
- **建议：** 在新建采集前复用 `tearDown` 的清理部分（取消 `tasks`、结束旧 `pipeline`），或在 `start()` 入口对“已在收听”做明确拒绝/转交，避免重复追加任务。

## 侧重检查

- **`tearDown` 置空 `capture` 后的事件行为：** 读 `ListeningSession.swift:89-126`，`tearDown` 只会在 `waitingForOwner`、`stopped`、`off` 时触发；这些状态下 `interruptionEnded` 都落到 `default`，不会把会话重新变成 `listening`。因此 `handle(.interruptionEnded)` 里的 `capture?.restart()` 变成空操作不会产生“会话已停止但状态复活”的回归。`liveState` 只在 `start` 和状态转换到 `listening` 时使用，`tearDown` 后不会用空 `capture` 生成新的 live state。`feed`/`receive` 在 `tasks` 取消且 `session.isCapturing` 为假后也不会继续产生新证据。
- **`deinit` 访问 `engine.inputNode`：** 只在 `holdsSession` 为真时访问，而 `holdsSession` 只在 `configureSession` 成功执行 `setActive(true)` 后置位。按代码看类别已允许输入；但在系统中断/媒体服务重置后或非主线程释放时是否绝对安全，Linux 上无法编译或验证，属于**未核实/推测**，没有足够证据判为缺陷。
- **`start` 与 `.resume`：** 正常恢复路径先经过 `tearDown`，`capture` 已为 `nil`；非正常重复进入的问题见上面第 3 条。
- **其他会让会话在非收听时激活的路径：** 我在 `clients` 下只找到 `AudioCapture.swift` 使用 `setActive(true`；`configureSession()` 的调用方只有 `ListeningController.start()` 和 `ListenEvalRecorder.start()`；`restart()` 只由 `interruptionEnded` 调用，仍属于收听生命周期。`Info.plist` 的 `UIBackgroundModes` 含 `audio` 与文档一致。
- **不可信输入/安全/资源耗尽/不可撤销操作：** 新增测试只读仓库内文件和调用 `grep`，不处理外部输入、不联网；生产改动不涉及凭据或不可撤销操作。资源方面唯一值得留意的是第 3 条的重复 `start` 任务累积。

## 必答问题

1. **不涉及，模型请求开头没有变化。** 增量只改 iOS 音频会话的源码守卫和事故文档，没有触碰系统提示、工具定义、历史消息或遮盖；整个 `ab7070a..b5c3518` 也没有模型请求组装文件。发给模型的内容仍然只在末尾追加，每轮会变的值仍然只应在最后一条消息里，依据 `prompt-prefix.md` 第 1、4 条；这次没有新增反例。
2. **不涉及。** 增量没有改变任何序列化格式、遮盖规则、时间字段或集合顺序；`CapturedBuffer.hostTime` 是既有音频时间戳，不进入模型请求。
3. **有自动检查，但反向覆盖不完整。** 新测试在 `npm run test:tooling` 和 CI 的 `tooling` 作业里运行（已核对 `ci/policy.json` 和 `.github/workflows/ci.yml`），不在 `npm run check` 的步骤里；测试项目 include 也包含它。按源码推断，删除 `setAllowHaptics...`、`holdsSession` 的置位/清除、`AudioCapture.stop`/`deinit` 的释放、`ListeningController` 的拆除/换新释放都会失败；但删除 `ListenEvalRecorder` 的释放调用不会失败（见意见 1）。受工具限制我没有实际执行测试，以上是读代码推断。
4. **增量新增/修改的值都能被使用端接受。** `holdsSession` 是 `AudioCapture` 私有字段，使用端只在同文件内；`setAllowHapticsAndSystemSoundsDuringRecording` 是 iOS 26 目标可用的 `AVAudioSession` API；I-111 门槛里的 `test/tooling/ios-audio-session-haptics.test.ts` 会被 `scripts/check-incident-gates.mjs:73-78` 检查存在且实际存在；该测试也被 `ci/policy.json` 的 `tooling` include 和根 `vitest.workspace.ts` 纳入；`tooling` 作业在 CI 中存在。唯一不一致是“任一处释放”的文档范围与测试实际读取的文件不一致，已在意见 1 单独报告。
