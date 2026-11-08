## 结论

未发现由这次合并（27fe36c8 + 2ef9c633）或本 PR 带来的“会出错”问题。作者关于“27fe36c8 只改账本”“2ef9c633 是干净的 main 合并”“package.json 两项仍正确”的说法，与代码一致。

## 读代码证实的

**1. 合并没有丢改动、也没有手工改动**

`git diff 2ef9c633^1..2ef9c633 --name-only` 正好是 main 带来的 23 个文件（package.json、`test_rollback.py`、两个 test/tooling 文件、PR#271 账本）；`git diff 2ef9c633^2..2ef9c633 --name-only` 正好是本 PR 的 16 个文件（check 脚本、测试、package.json、PR#272 账本）。两边都只是各自父提交的增量，没有额外文件，说明合并结果等于两边的并集。`27fe36c8` 相对 `eaf17857` 只改了 `.agents/reviews/pr-272/usage.jsonl`。

main 带来的改动里没有任何 `packages/**`、`apps/**` 的源码（`git diff 27fe36c8..bc380a6e -- packages apps` 无输出），所以不会新增/删除/移动四个拦截函数的调用点，也不会新增外部出口地址。

**2. package.json 两项正确**

- `package.json:27` 的 `check:steps` 同时含有 `check:egress-redaction` 和 main 新增的 `check:delivery-deploy/rollback/cleanup`、`check:untested-claims`，且这些键在 `package.json:42-45` 都有定义，对应脚本文件都存在（`scripts/delivery-mode/test_deploy.py`、`test_release_cleanup.py`、`test_untested_claims.py`、`test_rollback.py`）。
- `package.json:48`：`"check:egress-redaction": "node scripts/check-egress-redaction.mjs && vitest run --config vitest.workspace.ts --project tooling test/tooling/egress-redaction-check.test.mjs"`，测试文件存在；`ci/policy.json` 的 `tooling` 项目 include 为 `test/tooling/**/*.test.mjs`，能被拾取。
- `test/tooling/run-all-checks.test.mjs:54-63` 断言这五个 delivery 脚本名与命令，与合并后的 package.json 完全对得上。

**3. 登记表与调用点逐文件核对，全部一致**

`SENSITIVE_GATE_CALLS`（`scripts/check-egress-redaction.mjs:92-255`）共 27 条。逐条用源码匹配核对，计数全部相等，例如：

- `automatic-memory-service.ts`：`scanMachineSecrets` 在 78、104、278、303 行，4 次，登记 4。
- `pi-host-publication.ts`：`containsToolOutputSecret` 在 139、161 行（2 次），`scanMachineSecrets` 在 154、160、193 行（3 次），登记 2/3。
- `exa-public-search.ts`：121、217、251、320 行，4 次，登记 4。
- `production-muse-intake.ts`：392（scan）、393/457（containsRestrictedIdentifier）、457（containsToolOutputSecret），登记 1/2/1。

所有在 `packages/**/src`、`apps/**/src` 下出现这些调用的文件都在登记表里；`packages/sensitive-capture/src` 与测试文件按脚本规则被跳过（`:377`、`:279`）。没有发现登记了但已无调用的条目（`:399-403` 的反向检查）。

**4. 外部出口、必需出口调用一致**

`ALLOWED_EXTERNAL_EGRESS_FILES`（`:73-79`）三个文件都存在且仍含对应地址：`typesafe-jev-transport.ts:364 /v1/systemone`、`exa-public-search.ts:18 https://mcp.exa.ai/mcp`、`deepseek-web-provider.ts:83,132 /v1/tools/...`；其他命中都在测试文件里（不含 `/src/`）。`REQUIRED_REDACTION_CALLS`（`:8-16`）的四个必需字符串在当前源码中都还能找到（`pi-runtime-adapter.ts:1006,1034`、`pi-model-transport.ts:314`、`embedding.ts:194`）。`EGRESS_PATTERNS` 命中的 `src` 文件只有这三个登记文件。

**5. 文档不一致（低，非本次改动引入）**

`docs/adr/0146-redact-sensitive-text-before-it-leaves-for-any-model.md:43` 写测试在 `packages/application/test/egress-redaction.unit.test.ts` 与 `packages/runtime-pi/test/egress-context.unit.test.ts`；仓库中这两个文件不存在（`glob` 无结果），实际是 `model-egress.unit.test.ts`、`egress-himawari-text.unit.test.ts`、`egress-real-pipeline.unit.test.ts`。docs 不在本次两个 diff 里，属既有漂移，不会让检查失败，但与“规则/文档和代码一致”要求不符，建议顺手更正或补回文件。

## 推测 / 未核实

- 我无法执行脚本，以上“检查会通过”是从源码逐项静态核对得出的，不是跑过 `npm run check:egress-redaction` 的结果。
- 设计层面的两个缺口（当前不报错，仅供参考）：`ALLOWED_EXTERNAL_EGRESS_FILES`/`ALLOWED_EGRESS_FILES` 只有“代码→登记表”方向的校验，登记表指向的文件若不再包含该地址不会被报出来；`:272` 对必需文件直接 `readFileSync`，文件被删除/改名时会抛异常而不是输出一条可读的违规。二者都不是本次合并造成的。

## 侧重检查

- 错误路径：`findEgressViolations` 读登记文件无异常处理，缺文件会抛 ENOENT（见上，当前文件都在，不会触发）。`registryViolations` 对缺 `calls` 的登记行会报违规而不崩溃，并有测试 `egress-redaction-check.test.mjs:254-266` 覆盖；`gateCalls()` 对 `calls: undefined` 返回 `{}`，不会崩。
- 不可信输入：该脚本只读本仓库自己的文件，不处理外部输入；无命令执行、无网络。
- 安全：登记表按“文件+模式名”放行，未登记文件的新出口会被 `:298-304` 拦住；对已登记文件内新增同类出口仍会放行（按模式名粒度），不是本次合并引入的问题。
- 资源耗尽/不可撤销操作：只有递归遍历和整文件读取，无删除、无写入、无外部副作用；`sourceFiles` 跟随 `statSync` 符号链接，理论上有环风险，但当前仓库无此类目录，未触发。
- 规则/文档一致性：见上面第 5 条（既有、低）。

## 必答问题

1. **不会改变模型已见过的请求开头。** 本 PR/合并只改 CI 脚本、测试、package.json 和复核账本，没有改系统提示、工具定义、历史消息、遮盖实现或任何请求组装代码；因此也不涉及“只在末尾追加/每轮变化值放最后一条消息”的落实问题。
2. **不会让同一段文字在不同请求里变成不同字节。** 改动没有进入运行时发送路径，没有依赖前后文的遮盖、时间字段或无序集合变化；`readdirSync` 的遍历顺序只影响本地检查控制台输出顺序，不影响任何发往模型的字节。
3. **有对应自动检查，反向用例存在且逻辑上会失败。** `check:egress-redaction` = 静态脚本 + `test/tooling/egress-redaction-check.test.mjs`，并已挂在 `check:steps`。反向用例（`egress-redaction-check.test.mjs:35-46,55-61,148-164,201-220,293-300`）分别覆盖漏掉脱敏、未登记出口、未登记外部出口、新增/多出拦截调用、登记残留；我核对后这些用例确实会产出对应违规信息。未实际执行（工具受限）。
4. **改动涉及的每个值，两端都能接受。** 登记表 27 条的文件路径/调用数、必需调用字符串、外部出口 `(文件, 模式名)`、`EGRESS` 允许表、以及 `check:egress-redaction`/`check:steps`/四个 delivery 键，均已逐一在“产生方”（源码调用点、package.json 定义）与“使用方”（`findEgressViolations`、`findSensitiveGateViolations`、`run-all-checks.mjs`、`run-all-checks.test.mjs`、`vitest.workspace.ts` 的 tooling include）两端核对，没有发现对不上的地方。
