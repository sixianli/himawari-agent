# PR 494 第 1 轮判断（deepseek-v4.1-flash）

- 1（deepseek-v4.1-flash）成立，会出错，中高：### 1. 致命（P0）— `--cache runner` 在 CLI 里被解析成绝对路径，所有作业装依赖都会失败。复核的是 5bcd08e67；PR 上 policy 作业已因此失败，786b67125 让 installArguments 原样保留 runner 并补了命令行用例；触发：工作流用 --cache runner 调 install-dependencies.mjs 的命令行入口；后果：installArguments 把 runner 转成绝对路径，cacheLocation 以 .ci-output 规则拒绝，所有作业装依赖失败
- 2（deepseek-v4.1-flash）成立，会出错，中高：### 2. 致命（P0）— 默认不统计覆盖率时 `tests` 不产出 lcov，但策略仍然要求 lcov，汇总必判失败。读 run.mjs 和 aggregate.mjs 证实；tests.outputs 改成 json、artifact，升级函数同步，新增用例核对不统计覆盖率时报告种类覆盖策略声明；触发：普通 PR 上 tests 作业默认不统计覆盖率；后果：报告里没有 lcov，aggregate 按 tests.outputs 报 Missing lcov output，ci/required 每次都失败
- 3（deepseek-v4.1-flash）成立，会出错，中高：### 3. 高（P1）— 初始化/夜间 measure 时 `tests` 把 tooling 计入 projects，和策略声明的 5 个项目不一致，汇总会拒绝。现有用例甚至把 6 个项目写成期望；改为 tooling 照样参与覆盖率统计、失败照样拦，但报告只列 tests 声明的 5 个项目，用例同步改；触发：夜间或初始化时 tests 带 --coverage measure 运行；后果：coverageProjects 带 tooling，报告项目多出 tooling，aggregate 报 Project count set differs from policy
- 4（deepseek-v4.1-flash）成立，可以更好：### 4. 低（P3）— 目标 3 没有覆盖 required 作业的最小依赖安装。汇总作业只装几个小依赖，有意不用 runner 缓存；运行手册已写明这个例外，代码不改
