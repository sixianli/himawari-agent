# 复核结论（PR 488，72b5b8bcf）

> 说明：本环境是 sparse checkout（约 63% 文件），我只读了与改动直接相关的文件；`vitest`、biome、CI 运行结果都没有实际跑过，相关结论标「未核实」。

## 读代码证实的问题（按严重度）

### 1. 中低：浏览器启动门槛按原始文本判断，既会漏判也会误判

- 文件:行：`scripts/browser-page-errors.mjs:63-78`
- 问题：`findUnwatchedBrowserLaunches` 只要源码里出现 `.launch(` 且全文任意位置出现 `watchPageErrors(`/`collectPageErrors(` 就放过。它分不清「调用」和「函数定义/注释/字符串」。
- 证据（我读到的原文）：

```js
71:     const source = await readFile(file, "utf8");
72:     if (
73:       /\.launch(?:PersistentContext|Server)?\s*\(/u.test(source) &&
74:       !/\b(?:watchPageErrors|collectPageErrors)\s*\(/u.test(source)
75:     )
76:       offenders.push(relative);
```

- 后果一（漏判）：某文件自己定义 `function collectPageErrors(...)` 或在注释/字符串里写了 `collectPageErrors(`，即使启动浏览器后根本没调用，也会通过。HEAD 提交本身就是因为扫描器源码里的字面量 `.launch(` 而把 `browser-page-errors.mjs` 加进允许名单（`test/tooling/browser-page-errors.test.mjs:165-170` 的 `screenshotOnlyLaunches`）。
- 后果二（误判）：将来任何脚本在注释或文档字符串里写 `chromium.launch()` 而不调用收集函数，会被判违规，造成新的 CI 假红。I-97 只写明了「注释里写调用、别名调用认不出」这一种漏判边界，没有覆盖这种误判。
- 建议：改为检查「从 `browser-page-errors.mjs` import 了收集函数，并且在 AST 里对启动后的 page 调用了它」；至少先剥掉注释和字符串再做匹配，并把允许名单写进扫描器而非测试。若继续维持文本判断，把上面两种边界写进 I-97。

### 2. 低：汇总作业无条件解析远端配置，x64 应急时可能被坏配置挡住

- 文件:行：`scripts/ci/run-share.mjs:177-188`、`scripts/ci/remote-share.mjs:35-47`
- 问题：只要命令带 `--remote-jobs`（本 PR 之后每次都带），`dispatch` 在调用 `collect` 之前就执行 `remoteShareConfig(env)`。即使三份报告都已经在本机共享目录里、根本不需要连 ARM，只要远端配置目录存在但文件不全/`target` 非法，就会直接抛错，整个 `collect` 步骤失败，与运行手册承诺的「arm-fallback 时汇总照样认可 x64 报告」不一致。
- 证据：

```js
185:       remote: remoteJobs
186:         ? { jobs: remoteJobs.split(","), config: remoteShareConfig(env) }
187:         : undefined,
```
```js
38:   if (!existsSync(directory)) return undefined;
39:   const file = (name) => {
41:     const info = lstatSync(filename, { throwIfNoEntry: false });
42:     if (!info?.isFile()) fail(`CONFIG_MISSING:${name}`);
```
- 注意：这只会造成「假失败」，不会「误判为通过」。目录完全不存在时返回 `undefined`，本机报告齐全仍可通过；问题只在配置目录存在但残缺/过期时。
- 建议：把 `config` 改成惰性解析，只在某份报告本机缺失、确实要 `pull` 时才解析；或者把配置错误记成该份报告的 `missing`，交给 `aggregate` 统一判失败。同时补一条「本机报告齐全 + 远端配置损坏仍通过」的测试。

### 3. 低：测试标题说 schema 也一致，但没有断言 `ci-arm`

- 文件:行：`test/tooling/ci-runner-scripts.test.mjs:1662-1664`
- 问题：测试名写「`ci/policy.json`、`ci.yml`、actionlint、the schema 和 runners.sh agree on the labels」，实际只断言了 `ci-vps`、`ci-vps-gate`，没有断言 `"ci-arm"` 在 schema 里。删掉 `ci/policy.schema.json` 的 `ci-arm` 枚举时，这条测试不会失败（虽然 `check-policy` 的 `validateRecord("CheckPolicy")` 仍会失败，所以不是功能漏洞，只是测试覆盖名不副实）。
- 证据：

```js
1662:     const schema = read("ci/policy.schema.json");
1663:     expect(schema).toContain(`"${linuxRunnerLabel}"`);
1664:     expect(schema).toContain(`"${gateRunnerLabel}"`);
```

- 建议：补 `expect(schema).toContain(`"${armRunnerLabel}"`)`。

### 4. 低：作者说法「每个检查作业结束时写一行」只在 `run.mjs` 被启动后成立

- 文件:行：`scripts/ci/run.mjs:587-602`
- 问题：`CI_HOST_LOAD` 只在 `main()` 里 `startHostLoad()` 之后、`runCheck()` 结束时输出。checkout、`install-tools.mjs`、`install-dependencies.mjs` 失败时根本到不了这里，作业结束不会有这一行。作为「机器负载观测」这可以接受，但和「每个检查作业结束时写一行」的绝对说法不一致。
- 证据：

```js
587:   const stopHostLoad = startHostLoad();
588:   let result;
589:   try {
590:     result = await runCheck({
...
600:   } finally {
601:     process.stdout.write(`${stopHostLoad()}\n`);
602:   }
```

- 建议：把说法改成「检查命令真正开始后的每个检查作业」，或者把采样挂到 job 的 started/completed hook（`scripts/operations/ci-runner/job-*.sh`）上，才能真正覆盖安装阶段。

### 5. 低：`commandFailure` 去掉数字、再截断，会合并不同错误码并丢失信息

- 文件:行：`scripts/ci/check-security.mjs:57-64`
- 问题：`.replace(/[0-9]/g, "")` 会把 `E2BIG` 变成 `EBIG`，把带序号的信号/错误压成同一个码；`.slice(0, 40)` 之后再处理尾部下划线，可能把有意义的后缀截掉。功能上仍满足 `/^[A-Z_]+$/` 的报告约束，但「写明原因」的精度下降。
- 证据：

```js
57: export function commandFailure(kind, detail) {
58:   const suffix = String(detail ?? "UNKNOWN")
59:     .toUpperCase()
60:     .replace(/[^A-Z0-9]+/g, "_")
61:     .replace(/[0-9]/g, "")
62:     .replace(/^_+|_+$/g, "");
63:   return `SECURITY_CMD_${kind}_${suffix || "UNKNOWN"}`.slice(0, 40).replace(/_+$/, "");
64: }
```

- 建议：保留数字（`[A-Z0-9_]` 仍能通过当前正则），或对已知 code 做映射；截断时优先保留完整 code。

## 推测（未核实）

- ARM 上 policy/static/security 的实际可行性（Node、Python、actionlint、gitleaks、Semgrep、Chromium、better-sqlite3 的 arm64 产物、内存/时长）：代码里 `PLATFORM_FILENAMES` 已有 `linux-arm64` 分支，锁文件校验也要求包含该平台，运行手册称试验工作流此前已在 ARM 跑过；但我没有跑 CI，也没有逐项核对锁文件里所有 arm64 条目（只看到 Semgrep 的 arm64 wheels）。「未核实」。
- 作者说的「相关 vitest、check:incident-gates、format:check、biome 通过」：本环境无法执行，未核实。
- sparse checkout 可能导致我看到的 `scripts/`、`test/qualification/` 文件不全；如果完整仓库里还有别的 `.launch(` 文件，上述扫描结论需要重跑门槛测试确认。未核实。

## 侧重检查（错误路径、不可信输入、安全、资源耗尽、不可撤销操作、文档一致性）

- **不可信远端报告**：`remote-share.mjs:124-156` 对 JSON、run/name 匹配、文件数 ≤500、单文件 ≤16MiB、合计 ≤64MiB、base64、`safeRelativePath`、大小写和前缀冲突都有校验；`requestRemote` 有总时限、响应上限，并 `SIGKILL` 子进程。未发现越界写文件或路径穿越。结论：可接受。
- **取远端报告失败**：`run-share.mjs:129-141` 把失败放进 `missing`；`required.mjs:27`、`aggregate.mjs:174-178` 对缺失报告判失败，`required.mjs:81` 非 passed 时退出码 1。结论：**不会误判为通过**，与作者说法一致。
- **不可撤销操作**：`run-share remove` 删除本机 run 目录，只在本机，ARM 侧由 `clean-old.sh`（`RUNNER_SHARE_KEEP_MINUTES=360`）清理；`install-runner.sh`/`install-arm-runners.sh` 有备份和回滚路径。未见本 PR 新增危险删除。
- **资源耗尽**：远端报告有大小/文件数/时间上限；`host-load` 每 15 秒采样，最多 60 分钟作业，量很小；`findUnwatchedBrowserLaunches` 只递归读 `scripts/` 和 `test/qualification/`。结论：无明显风险。
- **注入/安全**：`sshArguments` 用 `-F none`、`BatchMode`、`StrictHostKeyChecking=yes`、`IdentitiesOnly`，`target` 正则不允许以 `-` 开头；`commandFailure` 只输出大写字母下划线；`check-lint.mjs` 只执行仓库内的 biome。未发现新增注入面。
- **文档与代码一致性**：ADR 0266 引用的 ci.yml 行号（policy 33、static 72、security 284、remote-jobs 362）和 policy.json 行号（15/16、32/33、122/123）与实际文件一致；运行手册、install-arm-runners.sh 输出、incidents I-97/I-100 与代码一致。唯一不一致是上面第 4 条「每个检查作业」的绝对表述，以及第 1 条文档没写「注释里写 launch 会误判」。

## 必答问题

### 1. 会不会改变模型已经见过的请求开头？
**不会。** 本 PR 没有任何 `apps/`、`packages/`、提示词目录、出口遮盖或工具定义文件的改动（`git diff --name-only` 只有 CI、浏览器脚本、复核工具、测试、文档）。`gateway.mjs`/`opencode-review.mjs` 的 `setEncoding("utf8")` 和假服务器 `Buffer.concat` 只是把「收齐字节再解码」做对，不改变发给 Himawari 或复核模型的请求内容结构。仍然沿用既有「只追加、每轮变化值放最后一条消息」的规则；本 PR 没有实现或验证这条规则本身（未核实产品侧当前行为）。依据：`.claude/rules/prompt-prefix.md` 第 27–35 行。

### 2. 会不会让同一段文字在不同请求里变成不同的字节？
**对模型请求：不会，反而修复了一处会导致不同字节的随机性。** 改动前假模型服务器按块 `body += chunk`，多字节字符跨块会变成 U+FFFD，这正是 I-82 第 2 次「message 9 of 10 changed」的根因；改后 `Buffer.concat(chunks).toString("utf8")` 与 `setEncoding("utf8")` 是确定解码。`findUnwatchedBrowserLaunches` 结果有 `.sort()`，集合无序问题不成立。
唯一带时间/负载变化的值是新加的 `CI_HOST_LOAD`（`host-load.mjs:27-37` 含 `seconds`、`loadAvg*`、`memUsedPeakMiB`），但它只写进 CI 作业日志，不进入任何模型请求；`required.mjs`/`aggregate.mjs` 也不解析它。

### 3. 有没有对应自动检查，反向用例是不是真的会失败？
大体有，且多数是真正的反向用例：

- 浏览器启动门槛：`test/tooling/browser-page-errors.test.mjs:172-178` 对真实 `scripts/`、`test/qualification/` 断言为空；`:181-217` 用临时目录放 `bare.mjs`、`persistent.mjs`、`server.mjs` 等，断言必须报出，另有 `watched.mjs`、`collected.mjs`、`imported.mjs`、允许名单等反例。把 `findUnwatchedBrowserLaunches` 改成恒返回 `[]` 时该用例会失败。**但**「本地定义 `collectPageErrors`」这种绕过没有被覆盖（见问题 1）。
- 策略/工作流：`policy.test.mjs:1223-1262` 覆盖旧字节升级（无 `alternateArch` 和已有 `alternateArch` 两种）与混写拒绝；`:1263-1280` 覆盖把 static/security 改回 `ci-vps`、coverage 写 `ci-arm` 等；`:1281-1307` 覆盖 `--remote-jobs` 缺失/不全、删除试验工作流。把 `runnerLabelFor` 改回 `linuxRunnerLabel` 或把 `--remote-jobs` 校验删掉，都会失败。
- 汇总架构：`aggregate.test.mjs:401-418` 要求 policy/static/security 的 `arm64` 通过、`ppc64` 和 build 的 `arm64` 失败；回退成严格 `member.arch` 或放宽成任意架构都会失败。
- 请求体解码：`request-body-decoding.test.mjs` 有源码扫描 + 真实 HTTP 切块 + 反向样例；把 `startScriptedModel` 换回 `body += chunk` 时切块用例会失败。
- 安全命令失败：`security-process.test.mjs:258-270` 覆盖 ERROR/SIGNAL 两种；`commandFailure` 单测覆盖 `SIGKILL`、`ENOBUFS`、`UNKNOWN`、长度和字符集。
- 推送 lint：`layer0-hooks.test.mjs` 覆盖参数、退出码透传、缺 biome、pre-push 失败；参数与 `check-lint.mjs:5` 的 `LINT_ARGS` 一致。
- 负载日志：`runner-orchestration.test.mjs:790-806` 精确断言格式。

**测试缺口**：没有「本机报告齐全但远端配置损坏时仍应通过」的用例（见问题 2）；没有断言 schema 含 `ci-arm`（见问题 3）。

### 4. 改动产生/修改的每个值，产生方和使用方两端都能接受吗？
逐个核对了我读到的消费者：

- `runner: "ci-arm"`：产生方 `ci/policy.json`；使用方 `ci/policy.schema.json:64` 枚举已加；`check-policy.mjs:193-198` 的 `runnerLabelFor` 对三项返回 `armRunnerLabel`；`:374-380` `validatePolicy` 按它校验；`:527-531` `validateWorkflow` 要求 `runs-on` 等于 `member.runner`；`.github/workflows/ci.yml:33/72/284` 均为 `ci-arm`；`actionlint.yaml` 已列 `ci-arm`；`runners.sh:15` 定义 `RUNNER_ARM_LABEL=ci-arm`。两端一致。
- `alternateArch: "arm64"`：产生方 policy；`policy.schema.json:75-77` const；`validatePolicy:377` 只允许三项有；`aggregate.mjs:102` 接受 `[member.arch, member.alternateArch]`；`run.mjs:71-72` `memberRunsOnHost` 也接受；测试覆盖。两端一致。
- `--remote-jobs policy,static,security`：产生方 `ci.yml:362` 与 `check-policy.mjs:578` 的期望字符串严格相等；使用方 `run-share.mjs:177-188` 的正则接受小写逗号清单；`collect:131` 按 job 名决定是否远端取；`remote-share.mjs` 的 run/name 校验接受。两端一致。
- `CI_HOST_LOAD` 字段：只有日志和测试，无其它校验/解析方。
- `SECURITY_CMD_*`：产生方 `commandFailure`；`check-security.mjs:725/767` 用 `/^[A-Z_]+$/` 过滤，`run.mjs:278` 同样；测试覆盖。两端一致（除问题 5 的信息损失）。
- `check-lint.mjs`：`package.json:79` 的 `lint`、`scripts/git-hooks/pre-push`、`layer0-hooks.test.mjs` 三处一致；CI static 通过 `check:steps` 的 `npm run lint` 也会走到它。
- 删除 `.github/workflows/ci-arm-trial.yml`：`run.mjs:252-255` 已删、`ci-optimization.test.mjs` 列表已删、`policy.test.mjs:1305-1307` 和 `ci-runner-scripts.test.mjs:1673` 断言不存在、运行手册/ADR/安装脚本输出已更新；全仓库只剩历史事故 I-99 和这两个断言提到旧工作流名，属于历史记录，不算残留引用。

总体：**没有发现会让汇总误判为通过、或让 ARM 报告被错误接受/拒绝的功能性错误**；主要问题是门槛的文本判断强度和两处测试/文档精度。
