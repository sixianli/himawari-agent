## 结论

未发现会破坏 CI 主要修复路径的高严重度缺陷；本轮增量确实把追踪号带进了 `execute`、`isolatedEnvironment`、安全扫描的 Python 和 git 子进程。问题集中在「测试门槛覆盖不全」和「说明文档与代码不一致」。

## 读代码证实的问题（按严重度）

### 1. 中：新增的三处子进程环境没有自动化反向用例

- 位置：`scripts/ci/check-security.mjs:80`、`scripts/ci/security-exceptions.mjs:30`、`scripts/ci/security-redaction.mjs:173`
- 问题：这三处 `...runnerTracking()` 是本轮新增的，但仓库里只有 `execute` 和 `isolatedEnvironment` 的用例。把这三行删掉，现有测试不会失败，因此「作业取消后安全扫描子进程也能被 runner 结束」没有得到自动门槛保护。
- 证据：
  - `check-security.mjs:75-81` 的 git 环境新增了 `...runnerTracking()`；
  - `security-exceptions.mjs:25-31` 同样；
  - `security-redaction.mjs:169-174` 的 Python 扫描环境同样；
  - 测试只在 `test/tooling/runner.test.mjs:186-205` 断言 `execute` 的子进程能读到追踪号，在 `test/tooling/toolchain.test.mjs:284-306` 断言 `isolatedEnvironment` 带追踪号，没有覆盖上面三处。
- 建议：给这三处抽出可测的环境构造函数（或导出 `git`/`inspectBuildArchive` 的环境部分），用 `vi.stubEnv("RUNNER_TRACKING_ID", ...)` 断言生成的环境；至少加一条会因删除 `...runnerTracking()` 而失败的用例。

### 2. 中：I-99 门槛描述引用了已不存在的测试标题，且夸大了测试验证内容

- 位置：`docs/incidents-and-gates.md:133`
- 问题：文档仍写着用例标题「子进程带上 runner 的进程追踪号，作业取消后 runner 能找到并结束它」，但本轮已把标题改成「子进程环境带上 runner 的进程追踪号，runner 结束作业时能认出它」；而且这个用例只验证子进程看到了环境变量，并没有验证 runner 真能识别或结束它。文档还把 `toolchain.test.mjs` 描述成只「断言 `runnerTracking` 的取值」，实际已增加 `isolatedEnvironment` 和真实子进程断言。
- 证据：
  - `docs/incidents-and-gates.md:133` 的门槛文字仍是旧标题；
  - `test/tooling/runner.test.mjs:186-205` 的新标题和测试体；
  - `test/tooling/toolchain.test.mjs:284-306` 的额外断言。
- 建议：同步更新 I-99 的用例标题和描述，明确写「断言子进程环境带追踪号」，不要写成已经验证 runner 能找到并结束进程；或者把测试标题再收紧为只声明实际验证的内容。

### 3. 低：作者「避免 execute 与 install-tools 互相依赖」的理由与代码不符

- 位置：`scripts/ci/install-tools.mjs:1-24`、`scripts/ci/execute.mjs:4`
- 问题：代码里原本不存在 `install-tools.mjs -> execute.mjs` 的导入；`install-tools.mjs` 只导入 `platforms`、`verified-download` 和新的 `runner-tracking`。把函数挪到独立文件本身没问题，但「避免互相依赖」不是实际原因。只有 `execute.mjs` 单向依赖过 `install-tools.mjs`。
- 证据：`install-tools.mjs:15-24` 的导入列表中没有 `execute.mjs`；`execute.mjs:4` 现在只导入 `runner-tracking.mjs`。
- 建议：修正说明即可；这不是行为问题。

## 推测 / 未核实

- `scripts/model-review/opencode-review.mjs` 的 `opencodeChildEnv`、`gitChildEnv` 使用白名单环境（`GIT_KEPT_ENV` 见 `:662`，`OPENCODE_KEPT_ENV` 见 `:674-696`，构造见 `:713-741`），不会带上 `RUNNER_TRACKING_ID`。如果这些复核脚本也会在 GitHub Actions 作业里运行，那么它们仍是取消后可能残留的子进程。仓库是稀疏检出，当前没有 `.github/workflows`，无法核实是否在 CI 中调用。
- runner 侧清理逻辑依赖的变量名和匹配方式（`RUNNER_TRACKING_ID`）来自事故记录，本次无法离线读取 `actions/runner` 源码，未核实。

## 侧重检查

- **自定义 env 的 CI 子进程**：逐一读了 `scripts/ci` 里的 `spawn/spawnSync/execFile/execFileSync` 调用。除上面新增的三处外，其余直接子进程要么显式使用 `isolatedEnvironment`（现已带追踪号，如 `run.mjs:139-164`、`quality.mjs:71-100`、`install-dependencies.mjs:306-323`、`install-gate-dependencies.mjs:92-95`、`main-confirm.mjs:88-93`），要么继承 `process.env`（如 `context.mjs:78-83`、`check-policy.mjs:1087-1088`、`main-evidence.mjs:18-23`、`check-coverage.mjs:39`）。`coverage-comparison.mjs:36-40` 的 `comparisonEnv` 来自带追踪号的 `env`，且 `GITHUB_*` 清理不会删除 `RUNNER_TRACKING_ID`。
- **循环导入**：`runner-tracking.mjs` 不导入任何模块，是叶子模块；没有形成循环。
- **错误路径 / 不可信输入**：`coverage-model.mjs:242-248` 新增错误信息访问 `branch.loc.start.line`，但前一行 `location(branch.loc, ...)` 已校验过 `branch.loc`；`JSON.stringify` 对 JSON 解析出的数据不会抛循环引用；截断长度固定，不会放大输入。
- **资源耗尽 / 不可撤销操作**：追踪号只是环境变量透传，不改变超时、进程组终止或文件写入逻辑，没有新增清理或不可撤销操作。
- **安全性**：`RUNNER_TRACKING_ID` 不是凭据；新增透传没有引入密钥。理论上能控制父环境的人可以伪造追踪号，但攻击者本来就能给子进程任意环境，不是本次新增的暴露面。

## 必答问题

1. **会不会改变模型已经见过的请求开头？**
   不会。本轮 diff 只改 `scripts/ci/*`、`test/tooling/*` 和事故文档，没有触碰系统提示、工具定义、历史消息或出口遮盖逻辑。模型请求仍然是只在末尾追加，没有把每轮变化的值挪进请求开头。依据是 `prompt-prefix.md` 的「只追加」和「字节必须确定」两节，当前改动不涉及这两节的路径。

2. **同一段文字会不会在不同请求里变成不同字节？**
   不会（就模型可见内容而言）。`RUNNER_TRACKING_ID` 是每个作业不同的值，但它只出现在子进程环境里，没有被写入提示词、遮盖结果或证据序列化；我读到的 `artifact-archive.py` 也不读环境变量。没有发现依赖前后文的遮盖、时间字段或无序集合被本次改动引入。

3. **有没有对应的自动检查，反向用例真的会失败吗？**
   部分有。`execute` 的合并逻辑和 `isolatedEnvironment` 的追踪号都有真实反向用例：删掉 `execute.mjs:14` 的 `...runnerTracking()` 会让 `runner.test.mjs:186-205` 失败；删掉 `install-tools.mjs:361` 的 `...runnerTracking()` 会让 `toolchain.test.mjs:284-306` 失败。但 `check-security.mjs:80`、`security-exceptions.mjs:30`、`security-redaction.mjs:173` 三处没有测试，删掉不会失败，见问题 1。

4. **改动产生的每个值，生产端和使用端都能接受吗？**
   已核对 `RUNNER_TRACKING_ID`：生产端只有 `runnerTracking()`，对非空字符串返回 `{ RUNNER_TRACKING_ID: id }`，空字符串和非字符串返回 `{}`；使用端包括 `execute` 的 spawn、`isolatedEnvironment` 派生的安装/质量/测试环境、安全 git 子进程和 Python 扫描环境，都是直接透传环境变量，没有格式校验但也不需要额外校验。唯一未核实的是 runner 清理端是否确实按这个变量名和值匹配（无法离线读 `actions/runner`）。事故清单项 I-99 本身能通过 `check-incident-gates.mjs` 的 id、日期、状态和路径校验；但清单里的标题文字与实际测试标题不一致，见问题 2。
