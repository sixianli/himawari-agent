## 直接回答作者的问题

- 四条只读命令里，我没有找到“正常输出被误判为拒绝”的路径（依据见下）。
- 但“真实拒绝被漏判”仍有路径：受限 bash 的报错语言并没有被可靠地固定成 C，见问题 1。这不是推测出来的编码错误，而是 `LC_MESSAGES` 会被继承来的 `LC_ALL` 覆盖。
- R6‑3 的理由基本站得住；R6‑5 的事实成立，但“不在本 PR 改”的理由偏弱。

---

## 按严重度排列

### 1【高】`LC_MESSAGES=C` 被继承的 `LC_ALL` 覆盖，bash 报错可能仍是本地化文本，自检会漏判真实拒绝
**文件:行**：`scripts/model-review/opencode-review.mjs:655`、`:568`、`:571-578`、`:714-729`

**问题**：包装脚本只 `export LC_MESSAGES=C`。但 opencode 的环境通过 `opencodeEnv(process.env)` 原样保留 `LANG`、`LC_ALL`、`LC_CTYPE`；POSIX 下 `LC_ALL` 的优先级高于任何 `LC_MSG*`。上层环境只要有 `LC_ALL=ja_JP.UTF-8`（或任何非 C/英文 locale），包装脚本的 `export` 就不起作用，受限 bash 的 `restricted` 报错可能被翻译。

**证据（我读到的代码）**：
```js
// scripts/model-review/opencode-review.mjs:571-578
export const OPENCODE_KEPT_ENV = [
  "PATH","HOME","USER","LOGNAME","LANG","LC_ALL","LC_CTYPE", ...
];
// :655
      "export LC_MESSAGES=C",
// :714-729
        env: {
          ...opencodeEnv(process.env),
          ...
          SHELL: gitGuard.shell,
          ...extraEnv,
        },
```
而判据仍要求英文 `restricted`：
```js
// :2007-2011
export const REFUSAL_PATTERNS = [
  /^The user has specified a rule which prevents you/,
  new RegExp(`^${GIT_REFUSED} \\S`),
  /^(?:\S*\/)?(?:ba)?sh: (line \d+: )?[^\n]*: restricted/,
];
```
原来的 `extraEnv: { ..., LC_ALL: "C" }` 被删掉了，等于把“系统语言固定为 C”换成了“只固定消息类别”，而后者会被 `LC_ALL` 压过。

**建议**：在包装脚本里先 `unset LC_ALL`（或 `LC_ALL=`）再 `export LC_MESSAGES=C`。这样 `LC_MESSAGES=C` 生效，`LC_CTYPE` 仍可从 `LANG` 继承，grep 的中文 UTF‑8 字符类不受影响。更稳妥的是把 `LC_MESSAGES=C` 放进 `extraEnv` 并同时不传 `LC_ALL`。

**补充（作者问的两点）**：`export` 的位置是对的（在 `exec` 前、同一 `/bin/sh` 里）；`LC_MESSAGES` 本身确实只管消息类别、不动字符类，所以“不影响 grep 对 UTF‑8 字符类”这半句成立。问题不在位置，也不在类别选择，而在 `LC_ALL` 的优先级。

---

### 2【中】`--allow-empty` 让 `git diff HEAD~1 HEAD` 变成空 diff，外部 diff 的两条安全断言失去覆盖
**文件:行**：`test/tooling/opencode-review.test.mjs:1050-1053`、`:1095-1105`

**问题**：新提交是 `--allow-empty`，HEAD 的树和 HEAD~1 完全相同。因此后面两条 `git diff HEAD~1 HEAD` 没有任何文件差异，`GIT_EXTERNAL_DIFF` / `diff.external` 根本不会被调用。断言仍然通过，但即使 guard 对 external diff 的拦截坏了也发现不了。

**证据（我读到的代码）**：
```js
// test/tooling/opencode-review.test.mjs:1050-1053
          "commit",
          "--quiet",
          "--allow-empty",
// :1095-1105
      viaShell("export GIT_EXTERNAL_DIFF=touch; git diff HEAD~1 HEAD");
      viaShell(
        "export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=diff.external GIT_CONFIG_VALUE_0=touch; git diff HEAD~1 HEAD",
      );
      ...
      expect(viaShell("export GIT_EXTERNAL_DIFF=env; git diff HEAD~1 HEAD").text).not.toContain(
        canary,
      );
```
空提交使 `HEAD~1` 等于克隆前的 HEAD，树相同，diff 为空。这是“造提交让后面某条断言失效”的具体实例，虽然它不会变红，而是变成 vacuous。

**建议**：让造出的提交非空（例如修改 `AGENTS.md` 第 1 行，顺便覆盖问题 3），或者把这两条探针改成 `git diff HEAD~2 HEAD~1` 这种确有差异的提交对。

---

### 3【低】`git blame -L 1,1 -- AGENTS.md` 没有覆盖“作者名 `f: restricted`”这个历史形状
**文件:行**：`test/tooling/opencode-review.test.mjs:1088`、`:1052`

**问题**：作者声称四条只读命令覆盖了历史两个 bug 的形状。但空提交不修改 `AGENTS.md`，blame 第 1 行仍归给真实历史作者，不会出现 `f: restricted`。真正覆盖 `Author: f: restricted` 的只有 `git show --stat HEAD`。因此旧版“按行内子串匹配”的反向验证，blame 这一条本来也不会变红。

**证据**：
```js
        "git blame -L 1,1 -- AGENTS.md",
...
          "--allow-empty",
```
反向验证若只靠 blame，无法复现 `Author: f: restricted` 误判；只有 oneline/show 会红。

**建议**：在造提交时真的改动 `AGENTS.md` 第 1 行，让 blame 的行作者变成 `f: restricted`；这样同时解决问题 2 的空 diff。若不想改 `AGENTS.md`，就不要声称四条命令都覆盖了两个形状。

---

### 4【低】测试的 `git clone` / `git commit` 使用开发者的全局 git 配置，可能在有些机器上直接失败
**文件:行**：`test/tooling/opencode-review.test.mjs:1042-1059`

**问题**：这两条 `execFileSync("git", ...)` 没有像真实运行那样设置 `GIT_CONFIG_NOSYSTEM` / `GIT_CONFIG_GLOBAL`。开发者若配置了 `commit.gpgsign=true`、全局 `core.hooksPath` 指向会拒绝提交的钩子、或奇怪的别名/模板，造提交会失败或行为不同。真实复核里 git 环境是有隔离的（`GIT_ENV`），测试这里没有。

**证据**：
```js
      execFileSync("git", ["clone", "--quiet", "--depth", "3", `file://${process.cwd()}`, copy]);
      execFileSync(
        "git",
        ["-c","user.name=f: restricted","-c","user.email=nobody@example.org","commit", ...],
        { cwd: copy },
      );
```
没有 `env` 覆盖，也没有 `-c commit.gpgsign=false`。

**建议**：给这两条命令显式传 `GIT_CONFIG_GLOBAL=/dev/null`、`GIT_CONFIG_NOSYSTEM=1`，并加 `-c commit.gpgsign=false`。

---

### 5【低】R6‑5 的“留待 Andy”理由偏弱，且现在和 R6‑2 有关
**文件:行**：`scripts/model-review/opencode-review.mjs:714-729`

**问题**：`...extraEnv` 排在 `PATH`、`SHELL`、`OPENCODE_CONFIG` 之后，事实成立。作者说它是结构改动、与本 PR 无关，但这次改动本身就改了 `extraEnv`，而且 R6‑2 现在依赖包装脚本来固定 locale；将来有人往 `extraEnv` 放 `LANG`/`LC_ALL`，会同时破坏边界和 locale 修复。改动只是把 `...extraEnv` 挪到受保护键之前，风险很低。

**证据**：
```js
          PATH: `${gitGuard.binDir}${delimiter}${process.env.PATH ?? ""}`,
          SHELL: gitGuard.shell,
          ...extraEnv,
```
**建议**：至少在本 PR 里把 `...extraEnv` 放到这些键之前，或在 `runOpencode` 里断言 `extraEnv` 不含 `PATH`/`SHELL`/`OPENCODE_CONFIG`/`LANG`/`LC_ALL`。

---

## 对 R6‑3、R6‑5 的判断

**R6‑3（不采纳“容忍行首前缀”）**：理由基本成立。消费端确实是原始输出：
```js
// scripts/model-review/opencode-review.mjs:367
        output: String(part.state?.output ?? part.state?.error ?? ""),
```
我读了 `test/tooling/fixtures/opencode-review/glm-events.jsonl`，`part.state.output` 是命令原始输出，没有前缀。第二条理由也成立：放宽成 `^\S+:` 会重新命中 `Author: f: restricted`。但要注意一个未核实点：夹具里只有成功命令，没有“被拒绝”的 opencode 事件；如果 opencode 将来把拒绝话术放进带前缀的 `error` 字段，当前行首锚定会漏判。这不是现在改的理由，而是应该补一份拒绝事件夹具。

**R6‑5**：见问题 5。事实成立，但“与本 PR 无关”只说对了一半；建议至少顺手收紧。

---

## 读代码证实的 vs 推测

**读代码证实**
- `OPENCODE_KEPT_ENV` 保留 `LANG`/`LC_ALL`/`LC_CTYPE`，且 `runOpencode` 用 `opencodeEnv(process.env)`；selfCheck 的 `extraEnv` 里 `LC_ALL: "C"` 已删。
- 包装脚本确实在 `exec` 前 `export LC_MESSAGES=C`。
- 新提交是 `--allow-empty`，因此 `HEAD~1` 与新 HEAD 树相同，`git diff` 为空。
- 新提交不修改 `AGENTS.md`，blame 第 1 行作者不是 `f: restricted`。
- shell log 预期 11 次与调用次数一致：3 次基础拒绝 + 1 次 localized + 4 条只读 + 2 条 external diff + 1 条 env external diff = 11，`allowed` 调用在断言之后。
- 四条只读命令的普通输出不会命中三条行首锚定模式：oneline 有 hash 前缀、show 的正文有 4 空格缩进、blame/status 行首不是 `Author:`/`sh:`。
- 生产 `limitBytes` 的两个消费值（`maxOutputBytes`、`maxMemoryBytes`）只在 `sandboxCeilingExceededMessage` 和测试里出现；`SANDBOX_TOOL_MEMORY_LIMIT_BYTES = 1_073_741_824` → `1024 MB`，测试期望一致；旧十进制文案（`1073.7`、`268.4 MB`、`2.5 MB` 等）已无残留。
- `SAFE_TOOL_REASON_CODES` 现在只有一处导出，两个消费者都 import 它；被删的 `safe-tool-reason-codes.test.mjs` 没有被任何测试清单或配置再引用。

**推测/未核实**
- `LC_ALL` 优先级高于 `LC_MESSAGES` 是 POSIX 语义（代码事实 + 外部规范推论）；bash 的 ja_JP 翻译是否真的把 `restricted` 翻掉，我没法在本机验证。
- 容器是否安装 `ja_JP.UTF-8` 未核实。没装时，新断言是因为 locale 加载失败回退到 C 而通过，等于什么都没证明；装了时又可能因 `LC_ALL` 覆盖而失败。
- opencode 对“被拒绝”的实际事件形状（`output` 还是 `error`、有没有前缀）没有夹具，未核实。
- 我没有运行测试，作者说的 164 条全过未核实。

---

## 侧重检查

- **错误路径**：检查了包装脚本的 `exec` 前置语句、`LC_ALL` 覆盖、空 diff 导致 external diff 不执行、拒绝文本的三种来源（git 替身、受限 bash、opencode 权限拒绝）。确认了两处覆盖退化：locale 和 external diff。
- **不合规范/不可信输入**：上层 `LC_ALL`/`LANG` 未做清洗；测试造提交的 author/message 来自代码常量，可控；但 `git commit` 受开发者全局配置影响，属于未隔离的外部输入。
- **安全**：external diff 的断言被空提交削弱，是本轮最值得修的安全测试退化；拒判方向仍是 fail-closed（漏判会让自检失败、起不来），不是放行。
- **资源耗尽**：只多一个临时克隆里的提交和一次 shell 调用，可忽略。
- **不可撤销操作**：测试在临时目录内建提交，`finally` 里 `rmSync`；生产代码没有新增写入或删除。
- **规则/文档一致性**：`prompt-prefix.md` 未被改动，行为也不涉及请求前缀；`docs/lessons.md` 和 `docs/incidents-and-gates.md` 已同步删除 `safe-tool-reason-codes.test.mjs`。但 `docs/assets/others/Anthropic_SRT_AI_Agent_Integration_Guide_2026-09-07.md` 明确写着“不要假设所有 Linux 镜像都有同一 locale”，新断言恰好默认 `ja_JP.UTF-8` 可用来证明问题，这与该指引不一致（未核实各环境实际安装情况）。

---

## 必答问题

1. **不会改变模型已经见过的请求开头。** 本次增量只改自检的 `extraEnv`、guard shell 和集成测试；真实复核的 opencode 环境没有这次增删 `LC_ALL`（`LC_ALL=C` 原本只在 `selfCheck` 的 `extraEnv` 里），`LC_MESSAGES` 只影响工具执行环境。系统提示、工具定义、历史消息、遮盖规则都没动；新增内容和环境变化只会出现在末尾的工具结果里。符合 `prompt-prefix.md` 第 4、10 条。

2. **不会让同一段文字在同一对话的不同请求里变成不同字节。** `LC_MESSAGES=C` 是常量；父进程的 `LC_ALL` 在一次运行内不变；新造的提交和测试文本都在一次性的测试克隆里，不进模型请求。跨机器/跨父环境的 bash 报错语言可能不同（问题 1），但这不是同一请求序列内的变化。

3. **有对应检查，但覆盖不完整、反向用例不可靠。**
   - R6‑1 的四命令循环能反向失败（把判据改回行内子串，oneline/show 会红），这点成立；但 blame 没覆盖 `f: restricted`，external diff 两条断言被空提交变成 vacuous。
   - R6‑2 新增的 localized 断言：在没装 ja locale 的容器里，删掉 `export LC_MESSAGES=C` 它也不会失败（locale 加载失败后回退 C）；装了 ja 又可能因为 `LC_ALL` 覆盖而失败。所以它没有稳定地证明这个改动。

4. **逐个值核对结果：**
   - `LC_MESSAGES=C`：生产于包装脚本，消费于 exec 的 bash 及子进程；语法上接受，但 `LC_ALL` 会覆盖，导致消费者 `REFUSAL_PATTERNS` 要求的英文 `restricted` 得不到保证。
   - 被删除的 `LC_ALL=C`：opencode 仍会从 `OPENCODE_KEPT_ENV` 继承父进程的 `LC_ALL`；这正是两端校验不一致的地方。
   - 新提交的 `user.name=f: restricted`、`user.email`、标题、正文：`git show`/`git log` 接受，四条命令的断言接受它们为非拒绝；但 `git blame` 实际用不到这个作者。
   - shell log 计数 11：与调用次数一致（3+1+4+2+1），`allowed` 调用在断言之后，断言成立。
   - `limitBytes` 的 1024 换算：只被 `sandboxCeilingExceededMessage` 消费；`maxMemoryBytes`/`maxOutputBytes` 的测试期望已同步（`256 MB`、`128 MB`、`1024 MB`、`2.4 MB`、`48 KB`），旧十进制串无残留。
   - `SAFE_TOOL_REASON_CODES` 合一处：两个消费者都 import 同一导出，被删的比对测试没有残留引用。
   - `inspectToolResultRecovery`：作为 composition 返回值新增，测试通过 `make("authority-inspection")` 消费；我在 `apps/agent-service/src` 里只找到它在本文件和测试中的使用，未发现序列化或外部消费者，但未逐一核对所有下游构造。
