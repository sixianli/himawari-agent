# PR 484 第 3 轮判断（deepseek-v4.1-flash）

- 1（deepseek-v4.1-flash）成立，会出错，低：### 1、中：新增测试没有真正覆盖“按码点截 64”，退回到按字形截断时测试不会失败。属实：ListeningTests.swift:10-12 只用单码点的“あ”，码点数等于字形数，区分不了；实现已核对为按码点；本轮不改：第 3 轮只剩低问题，且 Swift 在 Linux 上无法编译验证新用例，留给 Mac 线程补国旗类多码点用例；触发：有人把 normalizedHeardName 改回按字形（Character）截 64；后果：测试仍然绿，守不住按码点截断；当前实现本身正确（SpokenCommand.swift:36-43 逐个 unicodeScalar 计数到 64），运行时不出错；判低理由：实现正确，只是测试守不住回退，不影响运行结果，不是正常使用会触发的错误
- 2（deepseek-v4.1-flash）成立，会出错，低：### 2、低：`normalizedHeardName` 没有按服务器的首尾空白校验处理，提交信息“和服务器的校验一致”不成立。属实：SpokenCommand.swift:36-43 不做首尾空白裁剪，服务器 device-api-routes.ts 要求 trim 后相等；生产路径 NameCall.swift:15 已 trim，正常使用碰不到；本轮不改，留给 Mac 线程；触发：有人绕过 NameCall（它已 trim）直接用 VoiceEvidence 公开初始化器传首尾带空白的名字；后果：服务器 value.trim()===value 校验回 400，这一句没有执行，手机回到收听
