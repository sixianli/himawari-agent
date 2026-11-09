## 发现（按严重度）

### 低 1：R8-3 声称“opencode 及它启动的一切”都用英文报错，但真实 git 拿不到新加的两个变量

- 文件:行：`scripts/model-review/opencode-review.mjs:568`、`:626-627`、`:636-641`、`:666`；`test/tooling/opencode-review.test.mjs:1226`
- 证据（读代码证实）：
  - `:568`：`export const GIT_KEPT_ENV = ["PATH", "HOME", "LANG", "LC_ALL", "TERM"];`
  - `:626-627`：`LC_MESSAGES: "C",` / `LANGUAGE: "C",`
  - `:636-641`：`gitChildEnv` 只保留 `GIT_KEPT_ENV` 里的键，然后 `return { ...kept, ...GIT_ENV };`
  - `:666`：git 替身调用真 git 时用的是 `env: gitChildEnv(process.env)`。
  - 也就是说，`opencodeChildEnv` 里新加的 `LC_MESSAGES`、`LANGUAGE` 不会进入真 git；真 git 只拿到 `LANG`（以及已删除的 `LC_ALL` 本来也没有）。如果父进程的 `LANG=ja_JP.UTF-8`（新用例自己就是这样设置的），真 git 的 gettext 报错仍可能是日文。测试 `:1226` 的名字是 “opencode and everything it starts report errors in English”，但它只检查 `opencodeChildEnv` 返回的键，没有实际启动任何子进程。
- 影响：当前探针的拒绝来源只有三类——git 替身的 `REVIEW_GIT_REFUSED`（`:663`）、受限 bash 的 `restricted`（`:680-681`）、opencode 自己的话术（`:2025`）。我核对 `probePlan` 里的写/越界探针，没有发现依赖真 git 报错文本的拒绝路径，所以这不会直接造成“真实拒绝被漏判”；但它使作者的说法和测试名不成立，将来若有探针依赖真 git 的错误文本，就会受语言环境影响。
- 建议：把 `LC_MESSAGES`、`LANGUAGE` 加进 `GIT_KEPT_ENV`（或显式把真 git 的 `LANG` 归一到 UTF-8 的英文消息环境）；补一个真正通过 git 替身运行真 git、在 `LANG=ja_JP.UTF-8` 下断言错误为英文的集成用例。

### 低 2：父进程只有 `LC_ALL` 时，删掉它会让字符类不再是 UTF-8

- 文件:行：`scripts/model-review/opencode-review.mjs:626-631`；`test/tooling/opencode-review.test.mjs:1228-1244`
- 证据（读代码证实）：
  - `:631`：`delete env.LC_ALL;`
  - 新用例的父环境同时给了 `LANG`、`LC_ALL`、`LC_CTYPE`，所以它只能证明“有 LANG/LC_CTYPE 时保留”；没有覆盖“只有 `LC_ALL=zh_CN.UTF-8`，没有 LANG/LC_CTYPE”的情况。
- 影响：如果父进程只靠 `LC_ALL` 提供 UTF-8，删掉后子进程只剩 `LC_MESSAGES=C`，没有 `LANG`/`LC_CTYPE`，字符类会退回 C/POSIX。作者“LANG 和 LC_CTYPE 保留，所以字符类仍是 UTF-8”的说法只在父进程本来就有这两个变量时成立。当前探针只检查退出码和拒绝标记，我没有发现这会直接让自检失败；但这是实际的环境语义变化。
- 建议：删除 `LC_ALL` 前，若 `LC_CTYPE` 不存在则把它设为原 `LC_ALL`（或至少加一个“父进程只有 LC_ALL”的用例），不要假设 `LANG`/`LC_CTYPE` 一定存在。

### 低 3：guard shell 的“第二道”没有处理 `LANGUAGE`，测试里的 `viaShell` 也没有隔离它

- 文件:行：`scripts/model-review/opencode-review.mjs:677-683`、`:626-627`；`test/tooling/opencode-review.test.mjs:1104-1110`、`:1120`
- 证据（读代码证实）：
  - `:680-681` 只有 `unset LC_ALL` 和 `export LC_MESSAGES=C`，没有 `unset LANGUAGE`/`export LANGUAGE=C`。
  - 用例的 `viaShell` 用 `env: { ...env, ...extraEnv }`（`:1107`），`env` 只是 `{ ...process.env, ... }`（`:1099-1103`）；如果测试进程自身有 `LANGUAGE=ja`，这个 wrapper 不会覆盖它。
- 影响：生产路径由 `opencodeChildEnv:627` 设置 `LANGUAGE=C` 兜住了，所以生产不必然出问题；但按作者自己“LANGUAGE 优先级更高”的前提，wrapper 单独调用时并不是自足的第二道防线，测试环境也可能因此抖动。
- 建议：wrapper 里再加 `unset LANGUAGE` 或 `export LANGUAGE=C`；测试的 `viaShell` 也显式设置 `LANGUAGE=C`，避免依赖宿主环境。

### 低 4（证明力提示，不是功能缺陷）：新的 locale 断言不再区分“未设置”和“空串”

- 文件:行：`test/tooling/opencode-review.test.mjs:1122-1126`
- 证据：旧断言使用 `${LC_ALL-unset}`，能区分未设置与空串；新断言 `echo "[$LC_ALL]/[$LC_MESSAGES]"` 对两者都打印 `[]`。严格说“证明力不变”不成立。
- 影响：glibc 下空串 `LC_ALL` 与未设置对类别解析是同一回事，所以对语言行为没有实际差别；而且代码 `:680` 确实执行了 `unset`，新用例 `:1240` 也检查了 `"LC_ALL" in env === false`。综合起来覆盖仍够，但新断言单独看是弱化了的。
- 建议：如果在意严格性，可保留一条只检查“键存在性”的断言（例如通过 `opencodeChildEnv` 的返回值），或在测试里用其他不触发 `noTemplateCurlyInString` 的写法确认未设置。

## 侧重检查

- 错误路径：检查了 `probeRefused` 的三个来源、`checkProbeRequests` 的 allowed/write/read 分支、`GitGuard` 拒绝路径与 bash 受限路径；本轮没有发现新增的“拒绝漏判”或“正常输出误判”路径。R8-4 反而把 `output: ""` 时丢掉 `error` 的漏判补上了。
- 不可信/不合规输入：`summarizeEvents` 里的 `output`/`error` 来自事件流，可能任意长、可能非字符串；改成 `||` 后仍用 `String(...)`，长度和类型没有新增资源风险。唯一残留是 `output` 为空白串（如 `"\n"`）时仍会压掉 `error`，真实事件形状未核实。
- 安全：`GUARD_ENV` 不能再由 `extraEnv` 接管；`opencodeChildEnv` 里 `PATH`、`SHELL`、`OPENCODE_CONFIG`、`XDG_CONFIG_HOME` 仍在 `extraEnv` 之后覆盖，未发现新的绕过。`LC_ALL` 被删除，`LC_MESSAGES`/`LANGUAGE` 被固定，未发现可利用的注入点。
- 资源耗尽/不可撤销操作：本轮只改测试和自检环境构造，自检仍在临时副本里运行；没有新增不可撤销操作。
- 规则/文档与代码一致：`prompt-prefix.md` 第 4、10、11 条和 I-73 的要求没有与代码冲突；但 R8-3 的提交说明、测试名与 `gitChildEnv` 的实际白名单不一致（见低 1），“字符类仍是 UTF-8”也只在特定父环境下成立（见低 2）。

## 必答问题

1. **不会改变模型已经见过的请求开头。** 本轮 `0740e100` 的增量只改自检脚本、环境构造和测试，没有改 `buildPrompt`、系统提示、工具定义、历史消息或遮盖逻辑。发给模型的正式复核内容仍然只在末尾追加，每轮会变的值仍由既有的最后一条用户消息承载；规则 `.claude/rules/prompt-prefix.md` 第 4、10 条没有受影响。语言环境变化只影响自检里 bash/git 的诊断文本，属于一次性自检，不是生产复核会话的历史前缀。**未核实**：我没有重新审查此前各轮的全量 prompt 相关改动。

2. **没有引入新的“同一段文字在不同请求里变字节”来源。** 新加的 locale 值在同一个进程/同一轮里是固定的，没有时间字段、无序集合或依赖前后文的遮盖；`summarizeEvents` 的 `||` 只是取值选择，不影响请求序列化。工具输出文本可能因父进程 locale 不同而不同，但在同一轮对话内稳定。**未核实**：真 git 的本地化输出在跨机器/跨父环境时会变，见低 1。

3. **有自动检查，反向用例是有效的，但覆盖不完整。**
   - R8-1：`test/tooling/opencode-review.test.mjs:1214` 在旧代码上会因为 `extraEnv` 的 `GUARD_ENV` 仍在而失败，反向有效。
   - R8-3：`:1226` 在旧代码上会因 `LC_ALL` 仍在、`LC_MESSAGES`/`LANGUAGE` 为日文而失败，反向有效；但它只检查键值，不实际启动进程，见低 1。
   - R8-4：新增用例在 `??` 版本下 `output: ""` 会得到空串，断言失败，反向有效。
   - locale 断言仍能在 wrapper 不 `unset LC_ALL`/不 `export LC_MESSAGES` 时失败；只是不再区分 unset 和空串，见低 4。
   - `review-delegate.test.mjs` 的 33 条：所有会写提交的调用都经 `f.run`（`:33`），`GIT_ENV` 已屏蔽全局/系统配置（`:23-28`），去掉 `GIT_SETTINGS` 或身份会失败，不是空转。
   - **没有发现新增的永远成立断言**；但测试执行结果和我无法运行 `npm test`/`npm run lint`，作者报告的 168 条、33 条和 lint 通过均为**未核实**。

4. **逐个值核对：**
   - `GUARD_ENV`：产生于 `opencode-review.mjs:618`，并在 `:632` 无条件删除无 guard 时的键；消费端 `scripts/model-review/spend-guard.mjs:58-59` 用 `if (!limitsPath) return {}`，接受“键不存在”；`passthroughProbe` 的 `runOpencode`（`:1890`）确实不传 guard，也没有调用方依赖“键存在但为空”。新用例 `:1214` 覆盖了这一点，另一个用例 `:1183` 覆盖有 guard 时不能被 `extraEnv` 覆盖。**接受。**
   - `LC_ALL`、`LC_MESSAGES`、`LANGUAGE`：产生于 `:626-631`；bash wrapper 接受（`:680-681`）；opencode 和 gettext 接受；但 `gitChildEnv`（`:636-641`）不接受后两个，见低 1；只在 `LC_ALL` 提供 UTF-8 的父环境下字符类不再 UTF-8，见低 2。**部分接受，有上述不一致。**
   - `toolCalls.output`：产生于 `:367`；消费端是 `probeRefused`（`:2030-2033`，只接受字符串）和 leak 检查（`:2100` 的 `call.output.includes`）；`String(...)` 保证字符串类型。持久化只写 `toolCalls.length`（`:3048`），原始事件在 `:3026` 原样写入，不经过这个字段。`||` 对 `0`/`false`/`NaN` 会当成假值，但事件模型里这两个字段是文本；**未核实**空白串的情形。**基本接受。**
   - `GIT_SETTINGS`：产生于 `test/tooling/review-delegate.test.mjs:22`，消费端是 `run`（`:33`）；所有提交类命令 `commitAll`（`:375-377`）、merge（`:436`）、`commitCloud`（`:601-603`）都经过 `run`，直接 `execFileSync` 只用于 `init`/`clone`（`:40`、`:44`、`:85`）。原先内联身份也都是 `t/t@t`，没有用例依赖不同的作者身份。**接受。**

### 对作者额外三问的直接回答

- **拒绝漏判/正常输出误判**：本轮没有发现新增路径。R8-4 修掉了一个漏判；R8-1、R8-2 与本问题无关；R8-3 的 locale 变化没有引入新的拒绝文本误判。真实 git 的英文问题属于“说法与测试名不准确”，不是当前探针的拒绝判据失败。
- **空转断言**：没有发现新增的永远成立断言；现有反向用例按代码推演会在旧实现上失败。locale 断言是唯一“证明力变弱”的地方，但不至于空转。
- **`opencodeChildEnv` 逐键变化**：新增 `LC_MESSAGES=C`、`LANGUAGE=C`；删除 `LC_ALL`；`GUARD_ENV` 只在 `limitsPath` 真值时保留，否则删除；其余键与改前一致。没有调用方需要“键存在但为空”：`SpendGuard` 用 falsy 判断，唯一无 guard 调用是 passthrough 探针。
- **关于 `Author: f: restricted` 的模式建议**：如果要容忍路径里的空格又保住行首 shell 名锚点，可以用只允许绝对路径或 `./`/`../` 开头的形式，例如：
  `^(?:(?:\.{0,2}\/)[^\n]*\/)?(?:ba)?sh: (line \d+: )?[^\n]*: restricted`
  它允许 `/work dir/bash`、`./my dir/bash`，但 `Author: f: restricted` 不以 `/`、`./`、`../` 开头，仍不会命中。**该模式我没有运行验证，属建议/未核实。**

**总评：本轮增量没有高、中严重度缺陷，可以继续；建议至少把 R8-3 的说法/测试名改准，或把 `LC_MESSAGES`/`LANGUAGE` 补进 `GIT_KEPT_ENV`，并补一个 `LC_ALL`-only 的用例。**
