# PR 623 第 1 轮判断（deepseek-v4.1-flash）

- 1（deepseek-v4.1-flash）成立，会出错，中高：### 1. 中：新增的 `prepare-hosted.sh` 和 `apple.yml` 没有对应的自动检查，反向用例也不存在。已加 test/tooling/hosted-ci-setup.test.mjs；触发：以后有人改坏 prepare-hosted.sh 的参数检查或 apple.yml 的草稿跳过条件；后果：没有测试拦下，CI 在托管机器上才暴露
- 2（deepseek-v4.1-flash）不成立：### 2. 中：删掉 `run-share remove` 后，GitHub 缓存没有清理，按运行号无限累积。GitHub 对 7 天没用的缓存自动删除，超过 10 GB 按最久没用的先驱逐，不收费；本次运行刚存的缓存最新，不会先被驱逐；删除缓存要 actions: write，而 ci.yml 要求只读权限。已在 ADR 0287 写明
- 3（deepseek-v4.1-flash）成立，会出错，中高：### 3. 中：规则文件和多份 ADR/设计文档仍在描述旧 CI VPS 和删除共享目录的步骤。已改 test-trigger-timing.md、CI 设计说明，并在 ADR 0287 补修订 0241、0243；触发：线程按 test-trigger-timing.md 或 CI 设计说明去找 CI VPS；后果：照着已删掉的机器和步骤做事
- 4（deepseek-v4.1-flash）成立，会出错，低：### 4. 低：工作流白名单允许 `macos-26`，策略和 schema 仍只认 `macos-15`，`macRunnerLabel` 没有进入策略校验。已统一成 macos-26 并用 macRunnerLabel 校验；触发：以后恢复 macOS 成员；后果：策略写 macos-15 而白名单只认 macos-26，恢复时校验失败
- 5（deepseek-v4.1-flash）成立，会出错，低：### 5. 低：`upgradeSelfHostedRunners` 对混合旧/新标签的基准也会逐成员升级，和既有“只升级完整旧写法”的约定不一致。已改成只有全部是旧标签时才升级，并加反向测试；触发：main 上的基准策略被改成旧新标签混写；后果：混写被悄悄升级通过，而不是被拒
