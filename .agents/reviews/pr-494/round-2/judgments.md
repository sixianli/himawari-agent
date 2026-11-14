# PR 494 第 2 轮判断（deepseek-v4.1-flash）

- 1（deepseek-v4.1-flash）成立，会出错，中高：### 1. 高：`npm test` 仍调用已被删除的 `--check coverage`，本地完整测试入口会直接失败。package.json 证实；改成 --check tests，README 同步，新增用例核对 package.json 里每个 --check 都是策略里的检查；触发：本地运行 npm test；后果：local.mjs 以 CI_LOCAL_CHECK_UNSUPPORTED 拒绝已删除的 coverage 检查，本地完整测试入口直接失败
- 2（deepseek-v4.1-flash）成立，会出错，中高：### 2. 高：`npm run test:tooling` 只跑 policy，静默跳过全部 tooling 测试，产生假通过。local.mjs 证实；改成 --check tooling，同一条新用例覆盖；触发：本地运行 npm run test:tooling；后果：只跑 policy 校验，一条 tooling 测试都不跑却显示通过
