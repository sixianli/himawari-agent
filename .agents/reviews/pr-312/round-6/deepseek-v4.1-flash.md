## 结论

这一轮的改动方向正确，四条都基本落实，而且失败方向仍然是 fail-closed。我没发现会“放过真实拒绝”的缺陷；发现的主要问题在**测试的可证明性**和 **R5-2 的实现层级**，都是低到中等，不影响生产。下面按严重度排列。运行结果我无法验证（不允许跑测试），只能核对代码和逻辑。

---

## 问题

### 1. 中：R5-1 的“真实输出”依赖外层仓库当前 HEAD，危险的作者名/标题形状没有被真实输出覆盖

**文件:行**：`test/tooling/opencode-review.test.mjs:1039-1043`、`:1066-1075`

**问题**：集成用例只是 `git clone --depth 3 file://${process.cwd()}`，然后用当前 HEAD 跑 `git show --stat HEAD` / `git log -1 --oneline`。输出内容完全由“这次检出的提交”决定，测试没有构造提交。当前 HEAD 的提交说明里虽然有 `restricted`，但：

- `git show --stat HEAD` 的 `Author:` 行是 `Andy`，不是 R5-3 要防的 `f: restricted`；
- `git log -1 --oneline` 的标题不含任何一段字样；
- 当前提交说明（`git show --format=%B HEAD`）里没有 `REVIEW_GIT_REFUSED`，也没有 `The user has specified a rule...`，只有 `restricted`。

所以作者说“打印的正是这个分支自己的提交说明（含那三段字样）”与代码事实不符：只含其中一段。更要紧的是，将来换一个提交说明/作者，这个用例会**静默失去覆盖**，而它正是 R5-1 用来替代手写字符串的证据。

**证据**：
```js
// test/tooling/opencode-review.test.mjs:1039-1043
const root = mkdtempSync(join(tmpdir(), "opencode-guard-"));
const copy = join(root, "repo");
execFileSync("git", ["clone", "--quiet", "--depth", "3", `file://${process.cwd()}`, copy]);
const guard = installGitGuard(root);
```
```js
// :1066-1075
for (const command of [
  "git log -1 --oneline",
  "git show --stat HEAD",
  "git blame -L 1,1 -- AGENTS.md",
  "git status --short",
]) {
  const allowedRun = viaShell(command);
  expect(allowedRun.status).toBe(0);
  expect(probeRefused({ status: "completed", output: allowedRun.text })).toBe(false);
}
```
**建议**：在 clone 出来的副本里先构造一个提交（`git -c user.name='f: restricted' -c user.email=... commit --allow-empty -m 'bash: line 1: x: restricted'`，正文再放入那三段字样），再跑这些只读命令；这样 `Author:` 和标题里的危险形状才会真实出现。构造提交用真实 git（不经过 `guard.shell`），不会影响 `SHELL_LOG_NAME` 的 10 次计数。

---

### 2. 低：R5-2 的 `LC_ALL: "C"` 作用面过宽，且没有测试证明它真能到达受限 bash

**文件:行**：`scripts/model-review/opencode-review.mjs:2136-2140`、`:713-729`、`:650-658`

**问题**：`extraEnv` 确实被拼进 opencode 进程的 env（`:728`），`LC_ALL` 也在 `opencodeEnv` 白名单里（`:577`），所以从脚本到 opencode 这一段是成立的。但从 opencode 到它启动的 `guard-shell/bash` 这一段无法在仓库代码里核实（opencode 是外部锁定二进制），作者也承认没实测。

另外，`LC_ALL=C` 会同时覆盖 `LC_CTYPE`，作者拒绝把它放进共用 guard shell 的理由（会让真实复核里的 `grep` 对 UTF-8 字符类/忽略大小写变化）正是 `LC_ALL` 带来的；其实只固定**消息语言**而不用改字符类的 `LC_MESSAGES=C` 就够了。

**证据**：
```js
// opencode-review.mjs:2136-2140
extraEnv: {
  [REVIEW_CANARY_ENV]: plan.marker,
  LC_ALL: "C",
  ...(gateway ? gatewayOpencodeEnv() : {}),
},
```
```js
// :650-658
writeFileSync(shell, [
  "#!/bin/sh",
  `echo "$$" >> ${JSON.stringify(join(workRoot, SHELL_LOG_NAME))}`,
  `exec ${JSON.stringify(realBash)} -r "$@"`,
  "",
].join("\n"));
```
**建议**：在 guard shell 包装层用 `LC_MESSAGES=C`（例如 `LC_MESSAGES=C exec "${realBash}" -r "$@"`），这样自检和真实复核的 shell 报错都固定为英文，又不影响 `grep` 的字符类；然后加一条断言：在非 C 的 `LC_ALL`/`LANG` 下，真实受限 shell 的输出仍能被 `probeRefused` 判为 true。当前没有任何测试检查 `LC_ALL=C` 是否生效（集成用例直接 `spawn` guard.shell，env 是 `{...process.env}`，见 `:1045-1055`，并未设置或断言 `LC_ALL`）。

---

### 3. 低：R5-3 收窄后，若 opencode 包装层给工具输出加前缀，旧的 `^\S+:` 能匹配、新的不能

**文件:行**：`scripts/model-review/opencode-review.mjs:2009`、`:362-368`、`test/tooling/opencode-review.test.mjs:1050-1057`

**问题**：`probeRefused` 实际消费的是 opencode `tool_use` 事件里的 `part.state.output`（`:367`），而集成测试喂的是 `result.stdout + result.stderr`（`:1056`），两者不是同一条路径。若 opencode 把 stderr 用类似 `Error: bash: ...: restricted` 的前缀包一层，旧正则 `^\S+:` 还能命中，新正则 `^(?:\S*\/)?(?:ba)?sh:` 不能。方向是 fail-closed（自检失败、复核起不来），但属于这次收窄新增的可用性风险。

关于作者问的“别的真实形状”：
- bash 以完整路径调用：`(?:\S*\/)?` 覆盖（guard 用 `exec <realBash> -r`，报错前缀就是 realBash 路径）；
- 以 `sh` 调用：`(?:ba)?sh` 覆盖；
- 以 `rbash` 调用：不覆盖，但 `installGitGuard` 始终 `exec realBash -r`，不会出现 `rbash:`；
- `sh` 链接到 dash/busybox：guard 用的是 `which("bash")` 的真实 bash，不适用；
- 有空白字符的 shell 路径：不覆盖，实际 guard 路径不会这样。

**证据**：
```js
// opencode-review.mjs:2009
/^(?:\S*\/)?(?:ba)?sh: (line \d+: )?[^\n]*: restricted/,
```
```js
// :367
output: String(part.state?.output ?? part.state?.error ?? ""),
```
**建议**：要么保留一个有界前缀容忍（例如允许行首若干非空格前缀后出现 `(?:ba)?sh:`），要么至少把集成测试改成从 `summarizeEvents`/`part.state.output` 形状喂入，覆盖真正的消费端。

---

### 4. 低：提交说明里“含那三段字样”与当前 HEAD 不符；R5-4 的计数是对的

**文件:行**：`scripts/model-review/opencode-review.mjs:2006-2010`；提交 `27d9bc2a` 说明

**证据**：`git show --no-patch --format=%B HEAD` 的正文只出现 `restricted`，没有 `REVIEW_GIT_REFUSED`，也没有 `The user has specified a rule...`。因此“`git show --stat HEAD` 打印的正是这个分支自己的提交说明（含那三段字样、缩进四格）”这句只对其中一段成立。R5-4 说“现在是 10 个 expect”，我逐条数过 `test/tooling/opencode-review.test.mjs:751-814`，确实是 10 个，正确。

**建议**：改提交说明措辞；更重要的是按问题 1 构造提交，让“三段”真的都出现。

---

### 5. 提示（非本轮缺陷）：`extraEnv` 展开在安全关键字段之后

**文件:行**：`scripts/model-review/opencode-review.mjs:713-729`

`...extraEnv` 位于 `PATH`、`SHELL`、`OPENCODE_CONFIG` 等之后。当前所有调用方传的都是内部常量（marker、`LC_ALL`、`gatewayOpencodeEnv`），没有问题；但将来若有人把变量名放进 `extraEnv`，会静默覆盖这些安全边界。建议只允许白名单键，或在 `selfCheck` 里显式拼装，避免这个扩展点被误用。

---

## 侧重检查

- **错误路径 / 不可信输入**：重点看了提交说明、`Author:` 行。R5-3 后，“作者姓名/提交说明伪造 `f: restricted`”的误判已被堵住（`Author: f: restricted` 不再命中，见 `:802-813` 的新反向用例）；`git show` 的正文始终缩进，不会命中。剩下的是问题 3 的包装前缀风险（未核实）。
- **安全**：`LC_ALL=C` 只加在自检那次 `runOpencode`（`:2136-2140`），不进入真实复核的 prompt，也不改变 `probeRefused` 之外的行为。写入探针仍然依赖 opencode 权限层 + git 替身 + `bash -r`；这次没有放宽任何拒绝条件，R5-3 是收窄匹配，失败方向是 fail-closed。
- **资源耗尽**：新正则的 `[^\n]*` 后接固定长度字面量，按行回溯是线性的，没有明显的灾难性回溯；没有新增循环、重试或大缓冲。
- **不可撤销操作**：本轮只改自检/测试，自检在一次性副本里跑；没有新增不可撤销操作。
- **规则、说明文档与代码一致性**：
  - `docs/incidents-and-gates.md` I-84 关于 `resultUnrecoverable` 的说法与 `production-run-composition.ts:317-341`、`production-tool-result-recovery.ts:155-166` 一致；
  - `.agents/instructions/model-review.md:140` 说 `check:gitleaks` 存在且是 `npm run check` 的一步，与 `package.json:27,66` 一致，`GITLEAKS_GATE_FAILED` 也确在 `scripts/check-gitleaks.mjs:70`；
  - `docs/lessons.md:668` 说 `test/tooling/safe-tool-reason-codes.test.mjs` 已删除，仓库里确实没有该文件，`SAFE_TOOL_REASON_CODES` 已合成到 `thread-execution-state.ts` 并被子投影 import；
  - `.agents/reviews` 下的本轮记录文件在当前工作区不可读（被 git 守卫挡住/未检出），相关“164 条全过”“反向用例会红”只能标未核实。

---

## 读代码证实的 / 推测的

**证实的**：
- 本轮实质 diff 只有 `scripts/model-review/opencode-review.mjs` 两处和 `test/tooling/opencode-review.test.mjs` 一处（`git diff aff8e4ee..27d9bc2a --stat`）。
- 新集成用例新增了 3 次被拒命令和 4 次只读命令，`viaShell` 调用在计数断言前正好 10 次（`:1058-1087`）。
- 新正则 `^(?:\S*\/)?(?:ba)?sh: ...` 能匹配 `/bin/bash: line 1: f: restricted: cannot redirect output`，不再匹配 `Author: f: restricted <...>`；旧 `^\S+: ...` 会匹配后者。因此新反向用例在还原旧写法时确实会失败。
- `probeRefused` 只在 `checkProbeRequests` 里用，而 `checkProbeRequests` 只在 `selfCheck` 里用；`LC_ALL` 不会影响真实复核的 prompt。
- `opencodeEnv` 白名单包含 `LC_ALL`，`runOpencode` 的 `...extraEnv` 在其后，能覆盖父环境。

**推测 / 未核实**：
- `LC_ALL=C` 是否真的传到 opencode 启动的受限 bash：仓库代码只到 opencode 进程为止，外部二进制行为未知。
- 真实 `runOpencode` 里 `part.state.output` 与被拒命令的 stderr 是否完全一致；若 opencode 加前缀或把 stderr 放进 `state.error` 而 `output` 为空，`output ?? error`（`:367`）可能取到空串，这是这次集成测试没有覆盖的消费端路径。
- 作者声称的 164 条测试结果、`biome`/`derive` 结果未运行核实。

---

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。本轮只改自检判据、自检 env 和测试；`buildPrompt`（`:277-306`）、`reviewConfig`、`MODE_TEXT`、工具定义、消息组装都没有改。复核提示词里的“必答问题”来自 `questionsSource`（`:2328-2333`）读取的 `model-review.md` checklist 段（第 49-57 行），而这份 PR 改的是第 140 行的“提交前检查”，不在该段内，所以连复核提示词都不变。发给模型的变更仍然只在末尾追加；本轮新增的 `LC_ALL` 不属于发给模型的内容。

2. **会不会让同一段文字在不同请求里变成不同的字节？**
   不会。产品侧模型请求没有任何改动；复核脚本的 prompt 仍是确定性拼接（固定数组 + 从提交读取的 questions + brief）。`LC_ALL=C` 反而让自检时 shell/git 的输出更确定，而且它只进入自检进程，不进入模型请求。没有新增时间、随机值或无序集合。

3. **有没有对应的自动检查，反向用例会不会真的失败？**
   - R5-1：有新增集成用例，但覆盖依赖当前 HEAD 的提交说明/作者，危险作者形状和 `--oneline` 危险标题没有真实覆盖（问题 1）。
   - R5-3：有手写反向用例（`:802-813`），读代码可确认旧正则 `^\S+:` 会命中、新正则不命中，所以还原旧写法时该用例会失败。
   - R5-2：没有自动检查证明 `LC_ALL` 能到达受限 bash；集成用例既没设置也没断言它。
   - R5-4：只改文字，不需要检查，计数与实际一致。
   - 自检本身仍是 fail-closed：allowed 误判→`PROBE_READ_COMMAND_BLOCKED`，write/read 漏判→`PROBE_NOT_REFUSED`。

4. **每个产生或修改的值，两端校验都能接受吗？**
   - `REFUSAL_PATTERNS` 第三条正则：唯一产生处 `:2006-2010`，唯一消费处 `probeRefused`（`:2012-2015`，另有 `checkProbeRequests` 间接使用）；`grep` 没找到别的消费者，两端一致。
   - `LC_ALL`：产生于 `selfCheck`（`:2138`），消费于 `runOpencode` env（`:728`）；脚本层的白名单 `opencodeEnv` 接受它（`:577`），`gatewayOpencodeEnv` 不会覆盖它。再往下的 opencode→bash 一段无代码可核对，尚未证实。
   - `SHELL_LOG_NAME` 计数 10：产生于 guard shell 的 `echo "$$" >>`（`:654`），消费于测试断言（`:1087`）；我数了断言前的 `viaShell` 调用正好 10 次，两端一致。
   - `Author` 反向用例的期望 `false`：产生/消费都在同一个 `probeRefused` 上，逻辑一致。
   - 没有发现“清单 id 交给后端校验”这类跨模块契约问题；本轮改的都是脚本内部和测试内部值。
