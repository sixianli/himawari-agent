## 复核范围

- `git diff 88ba0f33a..0658702df` 确实只有 1 个提交、4 个文件：`scripts/ci/execute.mjs`、`scripts/ci/install-tools.mjs`、`test/tooling/runner.test.mjs`、`test/tooling/toolchain.test.mjs`。
- `8c8c89523..0658702df` 还包含 3 个更早的提交（control-center 类型移动、coverage 报错信息），不属于本轮增量，下面不展开。
- 受工具限制，本轮没有运行测试；“改前会失败”是按旧 `execute.mjs` 代码推演，不是实跑结果。

## 发现

### 中：仍有一个 CI 长跑子进程绕过了追踪号

- 文件：`scripts/ci/security-redaction.mjs:168-178`
- 问题：`inspectBuildArchive()` 用自定义环境启动 Python，环境里没有 `RUNNER_TRACKING_ID`。这个函数在发布/检查构建产物时被 `assertPublicArtifacts()` 调用，Python 子进程最长可跑到 300 秒；如果作业在发布阶段被取消，父进程被杀后该 Python 进程不会匹配 runner 的孤儿清理，仍会继续运行。
- 证据（亲自读到）：

```js
// scripts/ci/security-redaction.mjs:168-178
const env = { PATH: "/usr/bin:/bin", PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1" };
const version = spawnSync(python, ["--version"], { env, encoding: "utf8" });
...
const child = spawn(python, ["-I", "-B", helper, "stream", file], {
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
```

- 影响：该进程只读归档并输出到 stdout，不写工作区，所以不会直接复现 `CI_OUTPUT_ALREADY_EXISTS`；但它仍然违反“CI 子进程都带追踪号”的目标，并可能在取消后继续占用文件句柄和 CPU。
- 建议：把 `runnerTracking()` 合并进这个 env，或把所有子进程环境构造统一到一个 `childEnvironment()` 出口；同时补一条该路径的追踪号测试。

### 低：另外两处自定义 env 的 git 子进程也没有追踪号

- 文件：`scripts/ci/check-security.mjs:72-80`、`scripts/ci/security-exceptions.mjs:18-31`
- 问题：这些 `spawnSync`/`execFileSync` 调用显式构造了 `{ PATH, GIT_CONFIG_NOSYSTEM, GIT_CONFIG_GLOBAL, GIT_PAGER }`，没有合并 `RUNNER_TRACKING_ID`。
- 证据（亲自读到）：

```js
// scripts/ci/check-security.mjs:72-80
const result = execute("git", args, {
  root,
  env: {
    PATH: "/usr/bin:/bin",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_PAGER: "cat",
  },
});
```

```js
// scripts/ci/security-exceptions.mjs:20-31
return execFileSync("git", args, {
  cwd: root,
  ...
  env: {
    PATH: "/usr/bin:/bin",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_PAGER: "cat",
  },
});
```

- 影响：这些命令通常很短，取消时仍在跑的概率和持续时间都低；但它们确实属于“带自定义 env 的 CI 子进程”这一类。
- 建议：如果目标是“所有 CI 子进程”，同样合并 `runnerTracking()`；如果只要求覆盖长跑进程，可以在注释或测试里明确排除短命 git 命令，避免下一个人误以为已经全覆盖。

### 低：测试没有保护 `isolatedEnvironment` 的注入，这部分改坏了不会被发现

- 文件：`test/tooling/toolchain.test.mjs:270-284`、`test/tooling/runner.test.mjs:186-206`
- 问题：`runner.test.mjs` 只验证 `execute()` 能把环境变量传给子进程；`toolchain.test.mjs` 只验证 `runnerTracking()` 本身的返回值。没有任何用例断言 `isolatedEnvironment()` 在 `RUNNER_TRACKING_ID` 存在时会带上它。因此即使删掉 `scripts/ci/install-tools.mjs:360` 的 `...runnerTracking()`，现有测试仍会通过，而 `install-tools.mjs`、`install-dependencies.mjs`、`install-gate-dependencies.mjs` 这些不经过 `execute()` 的直接步骤会失去保护。
- 证据（亲自读到）：

```js
// test/tooling/toolchain.test.mjs:272-283
const env = isolatedEnvironment(directory, "/fixture/bin");
expect(env.HOME).toBe(join(directory, "home"));
...
expect(runnerTracking({ RUNNER_TRACKING_ID: "github_fixture" })).toEqual({
  RUNNER_TRACKING_ID: "github_fixture",
});
```

```js
// scripts/ci/install-tools.mjs:343-361
return {
  HOME: home,
  ...
  SEMGREP_ENABLE_VERSION_CHECK: "0",
  ...runnerTracking(),
};
```

- 建议：
  1. 在 `toolchain.test.mjs` 中用 `vi.stubEnv("RUNNER_TRACKING_ID", "fixture")` 后断言 `isolatedEnvironment(...).RUNNER_TRACKING_ID === "fixture"`；再补未设置时不出现该键的反向断言。
  2. 最好再用真实的 `execFileSync` 子进程验证 `isolatedEnvironment` 的 env 能读回追踪号，而不只是比较对象。
- 另：`runner.test.mjs` 的标题说“作业取消后 runner 能找到并结束它”，但用例只验证子进程能读到变量，没有验证 runner 真的会结束进程；标题应改成实际验证的内容，或补一条进程清理测试。

### 低：`execute()` 省略 `env` 时的行为发生回归（当前调用者都显式传 env，属潜在问题）

- 文件：`scripts/ci/execute.mjs:12-17`
- 问题：改动前 `env` 为 `undefined` 时，Node 的 `spawn` 会继承父进程环境；改动后变成 `{ ...undefined, ...runnerTracking() }`，在 `RUNNER_TRACKING_ID` 不存在时是 `{}`，子进程会得到空环境而不是继承父环境。当前仓库里所有 `execute()` 调用点都显式传了 `env`，所以暂时不会触发；但这是导出 API 的行为变化。
- 证据：旧版本 `execute.mjs` 是 `env,`；新版本是：

```js
// scripts/ci/execute.mjs:12-17
const child = spawn(command, args, {
  cwd,
  env: { ...env, ...runnerTracking() },
  stdio: ["ignore", "pipe", "pipe"],
  detached: process.platform !== "win32",
});
```

- 建议：改为仅在 `env` 有值时构造合并对象，例如 `...(env === undefined ? {} : { env: { ...env, ...runnerTracking() } })`，保留原来的“省略即继承”语义；或者明确把 `env` 设为必填并在所有调用点校验。

## 侧重检查

- 错误路径：`runnerTracking()` 对 `undefined`、空字符串、非字符串都返回 `{}`，不会抛错；`test/tooling/toolchain.test.mjs:282-283` 覆盖了空字符串和缺失，但未覆盖非字符串（例如 `source.RUNNER_TRACKING_ID = 1`），不过默认来源是 `process.env`，实际都是字符串。
- 不合规范/不可信输入：`runnerTracking` 只检查“非空字符串”，不校验长度或字符集。值来自 runner 的环境变量，属于可信来源；若测试或不可信代码把它设成超长值，可能让 `spawn` 因环境过大失败，但这不是新的安全边界，也没有跨进程信任提升。
- 安全：追踪号不是秘密；把它加入 `isolatedEnvironment` 会让该函数从“固定白名单”变成多继承一个宿主变量，但没有引入密钥或 `NODE_OPTIONS` 一类注入变量。`RUNNER_TRACKING_ID` 也不在现有 `OPENAI_API_KEY`、`NODE_OPTIONS`、`NODE_PATH` 的拒绝列表里。
- 资源耗尽：`security-redaction.mjs` 的 Python 子进程可跑 300 秒且无追踪号，是这次检查里最实际的资源/句柄泄漏点。`check-security.mjs`、`security-exceptions.mjs` 的 git 子进程很短。`remote-share.mjs` 的 ssh 和 `resources.mjs` 的 `du` 都没显式传 env，会继承父环境，因此会带上追踪号；`resources.mjs:90` 的 `execFile("du", ...)` 也是继承。产品侧的 `forkJobHost`（`packages/runtime-sandbox/src/job-host-messages.ts:22-35`）虽然用固定 env 且 `detached: true`，但 `job-host-main.ts:1264` 有 `process.on("disconnect", () => stop("cancelled"))`，父进程消失时会自行停止，因此不列为本次 CI 追踪号缺口。
- 不可撤销操作：本改动没有引入删除、覆盖或写库；runner 结束进程属于预期清理。唯一需要注意的是，它会让 runner 在作业结束时更强地杀掉带该追踪号的所有进程，当前没有发现合法的跨作业常驻进程依赖。
- 规则/文档一致性：`.claude/rules/prompt-prefix.md` 与 CI 子进程无关，本次没有改变模型请求组装。`docs/architecture-v0.1.md:637` 提到 tooling 项目隔离继承的 GitHub 环境变量；`vitest.workspace.ts:6-14` 只清理 `GITHUB_*`，所以 `RUNNER_TRACKING_ID` 现在会出现在 tooling 测试进程里。`test/tooling/environment.test.mjs` 只断言 `GITHUB_*` 被清空，不会失败；如果项目把“runner 执行身份”也视为应隔离的身份，这是一处新继承，但目前没有代码或文档把它列为禁止项。提交标题“CI 子进程带上追踪号”比实际代码略宽，因为 `security-redaction.mjs` 等显式 env 路径没有覆盖。

## 读代码证实的与推测

**读代码证实的：**

- 本轮增量只改 4 个文件，`git show --stat` 已确认。
- `execute()` 现在把 `runnerTracking()` 合并到子进程 env（`scripts/ci/execute.mjs:14`）。
- `isolatedEnvironment()` 现在把 `runnerTracking()` 合并进返回对象（`scripts/ci/install-tools.mjs:360`）。
- `runnerTracking()` 只在非空字符串时返回键（`scripts/ci/install-tools.mjs:364-367`）。
- `security-redaction.mjs` 的 Python 子进程使用自定义 env，不含追踪号（`scripts/ci/security-redaction.mjs:168-178`）。
- `check-security.mjs` 和 `security-exceptions.mjs` 的 git 子进程使用自定义 env，不含追踪号。
- 其它 CI 子进程路径如 `remote-share.mjs` 的 ssh、`resources.mjs` 的 `du`、`verify-artifact.mjs` 的 Python 未显式传 env，会继承父进程环境。
- 缓存键不读取 `RUNNER_TRACKING_ID`；`verified-download.mjs` 的缓存目录只看 `HIMAWARI_CI_CACHE_DIR`、`HOME`、`GITHUB_ACTIONS`，内容按 SHA-256 校验。
- `run.mjs` 的 `result`、`quality.mjs` 的 `quality.json` 和安装记录都没有序列化进程环境。

**推测/未核实：**

- `actions/runner` 的源码不在本仓库；作者关于“runner 把 `RUNNER_TRACKING_ID` 放进步骤环境、并在作业结束扫描 `/proc/<pid>/environ` 清理孤儿进程”的说法，无法在本仓库核实。
- 我没有实际运行新测试来观察改前失败；“改前会失败”是按旧 `execute.mjs` 代码推演：旧代码把 `env: { PATH }` 原样传给子进程，子进程会读到 `RUNNER_TRACKING_ID=undefined`，因此 `toContain("id=github_tracking_fixture")` 会失败。
- 没有验证 macOS 上是否存在等价的孤儿进程清理机制；当前事故机器是 Linux ARM，相关结论只对 Linux 的 `/proc` 路径有依据。

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？

不会。本次改动只涉及 CI 脚本和测试，没有进入模型请求组装、系统提示、工具定义、历史消息或遮盖逻辑；`scripts/ci/*` 里的 `RUNNER_TRACKING_ID` 不会出现在发给模型的内容里。按 `prompt-prefix.md` 第 4 条（已发内容只能追加）和第 10 条（字节必须确定），本次没有改变请求开头；`RUNNER_TRACKING_ID` 是每个作业固定的值，也不是每轮变化的值。未发现会把每轮变化值塞进系统提示或前面历史的新路径。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？

不会影响模型请求文本或模型服务方的缓存键。追踪号只进入 CI 子进程的 `env`：

- 缓存键：`verified-download.mjs` 用下载内容的 SHA-256 和缓存目录，不读取追踪号。
- 报告：`run.mjs`、`quality.mjs` 的公开报告只写固定的工具链、硬件和命令结果字段，没有序列化 env。
- 遮盖：本次没有改遮盖规则。

唯一可能的字节差异是：如果某个 CI 测试把自己的环境打印进诊断日志，日志里可能带追踪号，导致不同作业的日志字节不同；但那是 CI 诊断内容，不是模型请求开头，也不是缓存键或报告摘要字段。

### 3. 有没有对应的自动检查，反向用例是否真的会失败？

有，但覆盖不完整。

- `test/tooling/runner.test.mjs:186-206`：正向验证 `execute()` 的子进程能读到 `RUNNER_TRACKING_ID`。按旧 `execute.mjs` 推演，改前子进程读到 `undefined`，该用例会失败，反向性成立。
- `test/tooling/toolchain.test.mjs:279-283`：验证 `runnerTracking()` 在非空、空字符串、缺失三种输入下的返回值；空字符串和缺失的反向用例会失败如果实现无条件返回键。
- 缺口：没有测试 `isolatedEnvironment()` 是否带上追踪号。删掉 `install-tools.mjs:360` 后上述测试仍会通过，而直接运行的 `install-tools.mjs`、`install-dependencies.mjs`、`install-gate-dependencies.mjs` 正是依赖这个函数的路径。
- 缺口：`runner.test.mjs` 没有验证 runner 真的会结束子进程，也没有覆盖 `security-redaction.mjs` 这类自定义 env 路径。

### 4. 改动产生或修改的每个值，每个使用它的地方都能接受吗？

产生处：

- `scripts/ci/install-tools.mjs:364-367` 的 `runnerTracking()` 只产生一个键 `RUNNER_TRACKING_ID`，值是原样的非空字符串。

使用处：

- `scripts/ci/install-tools.mjs:360`：展开到 `isolatedEnvironment()` 返回对象，`spawn`/`execFile`/`execFileSync` 都接受字符串环境值。
- `scripts/ci/execute.mjs:14`：展开到 `spawn` 的 `env`，同样接受字符串；并且它排在调用方 `env` 之后，会覆盖调用方传入的同名值。
- 测试处：`test/tooling/toolchain.test.mjs`、`test/tooling/runner.test.mjs`，只把值当普通字符串比较。

消费端校验：

- 没有发现 JSON schema、清单或缓存键校验 `RUNNER_TRACKING_ID`；没有发现精确断言隔离环境键集合的测试会因此失败。`test/tooling/environment.test.mjs:45-49` 检查的是 `vitest.workspace.ts` 里 `tooling.env` 的配置键，不是子进程完整环境。
- 但“每个使用它的地方”没有全部更新：`security-redaction.mjs:168-178` 的 Python 子进程、`check-security.mjs:72-80` 和 `security-exceptions.mjs:18-31` 的 git 子进程仍用不含追踪号的自定义 env。它们能接受这个键，只是没有拿到。
- `execute.mjs:14` 还有一个语义问题：调用方省略 `env` 时不再继承父环境；当前调用点都显式传了 env，所以暂未造成实际故障，但这个导出函数的行为已经改变。

## 总体建议

最小修正：给 `security-redaction.mjs` 的自定义 env 合并 `runnerTracking()`；补一条 `isolatedEnvironment` 的追踪号断言和一条真实子进程读取测试；把 `execute()` 的 env 合并在 `env === undefined` 时保持原语义。更稳的做法是把“所有 CI 子进程必须带追踪号”收敛到一个统一的 env 构造入口，避免下一条自定义 env 再次漏掉。
