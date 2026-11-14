**复核范围**：这一轮读了 `5bcd08e..163fa785` 的增量（786b67125、c9be56b17、64b9997b3 及复核记录），并跟读了增量直接影响的 `scripts/ci/install-dependencies.mjs`、`scripts/ci/run.mjs`、`scripts/ci/check-policy.mjs`、`ci/policy.json`、`ci.yml`、`aggregate.mjs`、`local.mjs`、`test.mjs` 及相关测试和文档。核对升级链、工作流汇总端、报告消费端时，检查了 `package.json` 和 `README`，发现两处标识未同步。没有运行测试。

### 1. 高：`npm test` 仍调用已被删除的 `--check coverage`，本地完整测试入口会直接失败

- 文件:行：`package.json:81`、`scripts/ci/local.mjs:28`
- 问题：`local.mjs` 已只接受 `policy/static/build/tests/tooling/security`，但 `npm test` 仍传 `coverage`。命令会在任何构建或测试开始前抛 `CI_LOCAL_CHECK_UNSUPPORTED`。这是 `cf84d0f88` 改 `local.mjs` 时漏掉的旧值；三个增量提交没碰它，但当前 HEAD 仍然存在。
- 证据（读代码证实）：
  - `package.json:81`：`"test": "node scripts/ci/local.mjs --check coverage"`
  - `scripts/ci/local.mjs:28`：`if (check && !["policy", "static", "build", "tests", "tooling", "security"].includes(check)) throw new Error("CI_LOCAL_CHECK_UNSUPPORTED");`
  - `README.md:51`、`README.md:67` 和 `.agents/instructions/test-trigger-timing.md:11` 仍把 `npm test` 当作本地完整测试/覆盖率入口。
- 建议：把脚本改成 `node scripts/ci/local.mjs --check tests`，并同步更新 `README.md:67`；如果本地仍要统计覆盖率，则给 `local.mjs` 增加显式的 `--coverage measure` 透传，而不是继续用已删除的 `coverage` 检查名。另加一条测试，断言 `package.json` 里所有 `local.mjs --check ...` 的值都在支持列表内。

### 2. 高：`npm run test:tooling` 只跑 policy，静默跳过全部 tooling 测试，产生假通过

- 文件:行：`package.json:93`、`scripts/ci/local.mjs:73`、`scripts/ci/local.mjs:83`
- 问题：`test:tooling` 仍是 `--check policy`。policy 作业现在 `projects: []`，`local.mjs` 在 `check === "policy"` 时只执行 `check-policy.mjs` 和工具链校验，只有 `check === "tooling"` 才执行 tooling 测试。因此该命令会通过，但一条 tooling 测试都没跑。README 明确说 `npm run check` 不含 tooling 测试、`npm run test:tooling` 不能省，所以这是会误导人的假通过。
- 证据（读代码证实）：
  - `package.json:93`：`"test:tooling": "node scripts/ci/local.mjs --check policy"`
  - `scripts/ci/local.mjs:83`：`if (!check || check === "tooling") await execute("tooling");`
  - `README.md:55`：“`npm run check` 不包含 tooling 测试，不能替代它”。
  - `scripts/ci/local.mjs:73`：`if (!check || check === "policy") await execute("policy");`，policy 分支不再跑 Vitest。
- 推测：原脚本是借 policy 作业顺带跑 tooling 测试；policy 改为不跑测试后，脚本没有跟着改。
- 建议：改成 `--check tooling`；如果确实需要 policy 校验加 tooling 测试，就在 `local.mjs` 里明确支持一个组合检查，而不是复用 `policy`。同时把这项纳入测试，防止以后再次静默漏跑。

## 侧重检查

- 错误路径：`installArguments` 对未知参数、缺少值仍会 `assert` 失败；`cacheLocation` 对非 `.ci-output` 路径和符号链接仍拒绝；`runCheck` 对 `--coverage` 非 `tests + measure` 组合报 `CI_COVERAGE_OPTION_INVALID`；`runTests` 对非法项目选择报错。以上读代码确认。
- 不合规范/不可信输入：新增的 CLI 值只有 `--cache runner` 被特殊保留，其他值仍按路径解析；`runnerNpmCache` 要求 `GITHUB_ACTIONS=true`、`HOME` 为绝对路径，并拒绝缓存路径上的符号链接。工作流输入仍走 `resolvePolicySource` 的 full SHA 校验。未发现新增的 shell 插值或网络输入。
- 资源耗尽与不可撤销操作：runner 缓存满 7 天整体删除的行为是既有实现，这次只是让 CLI 真正走到它；`execute` 仍有 32 MiB 输出上限和超时；没有新增无界循环。删除缓存是不可撤销的，但运行手册已说明恢复方式。
- 文档与代码一致性：运行手册关于 `ci/required` 用 `install-gate-dependencies.mjs`、仍用工作区缓存的描述与 `ci.yml:401-402` 一致；ADR 0267 背景里的时长说法已删除，剩余 81% 说法有 `.agents/evidence/ci-testing-timing-2026-11-13.md` 支撑。发现的不一致就是上面的 `package.json`、`README` 与 `local.mjs`。
- 作者特别关注的 `measuredCounts`：读 `run.mjs:198-211` 和 `run.mjs:378`，当 `coverage` 命令失败时，`reportedTestCommand` 会先执行 `collect()`，再重新抛出命令错误；`measuredCounts` 可能已被设置，也可能因报告缺失仍为 `undefined`，两种情况下作业都会因命令错误失败。只有命令 exit 0 但报告有 failed/skipped 时，后面的 `CI_TEST_INCOMPLETE:coverage` 才起作用。工具链/测量失败仍会让作业失败，这一点成立。
- `tests`/`tooling` 的升级链：读代码和测试确认，旧七作业 `coverage` 写法（policy 带/不带 tooling、coverage 带全部六项目、输出含 lcov）会升级到当前八作业形状；当前八作业原样返回；少 integration、少 lcov、coverage 放到 ARM、required 不等 coverage 等写法被拒；九作业旧链先经 `upgradeRetiredTestChecks` 再经 gate/arm/coverage 升级，测试也这样断言。
- 未核实：作者说的五个测试文件 1184 个用例通过、`check-policy --base origin/main` 通过，以及任何实际命令运行结果；本轮只读了代码。

## 必答问题

1. **不会改变模型已经见过的请求开头。** 本次改动全部是 CI 脚本、策略、测试和文档；没有触及系统提示、工具定义、历史消息、遮盖或请求序列化代码，也没有新增每轮变化的值。因此“仍然只在末尾追加、会变的值在最后一条消息里”这条在本改动中不适用，而不是被本次改动破坏。
2. **不会让同一段模型请求文字变成不同字节。** 没有改 prompt 串行化、遮盖或工具顺序。CI 侧新增的 policy 值由固定数组和 `.filter`/固定顺序生成；`new Set([...collection.outputs, "artifact"])` 也只依赖已有数组顺序。安装报告里的 `durationMs`、资源采样等时间字段是既有 CI 产出，不进入模型请求。若问题限定为发往模型的内容，本条不适用。
3. **有自动检查，但覆盖不完整。** 已读到的反向保障包括：
   - `test/tooling/toolchain-lifecycle.test.mjs:457`：如果去掉 `--cache runner` 的特殊处理，`cacheDirectory` 会被解析成绝对路径，断言失败。
   - `test/tooling/runner-orchestration.test.mjs:384-400`：非 measure 时遍历 `ci/policy.json` 的 `tests.outputs`，若仍要求 lcov 会因报告里没有 lcov 失败。
   - `test/tooling/aggregate.test.mjs:328-333`：反向用例现在删除 json 报告和对应证据，会触发 `Missing json output`；之前只删 lcov 的旧用例在非 measure 下不会失败。
   - `test/tooling/policy.test.mjs:1252`、`1311`、`1317` 覆盖七作业升级、拒绝不完整旧写法和反向拒绝。
   - 没有测试检查 `package.json` 中 `npm test`/`test:tooling` 的检查名，所以上面的两处问题没有被自动检查拦住。由于环境限制，我未运行测试，作者列出的 1184 个用例通过无法独立确认。
4. **大多数值两端一致，但 `package.json` 两个使用端没有跟上。**
   - `tests`/`tooling` 在 `ci/policy.json`、`ci.yml`、`aggregate.mjs`、`contracts.mjs`、`local.mjs`、`test.mjs`、`run.mjs` 中的使用基本一致；`tests.outputs=["json","artifact"]` 被 `aggregate` 按“声明必须存在”消费，measure 时额外产生的 lcov 不会因未声明而被拒；`--cache runner` 最终由 `cacheLocation` 的 `if (value === "runner") return runnerNpmCache(env);` 接受。
   - 不一致的两个值：`package.json:81` 的 `coverage` 被 `local.mjs` 直接拒绝；`package.json:93` 的 `policy` 虽能通过 `local.mjs` 的允许列表，但语义已从“policy 顺带跑 tooling”变成“只校验 policy”，下游工具无法识别这个语义变化。这正是 I-73 类问题：只检查值能被解析还不够，还要核对它在每个调用点的含义是否仍成立。
