**本轮范围**
- 先看 `git diff ed314427…e4e5280d --stat`，再逐行看 `git diff 521247d6…e4e5280d`。增量里的代码改动只有 `install/verify-source-cache-fixtures.mjs` 的 trace 检查；另外 `97319c7` 新增了 review 记录文件。
- 上一轮的 `source-cache.mjs:5` 修复在 `521247d6`，本轮按这次问题的值（`maintenance.auto`）继续核对。
- 实际读过：`source-cache.mjs` 全文、`verify-source-cache-fixtures.mjs` 全文、`test_make_packet.py:1178-1202/1220-1237/1300-1314`、`test_deploy.py:1046-1065`、`review-delegate.test.mjs:24-51/244-249`、`run-hermes-rehearsal.py:79-90`、`docs/adr/0151-ship-incremental-source-bundles-to-a-server-side-cache.md`、`.agents/instructions/prompt-prefix.md`、`docs/incidents-and-gates.md` 的 I-73。
- 未核实：`.agents/reviews/pr-641/round-1/*` 被仓库工具以 `REVIEW_GIT_REFUSED` 拒读，工作树里也不存在，只看到 `git diff` 显示为新增二进制文件，内容未评估。生产机/Hermes 的实际 git 版本未核实；仓库证据 `test/qualification/evidence/isolated-tool-execution/p2-runner-image-01/README.md:72` 记录某一 runner 为 git 2.54.0。

### 1. 低：上一轮意见 3 未改好——其他真实 git 临时仓库仍会启动自动维护
文件:行：`scripts/delivery-mode/test_make_packet.py:1181-1192,1230-1236`、`scripts/delivery-mode/test_deploy.py:1047-1059`、`test/tooling/review-delegate.test.mjs:26,248`
- 问题：`verify-source-cache-fixtures.mjs` 自己的 `git` 包装器加了 `maintenance.auto=false`，但这只覆盖这个 JS 夹具；其他在 `TemporaryDirectory`/`mkdtemp` 里真实运行 `git init/commit/fetch/clone` 的测试没有加。它们同样在测试结束时删除整个临时目录，和 PR 641 修的 `ENOTEMPTY` 是同一类路径。
- 证据（我读到的）：
  - `test_make_packet.py:1185`：`self.git_environment = {**os.environ, ... 'GIT_CONFIG_GLOBAL': '/dev/null'}`，没有 `maintenance.auto`；`:1186-1191` 直接 `git init`、4 次 `git commit`；`:1236` 直接 `git fetch`；`:1197-1198` 用 `TemporaryDirectory.cleanup()` 删除。
  - `test_deploy.py:1047-1059`：`TemporaryDirectory` 里 `git init`、`git commit`、`git clone --bare`，同样没有该键。
  - `review-delegate.test.mjs:26`：`GIT_SETTINGS` 只有 user/commit 设置；`:48` clone、`:248` fetch，根目录由 `mkdtempSync` 创建。
- 建议：给所有“真实 git + 临时目录”的测试统一加 `-c maintenance.auto=false`（旧版本再加 `-c gc.auto=0`），最好封装成共享的 git 包装器，而不是逐处手写。
- 读代码证实的：这些调用确实没有 `maintenance.auto=false`，清理方式也确实是删目录。推测：是否重现取决于 git 版本及是否触发后台维护。

### 2. 低：修复只关 `maintenance.auto`，新守卫却把 `gc --auto` 也算失败，旧 git 上两者不一致
文件:行：`scripts/delivery-mode/packet-template/install/source-cache.mjs:5`、`scripts/delivery-mode/packet-template/install/verify-source-cache-fixtures.mjs:80`
- 问题：修复只加 `-c maintenance.auto=false`；守卫的正则同时把 `git gc --auto` 视为失败。对于还没有 maintenance 子系统、`git fetch` 直接跑 `git gc --auto` 的旧 git，`maintenance.auto=false` 不会被读取，`gc.auto` 仍然生效；此时守卫会报失败，而修复其实没有覆盖这条路径。
- 证据：
  - `source-cache.mjs:5`：`const quietGit = ["-c", "core.hooksPath=/dev/null", "-c", "maintenance.auto=false"];`
  - `verify-source-cache-fixtures.mjs:80`：`/\b(run_command|built-in): .*\bgit (maintenance run|gc --auto)\b/`
- 建议：在 `quietGit`/测试设置里同时加 `-c gc.auto=0`，这样现代和旧 git 的自动清理都会被关掉，守卫和修复范围也一致；或者在测试里明确只检查 `maintenance run` 并说明版本下限。
- 读代码证实的：修复范围与守卫范围不一致。推测：旧 git 上是否真的触发 `gc --auto`、以及生产/Hermes 是否使用旧 git，未核实。

### 3. 低：作者「任何维护子进程出现就失败」与夹具实际覆盖范围不一致
文件:行：`scripts/delivery-mode/packet-template/install/verify-source-cache-fixtures.mjs:71-81`（另见 `:18-29`、`:35-69`）
- 问题：`GIT_TRACE` 只加在 `traced` 缓存的三次操作上（完整包、增量包、checkout）；前面的 seed/empty/wrong/unsafe/loose 等真实 git 操作和源仓库的 init/commit/bundle 都不在 trace 内。正则也只认 `maintenance run` 和 `gc --auto` 两种命令，不是“任何维护子进程”。
- 证据（我读到的）：
  - `:74`：只有 `tracedRun` 设置 `GIT_TRACE: trace`。
  - `:75-77`：只对 `traced` 调用 fetch/checkout。
  - 前面 `:35-69` 的真实缓存操作仍走普通 `run`/`git`。
  - `:80`：过滤模式只有 `git (maintenance run|gc --auto)`。
- 建议：要么把所有夹具 git 调用都走带 trace 的包装器，要么把作者说法收窄为“被 trace 的缓存操作没有出现 `maintenance run`/`gc --auto`”；若要覆盖“任何维护子进程”，至少把 `git maintenance`、`git gc`、`git repack`、`git commit-graph`、`git pack-refs` 等纳入模式并说明。
- 读代码证实的：trace 覆盖范围和正则范围都有限。推测：实际漏掉其他维护命令的可能性取决于 git 内部实现。

### 4. 低（推测）：正向前置检查绑定 `GIT_TRACE` 文件输出和 `run_command:` 行格式，换 git 版本可能无关失败
文件:行：`scripts/delivery-mode/packet-template/install/verify-source-cache-fixtures.mjs:73-79`
- 问题：新增的正向检查要求 trace 文件里同时出现 `built-in: git fetch` 和 `run_command: `。如果某个 git 版本不支持把 `GIT_TRACE` 的绝对值当文件路径，或者 trace 行格式不同，`readFileSync(trace, "utf8")` 会直接抛 `ENOENT`，或者检查项会失败；这不是产品缺陷，但会让构建因环境差异失败。
- 证据（我读到的）：
  - `:73`：`const trace = path.join(root, "git-trace.log");`
  - `:74`：`env: { ...env, GIT_TRACE: trace }`
  - `:78-79`：`readFileSync(trace, "utf8")`，并要求 `/\bbuilt-in: git fetch\b/` 和 `/\brun_command: /`。
- 建议：在夹具启动时先确认当前 git 支持 `GIT_TRACE=<绝对路径>` 和所需格式，或退化为 `GIT_TRACE=1` 收集 stderr；也可以把最低 git 版本写进门槛文档。
- 未核实：旧版 git 的行为；现代 runner 证据是 2.54，`built-in:`/`run_command:` 格式大概率存在。

**侧重检查**
- 错误路径：`GIT_TRACE` 文件缺失/不可读会让夹具在 `readFileSync` 处直接抛异常，而不是产生一条失败的 `check`；如果修复回退，`finally` 里的 `rmSync` 仍可能以 `ENOTEMPTY` 抢先失败，诊断信息会偏向环境错误。另见上面第 2 条的旧 git `gc --auto` 路径。
- 不可信输入：`HIMAWARI_TEST_TEMP_ROOT` 决定 trace 文件位置，但根目录由 `mkdtempSync` 创建，测试环境为 0700，trace 只写在其中；生产侧 `run` 的 `HOME/TMPDIR` 都指向受控 `work`。未发现注入或越权写入。
- 安全：`-c` 参数是硬编码键值，没有拼接外部输入；命令行配置优先级高于仓库/用户配置，能压住缓存仓库里的 `maintenance.auto`。trace 会记录 bundle/cache 路径到临时证据目录，未看到账号、密钥或 token。
- 资源耗尽：trace 文件很小，新增的 `traced` 缓存和 checkout 也是固定小夹具；没有新增无界循环或大文件。后台维护进程资源风险只被部分覆盖（见第 1、2 条）。
- 不可撤销操作：本次增量只加检查和 git 参数，没有新增删除、覆盖或迁移动作；原有 `rmSync` 仍是临时目录清理。
- 规则/文档一致性：`.agents/instructions/prompt-prefix.md:36` 的只追加规则、`:53` 的确定性规则与本次改动无关，未被修改。`docs/adr/0151…:62` 的门槛清单只列了原来的 fixture 用例，没有记录新增的维护 trace 检查；这是文档滞后，不是功能矛盾。I-73 的教训（产生值和使用端必须两端核对）已用于第 4 问的配置键核对。

**必答问题**
1. **会不会改变模型已经见过的请求开头？** 不涉及。本轮代码改动只在 `scripts/delivery-mode` 的 git 配置和测试夹具里，没有碰系统提示、工具定义、历史消息、遮盖结果或任何发给模型的内容，因此不存在“只能末尾追加”被破坏的路径。依据 `prompt-prefix.md:36`，本改动没有可违反它的代码路径。
2. **会不会让同一段文字在不同请求里变成不同字节？** 不涉及。`maintenance.auto=false`、`GIT_TRACE` 路径、trace 行只作用于构建/测试的 git 进程和证据文件，不进入模型请求序列化，也不会影响对话文本的遮盖或序列化。
3. **有没有自动检查，反向用例是否真的会失败？** 有检查，且上一轮意见 1 已改好：`:78-79` 现在要求 trace 里确实出现 `built-in: git fetch` 和 `run_command:`，trace 为空不再静默通过；`:80-81` 在出现维护子进程时失败。反向用例在“被修复的 git 版本确实会自动启动维护”的环境下会失败（作者说 GitHub 的 git 2.56）；但新增的 `:79` 本身在修复前后都会通过，它不是反向用例，真正依赖 `:81`。该检查没有正向控制来证明维护正则能命中，且用户上一轮意见 3 仍未覆盖到其他测试（见第 1 条）。
4. **每个值的使用端都能接受吗？** 读代码核对：`maintenance.auto=false` 在 `source-cache.mjs:5` 和 `verify-source-cache-fixtures.mjs:10` 产生，使用于 `source-cache.mjs:20,23,24,25,29,30,31` 以及夹具的 git 包装器；这些全是 git 子命令，`git -c` 位于子命令前，均能接受。生产 `artifact-install.mjs:32-44` 的 `run` 原样把参数交给 `execFileSync`，没有解析参数列表的地方；`test_make_packet.py:24` 只按文件名登记这些文件，没有内容摘要需要同步。旧版 git 遇到不认识的 `-c` 键：`-c` 接受任意合法的 `section.key`，不会因未知键报错（依据 git 通用行为，未在旧版本实测）；但若旧版本 `fetch` 仍走 `gc.auto` 的 `git gc --auto`，这个键不改变语义，见第 2 条。`GIT_TRACE` 的 `built-in: git fetch`/`run_command:` 在 runner 证据的 git 2.54 上可用；更旧版本的格式和 `GIT_TRACE=<绝对路径>` 支持未核实，存在第 4 条所述失败风险。
