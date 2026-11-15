## 先核对作者说法

- 意见 1（`check-lint.mjs` 本体没有测试）**已修**：`test/tooling/layer0-hooks.test.mjs:181-205` 用同一循环覆盖 `check-format.mjs` 和 `check-lint.mjs`，断言参数、退出码、`LINT_CHECK_UNAVAILABLE`。
- 意见 3（I-100 引用的用例名不符）**已修**：`docs/incidents-and-gates.md:134` 的三个用例名与测试文件实际标题逐字一致（模板标题展开后一致）。
- 意见 2（`npm run lint` 不透传参数）**确实未改**：见下面问题 1。
- “16 个用例全过”：我数了 `layer0-hooks.test.mjs` 的 `it`，正好 16 条，与说法一致；实际未运行。

## 读代码确认的问题（按严重度）

1. **低 | `package.json:79`、`scripts/check-lint.mjs:5,13` | `npm run lint` 不再透传额外参数**
   - 证据：
     - `package.json:79`：`"lint": "node scripts/check-lint.mjs",`
     - `scripts/check-lint.mjs:5`：`export const LINT_ARGS = ["lint", "--error-on-warnings", "--diagnostic-level=warn", "."];`
     - `scripts/check-lint.mjs:13`：`const result = spawnSync(process.execPath, [biome, ...LINT_ARGS], { cwd: root, stdio: "inherit" });`
   - 问题：改动前 `npm run lint -- --write`、`npm run lint -- <路径>` 会到 biome；现在 `check-lint.mjs` 完全忽略 `process.argv`，参数被静默丢弃。全仓 grep 没有发现现有脚本/文档依赖这种用法，所以不影响 CI 和 `check:steps`，但这是开发者会踩的行为回退，且“静默”比“报错”更难发现。
   - 建议：在默认参数后追加 `process.argv.slice(2)`，或至少在脚本里对多余参数报错并说明；若坚持不支持，补一条明确“多余参数被忽略”的测试，避免以后误以为透传仍然有效。

2. **低 | `scripts/check-lint.mjs:5,7-15` | 导出的 `LINT_ARGS` 无人使用，且模块没有 main 守卫**
   - 证据：`export const LINT_ARGS = ...`（第 5 行），随后第 7-15 行是顶层执行代码并 `process.exit(...)`；全仓没有其他文件引用 `LINT_ARGS` 或 import 这个模块。
   - 问题：这个 `export` 暗示它可被复用，但任何人 `import` 它都会立即运行 lint 并退出当前进程（与 `check-incident-gates.mjs` 的 main 守卫写法不一致）。当前无实际故障，属于后续容易踩的陷阱。
   - 建议：删掉 `export`，或照 `check-incident-gates.mjs` 加 `import.meta.url === pathToFileURL(...)` 守卫。

3. **提示（测试质量）| `test/tooling/layer0-hooks.test.mjs:161-168` | 用例名声称“at push”，实际只校验 `package.json` 字符串**
   - 证据：
     - `expect(scripts.lint).toBe("node scripts/check-lint.mjs");`
     - `expect(scripts["check:secrets"]).toBe("node scripts/scan-machine-secrets.mjs");`
   - 问题：这条用例没有验证 `pre-push` 真的调用这些脚本；真正覆盖钩子调用的是 `:149-159`（`LINT_STUB_RAN`）和 `:229-251`（失败/缺失）。用例名比断言范围大，I-100 又把它列为门槛，容易让人以为它单独保证了“推前跑 lint”。
   - 建议：改名以反映“npm scripts 指向同一脚本”，或在断言里直接读取 `scripts/git-hooks/pre-push` 文本确认包含这三个脚本。

## 推测与未核实

- **未核实**：`.agents/reviews/pr-488/round-1/` 下的 `deepseek-v4.1-flash.md`、`.prompt.md`、`judgments.md`、`verdicts.jsonl` 和 `usage.jsonl` 在 diff 中显示为二进制；按 `.agents/instructions/model-review.md:128`，复核副本用 sparse checkout 加 `-diff` 隐藏这些记录，git 替身也拒绝 `agents/reviews` 参数，所以我读不到内容。是否已按 I-86 规则完成遮盖、是否会触发 `check:secrets`/gitleaks，未核实。
- **未核实**：“删掉 `--error-on-warnings` 新用例失败、恢复后全过”没有实际运行；但读代码可确认 `:195` 逐字比较参数串，删掉该标志必然失败。
- **推测**：`check-lint.mjs` 的 `result.error` 分支（第 14 行）没有被测试直接覆盖；`biome` 缺失走的是第 9-11 行的 `existsSync` 分支，二者不是同一路径。影响很小。

## 侧重检查

- **错误路径**：`biome` 不存在 → 第 9-11 行报 `LINT_CHECK_UNAVAILABLE`、退出 1；`spawnSync` 失败 → 第 14 行打印、第 15 行 `status ?? 1` 退出 1；biome 非零退出码原样透传；被信号杀死时按 1 处理。`pre-push:12-15` 在脚本缺失或失败时统一报 `PUSH_LINT_CHECK_FAILED` 并拦截。均读代码确认。
- **不可信输入**：脚本不接受任何外部输入，额外 argv 被忽略（问题 1）；不经过 shell，biome 用绝对路径 + `process.execPath` 启动，无命令注入面。
- **安全**：不打印环境变量或凭据。唯一安全风险在新增的复核记录文件是否含像密钥的文字（I-86），因读取受限未核实。
- **资源耗尽**：`pre-push` 每次推送新增一次全仓 `biome lint`，会拉长推送耗时；没有循环、没有无界并发。测试用临时目录并在 `afterEach` 清理，无泄漏。
- **不可撤销操作**：`check-lint.mjs` 只读执行；测试只删自己创建的临时目录。无破坏性操作。
- **文档与代码一致性**：`docs/incidents-and-gates.md:134` 中三个用例名实测存在；全仓 grep 未发现旧用例名残留；`check-incident-gates.mjs` 只校验反引号里的仓库路径，I-100 行新增的路径（`scripts/check-lint.mjs`、`scripts/git-hooks/pre-push`、`test/tooling/layer0-hooks.test.mjs`）均存在，不会报 `INCIDENT_GATE_PATH_MISSING`。

## 必答问题

1. **不会改变模型已见过的请求开头。** 全量 diff 只涉及 lint 包装脚本、`pre-push`、测试、I-100 文档行和复核记录；没有任何系统提示、工具定义、历史消息、遮盖逻辑或请求序列化代码被改。发给模型的内容仍由原有逻辑只在末尾追加；本次没有新增“每轮变化”的值。`check:prompt-prefix` 仍在 `check:steps` 中，未改动。
2. **不会。** 新增的都是固定常量：`LINT_ARGS` 是定序数组，脚本路径、错误码、文档文字都是静态的。没有引入时间字段、依赖前后文的遮盖、或无序集合的序列化。文档里的日期是静态文本，不进入请求。
3. **有自动检查，反向用例有效。** `layer0-hooks.test.mjs:189-198` 逐字断言传给 biome 的参数并断言退出码透传，`:200-204` 断言缺 biome 时的 `UNAVAILABLE`；`:229-251` 断言 pre-push 在 `check-lint.mjs` 失败/缺失时拦截；`:149-159` 断言推送通过时 `LINT_STUB_RAN` 出现。删掉 `--error-on-warnings` 会让第 195 行失败；删掉 `pre-push` 的 lint 调用会让第 157 行和后两条用例失败。测试未运行，但反向逻辑读代码成立。残余缺口：`result.error` 分支未覆盖。
4. **逐个使用点核对过，均能接受。**
   - `scripts.lint = "node scripts/check-lint.mjs"`：`check:steps` 经 `run-all-checks.mjs` 按名字调用 `npm run lint`，接受；CI static 走 `npm run check`，接受；测试 `:166` 断言，接受；文档描述一致。
   - 文件 `scripts/check-lint.mjs`：`pre-push:12`、`package.json:79`、测试 fixture 桩 `:48`、共用用例 `:181-205`、失败/缺失用例 `:229-234` 都指向它，文件存在。
   - `PUSH_LINT_CHECK_FAILED`：生产于 `pre-push:13`，消费于测试 `:231`，一致。
   - `LINT_CHECK_UNAVAILABLE`：生产于 `check-lint.mjs:10,14`，消费于测试 `:186`，一致。
   - `LINT_ARGS`：生产于 `check-lint.mjs:5`，消费于 `:13`，测试 `:185` 逐字断言；与改动前的 `package.json` biome 命令一致。
   - 唯一不匹配的“值”是 `npm run lint` 之后的额外 CLI 参数：没有消费者会收到它们（问题 1）。
