## 结论先行

- 两个提交（`4d5a6e5b`、`61c5a107`）**没有高/中严重度缺陷**。R7-1、R7-2、R7-3、R7-4、R7-5 的主要说法与代码一致；没有发现「真实拒绝会漏判」或「正常输出会误判」的新增路径，也没有发现新的空转断言。
- 有 3 条低严重度/边界问题，和 2 条无法核实的说法。

---

## 读代码证实的问题（按严重度）

### 1. 低：`limitsPath` 为空时 `extraEnv` 仍能接管 `GUARD_ENV`

`scripts/model-review/opencode-review.mjs:611-629`：

```js
...opencodeEnv(parentEnv),
...extraEnv,
PWD: cwd,
...
...(limitsPath ? { [GUARD_ENV]: limitsPath } : {}),
```

`GUARD_ENV` 只有在 `limitsPath` 为真时才写到 `extraEnv` 之后；`limitsPath` 为空时这一整项被省略，`extraEnv` 里的 `GUARD_ENV` 会原样留下。新增用例 `test/tooling/opencode-review.test.mjs:1160-1189` 只覆盖了「有 limitsPath」的情况（1170 行传了 `/work/limits.json`），所以「extraEnv cannot take over the guard path」这句保证在无 guard 的调用上并不成立。

- 现有所有调用方（`selfCheck` 2149、`passthroughProbe` 1904、`reviewOnce` 等）的 `extraEnv` 都不含 `GUARD_ENV`，因此**当前不是可利用漏洞**，属于防御性缺口，不是回归（旧代码这个场景同样是 `extraEnv` 获胜）。
- 建议：无条件显式处理，例如 `limitsPath ? { [GUARD_ENV]: limitsPath } : { [GUARD_ENV]: undefined }`（随后 `delete`），并补一条 `limitsPath: undefined` 的反向断言。

### 2. 低：`review-delegate.test.mjs` 里「统一带 `-c`」的说法略过头，仍有三处重复内联身份

`test/tooling/review-delegate.test.mjs:22` 的 `GIT_SETTINGS` 已经包含 `user.name/user.email/commit.gpgsign`，`run`（32-38 行）每次都会前置它们；但：

- `commitAll` 377 行、`commitCloud` 615 行仍写 `f.run(..., "-c", "user.name=t", "-c", "user.email=t@t", "commit", ...)`；
- merge 用例 436-448 行仍内联 `-c user.name=t` / `-c user.email=t@t`。

结果是同一组 `-c` 被传两遍（值相同，git 取后者，行为不变）。不是错误，但与作者「统一带、原来只给 commit 用的 identity 常量删掉」的描述不完全一致，后续只改 `GIT_SETTINGS` 时容易误以为这三处也覆盖到了。建议删掉这三处内联身份。

### 3. 低（推理不完整）：语言隔离只对 bash 成立，opencode 自己的拒绝话术仍未受保护

`opencodeChildEnv` 通过 `OPENCODE_KEPT_ENV` 把 `LANG`、`LC_ALL` 转给 opencode（`opencode-review.mjs:576-577`），而匹配 opencode 拒绝的模式只有英文：

```js
/^The user has specified a rule which prevents you/,   // 2020
```

R7-1 的 `unset LC_ALL` + `LC_MESSAGES=C`（675-676 行）确实能锁住 **受限 bash** 的消息；git 替身的拒绝由 Node 写死 ASCII（658 行），也不受 locale 影响。但作者「`extraEnv` 里放什么语言环境都盖不过它」这个理由**没有覆盖 opencode 自身输出的拒绝文本**。若 opencode 按 locale 本地化或给该句加前缀，`probeRefused` 会漏判（后果是 `PROBE_NOT_REFUSED`，fail-closed，但会让整轮复核起不来）。opencode 源码不在仓库里，**未核实**它是否本地化。

- 建议：把 `LANG`/`LC_ALL`/`LANGUAGE` 也列入 `opencodeChildEnv` 的受保护键（成本极低），或补一条用真实 opencode 在 `ja_JP.UTF-8` 下拒绝某条命令的用例。

---

## 推测 / 未核实（不当作已证实缺陷）

- **可能漏判：`output` 是空串时 error 被丢弃。** `opencode-review.mjs:367`：
  ```js
  output: String(part.state?.output ?? part.state?.error ?? ""),
  ```
  若真实 opencode 事件对「被拒」是 `state.output === ""` 且 `state.error` 有拒绝文本，`??` 不会回退到 error，`probeRefused` 会看到空串而漏判。这是既有代码、不是本轮引入；真实事件形状未核实（R6-3 已说明集成用例喂的是 `stdout+stderr`，不是真正的 `part.state.output`）。
- **bash 路径含空格时漏判。** 模式 `^(?:\S*\/)?(?:ba)?sh:` 的 `\S*` 不允许路径中有空格；若 `command -v bash` 返回带空格的路径（非 Linux 常见布局），真实拒绝会漏判。本仓库运行环境是 Linux，风险很低。
- **`origin/main` 逐字节相同：未核实。** 仓库没有 `origin/main` ref（`git log origin/main` 报 unknown revision）；只能确认相对给定基准 `1a3a1ef` 到 `b291add7` 该文件未改动（`git diff --stat` 为空）。
- **测试结果未核实：** 不能运行 vitest，作者说的 165/33 条全过、biome/derive 结果未复核。

---

## 侧重检查

- **错误路径 / 拒绝判据：** `REFUSAL_PATTERNS`（2019-2023）三条都行首锚定，`probeRefused`（2025-2028）逐行匹配。我用本轮新增提交的真实形状核对过：提交标题 `REVIEW_GIT_REFUSED --output bash: line 1: x: restricted` 在 `git log -1 --oneline` 里前面有缩略哈希，`git show --stat HEAD` 里提交说明被缩进 4 空格，`Author: f: restricted` 行以 `Author:` 开头，`git blame -L 1,1` 行以提交哈希开头——都不匹配三条模式，所以「正常输出被误判」没有新增路径。
- **不可信输入：** 本轮让测试真的造出危险作者名 `f: restricted` 和含三种拒绝字样的提交说明，并让允许命令（`log/show/blame/status`）走真实 guard；断言仍是 `probeRefused(...) === false`，这正是对行首锚定的真实回归检查，非空转。
- **安全 / 环境优先级：** `opencodeChildEnv` 现在把 `PATH`、`SHELL`、`OPENCODE_CONFIG`、`XDG_CONFIG_HOME`、`GIT_CONFIG_GLOBAL`、`GUARD_ENV` 放在 `...extraEnv` 之后（614-627），逐键值与旧内联对象一致（旧对象在 `git show b291add7:...` 里，`extraEnv` 在最后）。`gitChildEnv` 只保留 `GIT_KEPT_ENV`+`GIT_ENV`，`GIT_EXTERNAL_DIFF`/`GIT_CONFIG_COUNT` 被剥掉有单测 `opencode-review.test.mjs:1231-1242` 兜底，因此 R7-2 的两条安全断言现在是「活」的。
- **不可逆 / 资源：** 两个提交都只动测试与 guard 环境；临时目录都有 `try/finally rmSync`；新增的是一个浅克隆上的普通提交，无生产写入、无网络、无无限循环。`unset LC_ALL` 只影响受限 bash 的消息语言，不改变资源路径。
- **规则/文档一致性：** 本轮两提交没有改 `.claude/rules/prompt-prefix.md`；`docs/incidents-and-gates.md` 的 I-84 条目与 `docs/lessons.md` 已同步移除被删除的 `test/tooling/safe-tool-reason-codes.test.mjs`（白名单现在只有 `thread-execution-state.ts` 一处导出，`thread-execution-projection.ts:29` 改为 import），`package.json:66` 确有 `check:gitleaks`，与 `.agents/instructions/model-review.md:140` 的新说法一致。

---

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

**不会。** 这两个提交只改 `scripts/model-review/opencode-review.mjs` 的子进程环境、guard 启动脚本和两个测试文件，没有改系统提示、工具定义、历史消息或遮盖逻辑，也没有改任何 `buildPrompt`/`reviewConfig` 的内容（`opencode-review.mjs` 本轮只动了 611-629、675-676、732-742 一带）。发给模型的内容仍然只在末尾追加。

顺带核对了本 PR 范围内（1a3a1ef..61c5a107）唯一会改变「模型看到的文字」的 `limitBytes`（`production-sandbox-tool-result.ts:145-168`）：它在 `production-runtime-tools.ts:2103` 生成工具结果时计算，属于新产生的工具结果、随消息追加，不会回头重写历史。每轮变化的值仍在最后一条消息/最后一条工具结果里。

### 2. 会不会让同一段文字在不同请求里变成不同字节？

**不会。** `opencodeChildEnv` 是 `parentEnv`/参数的纯函数，没有时间、随机、上下文相关遮盖；环境对象的键顺序与模型请求字节无关。测试里新增的 `GIT_SETTINGS`/`GIT_ENV` 是常量。`SAFE_TOOL_REASON_CODES` 只是从「两份 Set」改成「一份导出」，使用处（`thread-execution-state.ts:155,161`、`thread-execution-projection.ts:420`）都只做 `.has`，不参与序列化顺序。`limitBytes` 是数值的纯函数。

### 3. 有没有对应的自动检查，反向用例真的会失败？

- **R7-1：** 有。`unset/C` 断言（`opencode-review.test.mjs:1099-1103`）在父进程同时设 `LC_ALL=ja_JP.UTF-8`、`LC_MESSAGES=ja_JP.UTF-8` 的情况下期望 `unset/C`：去掉 `unset LC_ALL` 会得到 `ja_JP.UTF-8/C`，去掉 `export LC_MESSAGES=C` 会得到 `unset/ja_JP.UTF-8`，两条都变红，不是空转。
- **R7-2：** 有，而且现在真的活了。`AGENTS.md` 第 1 行前插锚点 + `git commit --all`（1053-1073）让 `HEAD~1..HEAD` 非空；若 `gitChildEnv` 不再剥 `GIT_EXTERNAL_DIFF`/`GIT_CONFIG_COUNT`，`touch`/`env` 会执行，`git status --porcelain` 或 canary 断言会失败。该剥离本身还有单测 1231-1242。
- **R7-3：** 成立。锚点在 `AGENTS.md` 第 1 行，`git blame -L 1,1` 的作者确实是 `f: restricted`，而 1107-1112 行的允许断言仍要求 `probeRefused` 为 false，能挡住「去掉行首锚定」的回归。
- **R7-4 / 第二提交：** 有。所有会写提交的路径（`fixture` 的 `commit` 54、`revert` 421、`merge` 436-448、`commitAll` 377、`commitCloud` 615）都经过 `run`，而 `run` 现在统一前置 `GIT_SETTINGS` 并带 `GIT_ENV`。没有用例依赖「未签名」或「不同提交者身份」。**没有把已有断言变成永远成立。**

### 4. 新增/修改的每个值，两端都能接受吗？

- `GUARD_ENV`：产生端是 `spend-guard.mjs:3`，消费端 `spend-guard.mjs:58` 读同一个常量，`prepareGuard` 写出的 `limitsPath` 是真实存在的临时文件；测试也从同一模块 import，两端一致（唯一缺口见上面第 1 条）。
- `opencodeChildEnv` 的六个参数键：调用端 `runOpencode`（735-742）全部传入，值与旧内联对象逐键一致（`parentEnv: process.env`、`guardFiles?.limitsPath` 等价）。
- `PATH`/`SHELL`/`OPENCODE_CONFIG`/`XDG_CONFIG_HOME`/`GIT_CONFIG_GLOBAL` 的消费端分别是 guard 目录、guard shell、opencode 配置、config home、git；测试断言值相同，`delimiter` 也来自 `node:path`，跨平台一致。
- `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM`/`GIT_CONFIG_NOSYSTEM`：均为 git 认识的变量，`GIT_CONFIG_NOSYSTEM=1` 在旧版本 git 上也能兜底；无后端/契约校验参与。
- 本改动不涉及 `modelRef` 之类需要后端校验的清单项，没有 I-73 那类「两端校验不一致」的问题。
